// 原生消息主机：浏览器扩展调用 chrome.runtime.sendNativeMessage 时，浏览器运行 native-host.bat，
// 由 electron.exe 以 Node 模式（ELECTRON_RUN_AS_NODE=1）执行本文件。
// 做的事只有一件：中控没在运行就把它启动起来，然后回复扩展。
//
// 原生消息协议：stdin / stdout 上每条消息 = 4 字节小端长度 + UTF-8 JSON。stdout 上不能输出任何别的东西。
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.FOCUS_HUB_PORT) || 47321;
const HUB_DIR = path.join(__dirname, '..');
const ELECTRON = process.execPath; // 就是 hub\node_modules\electron\dist\electron.exe

function readMessage(timeoutMs = 2000) {
  return new Promise(resolve => {
    let buf = Buffer.alloc(0);
    const done = v => { clearTimeout(t); process.stdin.removeAllListeners('data'); resolve(v); };
    const t = setTimeout(() => done(null), timeoutMs);
    process.stdin.on('data', d => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= 4) {
        const len = buf.readUInt32LE(0);
        if (buf.length >= 4 + len) {
          try { done(JSON.parse(buf.slice(4, 4 + len).toString('utf8'))); } catch { done(null); }
        }
      }
    });
    process.stdin.on('end', () => done(null));
  });
}

function writeMessage(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
}

function portOpen() {
  return new Promise(resolve => {
    const s = net.connect({ host: '127.0.0.1', port: PORT });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.setTimeout(800, () => { s.destroy(); resolve(false); });
  });
}

// 浏览器会在通信结束后结束主机进程（以及它直接启动的子进程），所以中控要通过 WMI 启动：
// 由系统服务创建的进程不属于浏览器，浏览器关掉也不会被一起关掉。
function launchHub() {
  const q = s => s.replace(/'/g, "''");
  const cmdLine = `"${ELECTRON}" "${HUB_DIR}" --background`;
  const ps = `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${q(cmdLine)}'; CurrentDirectory = '${q(HUB_DIR)}' }; exit $r.ReturnValue`;
  if (process.env.FOCUS_LAUNCH_DRY) return Promise.resolve({ dry: true, cmdLine, ps });
  return new Promise(resolve => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: 'ignore' });
    child.on('exit', code => {
      if (code === 0) return resolve({ via: 'wmi' });
      // 退路：直接启动（浏览器关闭时可能会被一起关掉，但至少能用）
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const p = spawn(ELECTRON, [HUB_DIR, '--background'], { cwd: HUB_DIR, env, detached: true, stdio: 'ignore', windowsHide: false });
      p.unref();
      resolve({ via: 'spawn', wmiCode: code });
    });
    child.on('error', () => resolve({ via: 'none' }));
  });
}

(async () => {
  const msg = await readMessage();
  const wasRunning = await portOpen();
  let launched = null;
  if (!wasRunning && (!msg || msg.cmd === 'launch')) {
    launched = await launchHub();
    if (!launched.dry) {
      for (let i = 0; i < 40 && !(await portOpen()); i++) await new Promise(r => setTimeout(r, 400));
    }
  }
  writeMessage({ ok: true, wasRunning, running: await portOpen(), launched });
  setTimeout(() => process.exit(0), 50);
})().catch(e => { try { writeMessage({ ok: false, error: String(e && e.message || e) }); } catch {} process.exit(1); });
