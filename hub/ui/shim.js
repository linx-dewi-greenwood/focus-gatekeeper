// 让浏览器扩展的界面代码（content.js、popup.js）不改动就能在中控窗口里运行：
// 用中控的 IPC 模拟它们用到的那一小部分 chrome.* 接口。
(function () {
  const mode = document.documentElement.dataset.mode; // card | badge | panel
  const B = window.hubBridge;
  const msgListeners = [];
  const storageListeners = [];

  B.onCard(card => msgListeners.forEach(fn => fn({ cmd: 'card', card }, {}, () => {})));
  B.onState(state => {
    storageListeners.forEach(fn => fn({ fs: { newValue: state } }, 'local'));
    if (mode === 'panel') maybeReloadPanel(state);
  });

  const fakeChrome = {
    runtime: {
      sendMessage: msg => B.send(msg),
      onMessage: { addListener: fn => msgListeners.push(fn) },
      getManifest: () => ({ version: 'hub' })
    },
    storage: {
      local: {
        get: async () => ({ fs: (await B.send({ type: 'getState' })).state, fsUi: {} }),
        set: async () => {}
      },
      onChanged: { addListener: fn => storageListeners.push(fn) }
    },
    tabs: { query: async () => [] }
  };
  try { Object.defineProperty(window, 'chrome', { value: fakeChrome, configurable: true, writable: true }); }
  catch { window.chrome = fakeChrome; }

  if (mode === 'card' || mode === 'badge') {
    window.__focusShieldMode = mode;
    window.__focusShieldLayout = info => B.layout(info);
  }

  // 控制面板：只有“结构”变化（开始/结束、岔路增减、清单增减）时才重新渲染，避免打字时被刷掉
  let sig = null;
  function signature(s) {
    if (!s) return 'none';
    return JSON.stringify([s.focus?.id, s.focus?.extended, s.focus?.pauseUntil, (s.detours || []).map(d => d.id + d.endsAt),
      (s.suspended || []).length, (s.later || []).length, (s.parked || []).length, (s.nextUp || []).length]);
  }
  function maybeReloadPanel(state) {
    const next = signature(state);
    if (next !== sig) { sig = next; if (typeof window.load === 'function') window.load(); }
  }
  if (mode === 'panel') {
    window.__focusHub = true;
    window.close = () => B.hidePanel();
    B.onRefresh(() => { if (typeof window.load === 'function') window.load(); });
  }
})();
