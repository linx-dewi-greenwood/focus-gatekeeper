// 一事一毕 · 浏览器适配器（Manifest V3 service worker）
// 中控是唯一的“大脑”：主线、岔路、四象限、计时都只在中控里，只有一个时钟。
// 扩展只负责浏览器：检测网站/标签页切换并上报中控，按中控的指令在网页里显示卡片、切换标签页。
// 中控没在运行时，通过原生消息（hub\native-host.bat）把它启动起来。
importScripts('engine.js'); // 只用里面的纯函数（判断网站是否属于当前线等），不在扩展里保存状态或计时
const E = self.FocusEngine;
const HUB_URL = 'ws://127.0.0.1:47321';
const NATIVE_HOST = 'com.focus_gatekeeper.hub';
const now = () => Date.now();

// 告诉中控“我是哪个浏览器”，中控据此把卡片发给在前台的那个浏览器（进程名：chrome / msedge …）
const BROWSER = (() => {
  const brands = (navigator.userAgentData?.brands || []).map(b => b.brand.toLowerCase()).join(' ');
  const ua = navigator.userAgent || '';
  if (brands.includes('edge') || /Edg\//.test(ua)) return 'msedge';
  if (brands.includes('brave')) return 'brave';
  if (brands.includes('opera') || /OPR\//.test(ua)) return 'opera';
  if (brands.includes('vivaldi')) return 'vivaldi';
  return 'chrome';
})();

/* ---------------- 中控连接 ---------------- */
const hub = { ws: null, ok: false, seq: 0, waiting: new Map(), readyWaiters: [], lastLaunch: 0, launchError: null };

function connectHub() {
  if (hub.ws && (hub.ws.readyState === WebSocket.CONNECTING || hub.ws.readyState === WebSocket.OPEN)) return;
  let ws;
  try { ws = new WebSocket(HUB_URL); } catch { return; }
  hub.ws = ws;
  ws.onopen = () => {
    hub.ok = true;
    hub.launchError = null;
    ws.send(JSON.stringify({ type: 'hello', role: 'browser', browser: BROWSER, version: chrome.runtime.getManifest().version }));
    hub.readyWaiters.splice(0).forEach(f => f(true));
  };
  ws.onmessage = ev => onHubMessage(ev.data);
  ws.onclose = () => {
    const was = hub.ok;
    hub.ok = false;
    if (hub.ws === ws) hub.ws = null;
    for (const [, w] of hub.waiting) w.reject(new Error('中控已断开'));
    hub.waiting.clear();
    if (was) { // 中控关了：清掉网页里的角标（不显示过期的时间），下次有动作时再自动拉起中控
      chrome.storage.local.set({ fs: null });
      refreshBadge(null);
    }
  };
  ws.onerror = () => {};
}

function waitHub(ms) {
  if (hub.ok) return Promise.resolve(true);
  return new Promise(resolve => {
    const f = ok => { clearTimeout(t); resolve(ok); };
    const t = setTimeout(() => { hub.readyWaiters = hub.readyWaiters.filter(x => x !== f); resolve(false); }, ms);
    hub.readyWaiters.push(f);
  });
}

// 确保中控在运行：先尝试连接；连不上就通过原生消息启动它（20 秒内最多启动一次），再等它就绪
async function ensureHub({ wait = 15000 } = {}) {
  if (hub.ok) return true;
  connectHub();
  if (await waitHub(800)) return true;
  if (now() - hub.lastLaunch > 20000) {
    hub.lastLaunch = now();
    try {
      const r = await chrome.runtime.sendNativeMessage(NATIVE_HOST, { cmd: 'launch' });
      hub.launchError = r?.ok ? null : (r?.error || '中控没有启动');
    } catch {
      // 浏览器里还没有登记启动器（中控从没手动启动过）：不用再等了
      hub.launchError = '没法自动启动中控：请先在电脑上双击一次“启动中控.bat”（中控会自动完成登记），之后扩展就能自动启动它';
      connectHub();
      return waitHub(1500);
    }
  }
  const end = now() + wait;
  while (now() < end) {
    connectHub();
    if (await waitHub(1000)) return true;
  }
  return hub.ok;
}

async function hubCall(method, ...args) {
  if (!hub.ok && !(await ensureHub())) throw new Error(hub.launchError || '中控未运行');
  return new Promise((resolve, reject) => {
    const id = ++hub.seq;
    hub.waiting.set(id, { resolve, reject });
    hub.ws.send(JSON.stringify({ type: 'rpc', id, method, args }));
    setTimeout(() => {
      if (hub.waiting.has(id)) { hub.waiting.delete(id); reject(new Error('中控没有响应')); }
    }, 15000);
  });
}
// 所有规则调用都发给中控
const engine = () => new Proxy({}, { get: (_, method) => (...args) => hubCall(method, ...args) });

async function onHubMessage(data) {
  let msg;
  try { msg = JSON.parse(data); } catch { return; }
  if (msg.type === 'state') {
    await chrome.storage.local.set({ fs: msg.state });
    refreshBadge(msg.state);
    const n = await N(); n.hadFocus = !!msg.state?.focus; await saveN();
  } else if (msg.type === 'reply') {
    const w = hub.waiting.get(msg.id);
    if (!w) return;
    hub.waiting.delete(msg.id);
    if (msg.error) w.reject(new Error(msg.error)); else w.resolve(msg.result);
  } else if (msg.type === 'cmd') {
    let result = null, error = null;
    try {
      if (msg.cmd === 'show') result = await showAt(msg.place, msg.card);
      else if (msg.cmd === 'switchTo') result = await switchToPlace(msg.place);
      else if (msg.cmd === 'activeTab') result = tabPlace(await activeTab());
    } catch (e) { error = String(e?.message || e); }
    hub.ws?.send(JSON.stringify({ type: 'reply', id: msg.id, result, error }));
  }
}

// 做事做到一半中控没了（比如被关掉）：用户一动浏览器就把它拉回来
async function recoverIfNeeded() {
  if (hub.ok) return;
  connectHub();
  const n = await N();
  if (n.hadFocus) ensureHub().catch(() => {});
}

/* ---------------- 会话内的导航状态 ---------------- */
let nav = null, navLoading = null;
function N() {
  if (nav) return Promise.resolve(nav);
  navLoading ||= chrome.storage.session.get('nav').then(({ nav: saved }) => {
    nav = Object.assign({ lastActiveTab: null, prevOf: {}, pending: {}, newTabs: [], tabHost: {}, asked: {}, suppress: {}, hadFocus: false }, saved || {});
    return nav;
  });
  return navLoading;
}
async function saveN() { await chrome.storage.session.set({ nav }); }
const suppressTab = (n, tabId) => { n.suppress[tabId] = now() + 1500; };

async function readState() {
  const { fs } = await chrome.storage.local.get('fs');
  return fs ? E.migrate(JSON.parse(JSON.stringify(fs))) : null;
}

function refreshBadge(s) {
  if (!s || !s.focus) { chrome.action.setBadgeText({ text: '' }); return; }
  const line = E.currentLine(s);
  const ms = line.endsAt - now();
  chrome.action.setBadgeText({ text: ms < 0 ? '!' : String(Math.ceil(ms / 60000)) });
  chrome.action.setBadgeBackgroundColor({ color: s.detours.length ? '#c2410c' : '#1f6f5c' });
}

/* ---------------- 标签页与卡片 ---------------- */
function tabPlace(tab) {
  if (!tab) return null;
  const url = tab.url || tab.pendingUrl || '';
  return { kind: 'tab', tabId: tab.id, host: E.hostOf(url), url, title: tab.title || '', browser: BROWSER };
}
async function activeTab() {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return t || null;
}
async function showCard(tabId, card) {
  if (tabId == null || !card) return false;
  try { await chrome.tabs.sendMessage(tabId, { cmd: 'card', card }); return true; } catch {}
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tabId, { cmd: 'card', card });
    return true;
  } catch { return false; }
}
// place 为标签页时显示在那个标签页，否则显示在当前标签页；都不行时用系统通知
async function showAt(place, card) {
  const tabId = place?.kind === 'tab' ? place.tabId : (await activeTab())?.id;
  if (await showCard(tabId, card)) return true;
  if (place?.kind === 'tab') { const t = await activeTab(); if (t && await showCard(t.id, card)) return true; }
  chrome.notifications.create({
    type: 'basic', iconUrl: 'icons/icon128.png', title: '一事一毕',
    message: card.text || card.title || '请切换到一个普通网页查看提醒'
  });
  return false;
}
async function switchTo(tabId) {
  if (tabId == null) return false;
  const n = await N();
  suppressTab(n, tabId);
  try {
    const t = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(t.windowId, { focused: true });
    n.lastActiveTab = tabId;
    await saveN();
    return true;
  } catch { await saveN(); return false; }
}
const switchToPlace = place => (place?.kind === 'tab' ? switchTo(place.tabId) : Promise.resolve(false));

