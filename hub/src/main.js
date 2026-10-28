// 一事一毕 · 中控（Electron 主进程）
// 窗口：控制面板（开始一件事、看状态）、置顶卡片窗口（提问/岔路/回程）、倒计时角标；系统托盘图标。
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, globalShortcut, nativeImage, net, shell } = require('electron');
const { createCore } = require('./core');
const { startWatcher } = require('./watcher');

const ROOT = path.join(__dirname, '..');
const ICON = path.join(ROOT, '..', 'extension', 'icons', 'icon48.png');
// 日志：同时打印到命令行和 %APPDATA%\focus-hub\hub.log（出问题时把这个文件发出来）
let logFile = null;
function log(...a) {
  const line = a.map(x => (x instanceof Error ? x.stack : typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ');
  console.log('[中控]', line);
  if (!logFile) return;
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 1024 * 1024) fs.renameSync(logFile, logFile + '.old');
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let core, watcher, tray, panelWin, cardWin, badgeWin;
let quitting = false;
const ownWindows = () => [panelWin, cardWin, badgeWin].filter(w => w && !w.isDestroyed());

function hwndOf(win) {
  try {
    const b = win.getNativeWindowHandle();
    return String(b.length >= 8 ? b.readBigUInt64LE(0) : b.readUInt32LE(0));
  } catch { return ''; }
}
function workArea() {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
}
function makeWindow(file, opts) {
  const w = new BrowserWindow({
    show: false, icon: ICON,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false },
    ...opts
  });
  w.loadFile(path.join(ROOT, 'ui', file));
  return w;
}

function createWindows() {
  panelWin = makeWindow('panel.html', { width: 380, height: 680, minWidth: 340, title: '一事一毕 · 中控', autoHideMenuBar: true, backgroundColor: '#fbfaf6' });
  panelWin.on('close', e => { if (!quitting) { e.preventDefault(); panelWin.hide(); } });

  cardWin = makeWindow('card.html', {
    frame: false, transparent: true, resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false, width: 376, height: 600
  });
  cardWin.setAlwaysOnTop(true, 'screen-saver');
  cardWin.on('close', e => { if (!quitting) { e.preventDefault(); cardWin.hide(); } });
  // 卡片窗口卡死或崩溃时：立刻隐藏（不能让一个盖满屏幕的窗口挡住用户），然后重新加载
  cardWin.webContents.on('unresponsive', () => { log('卡片窗口无响应，已隐藏并重新加载'); cardWin.hide(); cardWin.webContents.reload(); });
  cardWin.webContents.on('render-process-gone', (_e, d) => { log('卡片窗口崩溃：', d?.reason); cardWin.hide(); cardWin.webContents.reload(); });

  badgeWin = makeWindow('badge.html', {
    frame: false, transparent: true, resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false, focusable: false, width: 420, height: 48
  });
  badgeWin.setAlwaysOnTop(true, 'screen-saver');
  badgeWin.on('close', e => { if (!quitting) { e.preventDefault(); badgeWin.hide(); } });
}

// 强制关闭当前卡片（Alt+Shift+B / 托盘菜单）：任何情况下都能把盖住屏幕的卡片窗口收起来
function hideCards() {
  log('强制关闭卡片');
  try { cardWin.webContents.send('hub:card', { kind: 'clear' }); } catch {}
  cardWin.hide();
}

function showPanel() {
  panelWin.show();
  panelWin.focus();
  panelWin.webContents.send('hub:refresh');
}

/* ---------- 网页 → 主进程 ---------- */
ipcMain.handle('hub:msg', (_e, msg) => core.handleUi(msg));
ipcMain.on('hub:hidePanel', () => panelWin?.hide());
ipcMain.on('hub:layout', (e, info) => {
  const wa = workArea();
  if (e.sender === cardWin.webContents && info.type === 'card') {
    if (!info.visible) { cardWin.hide(); log('卡片隐藏'); return; }
    // 窗口永远只和卡片一样大，绝不盖满屏幕：就算出问题，也只挡住卡片这一小块
    const w = Math.min(Math.round(info.w), wa.width - 16), h = Math.min(Math.round(info.h), wa.height - 16);
    if (info.modal) { // 需要用户处理的卡片：屏幕中间，抢焦点
      const b = { x: Math.round(wa.x + (wa.width - w) / 2), y: Math.round(wa.y + (wa.height - h) / 3), width: w, height: h };
      cardWin.setBounds(b);
      cardWin.show();
      cardWin.focus();
      log('卡片显示（中间）', info.kind, b);
    } else {          // 提示类卡片：右下角，不抢焦点
      const b = { x: wa.x + wa.width - w - 8, y: wa.y + wa.height - h - 56, width: w, height: h };
      cardWin.setBounds(b);
      cardWin.showInactive();
      log('卡片显示（角落）', info.kind, b);
    }
  } else if (e.sender === badgeWin.webContents && info.type === 'badge') {
    if (!info.visible) { badgeWin.hide(); return; }
    badgeWin.setBounds({ x: wa.x + wa.width - info.w - 8, y: wa.y + wa.height - info.h - 8, width: info.w, height: info.h });
    badgeWin.showInactive();
  }
});

/* ---------- 托盘 ---------- */
function refreshTray(s) {
  if (!tray) return;
  const line = s?.focus ? (s.detours?.at(-1) || s.focus) : null;
  tray.setToolTip(line ? `一事一毕 · ${s.detours.length ? '岔路' : '主线'}：${line.title}` : '一事一毕 · 没有进行中的事');
  const login = app.getLoginItemSettings({ path: process.execPath, args: [app.getAppPath()] }).openAtLogin;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开控制面板', click: showPanel },
    { label: '我被打断了（Alt+B）', enabled: !!s?.focus, click: () => core.handleUi({ type: 'openDetourForm' }) },
    { label: '岔路完成，回去', enabled: !!s?.detours?.length, click: () => core.handleUi({ type: 'endDetour', outcome: 'done' }) },
    { label: '关闭当前卡片（Alt+Shift+B）', click: hideCards },
    { label: '打开日志', click: () => shell.openPath(logFile) },
    { type: 'separator' },
    { label: `浏览器扩展：${core.status().extConnected ? '已连接' : '未连接'}`, enabled: false },
    { label: `前台窗口检测：${watcher?.supported ? '运行中' : '不支持此系统'}`, enabled: false },
    {
      label: '开机自动启动', type: 'checkbox', checked: login,
      click: item => app.setLoginItemSettings({ openAtLogin: item.checked, path: process.execPath, args: [app.getAppPath()] })
    },
    { type: 'separator' },
    { label: '退出中控', click: () => { quitting = true; app.quit(); } }
  ]));
}

