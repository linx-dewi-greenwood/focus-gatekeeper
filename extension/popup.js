// 一事一毕 · 弹出面板
const QUAD_NAME = { IU: '重要且紧急', UNI: '紧急不重要', INU: '重要不紧急', NUNI: '不紧急不重要' };
const LEVELS = [
  { v: 0, name: '0 观察', tip: '不提示，只记录，先了解自己怎么跑偏' },
  { v: 1, name: '1 轻提示', tip: '角落小卡片，3 秒后消失' },
  { v: 2, name: '2 坚定', tip: '弹出卡片，必须选一项（Esc = 返回）' },
  { v: 3, name: '3 严格', tip: '默认返回；放行需输入确认句并等 30 秒' }
];
const app = document.getElementById('app');
let state = null;
let hubInfo = {};
const PRESETS = [25, 50, 90];
const blankForm = level => ({ title: '', timeboxMin: 50, customMin: '', level, sites: '', apps: [], nextUpId: null });
let form = blankForm(1);
let timer = null;

const send = msg => chrome.runtime.sendMessage(msg);
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of kids.flat()) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}
function fmt(ms) {
  const neg = ms < 0;
  const t = Math.floor(Math.abs(ms) / 1000);
  return (neg ? '+' : '') + String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
}
const clock = t => new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

async function load() {
  const r = await send({ type: 'getState' });
  state = r.state || { focus: null, detours: [], suspended: [], parked: [], later: [], nextUp: [] };
  hubInfo = r.hub || {};
  render();
}

function render() {
  clearInterval(timer);
  const status = window.__focusHub ? '中控' : (hubInfo.connected ? '已连接中控' : '单机模式');
  app.replaceChildren(h('h1', {}, h('span', { class: 'dot' }), '一事一毕',
    h('span', { class: 'status' + (window.__focusHub || hubInfo.connected ? ' on' : '') }, status)));
  if (state.focus) renderActive(); else renderStart();
  renderLists();
}

