// 中控核心测试：不需要 Electron。用假的前台窗口事件和一个模拟浏览器扩展的 WebSocket 客户端。
// 运行：npm test
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { createCore } = require('../src/core');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0;
async function step(name, fn) {
  try { await fn(); passed++; console.log('PASS', name); }
  catch (e) { console.log('FAIL', name, '\n  ', e.message); process.exitCode = 1; }
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-hub-'));
  const cards = [];
  const activated = [];
  const minimized = [];
  const core = createCore({
    statePath: path.join(dir, 'state.json'),
    port: 47399,
    log: () => {},
    activate: async place => { activated.push(place); return true; },
    minimize: async place => { minimized.push(place); return true; },
    engineOptions: { distractDwellMs: 1500 }, // 测试里把“分心”阈值从 2 分钟缩短到 1.5 秒
    ui: { showCard: card => { cards.push(card); return true; }, pushState: () => {} }
  });
  const win = (app, hwnd, title = '') => core.onForeground({ app, hwnd, pid: hwnd * 10, title });
  const lastCard = () => cards.at(-1);
  const S = () => core.engine.getState();

  await step('在 Word 里开始一件事，Word 自动算作这件事的应用', async () => {
    win('WINWORD', 1, '报告.docx - Word');
    await sleep(50);
    const r = await core.handleUi({ type: 'startFocus', form: { title: '写报告第 3 节', timeboxMin: 50, level: 2 } });
    assert.ok(r.ok, JSON.stringify(r));
    const s = await S();
    assert.deepStrictEqual(s.focus.apps, ['winword']);
  });

  await step('切到微信 → 弹出“这一步属于主线吗”', async () => {
    win('WeChat', 2, '微信');
    await sleep(900);
    const c = lastCard();
    assert.strictEqual(c?.kind, 'switch');
    assert.strictEqual(c.host, '微信');
    assert.strictEqual(c.verb, '切换到');
  });

  await step('选“返回” → 微信被最小化、切回 Word，偏离 +1', async () => {
    await core.handleUi({ type: 'decision', choice: 'back' });
    assert.strictEqual(minimized.at(-1).app, 'wechat');
    assert.strictEqual(activated.at(-1).app, 'winword');
    assert.strictEqual((await S()).focus.stats.offTrack, 1);
  });

  await step('“返回”没能切走（微信还在前台）→ 回到微信时再次提问', async () => {
    // 模拟：切回失败，前台仍是微信。先是中控自己的卡片窗口在前台，卡片关掉后回到微信
    win('WINWORD', 1); await sleep(900);
    win('WeChat', 2); await sleep(900);
    const n = cards.length;
    assert.strictEqual(lastCard().kind, 'switch');
    core.onForeground({ app: 'electron', hwnd: 99, pid: 1, self: true });
    await core.handleUi({ type: 'decision', choice: 'back' });
    win('WeChat', 2); await sleep(900);
    assert.strictEqual(cards.length, n + 1, '应该再弹一次');
    assert.strictEqual(lastCard().kind, 'switch');
    core.onForeground({ app: 'electron', hwnd: 99, pid: 1, self: true });
    await core.handleUi({ type: 'decision', choice: 'back' });
    win('WINWORD', 1); await sleep(900);
  });

  await step('按过“返回”之后再打开同一个应用，照样提问', async () => {
    const n = cards.length;
    win('WeChat', 2); await sleep(900);
    assert.strictEqual(cards.length, n + 1);
    core.onForeground({ app: 'electron', hwnd: 99, pid: 1, self: true });
    await core.handleUi({ type: 'decision', choice: 'back' });
    win('WINWORD', 1); await sleep(900);
  });

  await step('Alt+Tab 一闪而过（不到 0.7 秒）不提问', async () => {
    const n = cards.length;
    win('spotify', 3); await sleep(200); win('WINWORD', 1); await sleep(900);
    assert.strictEqual(cards.length, n);
  });

  await step('切到资源管理器/桌面不提问', async () => {
    const n = cards.length;
    win('explorer', 4); await sleep(900);
    assert.strictEqual(cards.length, n);
  });

  await step('切到微信 → 这是突发情况 → 登记“回消息”（紧急不重要），微信在岔路里放行', async () => {
    win('WeChat', 2); await sleep(900);
    assert.strictEqual(lastCard().kind, 'switch');
    await core.handleUi({ type: 'decision', choice: 'detour' });
    const r = await core.handleUi({ type: 'registerDetour', form: { reason: '消息', title: '回导师消息', urgent: true, important: false, timeboxMin: 5, note: '写到 3.2' } });
    assert.ok(r.started, JSON.stringify(r));
    const s = await S();
    assert.strictEqual(s.detours[0].returnPlace.app, 'winword');
    assert.ok(s.detours[0].apps.includes('wechat'));
  });

  await step('岔路里切回 Word 不提问（回主线总是可以的）', async () => {
    const n = cards.length;
    win('WINWORD', 1); await sleep(900);
    win('WeChat', 2); await sleep(900);
    assert.strictEqual(cards.length, n);
  });

  await step('岔路完成 → 切回 Word 并显示断点', async () => {
    await core.handleUi({ type: 'endDetour', outcome: 'done' });
    assert.strictEqual(activated.at(-1).app, 'winword');
    assert.strictEqual(lastCard().kind, 'return');
    assert.strictEqual(lastCard().note, '写到 3.2');
  });

  // ---------- 浏览器扩展 ----------
  const ext = new WebSocket('ws://127.0.0.1:47399', { origin: 'chrome-extension://abc' });
  const extInbox = [];
  let tabCmds = [];
  ext.on('message', raw => {
    const m = JSON.parse(raw);
    extInbox.push(m);
    if (m.type === 'cmd') {
      tabCmds.push(m);
      const result = m.cmd === 'activeTab' ? { kind: 'tab', tabId: 7, host: 'overleaf.com', url: 'https://overleaf.com/x', title: 'Overleaf' } : true;
      ext.send(JSON.stringify({ type: 'reply', id: m.id, result }));
    }
  });
  await new Promise(r => ext.on('open', r));
  ext.send(JSON.stringify({ type: 'hello', role: 'browser', browser: 'chrome', version: 'test' }));
  await sleep(100);
  let seq = 0;
  const rpc = (method, ...args) => new Promise(resolve => {
    const id = ++seq;
    const h = raw => { const m = JSON.parse(raw); if (m.type === 'reply' && m.id === id) { ext.off('message', h); resolve(m); } };
    ext.on('message', h);
    ext.send(JSON.stringify({ type: 'rpc', id, method, args }));
  });

  await step('扩展连上后收到当前状态', async () => {
    const st = extInbox.find(m => m.type === 'state');
    assert.strictEqual(st?.state?.focus?.title, '写报告第 3 节');
  });

  await step('普通网页不能连中控（Origin 检查）', async () => {
    const bad = new WebSocket('ws://127.0.0.1:47399', { origin: 'https://evil.example' });
    const res = await new Promise(r => { bad.on('open', () => r('open')); bad.on('error', () => r('refused')); });
    assert.strictEqual(res, 'refused');
  });

  await step('扩展连着时，切到 Chrome 由扩展按网站判断，中控不弹卡', async () => {
    const n = cards.length;
    win('chrome', 5, 'Overleaf - Google Chrome'); await sleep(900);
    assert.strictEqual(cards.length, n);
  });

  await step('扩展通过 RPC 放行一个网站，中控状态同步', async () => {
    const m = await rpc('decision', 'pass', { kind: 'tab', tabId: 7, host: 'overleaf.com', url: 'https://overleaf.com/x' });
    assert.ok(m.result.ok, JSON.stringify(m));
    assert.ok((await S()).focus.allowed.includes('overleaf.com'));
  });

  await step('浏览器在前台时，“被打断”把登记表显示到网页里', async () => {
    tabCmds = [];
    await core.handleUi({ type: 'openDetourForm' });
    const show = tabCmds.find(c => c.cmd === 'show');
    assert.strictEqual(show?.card?.kind, 'detour-form');
    assert.strictEqual(show.card.returnPlace.tabId, 7);
  });

  await step('不允许的 RPC 被拒绝', async () => {
    const m = await rpc('adopt', {});
    assert.ok(m.error);
  });

  await step('主线时间到 + 重要且紧急岔路 → 置换；2 小时内第二次不置换', async () => {
    win('WINWORD', 1); await sleep(900);
    await core.handleUi({ type: 'registerDetour', form: { reason: '网络', urgent: true, important: true, timeboxMin: 5 } });
    await core.engine.onAlarm('focus');
    let s = await S();
    assert.strictEqual(s.focus.title, '修网络');
    assert.strictEqual(s.suspended.length, 1);
    await core.handleUi({ type: 'registerDetour', form: { reason: '报错', title: '修驱动', urgent: true, important: true, timeboxMin: 5 } });
    await core.engine.onAlarm('focus');
    s = await S();
    assert.strictEqual(s.focus.title, '修网络');
    assert.ok(s.focus.wrapPending);
    assert.ok(/置换额度已用完/.test(cards.at(-1).text));
  });

  await step('断网 → 弹出“修网络”岔路登记（已有网络岔路时不重复）', async () => {
    await core.handleUi({ type: 'endDetour' });
    await core.handleUi({ type: 'focusAction', action: 'abandon' });
    await core.handleUi({ type: 'discardSuspended' });
    win('WINWORD', 1); await sleep(50);
    await core.handleUi({ type: 'startFocus', form: { title: '再写一节', timeboxMin: 25, level: 1 } });
    const n = cards.length;
    await core.onOffline();
    assert.strictEqual(cards.length, n + 1);
    assert.strictEqual(lastCard().kind, 'detour-form');
    assert.ok(lastCard().offline);
  });

  await step('四类切换：必要 / 突发情况 / 拦下的分心 / 分心（按停留时长预判）', async () => {
    await core.handleUi({ type: 'focusAction', action: 'abandon' });
    win('WINWORD', 1); await sleep(900);
    await core.handleUi({ type: 'startFocus', form: { title: '写文献综述', timeboxMin: 25, level: 1 } });
    // QQ：轻提示没回答，停留 2.5 秒 → 预判分心
    win('QQ', 6); await sleep(900);
    await core.handleUi({ type: 'decision', choice: 'ignored' });
    await sleep(2500);
    win('WINWORD', 1); await sleep(900);
    // Zotero：没回答，马上回来 → 预判必要
    win('zotero', 7); await sleep(900);
    await core.handleUi({ type: 'decision', choice: 'ignored' });
    win('WINWORD', 1); await sleep(900);
    // Excel：点了“属于” → 必要
    win('EXCEL', 8); await sleep(900);
    await core.handleUi({ type: 'decision', choice: 'pass' });
    win('WINWORD', 1); await sleep(900);
    // Spotify：点了“返回” → 拦下的分心
    win('spotify', 9); await sleep(900);
    await core.handleUi({ type: 'decision', choice: 'back' });
    win('WINWORD', 1); await sleep(900);
    // 微信：登记为岔路 → 突发情况
    win('WeChat', 2); await sleep(900);
    await core.handleUi({ type: 'decision', choice: 'detour' });
    await core.handleUi({ type: 'registerDetour', form: { reason: '消息', urgent: true, important: false, timeboxMin: 5 } });
    await core.handleUi({ type: 'endDetour' });
    await core.handleUi({ type: 'focusAction', action: 'done' });
    const c = lastCard();
    assert.strictEqual(c.kind, 'summary');
    assert.deepStrictEqual(c.summary.breakdown, { needed: 2, detour: 1, caught: 1, distracted: 1 }, JSON.stringify(c.summary.breakdown));
    const names = c.summary.review.map(r => [r.label, r.guess]);
    assert.deepStrictEqual(names, [['QQ', 'distracted'], ['Zotero', 'needed']], JSON.stringify(names));
  });

  await step('小结里把 QQ 改标为必要并“记住” → 计数更新，下次做同名的事自动放行 QQ', async () => {
    const sum = lastCard().summary;
    const qq = sum.review.find(r => r.label === 'QQ');
    const r = await core.handleUi({ type: 'labelSwitch', focusId: sum.focusId, switchId: qq.id, verdict: 'needed', remember: true });
    assert.ok(r.ok && r.remembered, JSON.stringify(r));
    assert.deepStrictEqual(r.breakdown, { needed: 3, detour: 1, caught: 1, distracted: 0 });
    win('WINWORD', 1); await sleep(900);
    await core.handleUi({ type: 'startFocus', form: { title: '写文献综述', timeboxMin: 25, level: 1 } });
    assert.ok((await S()).focus.apps.includes('qq'));
    const n = cards.length;
    win('QQ', 6); await sleep(900);
    assert.strictEqual(cards.length, n, '记住之后不应再提问');
    await core.handleUi({ type: 'forget', title: '写文献综述', kind: 'app', name: 'qq' });
    assert.ok(!(await S()).remember['写文献综述']);
  });

  await step('状态写在文件里，重启中控后还在', async () => {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    assert.strictEqual(raw.focus.title, '写文献综述');
    assert.ok(!JSON.stringify(raw).includes('报告.docx'), '不应保存窗口标题');
  });

  await step('Chrome 和 Edge 同时连接：状态同步给两边，卡片只发给在前台的那个浏览器', async () => {
    const edge = new WebSocket('ws://127.0.0.1:47399', { origin: 'chrome-extension://abc' });
    const edgeCmds = [], edgeStates = [];
    edge.on('message', raw => {
      const m = JSON.parse(raw);
      if (m.type === 'state') edgeStates.push(m.state);
      if (m.type === 'cmd') {
        edgeCmds.push(m);
        const result = m.cmd === 'activeTab' ? { kind: 'tab', tabId: 99, host: 'bing.com', url: 'https://bing.com/', title: 'Bing' } : true;
        edge.send(JSON.stringify({ type: 'reply', id: m.id, result }));
      }
    });
    await new Promise(r => edge.on('open', r));
    edge.send(JSON.stringify({ type: 'hello', role: 'browser', browser: 'msedge', version: 'test' }));
    await sleep(150);
    assert.deepStrictEqual(core.status().browsers.sort(), ['chrome', 'msedge']);
    assert.ok(edgeStates.length >= 1, 'Edge 连上后应收到状态');
    // Edge 在前台 → 登记表发给 Edge，不发给 Chrome
    tabCmds = [];
    win('msedge', 31, 'Bing - Microsoft Edge'); await sleep(50);
    await core.handleUi({ type: 'openDetourForm' });
    const toEdge = edgeCmds.find(c => c.cmd === 'show');
    assert.strictEqual(toEdge?.card?.kind, 'detour-form');
    assert.strictEqual(toEdge.card.returnPlace.browser, 'msedge');
    assert.ok(!tabCmds.some(c => c.cmd === 'show'), 'Chrome 不应收到卡片');
    // 状态变化两边都收到（只有一个时钟、一条主线）
    const before = edgeStates.length;
    await core.handleUi({ type: 'pause' });
    await sleep(100);
    assert.ok(edgeStates.length > before);
    edge.close();
    await sleep(100);
    assert.deepStrictEqual(core.status().browsers, ['chrome']);
  });

  ext.close();
  core.close();
  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
  process.exit(process.exitCode || 0);
})();
