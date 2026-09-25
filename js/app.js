import { searchStops, departures, journeys, trip } from './api.js';
import {
  getFavorites,
  isFavorite,
  toggleFavorite,
  getCachedDepartures,
  setCachedDepartures,
  getPinnedStop,
  setPinnedStop,
  getRoutePref,
  setRoutePref,
  getCachedHomeJourneys,
  setCachedHomeJourneys,
} from './store.js';

// ---------- 「282」栏:U Schloßstr. 坐 282 回 Breitenbachplatz ----------
const S282 = {
  key: 'Schlossstr', // 站点 id 解析缓存的 key
  query: 'U Schloßstr.',
  match: /Schlo(ß|ss)str/i,
  name: 'U Schloßstr.',
  line: '282',
  skipDir: /Dardanellenweg/i, // 往 Dardanellenweg 的是反方向,不要
  track: 3, // 在线路图上追踪最近几班车
};

// ---------- 「Home」栏固定盯的站点与线路 ----------
const PINNED = {
  id: '900051202', // 写死站点 ID(U Breitenbachplatz),省掉首次解析请求 → 更快
  query: 'Breitenbachplatz', // 备用:若 id 缺失则按站名解析
  name: 'U Breitenbachplatz',
  latitude: 52.46694, // 站点坐标:算距离;DB 源(id 不通用)按坐标规划路线
  longitude: 13.30889,
  lines: ['282', '101', '248', 'U3', '186'], // 只看这几路
  dirs: { 282: /Dardanellenweg/i }, // 这些线路只看指定方向(282 只看往 Dardanellenweg)
};

