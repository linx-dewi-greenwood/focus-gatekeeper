// 让浏览器扩展能在中控没开时把它拉起来：向 Chrome / Edge 登记一个“原生消息主机”。
// 中控每次启动都会调用 registerNativeHost()（只写当前用户的注册表，不需要管理员权限），
// 所以用户只要手动启动过一次中控，以后扩展就能自动启动它。
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const HOST_NAME = 'com.focus_gatekeeper.hub';
// 扩展的 ID 由 extension/manifest.json 里的 "key" 固定，Chrome 和 Edge 里都一样
const EXTENSION_ID = 'jkoppfcpiceehbfcbloeggopnieekhoo';
const REG_ROOTS = [
  'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts',
  'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts',
  'HKCU\\Software\\Chromium\\NativeMessagingHosts',
  'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts'
];

function hostManifest(hubDir) {
  return {
    name: HOST_NAME,
    description: '一事一毕：在中控没运行时由浏览器扩展启动中控',
    path: path.join(hubDir, 'native-host.bat'),
    type: 'stdio',
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`]
  };
}

function regAdd(key, value) {
  return new Promise(resolve => {
    execFile('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', value, '/f'], { windowsHide: true },
      err => resolve(!err));
  });
}

async function registerNativeHost({ hubDir, dataDir, log = console.log }) {
  if (process.platform !== 'win32') return { ok: false, reason: 'not windows' };
  const manifestPath = path.join(dataDir, 'native-host.json');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(hostManifest(hubDir), null, 2));
  const results = await Promise.all(REG_ROOTS.map(root => regAdd(`${root}\\${HOST_NAME}`, manifestPath)));
  const ok = results.some(Boolean);
  log(ok ? '已登记自动启动（浏览器扩展可在中控没开时启动它）' : '登记自动启动失败', manifestPath);
  return { ok, manifestPath };
}

module.exports = { HOST_NAME, EXTENSION_ID, hostManifest, registerNativeHost };