/* ---------------- 切换检测 ---------------- */
async function evaluate(tabId, via, prevTabId, isNew = false) {
  const s = await readState();
  if (!s?.focus) return;
  if (s.focus.pauseUntil && now() < s.focus.pauseUntil) return;
  const n = await N();
  if (now() < (n.suppress[tabId] || 0)) return;
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return; }
  if (!tab.active) return;
  const place = tabPlace(tab);
  if (!place.host) return;
  n.tabHost[tabId] = place.host;

  if (E.isAllowed(s, place)) {
    await saveN();
    await engine().touch(place).catch(() => {});
    return;
  }
  const line = E.currentLine(s);
  const askKey = `${tabId}|${place.host}|${line.id}`;
  if (n.asked[askKey]) { await saveN(); return; } // 这个页面在这条线里已经问过
  n.asked[askKey] = 1;
  n.pending[tabId] = { host: place.host, via, prevTabId, isNew, lineId: line.id };
  await saveN();
  const info = await engine().recordPrompt(place).catch(() => null);
  if (!info || info.level === 0) return; // 观察档：只记录
  await showCard(tabId, { kind: 'switch', level: info.level, host: place.host, title: tab.title || '', lineTitle: info.lineTitle, onDetour: info.onDetour });
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  recoverIfNeeded();
  const n = await N();
  const prev = n.lastActiveTab;
  if (prev === tabId) return;
  n.lastActiveTab = tabId;
  n.prevOf[tabId] = prev;
  await saveN();
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return; }
  if (tab.status === 'complete') evaluate(tabId, 'activate', prev);
});