// 格式化为柏林当地时间 HH:MM
function berlinTime(whenIso) {
  if (!whenIso) return '';
  try {
    return new Date(whenIso).toLocaleTimeString('de-DE', {
      timeZone: 'Europe/Berlin',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

// ---------- 工具函数 ----------

// 交通方式 -> 显示标签 + 配色类名(贴近柏林 BVG 官方配色)
const PRODUCT = {
  suburban: { label: 'S', cls: 'p-s' }, // S-Bahn 绿
  subway: { label: 'U', cls: 'p-u' }, // U-Bahn 蓝
  tram: { label: 'Tram', cls: 'p-tram' }, // 有轨电车 红
  bus: { label: 'Bus', cls: 'p-bus' }, // 公交 紫
  ferry: { label: 'F', cls: 'p-ferry' }, // 渡轮
  express: { label: 'IC', cls: 'p-express' },
  regional: { label: 'R', cls: 'p-regional' },
};

function productInfo(product) {
  return PRODUCT[product] || { label: '', cls: 'p-other' };
}

// 计算距离发车还有多少分钟(基于实时 when)
function minutesUntil(whenIso) {
  if (!whenIso) return null;
  const diffMs = new Date(whenIso).getTime() - Date.now();
  return Math.round(diffMs / 60000);
}

function countdownText(min) {
  if (min === null) return '—';
  if (min <= 0) return '现在';
  if (min === 1) return '1 分钟';
  return min + ' 分钟';
}

// 站名清洗:去掉末尾的 "(Berlin)" 之类
function cleanName(name) {
  return (name || '').replace(/\s*\(Berlin\)\s*/g, ' ').trim();
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------- 应用状态 ----------
const state = {
  tab: 'home', // home(Breitenbachplatz 发车) | s282(Schloßstr. 的 282) | go(定位去 Breitenbachplatz) | route | search | favorites
  homeJourneys: [], // 去固定站点的换乘方案
  routeSel: undefined, // 选中的线路组合签名;null = 全部;undefined = 未初始化(读本地偏好)
  s282: { deps: [], tracked: [] }, // Schloßstr. 的 282 发车 + 正在追踪的几趟车(含沿途站)
  mapShowAll: false, // 线路图是否展开前面折叠的站
  rtOpen: new Set(), // 已展开详情的方案

  currentStop: null, // { id, name }
  deps: [], // 当前站点的发车数据
  lineFilter: null, // 只看某条线路时的线路名
  pinnedDeps: [], // 固定站点的发车数据
  coords: null, // 最近一次定位坐标(会话内复用,避免重复请求权限)
  routeDest: null, // 路线目的地 { to, label };to 为站点 id 或坐标
  routeJourneys: [], // 路线换乘方案
  refreshTimer: null,
  tickTimer: null,
};

const app = document.getElementById('app');

// ---------- 视图渲染 ----------

function render() {
  if (state.currentStop) {
    renderDeparturesView();
  } else if (state.tab === 'home') {
    renderHome();
  } else if (state.tab === 's282') {
    render282();
  } else if (state.tab === 'go') {
    renderGo();
  } else if (state.tab === 'route') {
    renderRoute();
  } else if (state.tab === 'search') {
    renderSearch();
  } else {
    renderFavorites();
  }
  updateNav();
}

function updateNav() {
  document.querySelectorAll('.nav-btn').forEach((b) => {
    b.classList.toggle('active', !state.currentStop && b.dataset.tab === state.tab);
  });
  document.getElementById('bottomnav').style.display = state.currentStop ? 'none' : 'flex';
}

function stopRow(stop, { line = null, product = null, dist = true } = {}) {
  const distHtml = dist && stop.distance != null ? `<span class="dist">${stop.distance} m</span>` : '';
  const lineHtml = line
    ? `<span class="line-badge sm ${productInfo(product).cls}">${esc(line)}</span>`
    : '';
  return `<button class="stop-row" data-stop-id="${esc(stop.id)}" data-stop-name="${esc(stop.name)}" data-line="${esc(line || '')}">
    <span class="stop-name">${esc(cleanName(stop.name))}</span>
    ${distHtml}${lineHtml}
    <span class="chev">›</span>
  </button>`;
}

// ---- 固定路牌三个栏:
//   home) U Breitenbachplatz 本站发车表(只看指定几路车;282 只看往 Dardanellenweg)
//   s282) U Schloßstr. 往 Breitenbachplatz 的 282 时刻 + 整条线上车开到哪了
//   go)   按定位:从当前位置去 U Breitenbachplatz 的公交/地铁方案(按线路组合可选)
const HOME_PRODUCTS = ['subway', 'bus']; // 只坐公交和地铁
const NEAR_M = 400; // 离站这么近就不用规划路线

const onTab = (t) => state.tab === t && !state.currentStop;

// 固定栏通用头部:标题 + 刷新按钮
function tabHeader(title, reload) {
  const h = document.getElementById('header');
  h.innerHTML = `
    <span class="hspace"></span>
    <h1 class="htitle">${esc(title)}</h1>
    <button id="refresh-btn" class="hbtn">⟳</button>`;
  document.getElementById('refresh-btn').onclick = () => {
    const b = document.getElementById('refresh-btn');
    b.classList.add('spin');
    reload().finally(() => setTimeout(() => b.classList.remove('spin'), 500));
  };
}

// 定时:reload 每 refreshMs 拉一次数据,paint 每 10s 重画倒计时
function scheduleTab(tab, reload, paint, refreshMs) {
  stopTimers();
  state.refreshTimer = setInterval(() => onTab(tab) && reload(), refreshMs);
  state.tickTimer = setInterval(() => onTab(tab) && paint(), 10000);
}

// ---- Home:U Breitenbachplatz 发车 ----
function renderHome() {
  tabHeader(PINNED.name, loadPinned);
  const pinLines = PINNED.lines.map((l) => (PINNED.dirs[l] ? l + '(往 Dardanellenweg)' : l)).join(' · ');
  app.innerHTML = `
    <div class="tab-sub">${esc(pinLines)}</div>
    <div id="pin-status" class="pin-status"></div>
    <div id="pin-list" class="dep-list"><div class="loading">加载中…</div></div>`;
  if (state.pinnedDeps.length) paintPinned();
  loadPinned(); // 内部会先用缓存秒开
  scheduleTab('home', loadPinned, paintPinned, 30000);
}

// ---- 282:U Schloßstr. → Breitenbachplatz ----
function render282() {
  tabHeader('282 · ' + S282.name, load282);
  app.innerHTML = `
    <div class="tab-sub">往 U Breitenbachplatz 方向</div>
    <div id="s282-status" class="pin-status"></div>
    <div id="s282-list" class="dep-list"><div class="loading">加载中…</div></div>
    <div id="s282-map"></div>`;
  if (!state.s282.deps.length) state.s282.deps = getCachedDepartures('s282') || [];
  if (state.s282.deps.length) paint282();
  load282();
  scheduleTab('s282', load282, paint282, 30000);
}

// ---- 定位:从当前位置去 U Breitenbachplatz ----
function renderGo() {
  tabHeader('去 ' + PINNED.name, loadHomeRoutes);
  app.innerHTML = `
    <div class="tab-sub">从你现在的位置出发 · 只坐公交 / 地铁</div>
    <div id="rt-status" class="pin-status"></div>
    <div id="rt-chips" class="filter-bar rt-chips"></div>
    <div id="rt-note" class="rt-note"></div>
    <div id="rt-list" class="dep-list"><div class="loading">定位中…</div></div>`;
  // 秒开:先画上次的方案(已发车的会被丢弃)
  if (!state.homeJourneys.length) {
    const c = getCachedHomeJourneys();
    if (c) state.homeJourneys = c.journeys;
  }
  if (upcomingJourneys().length) paintHomeRoutes();
  loadHomeRoutes();
  scheduleTab('go', loadHomeRoutes, paintHomeRoutes, 60000);
}

function setStatus(id, text, warn = false) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('warn', warn);
}

// ---- 282 栏:U Schloßstr. 的 282(往 Breitenbachplatz)+ 线路图上的实时位置 ----

// 按站名解析站点 id 并永久缓存(与固定站点共用缓存表)
async function resolveStopId(key, query, re) {
  const cached = getPinnedStop('vbb:' + key);
  if (cached && cached.id) return cached;
  const results = await searchStops(query);
  const s =
    results.find((x) => re.test(x.name) && x.products && x.products.subway) ||
    results.find((x) => re.test(x.name));
  if (!s) throw new Error('未找到 ' + query);
  const stop = { id: s.id, name: s.name };
  setPinnedStop('vbb:' + key, stop);
  return stop;
}

const upcoming = (d) => {
  const m = minutesUntil(d.when);
  return m === null || m >= 0;
};

async function load282() {
  try {
    const stop = await resolveStopId(S282.key, S282.query, S282.match);
    let deps;
    try {
      deps = await departures(stop.id, { duration: 60, results: 30, products: ['bus'], timeout: 6000 });
    } catch (err) {
      // 缓存的 id 失效(404)→ 清掉重解析一次
      if (!/请求失败\(404\)/.test(err.message || '')) throw err;
      setPinnedStop('vbb:' + S282.key, { id: '', name: '' });
      throw err;
    }
    if (!onTab('s282')) return;
    const list = deps.filter((d) => d.line && d.line.name === S282.line && !S282.skipDir.test(d.direction || ''));
    state.s282.deps = list;
    setCachedDepartures('s282', list);
    paint282();

    // 追踪最近几班:拉每趟车的沿途站,推算它现在开到哪了
    const next = list.filter(upcoming).filter((d) => d.tripId).slice(0, S282.track);
    const trips = await Promise.all(next.map((d) => trip(d.tripId).catch(() => null)));
    if (!onTab('s282')) return;
    state.s282.tracked = next
      .map((dep, i) => ({ dep, trip: trips[i] }))
      .filter((x) => x.trip && Array.isArray(x.trip.stopovers) && x.trip.stopovers.length);
    paint282();
    setStatus('s282-status', '已更新 · 柏林时间 ' + berlinClock());
  } catch (err) {
    if (!onTab('s282')) return;
    const msg = err.message || '加载失败';
    if (state.s282.deps.length) {
      setStatus('s282-status', '⚠ ' + msg + ',显示上次数据', true);
    } else {
      const el = document.getElementById('s282-list');
      if (el) el.innerHTML = errorState(esc(msg), load282);
      setStatus('s282-status', '⚠ ' + msg, true);
    }
  }
}

function paint282() {
  const listEl = document.getElementById('s282-list');
  const mapEl = document.getElementById('s282-map');
  if (!listEl || !mapEl) return;
  const rows = state.s282.deps.filter(upcoming).sort((a, b) => new Date(a.when || 0) - new Date(b.when || 0));
  listEl.innerHTML = rows.length
    ? rows.slice(0, 4).map(depRowHtml).join('')
    : emptyState('近期暂无从 ' + esc(S282.name) + ' 开往 Breitenbachplatz 的 282');
  mapEl.innerHTML = routeMapHtml();
  const more = document.getElementById('rm-more');
  if (more)
    more.onclick = () => {
      state.mapShowAll = !state.mapShowAll;
      paint282();
    };
}

const soArr = (so) => so.arrival || so.plannedArrival || so.departure || so.plannedDeparture;
const soDep = (so) => so.departure || so.plannedDeparture || so.arrival || so.plannedArrival;

// 按沿途站实时时刻推算车的位置:
//   { kind: 'wait', idx: 0 } 还没从起点发车;{ kind: 'at', idx } 停在第 idx 站;
//   { kind: 'between', idx } 在 idx 与 idx+1 站之间;{ kind: 'done' } 已到终点
function tripPosition(stopovers) {
  const now = Date.now();
  const t = (x) => (x ? new Date(x).getTime() : NaN);
  if (now < t(soDep(stopovers[0]))) return { kind: 'wait', idx: 0 };
  for (let i = 0; i < stopovers.length; i++) {
    const arr = t(soArr(stopovers[i]));
    const dep = t(soDep(stopovers[i]));
    if (now >= arr && now <= dep) return { kind: 'at', idx: i };
    const nextArr = i + 1 < stopovers.length ? t(soArr(stopovers[i + 1])) : NaN;
    if (now > dep && now < nextArr) return { kind: 'between', idx: i };
  }
  return { kind: 'done' };
}

const stopKey = (so) => (so.stop && (so.stop.id || so.stop.name)) || '';

// 竖向线路图:从起点方向到 Breitenbachplatz,标出上车站、下车站和每班车的实时位置
function routeMapHtml() {
  const tracked = state.s282.tracked.filter((x) => upcoming(x.dep));
  if (!tracked.length) return '';
  // 以站点最全的那趟为底图,截到 Breitenbachplatz
  let base = tracked.reduce((a, b) => (b.trip.stopovers.length > a.length ? b.trip.stopovers : a), []);
  const endIdx = base.findIndex((so) => /Breitenbachplatz/i.test((so.stop && so.stop.name) || ''));
  if (endIdx >= 0) base = base.slice(0, endIdx + 1);
  const baseIdx = new Map(base.map((so, i) => [stopKey(so), i]));
  const boardIdx = base.findIndex((so) => S282.match.test((so.stop && so.stop.name) || ''));

  // 每班车在底图上的位置
  const markers = []; // { idx, between, label }
  for (const { dep, trip: tr } of tracked) {
    const pos = tripPosition(tr.stopovers);
    if (pos.kind === 'done') continue;
    const idx = baseIdx.get(stopKey(tr.stopovers[pos.idx]));
    if (idx == null) continue;
    const min = minutesUntil(dep.when);
    const label =
      (pos.kind === 'wait' ? '起点待发 · ' : '') + berlinTime(dep.when) + ' 班 · ' + (min <= 0 ? '即将到' : min + ' 分后到') + ' Schloßstr.';
    markers.push({ idx, between: pos.kind === 'between', label });
  }

  // 折叠最前面没车的站
  const firstBus = markers.length ? Math.min(...markers.map((m) => m.idx)) : boardIdx;
  const from = state.mapShowAll ? 0 : Math.max(0, Math.min(firstBus, boardIdx < 0 ? firstBus : boardIdx) - 1);

  const bus = (m) => `<div class="rm-bus"><span class="line-badge sm p-bus">282</span> ${esc(m.label)}</div>`;
  let html = '';
  for (let i = from; i < base.length; i++) {
    const so = base[i];
    const cls = i === boardIdx ? 'rm-board' : i === base.length - 1 && endIdx >= 0 ? 'rm-end' : '';
    const tag = i === boardIdx ? '<span class="rm-tag">上车</span>' : cls === 'rm-end' ? '<span class="rm-tag">下车</span>' : '';
    html += `<div class="rm-stop ${cls}">
      <span class="rm-dot"></span>
      <span class="rm-name">${esc(cleanName(so.stop && so.stop.name))}</span>${tag}
    </div>`;
    html += markers.filter((m) => m.idx === i && !m.between).map((m) => `<div class="rm-here">${bus(m)}</div>`).join('');
    html += markers.filter((m) => m.idx === i && m.between).map((m) => `<div class="rm-gap">${bus(m)}</div>`).join('');
  }
  const hidden = from;
  return `<div class="rm">
    <div class="rm-title">282 实时位置</div>
    ${hidden || state.mapShowAll ? `<button id="rm-more" class="rt-more rm-more">${state.mapShowAll ? '收起前面的站' : '↑ 前面还有 ' + hidden + ' 站'}</button>` : ''}
    ${html}
  </div>`;
}

// ---- 定位栏:去 U Breitenbachplatz 的方案 ----
// 两点间直线距离(米)
function distanceM(a, b) {
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * 6371000 * Math.asin(Math.sqrt(h)));
}

function fmtDist(m) {
  return m < 1000 ? m + ' m' : (m / 1000).toFixed(1) + ' km';
}

async function loadHomeRoutes() {
  const listEl = document.getElementById('rt-list');
  try {
    let coords;
    try {
      coords = await getPosition();
      state.coords = coords;
    } catch (e) {
      if (!state.coords) throw e;
      coords = state.coords; // 这次定位失败 → 沿用上次位置
    }
    if (!onTab('go')) return;

    // 人就在站边上:不用规划,提示去看 Home 的发车表
    const dist = distanceM(coords, PINNED);
    if (dist <= NEAR_M) {
      document.getElementById('rt-chips').innerHTML = '';
      document.getElementById('rt-note').textContent = '';
      if (listEl) listEl.innerHTML = emptyState('你就在 ' + esc(PINNED.name) + ' 附近(' + fmtDist(dist) + ')<br>发车时间看 Home 栏');
      setStatus('rt-status', '柏林时间 ' + berlinClock());
      return;
    }

    if (!upcomingJourneys().length && listEl) listEl.innerHTML = `<div class="loading">规划路线…</div>`;

    // 坐标取 4 位小数(约 10 m),让附近的人命中同一份代理缓存
    const from = { latitude: +coords.latitude.toFixed(4), longitude: +coords.longitude.toFixed(4), address: '我的位置' };
    let list = null;
    let src = null;
    let lastErr;
    for (const s of PINNED_SOURCES) {
      try {
        const to = s === 'vbb' ? PINNED.id : { latitude: PINNED.latitude, longitude: PINNED.longitude, address: PINNED.name };
        list = await journeys(from, to, { results: 8, products: HOME_PRODUCTS, src: s });
        src = s;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!onTab('go')) return;
    if (!list) throw lastErr || new Error('加载失败');
    state.homeJourneys = list;
    setCachedHomeJourneys(list, src);
    paintHomeRoutes();
    setStatus('rt-status', '已更新 · 柏林时间 ' + berlinClock() + ' · 离站 ' + fmtDist(dist) + (src === 'db' ? ' · DB 源' : ''));
  } catch (err) {
    if (!onTab('go')) return;
    const msg = err.message || '加载失败';
    if (upcomingJourneys().length) {
      setStatus('rt-status', '⚠ ' + msg + ',显示上次结果', true);
    } else if (listEl) {
      document.getElementById('rt-chips').innerHTML = '';
      listEl.innerHTML = errorState(esc(msg), loadHomeRoutes);
      setStatus('rt-status', '⚠ ' + msg, true);
    }
  }
}

// 方案里第一段乘车(不是步行)
const rides = (j) => j.legs.filter((l) => l.line);
const legDep = (l) => l.departure || l.plannedDeparture;
const legArr = (l) => l.arrival || l.plannedArrival;
const lineLabel = (line) => (line.name || '').replace(/^Bus\s+/, ''); // DB 源公交名带 "Bus " 前缀

// 线路组合签名,如 "186›U3";纯步行为 "步行"
function routeSig(j) {
  const r = rides(j);
  return r.length ? r.map((l) => lineLabel(l.line)).join('›') : '步行';
}

function journeyKey(j) {
  return j.legs.map((l) => (l.tripId || 'w') + '@' + (l.plannedDeparture || '')).join('|');
}

// 还赶得上的方案(第一段车未开走),去重、按上车时间排序
function upcomingJourneys() {
  const seen = new Set();
  return (state.homeJourneys || [])
    .filter((j) => j.legs && j.legs.length)
    .filter((j) => {
      const r = rides(j)[0];
      const m = minutesUntil(r ? legDep(r) : legArr(j.legs[j.legs.length - 1]));
      if (m !== null && m < 0) return false;
      const k = journeyKey(j);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => new Date(legDep(rides(a)[0] || a.legs[0])) - new Date(legDep(rides(b)[0] || b.legs[0])));
}

function journeyMinutes(j) {
  const a = legDep(j.legs[0]);
  const b = legArr(j.legs[j.legs.length - 1]);
  return a && b ? Math.round((new Date(b) - new Date(a)) / 60000) : null;
}

function sigBadges(j) {
  const r = rides(j);
  if (!r.length) return `<span class="jn-walk-ico">🚶</span>`;
  return r
    .map((l) => `<span class="line-badge sm ${productInfo(l.line.product).cls}">${esc(lineLabel(l.line))}</span>`)
    .join('<span class="rt-sep">›</span>');
}

function paintHomeRoutes() {
  const chipsEl = document.getElementById('rt-chips');
  const listEl = document.getElementById('rt-list');
  const noteEl = document.getElementById('rt-note');
  if (!chipsEl || !listEl) return;
  const all = upcomingJourneys();

  // 按线路组合分组 → 可选路线;快的排前面
  const groups = new Map();
  for (const j of all) {
    const sig = routeSig(j);
    const g = groups.get(sig) || { sig, sample: j, minDur: Infinity };
    const d = journeyMinutes(j);
    if (d != null) g.minDur = Math.min(g.minDur, d);
    groups.set(sig, g);
  }
  const options = [...groups.values()].sort((a, b) => a.minDur - b.minDur);

  if (state.routeSel === undefined) state.routeSel = getRoutePref();
  const pref = state.routeSel;
  const sel = pref && groups.has(pref) ? pref : null; // 偏好路线这会儿没班次 → 先看全部

  chipsEl.innerHTML =
    `<button class="chip ${sel ? '' : 'chip-on'}" data-sig="">全部</button>` +
    options
      .map(
        (o) => `<button class="chip rt-chip ${sel === o.sig ? 'chip-on' : ''}" data-sig="${esc(o.sig)}">
          ${sigBadges(o.sample)}<span class="rt-dur">${o.minDur !== Infinity ? o.minDur + '′' : ''}</span>
        </button>`
      )
      .join('');
  chipsEl.querySelectorAll('.chip').forEach((c) => {
    c.onclick = () => {
      state.routeSel = c.dataset.sig || null;
      setRoutePref(state.routeSel);
      paintHomeRoutes();
    };
  });

  noteEl.textContent = pref && !sel ? `你常选的 ${pref.replace(/›/g, ' › ')} 近期没有班次,先显示全部` : '';

  const rows = sel ? all.filter((j) => routeSig(j) === sel) : all;
  if (!rows.length) {
    listEl.innerHTML = emptyState('近期没有只坐公交/地铁去 ' + esc(PINNED.name) + ' 的方案');
    return;
  }
  listEl.innerHTML = rows.map(homeRowHtml).join('');
  listEl.querySelectorAll('details.rt-item').forEach((d) => {
    d.addEventListener('toggle', () => {
      if (d.open) state.rtOpen.add(d.dataset.key);
      else state.rtOpen.delete(d.dataset.key);
    });
  });
}

// 一条方案 = 一行路牌:线路 | 在哪上车/换乘、步行、到达 | 上车倒计时;点开看每段详情
function homeRowHtml(j) {
  const legs = j.legs;
  const r = rides(j);
  const first = r[0];
  const arr = berlinTime(legArr(legs[legs.length - 1]));
  const walk0 = legs[0].walking ? legMinutes(legs[0]) : 0;
  const key = journeyKey(j);

  let title = '步行前往';
  if (first) {
    title = cleanName(first.origin && first.origin.name) + ' 上车';
    if (r.length > 1) title += ' · ' + r.slice(1).map((l) => cleanName(l.origin && l.origin.name)).join('、') + ' 换乘';
  }

  const tags = [];
  if (first && first.cancelled) tags.push(`<span class="delay late">已取消</span>`);
  else if (first && first.departureDelay != null) {
    const dm = Math.round(first.departureDelay / 60);
    tags.push(
      dm >= 1
        ? `<span class="delay late">晚 ${dm} 分</span>`
        : dm <= -1
        ? `<span class="delay early">早 ${-dm} 分</span>`
        : `<span class="delay ontime">准点</span>`
    );
  }
  if (walk0) {
    const leaveIn = minutesUntil(legDep(legs[0]));
    tags.push(
      leaveIn !== null && leaveIn <= 0
        ? `<span class="delay late">🚶 ${walk0} 分 · 现在出门</span>`
        : `<span class="rt-tag">🚶 ${walk0} 分${leaveIn != null ? ' · ' + leaveIn + ' 分后出门' : ''}</span>`
    );
  }
  const last = legs[legs.length - 1];
  const walkEnd = legs.length > 1 && last.walking ? legMinutes(last) : 0;
  if (walkEnd) tags.push(`<span class="rt-tag">下车步行 ${walkEnd} 分</span>`);
  if (arr) tags.push(`<span class="rt-tag">${esc(arr)} 到</span>`);

  const min = minutesUntil(first ? legDep(first) : legDep(legs[0]));
  const urgent = min !== null && min <= Math.max(2, walk0) ? 'urgent' : '';
  const depTime = berlinTime(first ? legDep(first) : legDep(legs[0]));

  return `<details class="rt-item ${first && first.cancelled ? 'cancelled' : ''}" data-key="${esc(key)}" ${state.rtOpen.has(key) ? 'open' : ''}>
    <summary class="dep-row rt-row">
      <span class="rt-badges">${sigBadges(j)}</span>
      <span class="dep-mid">
        <span class="dep-dir">${esc(title)}</span>
        <span class="dep-sub rt-sub">${tags.join('')}</span>
      </span>
      <span class="dep-cd-wrap">
        <span class="dep-cd ${urgent}">${esc(countdownText(min))}</span>
        ${depTime ? `<span class="dep-time">${esc(depTime)} 发车</span>` : ''}
      </span>
    </summary>
    <div class="jn-legs rt-legs">${legs.map(legHtml).join('')}</div>
  </details>`;
}

// ---- Home 栏:U Breitenbachplatz 本站发车表(只看指定几路车)----
function setPinStatus(text, warn = false) {
  const el = document.getElementById('pin-status');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('warn', warn);
}

function berlinClock() {
  return new Date().toLocaleTimeString('de-DE', {
    timeZone: 'Europe/Berlin',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

// 数据源优先级:先 VBB(双镜像,含那几路公交),挂了再切 DB(独立后端,至少能保 U3/S-Bahn)
const PINNED_SOURCES = ['vbb', 'db'];

// 在指定源上按站名解析固定站点
async function resolvePinnedByName(src) {
  const results = await searchStops(PINNED.query, { src });
  const s =
    results.find((x) => /Breitenbachplatz/i.test(x.name) && x.products && x.products.subway) ||
    results.find((x) => /Breitenbachplatz/i.test(x.name)) ||
    results[0];
  if (!s) throw new Error('未找到该站点');
  return { id: s.id, name: s.name };
}

// 拉取固定看板发车:只要地铁+公交、缩短时长/条数、6s 超时
function fetchPinnedDeps(id, src) {
  return departures(id, { duration: 30, results: 25, products: ['subway', 'bus'], timeout: 6000, src });
}

// 从某个源取发车(站点 id 按源解析并缓存;写死 id 仅 vbb 用;404 自愈)
async function getDepsFromSource(src) {
  const key = src + ':' + PINNED.query;
  let stop = getPinnedStop(key) || (src === 'vbb' && PINNED.id ? { id: PINNED.id, name: PINNED.name } : null);
  if (!stop) {
    stop = await resolvePinnedByName(src);
    setPinnedStop(key, stop);
  }
  try {
    return { stop, deps: await fetchPinnedDeps(stop.id, src) };
  } catch (err) {
    if (/请求失败\(404\)|未找到/i.test(err.message || '')) {
      const resolved = await resolvePinnedByName(src);
      if (resolved.id !== stop.id) {
        setPinnedStop(key, resolved);
        return { stop: resolved, deps: await fetchPinnedDeps(resolved.id, src) };
      }
    }
    throw err;
  }
}

async function loadPinned() {
  const listEl = document.getElementById('pin-list');

  // 秒开:用上次成功的站点缓存立即渲染
  if (!state.pinnedDeps.length) {
    const last = getPinnedStop('last');
    const cached = last && getCachedDepartures(last.id);
    if (cached && cached.length) {
      state.pinnedDeps = cached;
      paintPinned();
    }
  }

  const refreshBtn = document.getElementById('refresh-btn');
  if (refreshBtn) refreshBtn.classList.add('spin');

  // 依次尝试各数据源,第一个成功即用
  let result = null;
  let lastErr;
  for (const src of PINNED_SOURCES) {
    try {
      result = { src, ...(await getDepsFromSource(src)) };
      break;
    } catch (e) {
      lastErr = e;
    }
  }

  try {
    if (!onTab('home')) return; // 用户已离开该栏
    if (!result) throw lastErr || new Error('加载失败');
    state.pinnedDeps = result.deps;
    setCachedDepartures(result.stop.id, result.deps);
    setPinnedStop('last', result.stop);
    paintPinned();
    setPinStatus('已更新 · 柏林时间 ' + berlinClock() + (result.src === 'db' ? ' · DB 源' : ''));
  } catch (err) {
    if (state.pinnedDeps.length) {
      setPinStatus('⚠ ' + (err.message || '刷新失败') + ',显示上次数据', true);
    } else if (listEl) {
      listEl.innerHTML = errorState('加载失败:' + (err.message || ''), loadPinned);
      setPinStatus('⚠ 两个数据源都无响应', true);
    }
  } finally {
    if (refreshBtn) refreshBtn.classList.remove('spin');
  }
}

function paintPinned() {
  const listEl = document.getElementById('pin-list');
  if (!listEl) return;
  const allow = new Set(PINNED.lines);
  const rows = state.pinnedDeps
    .filter((d) => d.line && allow.has(d.line.name))
    .filter((d) => !PINNED.dirs[d.line.name] || PINNED.dirs[d.line.name].test(d.direction || ''))
    .filter(upcoming)
    .sort((a, b) => new Date(a.when || 0) - new Date(b.when || 0));

  if (!rows.length) {
    listEl.innerHTML = emptyState('近期暂无这几路车(' + PINNED.lines.join('、') + ')的班次');
    return;
  }
  listEl.innerHTML = rows.map(depRowHtml).join('');
}

// 单条发车行(倒计时 + 柏林当地到达时间),供固定看板与站点详情共用
function depRowHtml(d) {
  const p = productInfo(d.line && d.line.product);
  const min = minutesUntil(d.when);
  const delay = d.delay; // 秒
  let delayTag = '';
  if (delay != null && Math.abs(delay) >= 60) {
    const m = Math.round(delay / 60);
    delayTag = delay > 0 ? `<span class="delay late">晚 ${m} 分</span>` : `<span class="delay early">早 ${-m} 分</span>`;
  } else if (delay != null) {
    delayTag = `<span class="delay ontime">准点</span>`;
  }
  const cancelled = d.cancelled ? `<span class="delay late">已取消</span>` : '';
  const time = berlinTime(d.when);
  const cd = countdownText(min);
  const urgent = min !== null && min <= 2 ? 'urgent' : '';
  return `<div class="dep-row ${d.cancelled ? 'cancelled' : ''}">
    <span class="line-badge ${p.cls}">${esc(d.line ? d.line.name : p.label)}</span>
    <span class="dep-mid">
      <span class="dep-dir">${esc(cleanName(d.direction) || '—')}</span>
      <span class="dep-sub">${delayTag}${cancelled}</span>
    </span>
    <span class="dep-cd-wrap">
      <span class="dep-cd ${urgent}">${esc(cd)}</span>
      ${time ? `<span class="dep-time">${esc(time)} 到站</span>` : ''}
    </span>
  </div>`;
}

// ---- 定位 ----
// 取当前位置(Promise 包一层 geolocation 回调)
function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('设备不支持定位'));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
      (err) => reject(new Error(err.code === 1 ? '定位被拒绝,请在系统/浏览器里允许位置权限' : '定位失败,请重试')),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 }
    );
  });
}

// ---- 路线:从我的位置到某个地点怎么坐车 ----
function renderRoute() {
  const h = document.getElementById('header');
  h.innerHTML = `
    <span class="hspace"></span>
    <h1 class="htitle">路线</h1>
    <button id="refresh-btn" class="hbtn">⟳</button>`;
  document.getElementById('refresh-btn').onclick = () => {
    if (!state.routeDest) return;
    const b = document.getElementById('refresh-btn');
    b.classList.add('spin');
    planRoute().finally(() => setTimeout(() => b.classList.remove('spin'), 500));
  };
  app.innerHTML = `
    <div class="search-wrap">
      <input id="route-input" class="search-input" type="search"
        placeholder="去哪儿?输入站点或地址" autocomplete="off" value="${esc(state._routeQuery || '')}">
    </div>
    <div id="route-results" class="list"></div>
    <div id="route-journeys" class="jn-list"></div>`;

  const input = document.getElementById('route-input');
  const results = document.getElementById('route-results');
  let timer;
  input.addEventListener('input', () => {
    state._routeQuery = input.value;
    state.routeDest = null; // 改了输入 → 目的地作废
    state.routeJourneys = [];
    document.getElementById('route-journeys').innerHTML = '';
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) {
      results.innerHTML = '';
      return;
    }
    results.innerHTML = `<div class="loading">搜索中…</div>`;
    timer = setTimeout(async () => {
      try {
        const items = await searchStops(q, { addresses: true, poi: true, results: 8 });
        state._routeSearch = items;
        results.innerHTML = items.length
          ? items.map((s, i) => routeResultRow(s, i)).join('')
          : emptyState('没有找到匹配的地点');
        bindRouteResults();
      } catch (err) {
        results.innerHTML = errorState('搜索失败:' + (err.message || ''));
      }
    }, 350);
  });

  // 回到该栏时:已选目的地 → 重新规划(刷新出发时间);否则若有历史输入则触发搜索
  if (state.routeDest) {
    planRoute();
  } else if ((state._routeQuery || '').trim().length >= 2) {
    input.dispatchEvent(new Event('input'));
  } else {
    input.focus();
  }
}

// 目的地显示名(站点用 name,地址用 address)
function placeLabel(item) {
  return cleanName(item.name || item.address || '');
}

// 搜索结果 → 路线目的地(站点用 id;地址/兴趣点用坐标)
function toPlace(item) {
  if (item.type === 'location' && item.latitude != null && item.longitude != null) {
    return { latitude: item.latitude, longitude: item.longitude, address: placeLabel(item) };
  }
  return item.id;
}

function routeResultRow(item, i) {
  const isStop = item.type !== 'location';
  return `<button class="stop-row" data-idx="${i}">
    <span class="stop-ico">${isStop ? '🚏' : '📍'}</span>
    <span class="stop-name">${esc(placeLabel(item))}</span>
    <span class="chev">›</span>
  </button>`;
}

function bindRouteResults() {
  document.querySelectorAll('#route-results .stop-row').forEach((row) => {
    row.onclick = () => {
      const item = state._routeSearch[+row.dataset.idx];
      if (!item) return;
      state.routeDest = { to: toPlace(item), label: placeLabel(item) };
      state._routeQuery = state.routeDest.label;
      const input = document.getElementById('route-input');
      if (input) {
        input.value = state.routeDest.label;
        input.blur();
      }
      document.getElementById('route-results').innerHTML = '';
      planRoute();
    };
  });
}

async function planRoute() {
  const el = document.getElementById('route-journeys');
  if (!el || !state.routeDest) return;
  el.innerHTML = `<div class="loading">定位并规划路线…</div>`;
  try {
    const coords = state.coords || (await getPosition());
    state.coords = coords;
    if (state.tab !== 'route' || !state.routeDest) return;
    const from = { latitude: coords.latitude, longitude: coords.longitude, address: '我的位置' };
    const list = await journeys(from, state.routeDest.to, { results: 4 });
    if (state.tab !== 'route' || !state.routeDest) return;
    state.routeJourneys = list;
    paintJourneys();
  } catch (err) {
    if (state.tab === 'route' && state.routeDest && el) {
      el.innerHTML = errorState('规划失败:' + (err.message || ''), planRoute);
    }
  }
}

function paintJourneys() {
  const el = document.getElementById('route-journeys');
  if (!el) return;
  const rows = (state.routeJourneys || []).filter((j) => j.legs && j.legs.length);
  el.innerHTML = rows.length
    ? `<div class="jn-dest">→ ${esc(state.routeDest.label)}</div>` + rows.map(journeyCard).join('')
    : emptyState('没找到合适的换乘方案');
}

// 一条 leg 的分钟数(到达 - 出发)
function legMinutes(leg) {
  const a = leg.departure || leg.plannedDeparture;
  const b = leg.arrival || leg.plannedArrival;
  if (!a || !b) return null;
  return Math.max(0, Math.round((new Date(b) - new Date(a)) / 60000));
}

function journeyCard(j) {
  const legs = j.legs;
  const dep = legs[0].departure || legs[0].plannedDeparture;
  const arr = legs[legs.length - 1].arrival || legs[legs.length - 1].plannedArrival;
  const durMin = dep && arr ? Math.round((new Date(arr) - new Date(dep)) / 60000) : null;
  const transfers = Math.max(0, legs.filter((l) => l.line).length - 1);
  const leaveIn = minutesUntil(dep);
  const leaveTxt = leaveIn === null ? '' : leaveIn <= 0 ? '现在出发' : leaveIn + ' 分钟后出发';
  return `<div class="jn-card">
    <div class="jn-head">
      <span class="jn-when">${esc(berlinTime(dep))} → ${esc(berlinTime(arr))}</span>
      <span class="jn-dur">${durMin != null ? '约 ' + durMin + ' 分钟' : ''}${transfers ? ' · 换乘 ' + transfers + ' 次' : ' · 直达'}</span>
      <span class="jn-meta">${esc(leaveTxt)}</span>
    </div>
    <div class="jn-legs">${legs.map(legHtml).join('')}</div>
  </div>`;
}

function legHtml(leg) {
  if (leg.line) {
    const p = productInfo(leg.line.product);
    const dep = berlinTime(leg.departure || leg.plannedDeparture);
    const arr = berlinTime(leg.arrival || leg.plannedArrival);
    return `<div class="jn-leg">
      <span class="line-badge ${p.cls}">${esc(leg.line.name)}</span>
      <div class="jn-leg-mid">
        <div class="jn-dir">往 ${esc(cleanName(leg.direction) || '—')}</div>
        <div class="jn-od">${esc(cleanName(leg.origin && leg.origin.name))} ${esc(dep)}
          &nbsp;→&nbsp; ${esc(cleanName(leg.destination && leg.destination.name))} ${esc(arr)}</div>
      </div>
    </div>`;
  }
  // 步行段
  const min = legMinutes(leg);
  const dist = leg.distance;
  const parts = [];
  if (dist) parts.push(dist + ' m');
  if (min) parts.push('约 ' + min + ' 分钟');
  return `<div class="jn-leg jn-walk">
    <span class="jn-walk-ico">🚶</span>
    <div class="jn-leg-mid"><div class="jn-dir">步行${parts.length ? ' · ' + parts.join(' · ') : ''}</div></div>
  </div>`;
}

// ---- 搜索 ----
function renderSearch() {
  setHeader('搜索站点');
  app.innerHTML = `
    <div class="search-wrap">
      <input id="search-input" class="search-input" type="search"
        placeholder="输入站名,如 Alexanderplatz" autocomplete="off" value="${esc(state._lastQuery || '')}">
    </div>
    <div id="search-results" class="list"></div>`;
  const input = document.getElementById('search-input');
  const results = document.getElementById('search-results');
  let timer;
  input.addEventListener('input', () => {
    state._lastQuery = input.value;
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) {
      results.innerHTML = '';
      return;
    }
    results.innerHTML = `<div class="loading">搜索中…</div>`;
    timer = setTimeout(async () => {
      try {
        const stops = await searchStops(q);
        results.innerHTML = stops.length
          ? stops.map((s) => stopRow(s)).join('')
          : emptyState('没有找到匹配的站点');
        bindStopRows();
      } catch (err) {
        results.innerHTML = errorState('搜索失败:' + (err.message || ''));
      }
    }, 350);
  });
  input.focus();
  if ((state._lastQuery || '').trim().length >= 2) {
    input.dispatchEvent(new Event('input'));
  }
}

