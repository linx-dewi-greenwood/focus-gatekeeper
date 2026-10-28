// 前台窗口监听：启动一个常驻的 PowerShell 进程（内嵌 C#，调用 Win32 GetForegroundWindow）
// 不需要编译任何原生 npm 模块。只支持 Windows。
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function startWatcher({ onWindow, log = console.log }) {
  if (process.platform !== 'win32') {
    log('前台窗口检测目前只支持 Windows，当前系统：' + process.platform);
    return { supported: false, activate: async () => false, minimize: async () => false, stop() {} };
  }
  const script = fs.readFileSync(path.join(__dirname, 'fgwatch.ps1'), 'utf8');
  const encoded = Buffer.from(script, 'utf16le').toString('base64'); // 用 -EncodedCommand，避免中文路径和编码问题
  let child = null, buf = '', stopped = false, seq = 0;
  const waiters = new Map(); // id → resolve

  function start() {
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/^\uFEFF/, '').trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m;
        try { m = JSON.parse(line); } catch { log('watcher 输出无法解析：', line); continue; }
        if (m.type === 'fg') onWindow(m);
        else if (m.type === 'done') { const w = waiters.get(m.id); if (w) { waiters.delete(m.id); w(m.ok); } }
        else if (m.type === 'ready') log('前台窗口检测已启动');
        else if (m.type === 'error') log('watcher 错误：', m.message);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', d => log('watcher stderr：', d.trim()));
    child.on('exit', code => {
      child = null;
      for (const [, w] of waiters) w(false);
      waiters.clear();
      if (!stopped) { log('watcher 已退出（' + code + '），3 秒后重启'); setTimeout(start, 3000); }
    });
  }
  start();

  function command(name, place) {
    return new Promise(resolve => {
      if (!child || !place?.hwnd) return resolve(false);
      const id = ++seq;
      const t = setTimeout(() => { waiters.delete(id); resolve(false); }, 2000);
      waiters.set(id, ok => { clearTimeout(t); resolve(!!ok); });
      child.stdin.write(`${name} ${id} ${place.hwnd}\n`);
    });
  }

  return {
    supported: true,
    activate: place => command('activate', place),
    minimize: place => command('minimize', place),
    stop() {
      stopped = true;
      try { child?.stdin.write('quit\n'); } catch {}
      setTimeout(() => { try { child?.kill(); } catch {} }, 500);
    }
  };
}

module.exports = { startWatcher };