chrome.tabs.onCreated.addListener(async t => {
  const n = await N();
  n.newTabs.push(t.id);
  if (n.newTabs.length > 50) n.newTabs.shift();
  await saveN();
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'complete') return;
  const n = await N();
  const host = E.hostOf(tab.url);
  const old = n.tabHost[tabId];
  if (!host || old === host) return;
  n.tabHost[tabId] = host;
  const isNew = old === undefined && n.newTabs.includes(tabId);
  if (isNew) n.newTabs = n.newTabs.filter(id => id !== tabId);
  await saveN();
  if (!tab.active) return;
  evaluate(tabId, 'nav', isNew ? n.prevOf[tabId] : tabId, isNew);
});

chrome.tabs.onRemoved.addListener(async tabId => {
  const n = await N();
  delete n.tabHost[tabId]; delete n.pending[tabId]; delete n.prevOf[tabId];
  await saveN();
});

chrome.windows.onFocusChanged.addListener(async wid => {
  if (wid === chrome.windows.WINDOW_ID_NONE) return;
  recoverIfNeeded();
  const [t] = await chrome.tabs.query({ active: true, windowId: wid });
  if (!t) return;
  const n = await N();
  const prev = n.lastActiveTab;
  if (prev === t.id) return;
  n.lastActiveTab = t.id;
  n.prevOf[t.id] = prev;
  await saveN();
  if (t.status === 'complete') evaluate(t.id, 'window', prev);
});

async function goBack(tabId, p) {
  if (p.via === 'nav') {
    if (p.isNew) { // 新开的标签页：关掉它，回到原来的页面
      const s = await readState();
      const lp = s?.focus && E.currentLine(s).lastPlace;
      const target = p.prevTabId ?? (lp?.kind === 'tab' ? lp.tabId : null);
      if (target != null && target !== tabId) await switchTo(target);
      chrome.tabs.remove(tabId).catch(() => {});
      return;
    }
    const n = await N(); suppressTab(n, tabId); await saveN();
    try { await chrome.tabs.goBack(tabId); return; } catch {}
  }
  if (p.prevTabId != null && await switchTo(p.prevTabId)) return;
  const s = await readState();
  const lp = s?.focus && E.currentLine(s).lastPlace;
  if (lp?.kind === 'tab' && lp.tabId !== tabId) await switchTo(lp.tabId);
}