// ---- 收藏 ----
function renderFavorites() {
  setHeader('收藏');
  const favs = getFavorites();
  if (!favs.length) {
    app.innerHTML = emptyState(
      '还没有收藏。<br>进入站点后点右上角 ☆ 收藏整站;<br>先选一条线路再点 ☆,即可收藏「站点+该线路」。'
    );
    return;
  }
  app.innerHTML = `<div class="list">${favs
    .map((f) => stopRow(f, { line: f.line, product: f.product, dist: false }))
    .join('')}</div>`;
  bindStopRows();
}

// ---- 站点发车详情 ----
function renderDeparturesView() {
  const stop = state.currentStop;
  const fav = isFavorite(stop.id, state.lineFilter);
  setHeader(cleanName(stop.name), true, fav);
  app.innerHTML = `
    <div id="filter-bar" class="filter-bar"></div>
    <div id="dep-list" class="dep-list"><div class="loading">加载发车信息…</div></div>`;
  loadDepartures();
}

async function loadDepartures() {
  const stop = state.currentStop;
  if (!stop) return;

  // 秒开:若本地有缓存,先立即渲染(倒计时按绝对时间算,缓存也准),再后台刷新
  if (!state.deps.length) {
    const cached = getCachedDepartures(stop.id);
    if (cached && cached.length) {
      state.deps = cached;
      paintDepartures();
    }
  }

  const refreshBtn = document.getElementById('refresh-btn');
  if (refreshBtn) refreshBtn.classList.add('spin');

  try {
    const deps = await departures(stop.id);
    if (!state.currentStop || state.currentStop.id !== stop.id) return; // 用户已离开该站
    state.deps = deps;
    setCachedDepartures(stop.id, deps);
    paintDepartures();
  } catch (err) {
    if (!state.currentStop || state.currentStop.id !== stop.id) return;
    // 只有在完全没有可显示数据时才报错;有缓存则继续显示、静默重试
    if (!state.deps.length) {
      document.getElementById('dep-list').innerHTML = errorState(
        '获取发车信息失败:' + (err.message || ''),
        loadDepartures
      );
    }
  } finally {
    if (refreshBtn) refreshBtn.classList.remove('spin');
    if (state.currentStop && state.currentStop.id === stop.id) scheduleRefresh();
  }
}