/* ---------- 开一件事 ---------- */
function renderStart() {
  const err = h('div', { class: 'err' });
  const title = h('input', { type: 'text', placeholder: '只写一件事，例如：写完报告第 3 节', value: form.title });
  title.addEventListener('input', () => { form.title = title.value; form.nextUpId = null; });

  const next = state.nextUp || [];
  const nextChips = next.length ? h('div', {},
    h('label', { class: 'f' }, '下一件事'),
    h('div', { class: 'chips' }, next.map(n => h('button', {
      class: 'chip' + (form.nextUpId === n.id ? ' on' : ''),
      onclick: () => { form.title = n.title; form.nextUpId = n.id; render(); }
    }, n.title)))) : null;

  // 时间盒：三个预设 + 自定义。输入框只建一次、打字时不重画（重画会丢光标），下方实时显示最终用多少分钟
  const custom = h('input', {
    type: 'text', inputmode: 'numeric', class: 'custom-min', placeholder: '自定义', 'aria-label': '自定义分钟数',
    value: form.customMin, 'data-part': 'custom-min'
  });
  const presetBtns = PRESETS.map(m => h('button', {
    class: 'chip', 'data-min': String(m),
    onclick: () => { form.timeboxMin = m; form.customMin = ''; custom.value = ''; syncTimes(); }
  }, `${m} 分钟`));
  const times = h('div', { class: 'chips', style: 'align-items:center' }, presetBtns, custom, h('span', { class: 'muted' }, '分钟'));
  const timeHint = h('div', { class: 'hint', 'data-part': 'timebox-hint' });
  function customValue() { // 返回自定义的分钟数；空 → null；不合法 → NaN
    const raw = String(form.customMin || '').trim();
    if (!raw) return null;
    const v = Number(raw);
    return Number.isInteger(v) && v >= 1 && v <= 240 ? v : NaN;
  }
  function syncTimes() {
    const cv = customValue();
    if (cv) form.timeboxMin = cv;
    const usingCustom = cv !== null;
    presetBtns.forEach(b => b.classList.toggle('on', !usingCustom && Number(b.dataset.min) === form.timeboxMin));
    custom.classList.toggle('on', usingCustom && !Number.isNaN(cv));
    custom.classList.toggle('bad', Number.isNaN(cv));
    timeHint.classList.toggle('bad', Number.isNaN(cv));
    timeHint.textContent = Number.isNaN(cv) ? '请输入 1–240 之间的整数分钟' : `本次时间盒：${form.timeboxMin} 分钟`;
    if (!Number.isNaN(cv) && /时间盒/.test(err.textContent)) err.textContent = ''; // 改对了就清掉旧的错误提示
  }
  custom.addEventListener('input', () => {
    custom.value = custom.value.replace(/[^\d]/g, '').slice(0, 3); // 只留数字
    form.customMin = custom.value;
    syncTimes();
  });
  syncTimes();

  const levels = h('div', { class: 'levels' });
  function drawLevels() {
    levels.replaceChildren(...LEVELS.map(l => h('div', {
      class: 'level' + (form.level === l.v ? ' on' : ''),
      onclick: () => { form.level = l.v; drawLevels(); }
    }, h('div', {}, h('b', {}, l.name), h('span', {}, l.tip)))));
  }
  drawLevels();

  const sites = h('input', { type: 'text', placeholder: '例如 overleaf.com, docs.google.com（可留空）', value: form.sites });
  sites.addEventListener('input', () => { form.sites = sites.value; });

  // 中控里可以选这件事会用到的桌面应用（最近用过的应用）
  const recent = hubInfo.recentApps || [];
  const appChips = h('div', { class: 'chips' });
  function drawApps() {
    appChips.replaceChildren(...recent.map(a => h('button', {
      class: 'chip' + (form.apps.includes(a.app) ? ' on' : ''), title: a.title || a.app,
      onclick: () => { form.apps = form.apps.includes(a.app) ? form.apps.filter(x => x !== a.app) : [...form.apps, a.app]; drawApps(); }
    }, a.label || a.app)));
  }
  drawApps();
  const appsBlock = recent.length ? h('div', {},
    h('label', { class: 'f' }, `这件事会用到的应用（${hubInfo.workApp ? hubInfo.workApp + ' 自动加入' : '可多选'}）`), appChips) : null;

  async function doStart() {
    if (Number.isNaN(customValue())) { err.textContent = '时间盒请输入 1–240 之间的整数分钟'; custom.focus(); return; }
    if (!String(form.title).trim()) { err.textContent = '先写下这一件事'; title.focus(); return; }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const r = await send({ type: 'startFocus', form: { ...form, tabId: tab?.id } });
    if (r.error) { err.textContent = r.error; return; }
    form = blankForm(form.level);
    load();
  }
  const start = h('button', { class: 'btn primary wide', 'data-act': 'start', onclick: doStart }, '开始这一件事');
  for (const input of [title, custom, sites]) input.addEventListener('keydown', e => { if (e.key === 'Enter') doStart(); });

  const suspended = (state.suspended || []).at(-1);
  app.append(...[
    suspended ? h('div', { class: 'line main', style: 'margin-bottom:8px' },
      h('div', { class: 'top' }, '被挂起的主线'),
      h('div', { class: 'title' }, suspended.title),
      suspended.note ? h('div', { class: 'muted' }, '断点：' + suspended.note) : null,
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', onclick: async () => { const r = await send({ type: 'restore' }); if (r.error) err.textContent = r.error; else window.close(); } }, '恢复'),
        h('button', { class: 'btn', onclick: async () => { await send({ type: 'discardSuspended' }); load(); } }, '放弃'))) : null,
    h('label', { class: 'f', style: 'margin-top:0' }, '这一件事是？'), title,
    nextChips,
    h('label', { class: 'f' }, '时间盒'), times, timeHint,
    h('label', { class: 'f' }, '提醒档位'), levels,
    appsBlock,
    h('label', { class: 'f' }, window.__focusHub ? '这件事会用到的网站（可留空）' : '这件事会用到的网站（当前页面自动加入）'), sites,
    start, err
  ].filter(Boolean));
  title.focus();
}