async function decide(choice, tabId) {
  const n = await N();
  const p = n.pending[tabId];
  if (!p) return { ok: false };
  if (choice === 'detour') return { ok: true }; // 等待岔路登记表单
  delete n.pending[tabId];
  if (choice === 'back' || choice === 'later') delete n.asked[`${tabId}|${p.host}|${p.lineId}`]; // 下次再来还会问
  await saveN();
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const place = tab ? tabPlace(tab) : { kind: 'tab', tabId, host: p.host };
  await engine().decision(choice, place);
  if (choice === 'back' || choice === 'later') await goBack(tabId, p);
  return { ok: true };
}

/* ---------------- 消息 ---------------- */
async function handle(msg, sender) {
  const tabId = sender.tab?.id ?? msg.tabId;
  switch (msg.type) {
    case 'getState': return { state: hub.ok ? await readState() : null, hub: { connected: hub.ok, launchError: hub.launchError } };
    case 'launchHub': return (await ensureHub()) ? { ok: true } : { error: hub.launchError || '中控没有启动' };
    case 'startFocus': {
      const tab = msg.form?.tabId != null ? await chrome.tabs.get(msg.form.tabId).catch(() => null) : await activeTab();
      const r = await engine().startFocus(msg.form, tabPlace(tab));
      if (r.ok) { const n = await N(); n.asked = {}; n.pending = {}; await saveN(); }
      return r;
    }
    case 'decision': return decide(msg.choice, tabId);
    case 'registerDetour': {
      const n = await N();
      const p = n.pending[tabId];
      delete n.pending[tabId];
      await saveN();
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      const place = tabPlace(tab);
      const returnPlace = msg.form.returnPlace || (p ? null : place);
      const r = await engine().registerDetour(msg.form, place, returnPlace);
      if (r.ok && !r.started) {
        if (p) await goBack(tabId, p);
        if (r.toast) await showAt(null, r.toast);
      }
      return r;
    }
    case 'openDetourForm': {
      const tab = msg.tabId != null ? await chrome.tabs.get(msg.tabId).catch(() => null) : await activeTab();
      const card = await engine().detourFormCard(tabPlace(tab));
      if (!card) return { error: '还没有开始一件事' };
      return (await showCard(tab?.id, card)) ? { ok: true } : { error: '这个页面无法显示卡片，请切到一个普通网页再试' };
    }
    case 'offline': {
      if (!sender.tab?.active) return { ok: true };
      const card = await engine().offlineCard(tabPlace(sender.tab));
      if (card) await showCard(tabId, card);
      return { ok: true };
    }
    case 'endDetour': return engine().endDetour(msg.outcome || 'done');
    case 'extendDetour': return engine().extendDetour();
    case 'focusAction': return engine().focusAction(msg.action, msg.title);
    case 'restore': return engine().restore(msg.timeboxMin);
    case 'discardSuspended': return engine().discardSuspended();
    case 'pause': return engine().pause();
    case 'listAction': return engine().listAction(msg);
    case 'labelSwitch': return engine().labelSwitch(msg);
    case 'forget': return engine().forget(msg);
    default: return { error: 'unknown message' };
  }
}
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  handle(msg, sender).then(reply, e => reply({ error: String(e?.message || e) }));
  return true;
});

chrome.alarms.onAlarm.addListener(async a => {
  if (a.name === 'hub') return recoverIfNeeded();
  if (a.name === 'tick') return refreshBadge(hub.ok ? await readState() : null);
  // 扩展不再自己计时：旧版留下的 focus / detour 计时器直接清掉
  chrome.alarms.clear(a.name);
});

chrome.commands.onCommand.addListener(cmd => {
  if (cmd === 'log-detour') handle({ type: 'openDetourForm' }, {});
});

async function boot() {
  chrome.alarms.create('hub', { periodInMinutes: 0.5 });
  chrome.alarms.create('tick', { periodInMinutes: 1 });
  const old = await chrome.alarms.getAll(); // 旧版（单机模式）的计时器
  await Promise.all(old.filter(a => a.name === 'focus' || a.name.startsWith('detour:')).map(a => chrome.alarms.clear(a.name)));
  await chrome.storage.local.set({ fs: null }); // 状态只以中控为准，连上后中控会发过来
  refreshBadge(null);
  ensureHub().catch(() => {}); // 浏览器启动时把中控也拉起来
}
chrome.runtime.onStartup.addListener(boot);
chrome.runtime.onInstalled.addListener(boot);
connectHub();