function paintDepartures() {
  const listEl = document.getElementById('dep-list');
  if (!listEl) return;

  // 线路过滤条
  const lines = [...new Set(state.deps.map((d) => d.line && d.line.name).filter(Boolean))];
  const filterBar = document.getElementById('filter-bar');
  if (lines.length > 1) {
    filterBar.innerHTML =
      `<button class="chip ${state.lineFilter ? '' : 'chip-on'}" data-line="">全部</button>` +
      lines
        .map((l) => `<button class="chip ${state.lineFilter === l ? 'chip-on' : ''}" data-line="${esc(l)}">${esc(l)}</button>`)
        .join('');
    filterBar.querySelectorAll('.chip').forEach((c) => {
      c.onclick = () => {
        state.lineFilter = c.dataset.line || null;
        updateFavButton(); // 收藏是「站点+线路」组合,切换线路后星标要同步
        paintDepartures();
      };
    });
  } else {
    filterBar.innerHTML = '';
  }

  updateFavButton();

  // 丢弃已过站的车次(尤其来自缓存的),只保留即将到站/未知时间的
  let rows = state.deps.filter((d) => {
    const m = minutesUntil(d.when);
    return m === null || m >= 0;
  });
  if (state.lineFilter) rows = rows.filter((d) => d.line && d.line.name === state.lineFilter);

  if (!rows.length) {
    listEl.innerHTML = emptyState('近期暂无发车信息');
    return;
  }

  listEl.innerHTML = rows.map(depRowHtml).join('');
}

