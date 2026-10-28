// 一事一毕 · 页面内的角标与卡片（Shadow DOM，不受网页样式影响）
(() => {
  if (window.__focusShieldInjected) return;
  window.__focusShieldInjected = true;

  const QUAD = {
    IU: { name: '重要且紧急', tip: '立即开始。主线时间到时，它会置换为新主线。' },
    UNI: { name: '紧急不重要', tip: '立即开始，做完回到主线。主线不变。' },
    INU: { name: '重要不紧急', tip: '默认搁置，以主线为准；主线收尾时会提醒你。' },
    NUNI: { name: '不紧急不重要', tip: '存入稍后清单，以主线为准。' }
  };
  const REASONS = ['网络', '报错', '找资料', '消息', '其他'];
  const REASON_TITLE = { 网络: '修网络', 报错: '修报错', 找资料: '找资料', 消息: '回消息', 其他: '' };
  const SWAP_WINDOW_MS = 2 * 60 * 60 * 1000;
  const STRICT_PHRASE = '我确定现在要看';

  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif; }
  .badge { position: fixed; right: 16px; bottom: 16px; display: flex; align-items: center; gap: 8px; max-width: min(560px, calc(100vw - 32px));
    background: #1d2321; color: #f4f1ea; border-radius: 999px; padding: 7px 8px 7px 14px; font-size: 13px; line-height: 1.2;
    box-shadow: 0 6px 24px rgba(0,0,0,.22); pointer-events: auto; }
  .badge.detour { background: #3a2418; }
  .badge .tag { font-size: 11px; padding: 2px 7px; border-radius: 999px; background: #1f6f5c; color: #fff; white-space: nowrap; }
  .badge.detour .tag { background: #c2410c; }
  .badge .ttl { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 240px; }
  .badge .sub { color: #b9b3a6; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 140px; }
  .badge .time { font-variant-numeric: tabular-nums; font-weight: 600; }
  .badge .time.over { color: #fb923c; }
  .badge button { all: unset; cursor: pointer; font-size: 12px; padding: 4px 9px; border-radius: 999px; background: rgba(255,255,255,.1); color: #f4f1ea; white-space: nowrap; }
  .badge button:hover { background: rgba(255,255,255,.2); }
  .badge.mini { padding: 6px 10px; cursor: pointer; }
  .overlay { position: fixed; inset: 0; background: rgba(20,24,22,.55); backdrop-filter: blur(3px); display: flex; align-items: center; justify-content: center; pointer-events: auto; padding: 16px; }
  .card { background: #fbfaf6; color: #1d2321; border-radius: 14px; width: min(460px, 100%); padding: 20px 22px; box-shadow: 0 18px 50px rgba(0,0,0,.28); font-size: 14px; line-height: 1.55; pointer-events: auto; max-height: calc(100vh - 32px); overflow: auto; }
  .card.corner { position: fixed; right: 16px; bottom: 64px; width: min(360px, calc(100vw - 32px)); padding: 16px 18px; }
  .eyebrow { font-size: 12px; color: #6b6558; letter-spacing: .04em; margin-bottom: 4px; }
  h2 { font-size: 18px; margin: 0 0 6px; font-weight: 650; }
  .card.corner h2 { font-size: 15px; }
  h2 em { font-style: normal; color: #1f6f5c; }
  p { margin: 6px 0; }
  .muted { color: #6b6558; font-size: 13px; word-break: break-all; }
  .note { background: #f1eee4; border-radius: 8px; padding: 8px 10px; margin: 10px 0; font-size: 13px; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
  .btn { all: unset; cursor: pointer; padding: 8px 13px; border-radius: 8px; border: 1px solid #d6d2c6; background: #fff; color: #1d2321; font-size: 13px; }
  .btn:hover { border-color: #9c968a; }
  .btn.primary { background: #1f6f5c; border-color: #1f6f5c; color: #fff; }
  .btn.warn { background: #c2410c; border-color: #c2410c; color: #fff; }
  .btn[disabled] { opacity: .45; pointer-events: none; }
  .btn:focus-visible { outline: 2px solid #1f6f5c; outline-offset: 2px; }
  .link { all: unset; cursor: pointer; color: #6b6558; font-size: 12px; text-decoration: underline; margin-top: 10px; display: inline-block; }
  label.f { display: block; font-size: 12px; color: #6b6558; margin: 12px 0 5px; }
  input[type=text], input[type=number], textarea { width: 100%; border: 1px solid #d6d2c6; border-radius: 8px; padding: 8px 10px; font-size: 14px; background: #fff; color: #1d2321; }
  textarea { resize: vertical; min-height: 54px; }
  input:focus, textarea:focus { outline: 2px solid #1f6f5c; outline-offset: -1px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { all: unset; cursor: pointer; padding: 5px 11px; border-radius: 999px; border: 1px solid #d6d2c6; font-size: 13px; background: #fff; }
  .chip.on { background: #1d2321; color: #fff; border-color: #1d2321; }
  .q { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 10px; font-size: 14px; }
  .quad { margin-top: 12px; border-radius: 10px; padding: 10px 12px; border: 1px solid #d6d2c6; background: #fff; font-size: 13px; }
  .quad b { display: inline-block; margin-right: 6px; padding: 1px 8px; border-radius: 999px; color: #fff; font-size: 12px; font-weight: 600; }
  .q-IU b { background: #b42318; } .q-UNI b { background: #c2410c; } .q-INU b { background: #1f6f5c; } .q-NUNI b { background: #6b7280; }
  .err { color: #b42318; font-size: 13px; margin-top: 8px; }
  .row { display: flex; gap: 10px; align-items: center; }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 12px 0; }
  .stat { background: #f1eee4; border-radius: 8px; padding: 8px; text-align: center; }
  .stat .v { font-size: 18px; font-weight: 650; font-variant-numeric: tabular-nums; }
  .stat .k { font-size: 11px; color: #6b6558; }
  .list { margin: 6px 0 0; padding: 0; list-style: none; }
  .list li { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px; padding: 6px 0; border-top: 1px solid #ebe7dc; font-size: 13px; }
  .list li .full { flex-basis: 100%; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 12px; color: #6b6558; }
  .seg { display: flex; gap: 4px; margin-left: auto; }
  .err:empty { display: none; }
  .seg .chip { padding: 3px 10px; font-size: 12px; }
  .stat .v.good { color: #1f6f5c; } .stat .v.bad { color: #c2410c; }
  .bar { height: 3px; background: #1f6f5c; border-radius: 3px; margin-top: 12px; transform-origin: left; }
  /* 在中控的置顶窗口里运行时：窗口大小贴合卡片/角标 */
  /* 中控卡片窗口：窗口和卡片一样大（不再盖满屏幕），卡片贴着窗口左上角 8px */
  :host([data-mode=card]) .card.inwin { position: fixed; left: 8px; top: 8px; box-shadow: 0 4px 16px rgba(0,0,0,.25); }
  :host([data-mode=card]) .card.inwin.modal { width: 460px; border: 2px solid #1f6f5c; }
  :host([data-mode=card]) .card.inwin.side { width: 360px; padding: 16px 18px; }
  :host([data-mode=badge]) .badge { right: 6px; bottom: 6px; max-width: none; }
  `;

  const hostEl = document.createElement('div');
  hostEl.id = 'focus-shield-root';
  hostEl.setAttribute('style', 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;');
  // 'page'：普通网页；'card' / 'badge'：中控的置顶卡片窗口 / 角标窗口
  const MODE = window.__focusShieldMode || 'page';
  hostEl.setAttribute('data-mode', MODE);
  const layout = info => { try { window.__focusShieldLayout?.(info); } catch {} };
  const root = hostEl.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = CSS;
  const $badge = document.createElement('div');
  const $layer = document.createElement('div');
  root.append(style, $badge, $layer);
  (document.documentElement || document.body).appendChild(hostEl);

  let state = null;
  let ui = { collapsed: false };

  function send(msg) {
    try { return chrome.runtime.sendMessage(msg).catch(e => ({ error: String(e) })); }
    catch (e) { return Promise.resolve({ error: '扩展已更新，请刷新本页' }); }
  }
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const c of kids.flat()) {
      if (c == null || c === false) continue;
      el.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  // append / replaceChildren 遇到 null 会显示成文字 "null"，统一过滤掉
  const keep = kids => kids.flat().filter(k => k != null && k !== false);
  const add = (el, ...kids) => el.append(...keep(kids));
  function fmt(ms) {
    const neg = ms < 0;
    const t = Math.floor(Math.abs(ms) / 1000);
    return (neg ? '+' : '') + String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
  }
  const clock = t => new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const currentLine = () => state?.detours?.at(-1) || state?.focus;

  /* ---------- 角标 ---------- */
  let $time = null;
  function renderBadge() {
    $badge.replaceChildren();
    $time = null;
    if (MODE === 'card') return;
    if (!state || !state.focus) { if (MODE === 'badge') layout({ type: 'badge', visible: false }); return; }
    const f = state.focus, ds = state.detours || [];
    const line = currentLine();
    const onDetour = ds.length > 0;
    if (ui.collapsed) {
      $time = h('span', { class: 'time' });
      $badge.append(h('div', { class: 'badge mini' + (onDetour ? ' detour' : ''), title: '展开', onclick: () => setUi({ collapsed: false }) }, $time));
      tick();
      reportBadge();
      return;
    }
    $time = h('span', { class: 'time' });
    const kids = [
      h('span', { class: 'tag' }, onDetour ? `岔路 ${ds.length}/3` : '主线'),
      h('span', { class: 'ttl', title: line.title }, line.title),
      onDetour ? h('span', { class: 'sub', title: f.title }, '← ' + (ds.length > 1 ? ds.at(-2).title : f.title)) : null,
      $time,
      h('button', { onclick: () => (MODE === 'badge' ? send({ type: 'openDetourForm' }) : detourForm({ lineTitle: line.title })) }, '被打断'),
      onDetour ? h('button', { onclick: () => send({ type: 'endDetour', outcome: 'done' }) }, '岔路完成') : null,
      h('button', { title: '收起', onclick: () => setUi({ collapsed: true }) }, '–')
    ];
    $badge.append(h('div', { class: 'badge' + (onDetour ? ' detour' : '') }, kids));
    tick();
    reportBadge();
  }
  function reportBadge() {
    if (MODE !== 'badge') return;
    setTimeout(() => { // 隐藏的窗口里 requestAnimationFrame 不触发，用 setTimeout
      const el = $badge.firstElementChild;
      if (!el) return;
      const r = el.getBoundingClientRect();
      layout({ type: 'badge', visible: true, w: Math.ceil(r.width) + 12, h: Math.ceil(r.height) + 12 });
    });
  }
  function tick() {
    if (!$time || !state?.focus) return;
    const left = currentLine().endsAt - Date.now();
    $time.textContent = fmt(left);
    $time.classList.toggle('over', left < 0);
    if (state.focus.pauseUntil > Date.now()) $time.textContent += ' · 暂停中';
  }
  function setUi(patch) {
    ui = Object.assign({}, ui, patch);
    chrome.storage.local.set({ fsUi: ui }).catch(() => {});
    renderBadge();
  }
  chrome.storage.local.get(['fs', 'fsUi']).then(r => {
    state = r.fs || null;
    ui = Object.assign(ui, r.fsUi || {});
    renderBadge();
  }).catch(() => {});
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    if (ch.fs) state = ch.fs.newValue || null;
    if (ch.fsUi) ui = Object.assign({}, ui, ch.fsUi.newValue || {});
    if (ch.fs || ch.fsUi) renderBadge();
  });
  setInterval(tick, 1000);

  /* ---------- 卡片容器 ---------- */
  let cleanup = [];
  // 注意：silent 必须严格是 true 才不通知中控。以前按钮直接写 onclick: clearCard，
  // 点击事件被当成 silent 传进来，导致中控窗口没被隐藏，留下一层看不见的窗口挡住其他程序。
  function clearCard(silent) {
    silent = silent === true;
    cleanup.forEach(fn => fn());
    cleanup = [];
    $layer.replaceChildren();
    if (!silent && MODE === 'card') layout({ type: 'card', visible: false });
  }
  // onEscape：按 Esc（或 outside=true 时点卡片外面）做什么。每张卡片都必须能被关掉，
  // 这样中控的全屏卡片窗口出任何问题时，用户都不会被困住。
  function mount(card, modal, onEscape = () => clearCard(), outside = false) {
    clearCard(true);
    if (MODE === 'card') {
      // 中控里：不用全屏遮罩。窗口只和卡片一样大，modal 的卡片由中控放在屏幕中间并抢焦点
      card.classList.add('inwin', modal ? 'modal' : 'side');
      card.style.maxHeight = 'none';
      $layer.append(card);
    } else if (modal) {
      const ov = h('div', { class: 'overlay' }, card);
      if (outside) ov.addEventListener('click', e => { if (e.target === ov) onEscape(); });
      $layer.append(ov);
    } else { card.classList.add('corner'); $layer.append(card); }
    if (modal || MODE === 'card') { // 网页里的角落小卡片不抢 Esc，免得影响网页本身
      const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); onEscape(); } };
      window.addEventListener('keydown', onKey, true);
      cleanup.push(() => window.removeEventListener('keydown', onKey, true));
    }
    if (MODE === 'card') {
      // 量出卡片的自然大小再让中控显示窗口；中控会把高度限制在屏幕内，之后卡片在窗口里滚动
      setTimeout(() => {
        if (!card.isConnected) return;
        const r = card.getBoundingClientRect();
        card.style.maxHeight = 'calc(100vh - 16px)';
        layout({ type: 'card', visible: true, modal, kind: card.dataset.card, w: Math.ceil(r.width) + 16, h: Math.ceil(r.height) + 16 });
      });
    }
  }
  // 按钮发出请求后关掉这张卡片——但如果中控已经在这个窗口换上了新卡片（回程卡、小结等），就不要误关新卡片
  const clearIf = card => { if (card.isConnected) clearCard(); };
  const later = (fn, ms) => { const t = setTimeout(fn, ms); cleanup.push(() => clearTimeout(t)); };
  const every = (fn, ms) => { const t = setInterval(fn, ms); cleanup.push(() => clearInterval(t)); };

  /* ---------- 切换提问 ---------- */
  function switchCard(c) {
    const lvl = c.level;
    const decide = choice => { clearCard(); send({ type: 'decision', choice }); };
    const card = h('div', { class: 'card', 'data-card': 'switch' });
    add(card, 
      h('div', { class: 'eyebrow' }, c.onDetour ? '你正在岔路上' : '你正在主线上'),
      h('h2', {}, '这一步属于「', h('em', {}, c.lineTitle), '」吗？'),
      h('p', { class: 'muted' }, c.verb || '正在打开', ' ', h('b', {}, c.host), c.title ? ` · ${c.title}` : '')
    );
    const back = h('button', { class: 'btn' + (lvl === 3 ? ' primary' : ''), 'data-act': 'back', onclick: () => decide('back') }, '返回');
    const pass = h('button', { class: 'btn' + (lvl === 3 ? '' : ' primary'), 'data-act': 'pass', onclick: () => decide('pass') }, '属于，继续');
    const detour = h('button', { class: 'btn', 'data-act': 'detour', onclick: () => { send({ type: 'decision', choice: 'detour' }); detourForm({ lineTitle: c.lineTitle, fromSwitch: c }); } }, '这是突发情况');
    const laterBtn = h('button', { class: 'btn', 'data-act': 'later', onclick: () => decide('later') }, '记到稍后');

    if (lvl === 3) {
      // 严格档：默认返回；放行需要输入确认句并等待 30 秒
      const wrap = h('div');
      const reveal = h('button', { class: 'link', onclick: () => { reveal.remove(); wrap.append(strictBox()); } }, '我确定现在要看…');
      wrap.append(reveal);
      function strictBox() {
        let left = 30;
        const input = h('input', { type: 'text', placeholder: `输入：${STRICT_PHRASE}` });
        const ok = h('button', { class: 'btn', disabled: true, 'data-act': 'strict-pass', onclick: () => decide('pass') }, `放行（${left}）`);
        const refresh = () => {
          const typed = input.value.trim() === STRICT_PHRASE;
          ok.textContent = left > 0 ? `放行（${left}）` : '放行';
          if (typed && left <= 0) ok.removeAttribute('disabled'); else ok.setAttribute('disabled', '');
        };
        input.addEventListener('input', refresh);
        every(() => { left = Math.max(0, left - 1); refresh(); }, 1000);
        return h('div', {}, h('label', { class: 'f' }, '输入确认句并等待 30 秒'), h('div', { class: 'row' }, input, ok));
      }
      add(card, h('div', { class: 'actions' }, back, detour, laterBtn), wrap);
      mount(card, true, () => decide('back'));
      back.focus();
      return;
    }
    add(card, h('div', { class: 'actions' }, pass, detour, laterBtn, back));
    if (lvl === 1) {
      // 轻提示：角落小卡片，3 秒后消失（鼠标悬停时不消失）
      const bar = h('div', { class: 'bar' });
      add(card, bar);
      mount(card, false, () => decide('ignored')); // 先挂载（挂载会清掉上一张卡的计时器），再开始计时
      bar.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], { duration: 3000, fill: 'forwards' });
      const timer = setTimeout(() => decide('ignored'), 3000);
      cleanup.push(() => clearTimeout(timer));
      card.addEventListener('mouseenter', () => { clearTimeout(timer); bar.remove(); }, { once: true });
      return;
    }
    mount(card, true, () => decide('back')); // 坚定档：必须选一项（Esc 等于“返回”）
  }

  /* ---------- 登记岔路（含四象限） ---------- */
  function detourForm(c) {
    const preset = c.preset || {};
    const st = {
      reason: preset.reason || '', title: preset.title || '',
      urgent: preset.urgent ?? null, important: preset.important ?? null,
      timeboxMin: 5, note: '', doNow: false
    };
    let titleTouched = !!preset.title;
    const card = h('div', { class: 'card', 'data-card': 'detour-form' });
    const err = h('div', { class: 'err' });

    const reasonChips = h('div', { class: 'chips' });
    const titleIn = h('input', { type: 'text', placeholder: '这条岔路要做什么？例如：修网络', value: st.title });
    titleIn.addEventListener('input', () => { st.title = titleIn.value; titleTouched = true; });
    const yn = key => {
      const box = h('div', { class: 'chips' });
      const draw = () => {
        box.replaceChildren(
          h('button', { class: 'chip' + (st[key] === true ? ' on' : ''), 'data-yn': key + '-yes', onclick: () => { st[key] = true; draw(); refresh(); } }, '是'),
          h('button', { class: 'chip' + (st[key] === false ? ' on' : ''), 'data-yn': key + '-no', onclick: () => { st[key] = false; draw(); refresh(); } }, '否')
        );
      };
      draw();
      return box;
    };
    const quad = h('div', { class: 'quad' }, '回答上面两个问题，确定这条岔路的象限。');
    const doNow = h('label', { class: 'q', style: 'justify-content:flex-start;gap:6px;font-size:13px;display:none' },
      h('input', { type: 'checkbox', onchange: e => { st.doNow = e.target.checked; refresh(); } }), '我还是要现在就做');
    const timeIn = h('input', { type: 'number', min: '1', max: '240', value: '5', style: 'width:90px' });
    timeIn.addEventListener('input', () => { st.timeboxMin = Number(timeIn.value) || 5; });
    const noteIn = h('textarea', { placeholder: `「${c.lineTitle}」做到哪了？回来时会显示这句话（可留空）` });
    noteIn.addEventListener('input', () => { st.note = noteIn.value; });
    const submit = h('button', { class: 'btn primary', 'data-act': 'submit-detour', disabled: true }, '确定');
    const cancel = h('button', { class: 'btn', onclick: () => (c.fromSwitch ? switchCard(c.fromSwitch) : clearCard()) }, '取消');

    function drawReasons() {
      reasonChips.replaceChildren(...REASONS.map(r => h('button', {
        class: 'chip' + (st.reason === r ? ' on' : ''), 'data-reason': r,
        onclick: () => {
          st.reason = r;
          if (!titleTouched) { st.title = REASON_TITLE[r]; titleIn.value = st.title; }
          drawReasons();
        }
      }, r)));
    }
    function refresh() {
      const known = st.urgent != null && st.important != null;
      if (!known) { submit.setAttribute('disabled', ''); doNow.style.display = 'none'; return; }
      const q = st.urgent ? (st.important ? 'IU' : 'UNI') : (st.important ? 'INU' : 'NUNI');
      quad.className = 'quad q-' + q;
      quad.replaceChildren(h('b', {}, QUAD[q].name), QUAD[q].tip);
      if (q === 'IU') {
        const next = (state?.lastSwapAt || 0) + SWAP_WINDOW_MS;
        const ok = !state?.lastSwapAt || Date.now() >= next;
        quad.append(h('div', { class: 'muted', style: 'margin-top:4px' },
          ok ? '置换额度：可用（2 小时内仅一次）' : `置换额度已用完，${clock(next)} 后恢复；到时按“紧急不重要”处理。`));
      }
      doNow.style.display = st.urgent ? 'none' : 'flex';
      submit.textContent = st.urgent || st.doNow ? '开始岔路' : (q === 'INU' ? '搁置，继续主线' : '存入稍后，继续主线');
      submit.removeAttribute('disabled');
    }
    submit.addEventListener('click', async () => {
      submit.setAttribute('disabled', '');
      const res = await send({ type: 'registerDetour', form: { ...st, title: titleIn.value, returnPlace: c.returnPlace } });
      if (res?.error) { err.textContent = res.error; submit.removeAttribute('disabled'); return; }
      clearIf(card);
    });

    drawReasons();
    add(card, 
      h('div', { class: 'eyebrow' }, c.offline ? '检测到网络断开' : `主线：${state?.focus?.title || c.lineTitle}`),
      h('h2', {}, c.offline ? '网络断了，要开一条「修网络」岔路吗？' : '登记岔路'),
      h('label', { class: 'f' }, '原因'), reasonChips,
      h('label', { class: 'f' }, '岔路名称'), titleIn,
      h('div', { class: 'q' }, h('span', {}, '不马上处理会出问题吗？', h('span', { class: 'muted' }, '（紧急）')), yn('urgent')),
      h('div', { class: 'q' }, h('span', {}, '这件事本身重要吗？', h('span', { class: 'muted' }, '（重要）')), yn('important')),
      quad, doNow,
      h('label', { class: 'f' }, '需要多久（分钟）'), timeIn,
      h('label', { class: 'f' }, '断点备注'), noteIn,
      err,
      h('div', { class: 'actions' }, submit, cancel)
    );
    refresh();
    mount(card, true, () => cancel.click());
    titleIn.focus();
  }

  /* ---------- 岔路超时 ---------- */
  function detourTimeoutCard(c) {
    const card = h('div', { class: 'card', 'data-card': 'detour-timeout' });
    const err = h('div', { class: 'err' });
    const act = (type, extra = {}) => async () => {
      const res = await send({ type, ...extra });
      if (res?.error) { err.textContent = res.error; return; }
      clearIf(card);
    };
    add(card, 
      h('div', { class: 'eyebrow' }, '岔路时间到'),
      h('h2', {}, '「', h('em', {}, c.title), '」解决了吗？'),
      h('p', { class: 'muted' }, `解决后回到「${c.parentTitle}」。`),
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', 'data-act': 'done', onclick: act('endDetour', { outcome: 'done' }) }, '已解决，回去'),
        c.canExtend ? h('button', { class: 'btn', 'data-act': 'extend', onclick: act('extendDetour') }, '再给 5 分钟') : null,
        h('button', { class: 'btn', 'data-act': 'park', onclick: act('endDetour', { outcome: 'parked' }) }, '搁置，先回去'),
        h('button', { class: 'btn', 'data-act': 'promote', onclick: act('endDetour', { outcome: 'promoted' }) }, '升级为下一件事')
      ),
      err
    );
    mount(card, c.level >= 2, () => clearCard(), true);
  }

  /* ---------- 回程 ---------- */
  function returnCard(c) {
    const card = h('div', { class: 'card', 'data-card': 'return' });
    add(card, 
      h('div', { class: 'eyebrow' }, c.restored ? '恢复被挂起的主线' : (c.toMain ? '回到主线' : '回到上一层岔路')),
      h('h2', {}, '继续「', h('em', {}, c.title), '」'),
      c.note ? h('div', { class: 'note' }, '断点：', c.note) : h('p', { class: 'muted' }, '离开时没有写断点备注。'),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => clearCard() }, '好，继续'))
    );
    mount(card, false);
    if (c.level <= 1) later(clearCard, 10000);
  }

  function toastCard(c) {
    const card = h('div', { class: 'card', 'data-card': 'toast' });
    add(card, h('p', {}, c.text), h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => clearCard() }, '知道了')));
    mount(card, false);
    if (!c.sticky) later(clearCard, 8000);
  }

  /* ---------- 主线时间到 ---------- */
  function focusEndCard(c) {
    const card = h('div', { class: 'card', 'data-card': 'focus-end' });
    const err = h('div', { class: 'err' });
    const splitIn = h('input', { type: 'text', placeholder: '剩下的部分叫什么？例如：写完 3.3 节' });
    const splitRow = h('div', { style: 'display:none;margin-top:10px' }, splitIn,
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', 'data-act': 'split-ok', onclick: () => act('split', splitIn.value)() }, '记为下一件事并结束')));
    const act = (action, title) => async () => {
      const res = await send({ type: 'focusAction', action, title });
      if (res?.error) { err.textContent = res.error; return; }
      clearIf(card); // 小结可能显示在别的地方（比如浏览器里），这张全屏卡片必须收起来
    };
    add(card, 
      h('div', { class: 'eyebrow' }, `已用 ${c.elapsedMin} 分钟`),
      h('h2', {}, '「', h('em', {}, c.title), '」时间到'),
      c.extra ? h('p', { class: 'muted' }, c.extra) : null,
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', 'data-act': 'done', onclick: act('done') }, '完成了'),
        c.canExtend ? h('button', { class: 'btn', 'data-act': 'extend', onclick: act('extend') }, `延长 ${c.extendMin} 分钟（仅一次）`) : null,
        h('button', { class: 'btn', 'data-act': 'split', onclick: () => { splitRow.style.display = 'block'; splitIn.focus(); } }, '剩下的拆成下一件事')
      ),
      splitRow, err
    );
    mount(card, c.level >= 1, () => clearCard(), true);
  }

  /* ---------- 收尾小结 ---------- */
  function summaryCard(c) {
    const s = c.summary;
    const card = h('div', { class: 'card', 'data-card': 'summary' });
    const stat = (v, k, cls = '') => h('div', { class: 'stat' }, h('div', { class: 'v ' + cls }, v), h('div', { class: 'k' }, k));
    // 切换分四类：必要切换 / 突发情况（岔路）/ 拦下的分心（点了返回、稍后）/ 分心（没回答且停留久，或你确认的）
    const b = Object.assign({ needed: 0, detour: s.stats?.detours || 0, caught: 0, distracted: 0 }, s.breakdown || {});
    const statsEl = h('div', { class: 'stats', 'data-part': 'breakdown' });
    const drawStats = () => statsEl.replaceChildren(
      stat(b.needed, '必要切换'), stat(b.detour, '突发情况'), stat(b.caught, '拦下的分心', 'good'), stat(b.distracted, '分心', b.distracted ? 'bad' : ''));
    drawStats();
    add(card, 
      h('div', { class: 'eyebrow' }, s.outcome === 'split' ? '已拆分，下一件事已记下' : '这件事结束了'),
      h('h2', {}, s.title),
      s.swappedFrom ? h('p', { class: 'muted' }, `（由岔路置换而来，原主线：${s.swappedFrom}）`) : null,
      h('p', { class: 'muted' }, `用时 ${s.usedMin} 分钟 / 计划 ${s.plannedMin} 分钟 · 稍后清单 ${s.laterCount} 条`),
      statsEl
    );
    const fmtDur = ms => ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))} 秒` : `${Math.round(ms / 60000)} 分钟`;
    function reviewItem(e) {
      let v = e.verdict || e.guess;
      const li = h('li', { 'data-switch': e.id });
      const err = h('span', { class: 'err' });
      const draw = extra => li.replaceChildren(...keep([
        h('span', {}, h('b', {}, e.label || e.name), ' · ',
          e.dwellMs == null ? '停留时长未知' : `停留 ${fmtDur(e.dwellMs)}`, e.verdict ? '' : (v === 'pending' ? '' : ' · 预判')),
        h('span', { class: 'seg' },
          h('button', { class: 'chip' + (v === 'needed' ? ' on' : ''), 'data-verdict': 'needed', onclick: () => set('needed') }, '必要'),
          h('button', { class: 'chip' + (v === 'distracted' ? ' on' : ''), 'data-verdict': 'distracted', onclick: () => set('distracted') }, '分心')),
        extra, err]));
      async function set(verdict, remember = false) {
        const r = await send({ type: 'labelSwitch', focusId: s.focusId, switchId: e.id, verdict, remember });
        if (r?.error) { err.textContent = r.error; return; }
        v = verdict; e.verdict = verdict;
        Object.assign(b, r.breakdown || {});
        drawStats();
        if (remember && r.remembered) draw(h('div', { class: 'full' }, `已记住：下次做「${s.title}」时自动放行 ${e.label || e.name}`));
        else if (verdict === 'needed') draw(h('div', { class: 'full' }, `下次做「${s.title}」时自动放行 ${e.label || e.name}？`,
          h('button', { class: 'chip', 'data-act': 'remember', onclick: () => set('needed', true) }, '记住'),
          h('button', { class: 'link', style: 'margin:0', onclick: () => draw() }, '不用')));
        else draw();
      }
      draw();
      return li;
    }
    if (s.review && s.review.length) {
      add(card, 
        h('label', { class: 'f' }, `这些切换当时没有回答。停留不到 ${s.distractMin || 2} 分钟的预判为必要，超过的预判为分心，点一下可以改正：`),
        h('ul', { class: 'list', 'data-part': 'review' }, s.review.map(reviewItem)));
    }
    if (c.parked && c.parked.length) {
      const ul = h('ul', { class: 'list' });
      for (const p of c.parked) {
        const li = h('li', {}, h('span', {}, p.title),
          h('button', { class: 'btn', onclick: async () => { await send({ type: 'listAction', list: 'parked', id: p.id, action: 'toNext' }); li.remove(); } }, '设为下一件事'));
        ul.append(li);
      }
      add(card, h('label', { class: 'f' }, '还有被搁置的重要岔路：'), ul);
    }
    if (c.suspended) {
      const sp = c.suspended;
      const tIn = h('input', { type: 'number', min: '1', max: '240', value: String(Math.max(1, Math.ceil(sp.timeboxMin / 2))), style: 'width:90px' });
      const err = h('div', { class: 'err' });
      add(card, h('div', { class: 'note' },
        h('div', {}, h('b', {}, `恢复被挂起的主线「${sp.title}」？`)),
        sp.note ? h('div', { class: 'muted' }, '断点：' + sp.note) : null,
        h('div', { class: 'row', style: 'margin-top:8px' }, h('span', { class: 'muted' }, '再给它'), tIn, h('span', { class: 'muted' }, '分钟')),
        h('div', { class: 'actions' },
          h('button', { class: 'btn primary', 'data-act': 'restore', onclick: async () => {
            const tb = Number(tIn.value);
            clearCard(); // 回程卡会在原主线的标签页上出现
            const r = await send({ type: 'restore', timeboxMin: tb });
            if (r?.error) toastCard({ text: r.error });
          } }, '恢复'),
          h('button', { class: 'btn', onclick: async () => { await send({ type: 'discardSuspended' }); clearCard(); } }, '放弃')),
        err));
    }
    add(card, h('div', { class: 'actions' }, h('button', { class: 'btn', 'data-act': 'close', onclick: () => clearCard() }, '关闭')));
    mount(card, true, () => clearCard(), true);
  }

  /* ---------- 消息 ---------- */
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.cmd !== 'card') return false;
    const c = msg.card;
    switch (c.kind) {
      case 'switch': switchCard(c); break;
      case 'detour-form': detourForm(c); break;
      case 'detour-timeout': detourTimeoutCard(c); break;
      case 'return': returnCard(c); break;
      case 'toast': toastCard(c); break;
      case 'focus-end': focusEndCard(c); break;
      case 'summary': summaryCard(c); break;
      case 'clear': clearCard(); break; // 中控的“强制关闭卡片”
    }
    reply({ ok: true });
    return false;
  });

  window.addEventListener('offline', () => {
    if (document.visibilityState === 'visible') send({ type: 'offline' });
  });
})();