/* ---------- 进行中 ---------- */
function renderActive() {
  const f = state.focus, ds = state.detours || [];
  const err = h('div', { class: 'err' });
  const times = [];
  const lineBox = (l, isMain, isCurrent) => {
    const t = h('span', { class: 'time' });
    times.push([t, l]);
    return h('div', { class: `line ${isMain ? 'main' : 'detour'}${isCurrent ? ' current' : ''}` },
      h('div', { class: 'top' },
        h('span', {}, isMain ? `主线 · ${LEVELS[f.level].name}` : '岔路 ', !isMain ? h('span', { class: 'q q-' + l.quadrant }, QUAD_NAME[l.quadrant]) : null),
        t),
      h('div', { class: 'title' }, l.title),
      !isMain && l.note ? h('div', { class: 'muted' }, '断点：' + l.note) : null);
  };
  const stack = h('div', { class: 'stack' }, lineBox(f, true, ds.length === 0), ds.map((d, i) => lineBox(d, false, i === ds.length - 1)));
  const tick = () => {
    for (const [t, l] of times) {
      const left = l.endsAt - Date.now();
      t.textContent = fmt(left);
      t.classList.toggle('over', left < 0);
    }
  };
  tick();
  timer = setInterval(tick, 1000);

  const act = (msg, close) => async () => {
    const r = await send(msg);
    if (r?.error) { err.textContent = r.error; return; }
    if (close) window.close(); else load();
  };
  const quotaOk = !state.lastSwapAt || Date.now() >= state.lastSwapAt + 2 * 3600 * 1000;
  app.append(
    stack,
    f.pauseUntil > Date.now() ? h('div', { class: 'muted', style: 'margin-top:6px' }, `暂停中，${clock(f.pauseUntil)} 恢复提醒`) : '',
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', onclick: act({ type: 'openDetourForm' }, true) }, '我被打断了'),
      ds.length ? h('button', { class: 'btn', onclick: act({ type: 'endDetour', outcome: 'done' }, true) }, '岔路完成，回去') : null,
      h('button', { class: 'btn', onclick: act({ type: 'focusAction', action: 'done' }, true) }, '完成主线'),
      !f.pauseUsed ? h('button', { class: 'btn', onclick: act({ type: 'pause' }) }, '暂停 10 分钟') : null,
      h('button', { class: 'btn', onclick: act({ type: 'focusAction', action: 'abandon' }) }, '放弃')),
    h('div', { class: 'muted', style: 'margin-top:8px' },
      `快捷键 Alt+B 登记岔路 · 置换额度：${quotaOk ? '可用' : clock(state.lastSwapAt + 2 * 3600 * 1000) + ' 后恢复'}`),
    err
  );
}

/* ---------- 清单 ---------- */
function renderLists() {
  const section = (label, list, items, toNext) => {
    if (!items || !items.length) return null;
    return h('details', {},
      h('summary', {}, `${label}（${items.length}）`),
      h('ul', { class: 'list' }, items.map(it => h('li', {},
        it.url ? h('a', { href: it.url, target: '_blank', title: it.url }, it.text || it.title) : h('span', { title: it.note || '' }, it.title || it.text),
        h('span', { style: 'display:flex;gap:4px;flex:none' },
          toNext ? h('button', { class: 'mini', onclick: async () => { await send({ type: 'listAction', list, id: it.id, action: 'toNext' }); load(); } }, '设为下一件') : null,
          h('button', { class: 'x', title: '删除', onclick: async () => { await send({ type: 'listAction', list, id: it.id }); load(); } }, '×'))))));
  };
  const rememberRows = Object.entries(state.remember || {}).flatMap(([title, r]) =>
    [...(r.apps || []).map(name => ({ title, kind: 'app', name })), ...(r.hosts || []).map(name => ({ title, kind: 'tab', name }))]);
  const rememberBlock = rememberRows.length ? h('details', {},
    h('summary', {}, `记住的放行（${rememberRows.length}）`),
    h('ul', { class: 'list' }, rememberRows.map(r => h('li', {},
      h('span', { title: `做「${r.title}」时自动放行` }, `${r.title} → ${r.name}`),
      h('button', { class: 'x', title: '不再自动放行', onclick: async () => { await send({ type: 'forget', ...r }); load(); } }, '×'))))) : '';
  app.append(
    rememberBlock,
    section('搁置的重要岔路', 'parked', state.parked, true) || '',
    section('稍后清单', 'later', state.later, true) || '',
    section('下一件事', 'nextUp', state.nextUp, false) || ''
  );
}

load();