// 每 30s 重新拉取,每 10s 只刷新倒计时文本
function scheduleRefresh() {
  clearInterval(state.refreshTimer);
  clearInterval(state.tickTimer);
  state.refreshTimer = setInterval(loadDepartures, 30000);
  state.tickTimer = setInterval(() => {
    if (state.currentStop) paintDepartures();
  }, 10000);
}

function stopTimers() {
  clearInterval(state.refreshTimer);
  clearInterval(state.tickTimer);
  state.refreshTimer = state.tickTimer = null;
}

// ---------- 头部 ----------
function setHeader(title, back = false, fav = false) {
  const h = document.getElementById('header');
  h.innerHTML = `
    ${back ? `<button id="back-btn" class="hbtn">‹</button>` : `<span class="hspace"></span>`}
    <h1 class="htitle">${esc(title)}</h1>
    ${
      back
        ? `<button id="fav-btn" class="hbtn ${fav ? 'faved' : ''}">${fav ? '★' : '☆'}</button>
           <button id="refresh-btn" class="hbtn">⟳</button>`
        : `<span class="hspace"></span>`
    }`;
  const back_ = document.getElementById('back-btn');
  if (back_)
    back_.onclick = () => {
      stopTimers();
      state.currentStop = null;
      state.deps = [];
      state.lineFilter = null;
      render();
    };
  const favBtn = document.getElementById('fav-btn');
  if (favBtn)
    favBtn.onclick = () => {
      // 找到当前线路的交通方式,收藏后徽章可显示对应配色
      let product = null;
      if (state.lineFilter) {
        const d = state.deps.find((x) => x.line && x.line.name === state.lineFilter);
        product = d && d.line ? d.line.product : null;
      }
      const nowFav = toggleFavorite({
        id: state.currentStop.id,
        name: state.currentStop.name,
        line: state.lineFilter,
        product,
      });
      favBtn.textContent = nowFav ? '★' : '☆';
      favBtn.classList.toggle('faved', nowFav);
      const target = state.lineFilter ? state.lineFilter + ' 线' : '整站';
      toast(nowFav ? `已收藏(${target})` : `已取消收藏(${target})`);
    };
  const refreshBtn = document.getElementById('refresh-btn');
  if (refreshBtn)
    refreshBtn.onclick = () => {
      refreshBtn.classList.add('spin');
      loadDepartures().finally(() => setTimeout(() => refreshBtn.classList.remove('spin'), 500));
    };
}

