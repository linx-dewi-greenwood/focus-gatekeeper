// 一事一毕 · 规则引擎（浏览器扩展和中控共用这一份文件）
//
// 引擎只管状态和规则，不直接碰浏览器或操作系统。所有“副作用”通过 io 交给调用方：
//   io.load() / io.save(state)          读写状态
//   io.schedule(name, when) / io.clear(name)   计时器（'focus'、'detour:<id>'）
//   io.show(card, place)                在某个位置显示卡片（place 为 null 表示“当前位置”），返回是否显示成功
//   io.switchTo(place)                  切回某个位置，返回是否成功
//
// “位置”（place）统一描述用户在哪：
//   { kind: 'tab', tabId, host, url, title }        浏览器标签页（由浏览器扩展提供）
//   { kind: 'app', app, hwnd, pid, title }          桌面应用（由中控提供，app 为小写进程名，不带 .exe）
(function (root) {
  const SWAP_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 小时内最多置换一次
  const DISTRACT_DWELL_MS = 2 * 60 * 1000;   // 未确认的切换：停留超过 2 分钟预判为“分心”，否则预判为“必要”
  const MAX_SWITCH_LOG = 100;
  const MAX_DEPTH = 3;
  const QUAD_NAME = { IU: '重要且紧急', UNI: '紧急不重要', INU: '重要不紧急', NUNI: '不紧急不重要' };
  const REASON_TITLE = { 网络: '修网络', 报错: '修报错', 找资料: '找资料', 消息: '回消息', 其他: '处理突发情况' };
  const REASON_SITES = {
    网络: ['tplogin.cn', 'melogin.cn', 'falogin.cn', 'miwifi.com', 'routerlogin.net', 'speedtest.net', 'speedtest.cn', 'fast.com'],
    报错: ['stackoverflow.com', 'stackexchange.com', 'github.com', 'developer.mozilla.org', 'learn.microsoft.com',
      'docs.python.org', 'pypi.org', 'npmjs.com', 'segmentfault.com', 'csdn.net'],
    找资料: ['drive.google.com', 'docs.google.com', 'onedrive.live.com', 'sharepoint.com', 'outlook.office.com',
      'outlook.live.com', 'mail.google.com', 'mail.qq.com', 'pan.baidu.com', 'scholar.google.com'],
    消息: ['web.whatsapp.com', 'wx.qq.com', 'teams.microsoft.com', 'app.slack.com', 'discord.com', 'outlook.office.com'],
    其他: []
  };
  // 各类岔路默认放行的桌面应用（小写进程名）
  const REASON_APPS = {
    网络: ['systemsettings', 'control', 'mmc', 'ncpa'],
    报错: ['code', 'windowsterminal', 'cmd', 'powershell', 'pwsh', 'devenv', 'pycharm64', 'idea64'],
    找资料: ['onedrive', 'acrord32', 'acrobat', 'sumatrapdf', 'foxitpdfreader'],
    消息: ['wechat', 'weixin', 'qq', 'teams', 'ms-teams', 'slack', 'discord', 'outlook', 'olk', 'whatsapp', 'telegram', 'dingtalk', 'feishu', 'lark'],
    其他: []
  };
  // 切换到这些应用时从不提问（桌面、任务栏、开始菜单、锁屏、任务切换界面等）
  const IGNORED_APPS = ['explorer', 'shellexperiencehost', 'startmenuexperiencehost', 'searchhost', 'searchapp',
    'lockapp', 'applicationframehost', 'textinputhost', 'shellhost', 'taskmgr', 'snippingtool', 'screenclippinghost', 'idle'];
  const BROWSER_APPS = ['chrome', 'msedge', 'brave', 'vivaldi', 'opera', 'firefox', 'arc'];

  const DEFAULT_STATE = {
    focus: null, detours: [], suspended: [], parked: [], later: [], nextUp: [],
    lastSwapAt: 0, history: [],
    remember: {} // 记住的放行：{ 事情名称: { hosts: [], apps: [] } }，下次做同名的事自动放行
  };

  const uid = () => Math.random().toString(36).slice(2, 10);
  const now = () => Date.now();
  const clone = o => JSON.parse(JSON.stringify(o));
  const clock = t => new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

  function hostOf(url) {
    try {
      const u = new URL(url);
      if (!/^https?:$/.test(u.protocol)) return null;
      return u.hostname.replace(/^www\./, '');
    } catch { return null; }
  }
  const matchHost = (h, list) => !!h && (list || []).some(d => h === d || h.endsWith('.' + d));
  const isPrivateIp = h => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h || '');
  function isSearchUrl(url) {
    try {
      const u = new URL(url);
      const h = u.hostname.replace(/^www\./, '');
      if (/(^|\.)google\.[a-z.]+$/.test(h) && u.pathname === '/search') return true;
      if (/(^|\.)bing\.com$/.test(h) && u.pathname === '/search') return true;
      if (/(^|\.)baidu\.com$/.test(h) && u.pathname === '/s') return true;
      if (/(^|\.)duckduckgo\.com$/.test(h) && u.searchParams.has('q')) return true;
      if (/(^|\.)sogou\.com$/.test(h) && u.pathname.startsWith('/web')) return true;
      return false;
    } catch { return false; }
  }
  const normApp = a => String(a || '').toLowerCase().replace(/\.exe$/, '').trim();
  const currentLine = s => (s.detours && s.detours.at(-1)) || s.focus;
  const swapQuota = s => {
    const next = (s.lastSwapAt || 0) + SWAP_WINDOW_MS;
    return { ok: !s.lastSwapAt || now() >= next, next };
  };
  const placeName = p => !p ? '' : p.kind === 'tab' ? (p.host || '网页') : (p.app || '应用');
  const samePlace = (a, b) => !!a && !!b && a.kind === b.kind &&
    (a.kind === 'tab' ? a.tabId === b.tabId : a.app === b.app);
  const switchName = p => !p ? '' : p.kind === 'tab' ? (p.host || hostOf(p.url) || '') : normApp(p.app);

  // 一次切换属于哪一类：
  //   needed 必要切换（点了“属于”，或预判/确认为必要）  detour 突发情况（登记了岔路）
  //   caught 拦下的分心（点了“返回”/“记到稍后”）      distracted 分心（预判/确认为分心）  pending 还没法判断
  function classify(e, dwellMs = DISTRACT_DWELL_MS) {
    if (e.choice === 'pass') return 'needed';
    if (e.choice === 'detour') return 'detour';
    if (e.choice === 'back' || e.choice === 'later') return 'caught';
    if (e.verdict) return e.verdict;
    return guess(e, dwellMs);
  }
  function guess(e, dwellMs = DISTRACT_DWELL_MS) {
    if (e.dwellMs == null) return 'pending';
    return e.dwellMs >= dwellMs ? 'distracted' : 'needed';
  }
  // 小结用：四类计数 + 需要用户确认的切换（0 档只记录的、轻提示自动消失的）
  function summarizeSwitches(list, dwellMs = DISTRACT_DWELL_MS) {
    const counts = { needed: 0, detour: 0, caught: 0, distracted: 0 };
    const review = [];
    for (const e of list || []) {
      const c = classify(e, dwellMs);
      if (counts[c] != null) counts[c]++;
      if (e.choice === 'observed' || e.choice === 'ignored') {
        review.push({ id: e.id, kind: e.kind, name: e.name, label: e.label, dwellMs: e.dwellMs, guess: guess(e, dwellMs), verdict: e.verdict || null });
      }
    }
    return { counts, review };
  }

  // 旧版（v0.1）状态迁移：lastTabId → lastPlace，returnTabId → returnPlace
  function migrate(s) {
    const fixLine = l => {
      if (!l) return;
      if (!l.apps) l.apps = [];
      if (!l.allowed) l.allowed = [];
      if (l.lastPlace === undefined) l.lastPlace = l.lastTabId != null ? { kind: 'tab', tabId: l.lastTabId } : null;
      if (l.returnTabId != null && l.returnPlace === undefined) l.returnPlace = { kind: 'tab', tabId: l.returnTabId };
      delete l.lastTabId; delete l.returnTabId;
    };
    fixLine(s.focus);
    (s.detours || []).forEach(fixLine);
    (s.suspended || []).forEach(fixLine);
    return s;
  }

  // 这个位置属于当前这条线吗？
  function isAllowed(s, place) {
    if (!s.focus || !place) return true;
    const line = currentLine(s);
    const onDetour = line !== s.focus;
    if (place.kind === 'tab') {
      const host = place.host || hostOf(place.url);
      if (!host) return true;
      if (isSearchUrl(place.url)) return true; // 搜索结果页放行；从结果页点进的新域名会再问
      if (matchHost(host, line.allowed)) return true;
      if (onDetour) {
        if (matchHost(host, s.focus.allowed)) return true; // 回到主线总是可以的
        if (s.detours.some(d => matchHost(host, d.allowed))) return true;
        if (matchHost(host, REASON_SITES[line.reason])) return true;
        if (line.reason === '网络' && isPrivateIp(host)) return true; // 路由器后台
      }
      return false;
    }
    const app = normApp(place.app);
    if (!app || IGNORED_APPS.includes(app)) return true;
    if (line.apps.includes(app)) return true;
    if (onDetour) {
      if (s.focus.apps.includes(app)) return true;
      if (s.detours.some(d => d.apps.includes(app))) return true;
      if ((REASON_APPS[line.reason] || []).includes(app)) return true;
    }
    return false;
  }

  function createEngine(io, opts = {}) {
    const dwellMs = opts.distractDwellMs || DISTRACT_DWELL_MS;
    let chain = Promise.resolve();
    let lastOffline = 0;

    async function load() {
      const raw = await io.load();
      return migrate(Object.assign(clone(DEFAULT_STATE), raw || {}));
    }
    function update(fn) {
      const p = chain.then(async () => {
        const s = await load();
        const r = await fn(s);
        await io.save(s);
        return r;
      });
      chain = p.catch(() => {});
      return p;
    }
    const schedule = (name, when) => io.schedule(name, Math.max(when, now() + 1000));

    function newFocus({ title, timeboxMin, level, allowed = [], apps = [], lastPlace = null, endsAt, swappedFrom = null }) {
      const t = now();
      return {
        id: uid(), title, timeboxMin, level, startedAt: t,
        endsAt: endsAt || t + timeboxMin * 60000,
        extended: false, pauseUsed: false, pauseUntil: 0, wrapPending: false,
        allowed: [...new Set(allowed.filter(Boolean))], apps: [...new Set(apps.map(normApp).filter(Boolean))],
        lastPlace, swappedFrom,
        stats: { prompts: 0, passes: 0, offTrack: 0, detours: 0 },
        switches: [], openSwitchId: null
      };
    }
    function parkDetour(s, d) {
      if (d.quadrant === 'NUNI') s.later.push({ id: d.id, text: d.title, url: null, note: d.note, createdAt: now() });
      else s.parked.push({ id: d.id, title: d.title, reason: d.reason, quadrant: d.quadrant, note: d.note, createdAt: now() });
    }
    function placeAllow(line, place) {
      if (!place) return;
      if (place.kind === 'tab') {
        const h = place.host || hostOf(place.url);
        if (h && !line.allowed.includes(h)) line.allowed.push(h);
      } else {
        const a = normApp(place.app);
        if (a && !line.apps.includes(a)) line.apps.push(a);
      }
    }

    /* ---------- 查询与记录 ---------- */
    async function getState() { return load(); }
    // 切换记录：用户离开一个“未确认”的位置时，记下停留了多久
    function closeOpenSwitch(f) {
      if (!f || !f.openSwitchId) return;
      const e = (f.switches || []).find(x => x.id === f.openSwitchId);
      if (e && e.dwellMs == null) e.dwellMs = now() - e.at;
      f.openSwitchId = null;
    }
    // 找到这个位置最近一条还没有回答的切换记录
    function pendingSwitch(f, place) {
      const name = switchName(place);
      const list = f.switches || [];
      for (let i = list.length - 1; i >= 0; i--) if (list[i].choice == null && list[i].name === name) return list[i];
      return null;
    }
    async function touch(place) { // 用户在当前这条线允许的位置上
      return update(s => {
        if (!s.focus) return;
        closeOpenSwitch(s.focus);
        currentLine(s).lastPlace = place;
      });
    }
    async function recordPrompt(place) { // 记一次“不属于当前线”的切换，返回档位；0 档只记录不提问
      return update(s => {
        if (!s.focus) return null;
        const f = s.focus;
        closeOpenSwitch(f);
        f.stats.prompts++;
        if (!f.switches) f.switches = [];
        const e = {
          id: uid(), at: now(), kind: place?.kind || 'app', name: switchName(place),
          label: place?.label || placeName(place), choice: f.level === 0 ? 'observed' : null, dwellMs: null, verdict: null
        };
        f.switches.push(e);
        if (f.switches.length > MAX_SWITCH_LOG) f.switches.shift();
        if (f.level === 0) { f.stats.offTrack++; f.openSwitchId = e.id; }
        const line = currentLine(s);
        return { level: f.level, lineId: line.id, lineTitle: line.title, onDetour: line !== f, switchId: e.id };
      });
    }
    async function decision(choice, place) {
      return update(s => {
        if (!s.focus) return { ok: false };
        const f = s.focus;
        const line = currentLine(s);
        const e = pendingSwitch(f, place);
        if (e) e.choice = choice;
        if (choice === 'pass') {
          placeAllow(line, place);
          line.lastPlace = place;
          f.stats.passes++;
        } else if (choice === 'ignored' || choice === 'back' || choice === 'later') {
          f.stats.offTrack++;
          if (choice === 'ignored' && e) f.openSwitchId = e.id; // 轻提示没回答：等离开时记下停留多久
          if (choice !== 'ignored' && e) e.dwellMs = now() - e.at;
          if (choice === 'later') s.later.push({ id: uid(), text: place?.title || placeName(place), url: place?.url || null, createdAt: now() });
        }
        return { ok: true, returnPlace: line.lastPlace };
      });
    }

    // 小结里给一次未确认的切换改标：verdict = 'needed' | 'distracted'；remember = 下次做同名的事时自动放行
    async function labelSwitch({ focusId, switchId, verdict, remember }) {
      if (!['needed', 'distracted'].includes(verdict)) return { error: 'bad verdict' };
      return update(s => {
        const h = (s.history || []).find(x => x.focusId === focusId);
        if (!h) return { error: '找不到这次记录' };
        const e = (h.switches || []).find(x => x.id === switchId);
        if (!e) return { error: '找不到这次切换' };
        e.verdict = verdict;
        const sum = summarizeSwitches(h.switches, dwellMs);
        h.breakdown = sum.counts;
        let remembered = false;
        if (remember && verdict === 'needed' && e.name) {
          if (!s.remember) s.remember = {};
          const r = s.remember[h.title] || (s.remember[h.title] = { hosts: [], apps: [] });
          const list = e.kind === 'tab' ? r.hosts : r.apps;
          if (!list.includes(e.name)) list.push(e.name);
          remembered = true;
        }
        return { ok: true, breakdown: sum.counts, review: sum.review, remembered };
      });
    }
    async function forget({ title, kind, name }) { // 取消一条“记住的放行”
      return update(s => {
        const r = s.remember?.[title];
        if (!r) return { ok: true };
        const key = kind === 'tab' ? 'hosts' : 'apps';
        r[key] = r[key].filter(x => x !== name);
        if (!r.hosts.length && !r.apps.length) delete s.remember[title];
        return { ok: true };
      });
    }

    /* ---------- 主线 ---------- */
    async function startFocus(form, place) {
      const title = String(form.title || '').trim();
      if (!title) return { error: '先写下这一件事' };
      const timeboxMin = Math.max(1, Math.min(240, Number(form.timeboxMin) || 50));
      const level = [0, 1, 2, 3].includes(Number(form.level)) ? Number(form.level) : 1;
      const sites = String(form.sites || '').split(/[,，\s]+/)
        .map(x => x.trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '')).filter(Boolean);
      const apps = (form.apps || []).map(normApp);
      if (place?.kind === 'app') apps.push(place.app);
      if (place?.kind === 'tab' && place.app) apps.push(place.app);
      const host = place?.kind === 'tab' ? (place.host || hostOf(place.url)) : null;
      const r = await update(s => {
        if (s.focus) return { error: '已经有一件事在进行中了' };
        const remembered = (s.remember || {})[title] || { hosts: [], apps: [] };
        s.focus = newFocus({
          title, timeboxMin, level, lastPlace: place || null,
          allowed: [host, ...sites, ...remembered.hosts], apps: [...apps, ...remembered.apps]
        });
        s.detours = [];
        if (form.nextUpId) s.nextUp = s.nextUp.filter(x => x.id !== form.nextUpId);
        return { ok: true, endsAt: s.focus.endsAt };
      });
      if (r.ok) schedule('focus', r.endsAt);
      return r;
    }

    async function showFocusEnd(extra = '') {
      const s = await load();
      if (!s.focus) return;
      const f = s.focus;
      await io.show({
        kind: 'focus-end', level: f.level, title: f.title, extra,
        canExtend: !f.extended, extendMin: Math.max(1, Math.ceil(f.timeboxMin / 2)),
        elapsedMin: Math.round((now() - f.startedAt) / 60000)
      }, null);
    }

    async function focusTimeout() {
      const s = await load();
      if (!s.focus) return;
      if (s.detours.length === 0) { await showFocusEnd(); return; }
      const quota = swapQuota(s);
      let iu = -1;
      for (let i = s.detours.length - 1; i >= 0; i--) if (s.detours[i].quadrant === 'IU') { iu = i; break; }
      if (iu >= 0 && quota.ok) { await doSwap(iu); return; }
      const urgent = s.detours.find(d => d.quadrant === 'IU' || d.quadrant === 'UNI');
      if (urgent) {
        await update(st => { if (st.focus) st.focus.wrapPending = true; });
        const text = iu >= 0
          ? `主线「${s.focus.title}」时间到。置换额度已用完（${clock(quota.next)} 后可再置换），「${s.detours[iu].title}」按“紧急不重要”处理：先做完岔路，再回主线收尾。`
          : `主线「${s.focus.title}」时间到，但「${urgent.title}」紧急，岔路优先。做完后回到主线收尾。`;
        await io.show({ kind: 'toast', level: s.focus.level, text, sticky: true }, null);
        return;
      }
      // 只有“现在就做”的不紧急岔路在进行：以主线为准
      const r = await update(st => {
        const ids = st.detours.map(d => d.id);
        for (const d of st.detours) parkDetour(st, d);
        const target = st.detours[0].returnPlace || st.focus.lastPlace;
        st.detours = [];
        return { ids, target };
      });
      r.ids.forEach(id => io.clear('detour:' + id));
      await io.switchTo(r.target);
      await showFocusEnd('主线时间到，以主线为准：进行中的不紧急岔路已搁置。');
    }

    async function doSwap(idx) {
      const r = await update(s => {
        const d = s.detours[idx];
        const old = s.focus;
        const parkedIds = s.detours.slice(0, idx).map(b => b.id);
        for (const b of s.detours.slice(0, idx)) parkDetour(s, b);
        s.suspended.push({
          id: old.id, title: old.title, timeboxMin: old.timeboxMin, level: old.level,
          allowed: old.allowed, apps: old.apps,
          lastPlace: d.returnPlace || old.lastPlace, note: d.note, suspendedAt: now(), stats: old.stats
        });
        s.focus = newFocus({
          title: d.title, timeboxMin: d.timeboxMin, level: old.level,
          allowed: d.allowed, apps: d.apps, lastPlace: d.lastPlace,
          endsAt: Math.max(d.endsAt, now() + 5 * 60000), swappedFrom: old.title
        });
        s.focus.stats.detours = s.detours.length - idx - 1;
        s.detours = s.detours.slice(idx + 1);
        s.lastSwapAt = now();
        return { newTitle: d.title, oldTitle: old.title, endsAt: s.focus.endsAt, level: old.level, ids: [d.id, ...parkedIds] };
      });
      r.ids.forEach(id => io.clear('detour:' + id));
      schedule('focus', r.endsAt);
      await io.show({
        kind: 'toast', level: r.level, sticky: true,
        text: `主线「${r.oldTitle}」时间到。「${r.newTitle}」重要且紧急，已置换为新主线；原主线已挂起，做完后会提示你恢复。2 小时内不能再置换。`
      }, null);
    }

    async function focusAction(action, title) {
      if (action === 'extend') {
        const r = await update(s => {
          if (!s.focus || s.focus.extended) return { error: '只能延长一次' };
          s.focus.extended = true;
          s.focus.endsAt = now() + Math.max(1, Math.ceil(s.focus.timeboxMin / 2)) * 60000;
          s.focus.wrapPending = false;
          return { ok: true, endsAt: s.focus.endsAt };
        });
        if (r.ok) schedule('focus', r.endsAt);
        return r;
      }
      // done / split / abandon：结束这一件事
      const r = await update(s => {
        const f = s.focus;
        if (!f) return { error: '没有进行中的主线' };
        if (action === 'split' && title && String(title).trim()) s.nextUp.push({ id: uid(), title: String(title).trim() });
        const ids = s.detours.map(d => d.id);
        for (const d of s.detours) parkDetour(s, d);
        s.detours = [];
        closeOpenSwitch(f);
        const sum = summarizeSwitches(f.switches, dwellMs);
        const summary = {
          focusId: f.id, title: f.title, outcome: action, startedAt: f.startedAt, endedAt: now(),
          plannedMin: f.timeboxMin, usedMin: Math.max(1, Math.round((now() - f.startedAt) / 60000)),
          stats: f.stats, breakdown: sum.counts, review: sum.review, distractMin: Math.round(dwellMs / 60000),
          swappedFrom: f.swappedFrom, laterCount: s.later.length
        };
        s.history.unshift({ ...summary, review: undefined, switches: f.switches || [] });
        s.history = s.history.slice(0, 30);
        s.focus = null;
        return { ok: true, ids, summary, level: f.level, parked: s.parked, suspended: s.suspended.at(-1) || null };
      });
      if (!r.ok) return r;
      io.clear('focus');
      r.ids.forEach(id => io.clear('detour:' + id));
      if (action !== 'abandon') {
        await io.show({ kind: 'summary', level: r.level, summary: r.summary, parked: r.parked, suspended: r.suspended }, null);
      }
      return { ok: true, summary: r.summary };
    }

    async function restore(timeboxMin) {
      const r = await update(s => {
        if (s.focus) return { error: '先结束当前主线' };
        const sp = s.suspended.pop();
        if (!sp) return { error: '没有被挂起的主线' };
        const tb = Math.max(1, Number(timeboxMin) || Math.ceil(sp.timeboxMin / 2));
        s.focus = newFocus({ title: sp.title, timeboxMin: tb, level: sp.level, allowed: sp.allowed, apps: sp.apps, lastPlace: sp.lastPlace });
        return { ok: true, title: sp.title, note: sp.note, place: sp.lastPlace, endsAt: s.focus.endsAt, level: sp.level };
      });
      if (!r.ok) return r;
      schedule('focus', r.endsAt);
      const moved = await io.switchTo(r.place);
      await io.show({ kind: 'return', level: r.level, title: r.title, toMain: true, note: r.note, restored: true }, moved ? r.place : null);
      return { ok: true };
    }

    async function discardSuspended() { return update(s => { s.suspended.pop(); return { ok: true }; }); }

    async function pause() {
      return update(s => {
        if (!s.focus) return { error: '没有进行中的主线' };
        if (s.focus.pauseUsed) return { error: '每件事只能暂停一次' };
        s.focus.pauseUsed = true;
        s.focus.pauseUntil = now() + 10 * 60000;
        return { ok: true };
      });
    }

    /* ---------- 岔路 ---------- */
    // place：登记时用户所在的位置；returnPlace：岔路结束后要回到的位置（不填则用当前线上次的位置）
    async function registerDetour(form, place, returnPlace) {
      if (form.urgent == null || form.important == null) return { error: '请先回答两个问题' };
      const quadrant = form.urgent ? (form.important ? 'IU' : 'UNI') : (form.important ? 'INU' : 'NUNI');
      const startNow = !!(form.urgent || form.doNow);
      const r = await update(s => {
        if (!s.focus) return { error: '还没有开始一件事' };
        const line = currentLine(s);
        if (startNow && s.detours.length >= MAX_DEPTH) return { error: `已经有 ${MAX_DEPTH} 层岔路了，先结束一层再开新的` };
        s.focus.stats.detours++;
        if (place) { const e = pendingSwitch(s.focus, place); if (e) { e.choice = 'detour'; e.dwellMs = 0; } }
        const item = {
          id: uid(), reason: form.reason || '其他',
          title: String(form.title || '').trim() || REASON_TITLE[form.reason] || '处理突发情况',
          quadrant, timeboxMin: Math.max(1, Math.min(240, Number(form.timeboxMin) || 5)),
          note: String(form.note || '').trim()
        };
        const back = returnPlace || form.returnPlace || line.lastPlace || place || null;
        if (!startNow) {
          parkDetour(s, item);
          return { ok: true, started: false, quadrant, title: item.title, level: s.focus.level, returnPlace: back };
        }
        const d = {
          ...item, startedAt: now(), endsAt: now() + item.timeboxMin * 60000, extended: false,
          returnPlace: back, lastPlace: place || null, parentTitle: line.title, allowed: [], apps: []
        };
        if (place && !samePlace(place, back)) placeAllow(d, place);
        s.detours.push(d);
        return { ok: true, started: true, quadrant, id: d.id, endsAt: d.endsAt, depth: s.detours.length, title: d.title, level: s.focus.level, returnPlace: back };
      });
      if (r.error) return r;
      if (r.started) {
        schedule('detour:' + r.id, r.endsAt);
        if (r.depth >= MAX_DEPTH) {
          await io.show({ kind: 'toast', level: r.level, text: `已经离主线 ${MAX_DEPTH} 步远了。这一层做完就往回走吧。` }, place);
        }
      } else {
        const where = r.quadrant === 'INU' ? '已搁置，主线收尾时会提醒你' : '已存入稍后清单';
        r.toast = { kind: 'toast', level: r.level, text: `「${r.title}」${QUAD_NAME[r.quadrant]}：${where}。继续主线。` };
      }
      return r;
    }

    async function endDetour(outcome = 'done') {
      const r = await update(s => {
        if (!s.focus) return null;
        const d = s.detours.pop();
        if (!d) return null;
        if (outcome === 'parked') parkDetour(s, d);
        if (outcome === 'promoted') s.nextUp.push({ id: d.id, title: d.title });
        const parent = currentLine(s);
        return {
          d, parentTitle: parent.title, toMain: s.detours.length === 0,
          wrapPending: s.focus.wrapPending && s.detours.length === 0,
          target: d.returnPlace || parent.lastPlace, fallback: parent.lastPlace, level: s.focus.level
        };
      });
      if (!r) return { error: '没有进行中的岔路' };
      io.clear('detour:' + r.d.id);
      let place = r.target;
      if (!(await io.switchTo(place))) {
        place = r.fallback;
        if (!(await io.switchTo(place))) place = null;
      }
      if (r.wrapPending) await showFocusEnd('紧急岔路已结束，现在给主线收尾。');
      else await io.show({ kind: 'return', level: r.level, title: r.parentTitle, toMain: r.toMain, note: r.d.note }, place);
      return { ok: true };
    }

    async function extendDetour() {
      const r = await update(s => {
        const d = s.detours.at(-1);
        if (!d) return { error: '没有进行中的岔路' };
        if (d.extended) return { error: '每条岔路只能延长一次' };
        d.extended = true;
        d.endsAt = now() + 5 * 60000;
        return { ok: true, id: d.id, endsAt: d.endsAt };
      });
      if (r.ok) schedule('detour:' + r.id, r.endsAt);
      return r;
    }

    async function detourTimeout(id) {
      const s = await load();
      if (!s.focus) return;
      const d = s.detours.find(x => x.id === id);
      if (!d) return;
      if (d !== s.detours.at(-1)) { schedule('detour:' + id, now() + 60000); return; } // 里面还有更深一层
      const level = s.focus.level;
      if (level === 0) return;
      if (level === 3) { // 严格档：自动搁置并切回
        await endDetour('parked');
        await io.show({ kind: 'toast', level, text: `严格档：岔路「${d.title}」超时，已自动搁置并带你回到「${d.parentTitle}」。` }, null);
        return;
      }
      await io.show({ kind: 'detour-timeout', level, title: d.title, parentTitle: d.parentTitle, canExtend: !d.extended, quadrant: d.quadrant }, null);
    }

    async function onAlarm(name) {
      if (name === 'focus') return focusTimeout();
      if (name.startsWith('detour:')) return detourTimeout(name.slice(7));
    }

    // 按当前状态重新安排计时器（中控重启、扩展从中控模式退回单机时用）
    async function resync() {
      const s = await load();
      if (!s.focus) return;
      schedule('focus', s.focus.endsAt);
      for (const d of s.detours) schedule('detour:' + d.id, d.endsAt);
    }

    /* ---------- 卡片 ---------- */
    async function detourFormCard(place, extra = {}) {
      const s = await load();
      if (!s.focus) return null;
      return { kind: 'detour-form', returnPlace: place || null, lineTitle: currentLine(s).title, ...extra };
    }
    async function offlineCard(place) {
      const s = await load();
      if (!s.focus || s.focus.level === 0) return null;
      if (s.detours.some(d => d.reason === '网络')) return null;
      if (now() - lastOffline < 60000) return null;
      lastOffline = now();
      return detourFormCard(place, { offline: true, preset: { reason: '网络', title: '修网络', urgent: true } });
    }

    /* ---------- 列表 ---------- */
    async function listAction({ list, id, action }) {
      return update(s => {
        const arr = s[list];
        if (!Array.isArray(arr)) return { error: 'bad list' };
        const i = arr.findIndex(x => x.id === id);
        if (i < 0) return { error: 'not found' };
        const [item] = arr.splice(i, 1);
        if (action === 'toNext') s.nextUp.push({ id: item.id, title: item.title || item.text });
        return { ok: true };
      });
    }

    // 中控接手：中控没有进行中的事、而扩展有，就采用扩展的状态
    async function adopt(other) {
      if (!other || !other.focus) return { adopted: false };
      const r = await update(s => {
        if (s.focus) return false;
        Object.assign(s, migrate(Object.assign(clone(DEFAULT_STATE), clone(other))));
        return true;
      });
      if (r) await resync();
      return { adopted: r };
    }

    return {
      getState, touch, recordPrompt, decision, labelSwitch, forget, startFocus, focusAction, restore, discardSuspended, pause,
      registerDetour, endDetour, extendDetour, onAlarm, resync, detourFormCard, offlineCard, listAction, adopt
    };
  }

  const api = {
    createEngine, isAllowed, currentLine, swapQuota, hostOf, isSearchUrl, normApp, samePlace, placeName, migrate,
    classify, summarizeSwitches, DISTRACT_DWELL_MS,
    QUAD_NAME, REASON_TITLE, REASON_SITES, REASON_APPS, IGNORED_APPS, BROWSER_APPS, SWAP_WINDOW_MS, MAX_DEPTH
  };
  root.FocusEngine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
