// 原生消息启动器测试：模拟浏览器按原生消息协议发消息，检查回复。不会真的启动中控（FOCUS_LAUNCH_DRY）。
// 运行：npm test
const assert = require('assert');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { hostManifest, EXTENSION_ID, HOST_NAME } = require('../src/native-host');

const PORT = 47398;
let passed = 0;
async function step(name, fn) {
  try { await fn(); passed++; console.log('PASS', name); }
  catch (e) { console.log('FAIL', name, '\n  ', e.message); process.exitCode = 1; }
}

function callLauncher(msg) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'launcher.js')], {
      env: { ...process.env, FOCUS_HUB_PORT: String(PORT), FOCUS_LAUNCH_DRY: '1' }
    });
    let out = Buffer.alloc(0);
    p.stdout.on('data', d => { out = Buffer.concat([out, d]); });
    p.on('exit', () => {
      if (out.length < 4) return reject(new Error('没有回复'));
      const len = out.readUInt32LE(0);
      assert.strictEqual(out.length, 4 + len, 'stdout 里除了一条消息不应有别的内容');
      resolve(JSON.parse(out.slice(4).toString('utf8')));
    });
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    const head = Buffer.alloc(4); head.writeUInt32LE(body.length, 0);
    p.stdin.write(Buffer.concat([head, body]));
  });
}

(async () => {
  await step('中控没运行 → 启动器尝试启动中控（WMI 方式，带 --background）', async () => {
    const r = await callLauncher({ cmd: 'launch' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.wasRunning, false);
    assert.ok(r.launched?.dry, JSON.stringify(r));
    assert.ok(r.launched.cmdLine.includes('--background'));
    assert.ok(r.launched.ps.includes('Win32_Process'));
  });

  await step('中控已在运行 → 不再重复启动', async () => {
    const server = net.createServer(s => s.end()).listen(PORT, '127.0.0.1');
    await new Promise(r => server.on('listening', r));
    const r = await callLauncher({ cmd: 'launch' });
    server.close();
    assert.strictEqual(r.wasRunning, true);
    assert.strictEqual(r.launched, null);
  });

  await step('原生消息登记文件：名称、路径、只允许本扩展', async () => {
    const m = hostManifest('D:\\桌面\\项目\\Focus\\hub');
    assert.strictEqual(m.name, HOST_NAME);
    assert.ok(/^[a-z0-9._]+$/.test(m.name));
    assert.ok(m.path.endsWith('native-host.bat'));
    assert.strictEqual(m.type, 'stdio');
    assert.deepStrictEqual(m.allowed_origins, [`chrome-extension://${EXTENSION_ID}/`]);
  });

  await step('扩展 manifest 里的 key 对应的 ID 与登记的 ID 一致', async () => {
    const crypto = require('crypto');
    const mf = require('../../extension/manifest.json');
    const hex = crypto.createHash('sha256').update(Buffer.from(mf.key, 'base64')).digest('hex').slice(0, 32);
    const id = [...hex].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
    assert.strictEqual(id, EXTENSION_ID);
    assert.ok(mf.permissions.includes('nativeMessaging'));
  });

  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
})();