// ---------- 交互绑定 ----------
function bindStopRows() {
  document.querySelectorAll('.stop-row').forEach((row) => {
    row.onclick = () => {
      // 收藏行带 data-line 时自动应用该线路过滤;附近/搜索行无 line
      state.lineFilter = row.dataset.line || null;
      state.currentStop = { id: row.dataset.stopId, name: row.dataset.stopName };
      state.deps = [];
      render();
    };
  });
}

// 同步头部收藏星标为「当前站点 + 当前线路」组合的状态
function updateFavButton() {
  const btn = document.getElementById('fav-btn');
  if (!btn || !state.currentStop) return;
  const f = isFavorite(state.currentStop.id, state.lineFilter);
  btn.textContent = f ? '★' : '☆';
  btn.classList.toggle('faved', f);
}

// 轻提示
let toastTimer;
function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

// ---------- 通用小组件 ----------
function emptyState(msg) {
  return `<div class="empty">${msg}</div>`;
}
function errorState(msg, retryFn) {
  const id = 'retry-' + Math.random().toString(36).slice(2);
  setTimeout(() => {
    const b = document.getElementById(id);
    if (b && retryFn) b.onclick = retryFn;
  }, 0);
  return `<div class="error">
    <div>${msg}</div>
    ${retryFn ? `<button id="${id}" class="retry-btn">重试</button>` : ''}
  </div>`;
}

// ---------- 底部导航 ----------
document.querySelectorAll('.nav-btn').forEach((b) => {
  b.onclick = () => {
    stopTimers();
    state.tab = b.dataset.tab;
    state.currentStop = null;
    render();
  };
});

// 页面重新可见时刷新一次
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (state.currentStop) loadDepartures();
  else if (state.tab === 'home') loadPinned();
  else if (state.tab === 's282') load282();
  else if (state.tab === 'go') loadHomeRoutes();
});

// 注册 Service Worker(离线壳)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

render();
