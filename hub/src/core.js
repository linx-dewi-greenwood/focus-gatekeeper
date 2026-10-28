// 一事一毕 · 中控核心（纯 Node.js，不依赖 Electron，方便测试）
// 负责：规则引擎（与浏览器扩展共用 extension/engine.js）、状态文件、计时器、
//       前台窗口切换的判断、与浏览器扩展的 WebSocket 通信、把卡片分发到网页或中控窗口。
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const E = require('../../extension/engine.js');

const PORT = 47321;
const DEBOUNCE_MS = 700; // 窗口停留这么久才算一次切换（避免 Alt+Tab 一闪而过也提问）
const RPC_METHODS = ['getState', 'touch', 'recordPrompt', 'decision', 'labelSwitch', 'forget', 'startFocus', 'focusAction', 'restore',
  'discardSuspended', 'pause', 'registerDetour', 'endDetour', 'extendDetour', 'detourFormCard', 'offlineCard', 'listAction'];
const APP_NAMES = {
  winword: 'Word', excel: 'Excel', powerpnt: 'PowerPoint', onenote: 'OneNote', outlook: 'Outlook', olk: 'Outlook',
  code: 'VS Code', chrome: 'Chrome', msedge: 'Edge', firefox: 'Firefox', brave: 'Brave',
  wechat: '微信', weixin: '微信', qq: 'QQ', dingtalk: '钉钉', feishu: '飞书', lark: '飞书',
  teams: 'Teams', 'ms-teams': 'Teams', slack: 'Slack', discord: 'Discord', telegram: 'Telegram', whatsapp: 'WhatsApp',
  notion: 'Notion', obsidian: 'Obsidian', zotero: 'Zotero', acrord32: 'Acrobat Reader', acrobat: 'Acrobat',
  sumatrapdf: 'SumatraPDF', windowsterminal: '终端', cmd: '命令提示符', powershell: 'PowerShell', pwsh: 'PowerShell',
  rstudio: 'RStudio', pycharm64: 'PyCharm', spotify: 'Spotify', cloudmusic: '网易云音乐', steam: 'Steam', bilibili: '哔哩哔哩'
};
const appLabel = app => APP_NAMES[app] || app;