app.whenReady().then(() => {
  logFile = path.join(app.getPath('userData'), 'hub.log');
  log('—— 中控启动 ——', `Electron ${process.versions.electron}`, `Windows ${process.getSystemVersion?.() || ''}`);
  createWindows();

  watcher = startWatcher({
    log,
    onWindow: w => {
      // 中控自己的窗口（卡片、面板、角标）不算切换
      const self = w.pid === process.pid || ownWindows().some(x => hwndOf(x) === String(w.hwnd));
      log('前台', self ? '(中控自己)' : w.app, w.hwnd); // 只记进程名，不记窗口标题
      core?.onForeground({ ...w, self });
    }
  });

  core = createCore({
    statePath: path.join(app.getPath('userData'), 'state.json'),
    log,
    activate: async place => { const ok = await watcher.activate(place); log('切回窗口', place?.app, place?.hwnd, ok ? '成功' : '失败'); return ok; },
    minimize: async place => { const ok = await watcher.minimize(place); log('最小化窗口', place?.app, place?.hwnd, ok ? '成功' : '失败'); return ok; },
    ui: {
      showCard: card => { log('发出卡片', card.kind, `档位${card.level ?? ''}`); cardWin.webContents.send('hub:card', card); return true; },
      pushState: s => {
        for (const w of ownWindows()) w.webContents.send('hub:state', s);
        refreshTray(s);
      }
    }
  });

  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.on('click', showPanel);
  core.engine.getState().then(refreshTray);
  setInterval(() => core.engine.getState().then(refreshTray), 30000);

  // 保险：卡片窗口可见时，每 1.5 秒确认里面真的有卡片；空的就立刻隐藏，绝不留下看不见的窗口挡住别的程序
  setInterval(async () => {
    if (!cardWin || cardWin.isDestroyed() || !cardWin.isVisible()) return;
    const has = await cardWin.webContents.executeJavaScript(
      "!!document.getElementById('focus-shield-root')?.shadowRoot?.querySelector('[data-card]')").catch(() => false);
    if (!has) { log('卡片窗口是空的，自动隐藏'); cardWin.hide(); }
  }, 1500);

  globalShortcut.register('Alt+B', () => core.handleUi({ type: 'openDetourForm' }));
  globalShortcut.register('Alt+Shift+B', hideCards);

  // 断网检测：每 5 秒看一次
  let online = net.isOnline();
  setInterval(() => {
    const now = net.isOnline();
    if (online && !now) core.onOffline();
    online = now;
  }, 5000);

  global.__focusHub = { core, panelWin, cardWin, badgeWin }; // 调试用：在开发者工具/测试脚本里可以访问
  if (!process.env.FOCUS_HUB_HIDDEN) showPanel();
  log('中控已启动，状态文件：', path.join(app.getPath('userData'), 'state.json'));
});

app.on('second-instance', () => showPanel());
app.on('window-all-closed', e => e.preventDefault()); // 常驻托盘
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  watcher?.stop();
  core?.close();
});