function createCore({ statePath, ui, activate, minimize = async () => false, port = PORT, log = console.log, engineOptions = {} }) {
  // ui:       { showCard(card) → bool, pushState(state) }  中控自己的窗口
  // activate: (place) → Promise<bool>                        把某个应用窗口切到前台
  // minimize: (place) → Promise<bool>                        把某个应用窗口最小化
  const timers = new Map();
  let ext = null;            // 已连接的浏览器扩展 { ws, seq, waiting }
  let fg = null;             // 当前前台窗口
  let lastFgHwnd = null;     // 上一个前台窗口（包括中控自己的卡片）
  let lastWork = null;       // 最近一个“用户在用的”窗口（不含中控自己和系统界面）
  let browserWin = null;     // 最近一次在前台的浏览器窗口
  let pending = null;        // 应用级提问卡 { place, prevPlace, key }
  let debounce = null;
  const suppress = {};       // app → 时间：程序自己切过去的，短时间内不提问
  const asked = new Set();   // 这条线里已经问过的应用
  const recent = [];         // 最近用过的应用

  /* ---------- 状态与引擎 ---------- */
  function readFile() {
    try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return null; }
  }
  function writeFile(s) {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const tmp = statePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, statePath);
  }
  const engine = E.createEngine({
    load: async () => readFile(),
    save: async s => { writeFile(s); broadcast(s); },
    schedule: (name, when) => {
      clearTimeout(timers.get(name));
      timers.set(name, setTimeout(() => { timers.delete(name); engine.onAlarm(name).catch(e => log('alarm', e)); }, Math.max(0, when - Date.now())));
    },
    clear: name => { clearTimeout(timers.get(name)); timers.delete(name); },
    show: (card, place) => show(card, place),
    switchTo: place => switchTo(place)
  }, engineOptions);
  function broadcast(s) {
    try { ui.pushState(s); } catch (e) { log('pushState', e); }
    sendExt({ type: 'state', state: s });
  }

  /* ---------- 位置 ---------- */
  const appPlace = w => (w ? { kind: 'app', app: w.app, label: appLabel(w.app), hwnd: w.hwnd, pid: w.pid } : null);
  const isBrowser = w => !!w && E.BROWSER_APPS.includes(w.app);
  function rememberRecent(w) {
    const i = recent.findIndex(r => r.app === w.app);
    if (i >= 0) recent.splice(i, 1);
    recent.unshift({ app: w.app, label: appLabel(w.app) });
    recent.length = Math.min(recent.length, 8);
  }
  // 用户“正在工作的位置”：浏览器在前台且扩展已连接时取当前标签页，否则取应用窗口
  async function workPlace() {
    if (!lastWork) return null;
    if (isBrowser(lastWork) && ext) {
      const tab = await extCmd('activeTab', {}).catch(() => null);
      if (tab) return { ...tab, app: lastWork.app };
    }
    return appPlace(lastWork);
  }

  /* ---------- 卡片与切换 ---------- */
  async function show(card, place) {
    if (!card) return false;
    const wantExt = ext && (place?.kind === 'tab' || (!place && isBrowser(lastWork)));
    if (wantExt) {
      const ok = await extCmd('show', { card, place }).catch(() => false);
      if (ok) return true;
    }
    return ui.showCard(card) !== false;
  }
  async function switchTo(place) {
    if (!place) return false;
    if (place.kind === 'tab') {
      if (!ext) return false;
      const ok = await extCmd('switchTo', { place }).catch(() => false);
      if (ok && browserWin && !isBrowser(fg)) { suppress[browserWin.app] = Date.now() + 1500; await activate(appPlace(browserWin)); }
      return !!ok;
    }
    suppress[place.app] = Date.now() + 1500;
    return activate(place);
  }

  /* ---------- 前台窗口 ---------- */
  // win: { hwnd, pid, app, title, self }，self 表示是中控自己的窗口
  function onForeground(win) {
    win = { ...win, app: E.normApp(win.app) };
    const prevFgHwnd = lastFgHwnd;
    lastFgHwnd = win.hwnd;
    fg = win;
    if (win.self || !win.app || E.IGNORED_APPS.includes(win.app)) return;
    if (isBrowser(win)) browserWin = win;
    rememberRecent(win);
    const prev = lastWork;
    lastWork = win;
    if (prevFgHwnd === win.hwnd) return; // 同一窗口只是标题变了
    // 注意：从中控卡片回到同一个窗口（比如按了“返回”却没切走）也会走到这里，重新判断一次
    clearTimeout(debounce);
    const prevOther = prev && prev.hwnd !== win.hwnd ? prev : null;
    debounce = setTimeout(() => evaluateApp(win, prevOther).catch(e => log('evaluate', e)), DEBOUNCE_MS);
  }

  async function evaluateApp(win, prev) {
    if (!fg || fg.hwnd !== win.hwnd) return; // 已经又切走了
    if (ext && isBrowser(win)) return;       // 浏览器里交给扩展按网站判断
    if (Date.now() < (suppress[win.app] || 0)) return;
    const s = await engine.getState();
    if (!s.focus) return;
    if (s.focus.pauseUntil && Date.now() < s.focus.pauseUntil) return;
    const place = appPlace(win);
    if (E.isAllowed(s, place)) { await engine.touch(place); return; }
    const line = E.currentLine(s);
    const key = `${line.id}|${win.app}`;
    if (asked.has(key)) return;
    asked.add(key);
    const info = await engine.recordPrompt(place);
    if (!info || info.level === 0) return;
    // “返回”的目标：这条线上最后待过的位置；没有时用上一个窗口
    const lp = line.lastPlace;
    const prevPlace = lp && !(lp.kind === 'app' && lp.app === win.app) ? lp : (prev ? appPlace(prev) : null);
    pending = { place, prevPlace, key };
    ui.showCard({
      kind: 'switch', level: info.level, verb: '切换到', host: appLabel(win.app),
      title: shortTitle(win.title, win.app), lineTitle: info.lineTitle, onDetour: info.onDetour
    });
  }
  // 窗口标题只用来在卡片上显示，不保存
  function shortTitle(title, app) {
    const t = String(title || '').trim();
    if (!t || t.toLowerCase() === app || t === appLabel(app)) return '';
    return t.length > 60 ? t.slice(0, 58) + '…' : t;
  }

  // “返回”：先把让人分心的窗口最小化，再切回原来的位置
  async function goBackApp(p) {
    if (p?.place?.kind === 'app') await minimize(p.place).catch(() => false);
    const target = p?.prevPlace;
    if (!target) return;
    if (target.kind === 'tab') await switchTo(target);
    else { suppress[target.app] = Date.now() + 1500; await activate(target); }
  }

  /* ---------- 中控界面发来的消息（卡片窗口、角标、控制面板） ---------- */
  async function handleUi(msg) {
    switch (msg.type) {
      case 'getState':
        return {
          state: await engine.getState(),
          hub: { connected: !!ext, recentApps: recent.slice(), workApp: lastWork ? appLabel(lastWork.app) : null }
        };
      case 'startFocus': {
        const r = await engine.startFocus(msg.form || {}, await workPlace());
        if (r.ok) asked.clear();
        return r;
      }
      case 'decision': {
        const p = pending;
        if (!p) return { ok: false };
        if (msg.choice === 'detour') return { ok: true };
        pending = null;
        await engine.decision(msg.choice, p.place);
        if (msg.choice === 'back' || msg.choice === 'later') { asked.delete(p.key); await goBackApp(p); }
        return { ok: true };
      }
      case 'registerDetour': {
        const p = pending;
        pending = null;
        const place = p ? p.place : await workPlace();
        const returnPlace = msg.form.returnPlace || (p ? null : place);
        const r = await engine.registerDetour(msg.form, place, returnPlace);
        if (r.ok && !r.started) {
          if (p) await goBackApp(p);
          if (r.toast) await show(r.toast, null);
        }
        return r;
      }
      case 'openDetourForm': {
        const place = await workPlace();
        const card = await engine.detourFormCard(place);
        if (!card) return { error: '还没有开始一件事' };
        await show(card, place?.kind === 'tab' ? place : null);
        return { ok: true };
      }
      case 'offline': return { ok: true }; // 中控自己检测断网（见 onOffline）
      case 'endDetour': return engine.endDetour(msg.outcome || 'done');
      case 'extendDetour': return engine.extendDetour();
      case 'focusAction': return engine.focusAction(msg.action, msg.title);
      case 'restore': return engine.restore(msg.timeboxMin);
      case 'discardSuspended': return engine.discardSuspended();
      case 'pause': return engine.pause();
      case 'listAction': return engine.listAction(msg);
      case 'labelSwitch': return engine.labelSwitch(msg);
      case 'forget': return engine.forget(msg);
      default: return { error: 'unknown message' };
    }
  }

  async function onOffline() {
    const place = await workPlace();
    const card = await engine.offlineCard(place);
    if (card) await show(card, place?.kind === 'tab' ? place : null);
  }

  /* ---------- 浏览器扩展（WebSocket） ---------- */
  function sendExt(obj) {
    if (ext && ext.ws.readyState === 1) ext.ws.send(JSON.stringify(obj));
  }
  function extCmd(cmd, payload) {
    return new Promise((resolve, reject) => {
      if (!ext) return reject(new Error('浏览器扩展未连接'));
      const id = ++ext.seq;
      ext.waiting.set(id, { resolve, reject });
      ext.ws.send(JSON.stringify({ type: 'cmd', id, cmd, ...payload }));
      setTimeout(() => { if (ext?.waiting.has(id)) { ext.waiting.delete(id); reject(new Error('扩展没有响应')); } }, 5000);
    });
  }
  const wss = new WebSocketServer({
    host: '127.0.0.1', port,
    // 只接受浏览器扩展和本机程序，拒绝普通网页（网页里的脚本也能连本机端口）
    verifyClient: ({ origin }) => !origin || /^(chrome-extension|extension|moz-extension):\/\//.test(origin)
  });
  wss.on('error', e => log('WebSocket 服务启动失败（端口 ' + port + ' 被占用？）', e.message));
  wss.on('connection', ws => {
    ws.on('message', async raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === 'hello') {
        if (ext && ext.ws !== ws) try { ext.ws.close(); } catch {}
        ext = { ws, seq: 0, waiting: new Map(), version: msg.version };
        log('浏览器扩展已连接', msg.version || '');
        await engine.adopt(msg.state);
        ws.send(JSON.stringify({ type: 'state', state: await engine.getState() }));
      } else if (msg.type === 'rpc') {
        let result = null, error = null;
        try {
          if (!RPC_METHODS.includes(msg.method)) throw new Error('不支持的调用：' + msg.method);
          result = await engine[msg.method](...(msg.args || []));
          if (msg.method === 'startFocus' && result?.ok) asked.clear();
        } catch (e) { error = String(e?.message || e); }
        ws.send(JSON.stringify({ type: 'reply', id: msg.id, result, error }));
      } else if (msg.type === 'reply' && ext?.ws === ws) {
        const w = ext.waiting.get(msg.id);
        if (!w) return;
        ext.waiting.delete(msg.id);
        if (msg.error) w.reject(new Error(msg.error)); else w.resolve(msg.result);
      }
    });
    ws.on('close', () => {
      if (ext?.ws !== ws) return;
      for (const [, w] of ext.waiting) w.reject(new Error('扩展已断开'));
      ext = null;
      log('浏览器扩展已断开');
    });
  });
  const ping = setInterval(() => sendExt({ type: 'ping' }), 20000); // 保持扩展的 service worker 不休眠

  engine.resync().catch(e => log('resync', e));

  return {
    engine, handleUi, onForeground, onOffline,
    status: () => ({ extConnected: !!ext, fg, lastWork }),
    close: () => {
      clearInterval(ping); clearTimeout(debounce); timers.forEach(clearTimeout);
      for (const c of wss.clients) c.terminate(); // 断开扩展，让它退回单机模式
      wss.close();
    }
  };
}

module.exports = { createCore, PORT, appLabel };
