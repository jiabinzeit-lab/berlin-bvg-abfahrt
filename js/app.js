import { searchStops, departures, journeys, trip } from './api.js';
import { loadInspectors, activeReports, reportsOnLine, reportsAtStation, reportsForLeg, normStation, lineType } from './inspectors.js';
import {
  getSaved,
  setSaved,
  newCardId,
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
  latitude: 52.467339, // 站点坐标:算距离;DB 源(id 不通用)按坐标规划路线
  longitude: 13.309276,
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
  tab: 'home', // home(Board:Breitenbachplatz 发车) | s282(Schloßstr. 的 282) | go(定位去 Breitenbachplatz) | saved(常去) | ff(查票)
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
  alertCache: {}, // 线路+方向 → { ts, list } 整条线的运营提示(2 分钟内复用)
  alertOpen: new Set(), // 已展开的提示
  homeAlerts: [],
  s282Alerts: [],
  svEdit: false, // 常去:编辑模式(排序/删除)
  svAdd: null, // 常去:正在添加的卡片草稿
  svSearch: [], // 常去:搜索结果
  svQuery: '', // 常去:搜索框内容
  svData: {}, // 常去:卡片 id → { deps | journeys, alerts, err, near }
  svOpen: new Set(), // 常去:已展开的目的地卡
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
  } else if (state.tab === 'ff') {
    renderFF();
  } else {
    renderSaved();
  }
  updateNav();
  if (!state.currentStop) refreshInspectors();
}

function updateNav() {
  document.querySelectorAll('.nav-btn').forEach((b) => {
    b.classList.toggle('active', !state.currentStop && b.dataset.tab === state.tab);
  });
  document.getElementById('bottomnav').style.display = state.currentStop ? 'none' : 'flex';
}

// ---- 固定路牌三个栏:
//   home) Board:U Breitenbachplatz 本站发车表(只看指定几路车;282 只看往 Dardanellenweg)
//   s282) U Schloßstr. 往 Breitenbachplatz 的 282 时刻 + 整条线上车开到哪了
//   go)   按定位:从当前位置去 U Breitenbachplatz 的公共交通方案(按线路组合可选)
// 公交 + Tram + U-Bahn + S-Bahn + 区域火车 RE/RB(不含 IC/ICE 长途和渡轮)
const HOME_PRODUCTS = ['subway', 'suburban', 'tram', 'bus', 'regional'];
const RAIL_PRODUCTS = ['subway', 'suburban', 'regional']; // 单独查一遍「只坐轨道」,补出 U 转 S 这类方案

// 路线更多元:同时查「允许的全部交通方式」和「只坐轨道(U / S / RE·RB)」,合并去重。
// 公交更快时 HAFAS 往往只给公交方案,单独查轨道才能看到 U9›S46›U3 这类换乘。
async function diverseJourneys(from, to, { products = null, results = 6, src } = {}) {
  const [main, rail] = await Promise.all([
    journeys(from, to, { results, products, src }),
    journeys(from, to, { results, products: RAIL_PRODUCTS, src }).catch(() => []), // 这一路失败不影响主结果
  ]);
  const seen = new Set();
  return [...main, ...rail].filter((j) => {
    if (!j.legs || !j.legs.length) return false;
    const k = journeyKey(j);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
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
  state.refreshTimer = setInterval(() => {
    if (!onTab(tab)) return;
    reload();
    refreshInspectors();
  }, refreshMs);
  state.tickTimer = setInterval(() => onTab(tab) && paint(), 10000);
}

// ---- Board:U Breitenbachplatz 发车 ----
function renderHome() {
  tabHeader(PINNED.name, loadPinned);
  const pinLines = PINNED.lines.map((l) => (PINNED.dirs[l] ? l + '(往 Dardanellenweg)' : l)).join(' · ');
  app.innerHTML = `
    <div class="tab-sub">${esc(pinLines)}</div>
    <div id="pin-status" class="pin-status"></div>
    <div id="pin-alerts" class="alerts"></div>
    <div id="pin-ff"></div>
    <div id="pin-list" class="dep-list"><div class="loading">加载中…</div></div>`;
  paintAlerts('pin-alerts', state.homeAlerts);
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
    <div id="s282-alerts" class="alerts"></div>
    <div id="s282-ff"></div>
    <div id="s282-list" class="dep-list"><div class="loading">加载中…</div></div>
    <div id="s282-map"></div>`;
  if (!state.s282.deps.length) state.s282.deps = getCachedDepartures('s282') || [];
  paintAlerts('s282-alerts', state.s282Alerts);
  if (state.s282.deps.length) paint282();
  load282();
  scheduleTab('s282', load282, paint282, 30000);
}

// ---- 定位:从当前位置去 U Breitenbachplatz ----
function renderGo() {
  tabHeader('去 ' + PINNED.name, loadHomeRoutes);
  app.innerHTML = `
    <div class="tab-sub">从你现在的位置出发 · 公交 / Tram / U / S / RE·RB</div>
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

// 发车时间:实时优先;取消的班次没有实时时间,用计划时间
const depWhen = (d) => d.when || d.plannedWhen;
const byWhen = (a, b) => new Date(depWhen(a) || 0) - new Date(depWhen(b) || 0);

const upcoming = (d) => {
  const m = minutesUntil(depWhen(d));
  return m === null || m >= 0;
};

async function load282() {
  try {
    const stop = await resolveStopId(S282.key, S282.query, S282.match);
    let deps;
    try {
      deps = await departures(stop.id, { duration: 60, results: 30, products: ['bus'], remarks: true, timeout: 6000 });
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
    const next = list.filter(upcoming).filter((d) => d.tripId && !d.cancelled).slice(0, S282.track);
    const trips = await Promise.all(next.map((d) => trip(d.tripId, { remarks: true }).catch(() => null)));
    if (!onTab('s282')) return;
    state.s282.tracked = next
      .map((dep, i) => ({ dep, trip: trips[i] }))
      .filter((x) => x.trip && Array.isArray(x.trip.stopovers) && x.trip.stopovers.length);
    state.s282Alerts = mergeAlerts(
      state.s282.tracked.flatMap(({ dep, trip: tr }) => tripWarnings(tr).map((r) => ({ r, line: dep.line.name }))),
      /Schlo(ß|ss)str|Breitenbachplatz/i
    );
    paintAlerts('s282-alerts', state.s282Alerts);
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
  const rows = state.s282.deps.filter(upcoming).sort(byWhen);
  const ffEl = document.getElementById('s282-ff');
  if (ffEl) ffEl.innerHTML = ffBannerHtml([...reportsAtStation(S282.name), ...reportsAtStation(PINNED.name)]);
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
    const min = minutesUntil(depWhen(dep));
    const label =
      (pos.kind === 'wait' ? '起点待发 · ' : '') + berlinTime(depWhen(dep)) + ' 班 · ' + (min <= 0 ? '即将到' : min + ' 分后到') + ' Schloßstr.';
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
      <span class="rm-name">${esc(cleanName(so.stop && so.stop.name))}</span>${tag}${ffStopTag(so.stop && so.stop.name)}
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

    // 人就在站边上:不用规划,提示去看 Board 的发车表
    const dist = distanceM(coords, PINNED);
    if (dist <= NEAR_M) {
      document.getElementById('rt-chips').innerHTML = '';
      document.getElementById('rt-note').textContent = '';
      if (listEl) listEl.innerHTML = emptyState('你就在 ' + esc(PINNED.name) + ' 附近(' + fmtDist(dist) + ')<br>发车时间看 Board 栏');
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
        list = await diverseJourneys(from, to, { results: 6, products: HOME_PRODUCTS, src: s });
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
function upcomingJourneys(list = state.homeJourneys) {
  const seen = new Set();
  return (list || [])
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
    listEl.innerHTML = emptyState('近期没有坐公共交通去 ' + esc(PINNED.name) + ' 的方案');
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
  const ffj = journeyInspectors(j);
  if (ffj.length) tags.unshift(ffTag(ffj));

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

// ---- Board 栏:U Breitenbachplatz 本站发车表(只看指定几路车)----
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
  return departures(id, { duration: 30, results: 25, products: ['subway', 'bus'], remarks: true, timeout: 6000, src });
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
    if (result.src === 'vbb') {
      alertsFor(pinnedRows(), stopNameRe(PINNED.name)).then((list) => {
        state.homeAlerts = list;
        if (onTab('home')) paintAlerts('pin-alerts', list);
      });
    }
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

// Board 要显示的车次:指定线路 + 指定方向 + 未开走
function pinnedRows() {
  const allow = new Set(PINNED.lines);
  return state.pinnedDeps
    .filter((d) => d.line && allow.has(d.line.name))
    .filter((d) => !PINNED.dirs[d.line.name] || PINNED.dirs[d.line.name].test(d.direction || ''))
    .filter(upcoming)
    .sort(byWhen);
}

function paintPinned() {
  const listEl = document.getElementById('pin-list');
  if (!listEl) return;
  const rows = pinnedRows();
  const ffEl = document.getElementById('pin-ff');
  if (ffEl) {
    const here = normStation(PINNED.name);
    ffEl.innerHTML = ffBannerHtml(activeReports().filter((r) => PINNED.lines.includes(r.line) || r.norm === here));
  }

  if (!rows.length) {
    listEl.innerHTML = emptyState('近期暂无这几路车(' + PINNED.lines.join('、') + ')的班次');
    return;
  }
  listEl.innerHTML = rows.map(depRowHtml).join('');
}

// 单条发车行(倒计时 + 柏林当地到达时间),供固定看板与站点详情共用
function depRowHtml(d) {
  const p = productInfo(d.line && d.line.product);
  const min = minutesUntil(depWhen(d));
  const delay = d.delay; // 秒
  let delayTag = '';
  if (delay != null && Math.abs(delay) >= 60) {
    const m = Math.round(delay / 60);
    delayTag = delay > 0 ? `<span class="delay late">晚 ${m} 分</span>` : `<span class="delay early">早 ${-m} 分</span>`;
  } else if (delay != null) {
    delayTag = `<span class="delay ontime">准点</span>`;
  }
  const codes = (d.remarks || []).filter((r) => r.type === 'status').map((r) => r.code || '');
  const cancelled = d.cancelled
    ? `<span class="delay late">已取消</span>`
    : codes.some((c) => /stop\.cancelled/.test(c))
    ? `<span class="delay late">本站不停</span>`
    : codes.some((c) => /partially\.cancelled/.test(c))
    ? `<span class="delay late">部分站不停</span>`
    : '';
  const time = berlinTime(depWhen(d));
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

// 一条 leg 的分钟数(到达 - 出发)
function legMinutes(leg) {
  const a = leg.departure || leg.plannedDeparture;
  const b = leg.arrival || leg.plannedArrival;
  if (!a || !b) return null;
  return Math.max(0, Math.round((new Date(b) - new Date(a)) / 60000));
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

// ---------- 运营提示:停运 / 绕行 / 施工 ----------
const ALERT_TTL = 120000; // 整条线的提示 2 分钟刷一次就够
const ALERT_NOISE = /elevator|\blift\b|aufzug|escalator|fahrtreppe|rolltreppe/i; // 电梯维修之类不打扰
// 影响小的(站点挪了几十米等):只有提到你用的站时才显示
const ALERT_MINOR = /moved stop|stop moved/i;
const ALERT_ZH = {
  Diversion: '绕行',
  'Moved Stop': '站点迁移',
  Disruption: '运营故障',
  'Construction work': '施工',
  'Construction works': '施工',
  Cancellation: '停运',
  'Stop moved': '站点临时迁移',
  'Replacement service': '替代交通',
  'Rail replacement service': '替代巴士',
  Delays: '延误',
};

function decodeEntities(str) {
  const t = document.createElement('textarea');
  t.innerHTML = str || '';
  return t.value;
}

// 一趟车带的运营提示(不带沿途站时在 trip.remarks,带沿途站时散在各站)
function tripWarnings(tr) {
  if (!tr) return [];
  return [...(tr.remarks || []), ...(tr.stopovers || []).flatMap((so) => so.remarks || [])].filter((r) => r.type === 'warning');
}

// [{ r, line }] → 去重合并,过滤电梯类、已过期的,以及与 stopRe 无关的小提示
function mergeAlerts(items, stopRe = null) {
  const map = new Map();
  for (const { r, line } of items) {
    const summary = decodeEntities(r.summary);
    const text = decodeEntities(r.text);
    if (ALERT_NOISE.test(summary + ' ' + text)) continue;
    if (ALERT_MINOR.test(summary) && !(stopRe && stopRe.test(text))) continue;
    if (r.validUntil && new Date(r.validUntil).getTime() < Date.now()) continue;
    const key = String(r.id || summary + '|' + text);
    const a = map.get(key) || { key, summary, text, validUntil: r.validUntil, priority: r.priority || 0, lines: new Set() };
    a.lines.add(line);
    map.set(key, a);
  }
  return [...map.values()].sort((a, b) => b.priority - a.priority);
}

// 每条「线路 + 方向」取最近一班车,拉整趟车的提示(只要提示、不要沿途站,很轻)
async function alertsFor(deps, stopRe = null) {
  const firsts = new Map();
  for (const d of deps) {
    if (!d.line || !d.tripId || !upcoming(d)) continue;
    const k = d.line.name + '|' + (d.direction || '');
    if (!firsts.has(k)) firsts.set(k, d);
  }
  const items = [];
  await Promise.all(
    [...firsts].map(async ([k, d]) => {
      let c = state.alertCache[k];
      if (!c || Date.now() - c.ts > ALERT_TTL) {
        try {
          c = { ts: Date.now(), list: tripWarnings(await trip(d.tripId, { stopovers: false, remarks: true })) };
          state.alertCache[k] = c;
        } catch {
          c = c || { ts: 0, list: [] };
        }
      }
      for (const r of c.list) items.push({ r, line: d.line.name });
    })
  );
  return mergeAlerts(items, stopRe);
}

// 站名 → 在提示正文里匹配它的正则(去掉 "U " / "(Berlin)" 等前后缀)
function stopNameRe(name) {
  const core = cleanName(name).replace(/^(S\+U|U|S)\s+/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return core ? new RegExp(core, 'i') : null;
}

function berlinDate(iso) {
  try {
    return new Date(iso).toLocaleDateString('zh-CN', { timeZone: 'Europe/Berlin', month: 'long', day: 'numeric' });
  } catch {
    return '';
  }
}

function alertsHtml(alerts) {
  return (alerts || [])
    .map(
      (a) => `<details class="alert" data-key="${esc(a.key)}" ${state.alertOpen.has(a.key) ? 'open' : ''}>
    <summary>
      <span class="alert-ico">⚠</span>
      <span class="alert-lines">${esc([...a.lines].join(' · '))}</span>
      <span class="alert-sum">${esc(ALERT_ZH[a.summary] || a.summary || '运营提示')}</span>
      <span class="alert-peek">${esc(a.text)}</span>
    </summary>
    <div class="alert-text">${esc(a.text)}${
        a.validUntil ? `<div class="alert-until">预计持续到 ${esc(berlinDate(a.validUntil))}</div>` : ''
      }</div>
  </details>`
    )
    .join('');
}

// 记住 <details> 的展开状态(定时重画后不收起)
function bindDetails(root) {
  root.querySelectorAll('details.alert').forEach((d) =>
    d.addEventListener('toggle', () => (d.open ? state.alertOpen.add(d.dataset.key) : state.alertOpen.delete(d.dataset.key)))
  );
  root.querySelectorAll('details.rt-item').forEach((d) =>
    d.addEventListener('toggle', () => (d.open ? state.rtOpen.add(d.dataset.key) : state.rtOpen.delete(d.dataset.key)))
  );
}

function paintAlerts(id, alerts) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = alertsHtml(alerts);
  bindDetails(el);
}

// ---------- 查票举报(FreiFahren 社群数据)----------
const ffAgo = (r) => (r.minutesAgo <= 0 ? '刚刚' : r.minutesAgo + ' 分钟前');
const ffColor = (min) => (min <= 10 ? '#F05044' : min <= 30 ? '#FF8A3D' : '#FACB3F');

// 拉最新举报;有新数据就重画当前栏里用到它的部分
function refreshInspectors(force = false) {
  return loadInspectors(force).then((changed) => {
    if (!changed || state.currentStop) return;
    if (state.tab === 'home') paintPinned();
    else if (state.tab === 's282') paint282();
    else if (state.tab === 'go') paintHomeRoutes();
    else if (state.tab === 'saved') paintSavedCards();
    else if (state.tab === 'ff') paintFF();
  });
}

// 一条方案途经路段上的举报(每段车:上下车站 + 同线路两站之间)
function journeyInspectors(j) {
  const seen = new Set();
  const out = [];
  for (const leg of rides(j)) {
    for (const r of reportsForLeg(leg)) {
      const k = r.stationId + '|' + r.lineId + '|' + r.timestamp;
      if (!seen.has(k)) {
        seen.add(k);
        out.push(r);
      }
    }
  }
  return out.sort((a, b) => a.minutesAgo - b.minutesAgo);
}

function ffTag(list) {
  if (!list || !list.length) return '';
  const r = list[0];
  return `<span class="delay ff">🎫 ${esc(r.stationName)}${r.line ? ' · ' + esc(r.line) : ''} · ${esc(ffAgo(r))}${
    list.length > 1 ? ' 等 ' + list.length + ' 处' : ''
  }</span>`;
}

function ffStopTag(name) {
  const list = reportsAtStation(name);
  return list.length ? `<span class="rm-ff">🎫 ${esc(list[0].line || '')} ${esc(ffAgo(list[0]))}</span>` : '';
}

// 举报横幅(Board、282 栏顶部)
function ffBannerHtml(list, max = 3) {
  if (!list.length) return '';
  const seen = new Set();
  list = list.filter((r) => {
    const k = r.stationId + '|' + r.lineId + '|' + r.timestamp;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return `<div class="ff-banner">${list
    .slice(0, max)
    .map(
      (r) => `<div class="ff-row"><span class="ff-ico">🎫</span><b>${esc(r.line || '?')}</b>
        <span class="ff-st">${esc(r.stationName)}${r.directionName ? ' → ' + esc(r.directionName) : ''}</span>
        <span class="ff-ago">${esc(ffAgo(r))}</span></div>`
    )
    .join('')}${list.length > max ? `<div class="ff-more">还有 ${list.length - max} 条 · 看「查票」栏</div>` : ''}</div>`;
}

// ---- 查票栏:最近 1 小时社群举报的火点地图 + 列表 ----
const ff = { map: null, layer: null, mine: false };
let leafletJob = null;

function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (!leafletJob) {
    leafletJob = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
      document.head.appendChild(css);
      const js = document.createElement('script');
      js.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
      js.onload = () => resolve(window.L);
      js.onerror = () => {
        leafletJob = null;
        reject(new Error('地图组件加载失败,请检查网络'));
      };
      document.head.appendChild(js);
    });
  }
  return leafletJob;
}

// 你常坐的线路:Board 的几路 + 常去站牌卡 + 定位栏方案里的线路
function myLines() {
  const set = new Set(PINNED.lines);
  for (const c of getSaved()) if (c.line) set.add(c.line);
  for (const j of state.homeJourneys || []) for (const l of rides(j)) set.add(l.line.name);
  return set;
}

function renderFF() {
  tabHeader('查票', () => refreshInspectors(true));
  app.innerHTML = `
    <div class="tab-sub">最近 1 小时的社群举报 · 越红越新 · 数据来自
      <a href="https://freifahren.org" target="_blank" rel="noopener">FreiFahren</a>(Telegram freiFahren_BE)</div>
    <div id="ff-map" class="ff-map"><div class="loading">加载地图…</div></div>
    <div id="ff-chips" class="filter-bar rt-chips"></div>
    <div id="ff-list" class="dep-list"></div>`;
  ff.map = null;
  document.getElementById('ff-chips').onclick = (e) => {
    const b = e.target.closest('[data-mine]');
    if (!b) return;
    ff.mine = b.dataset.mine === '1';
    paintFF();
  };
  document.getElementById('ff-list').onclick = (e) => {
    const row = e.target.closest('[data-lat]');
    if (row && ff.map) ff.map.flyTo([+row.dataset.lat, +row.dataset.lon], 15, { duration: 0.6 });
  };
  loadLeaflet()
    .then((L) => {
      if (!onTab('ff')) return;
      const el = document.getElementById('ff-map');
      el.innerHTML = '';
      const c = state.coords;
      ff.map = L.map(el, { zoomControl: false }).setView(c ? [c.latitude, c.longitude] : [52.505, 13.39], c ? 13 : 11);
      // OpenStreetMap 官方瓦片(免 key);用 CSS 反色成暗色,和 App 风格一致
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
      }).addTo(ff.map);
      ff.layer = L.layerGroup().addTo(ff.map);
      paintFF();
    })
    .catch((err) => {
      const el = document.getElementById('ff-map');
      if (el) el.innerHTML = errorState(esc(err.message));
    });
  paintFF();
  currentPosition()
    .then(() => onTab('ff') && paintFF())
    .catch(() => {});
  scheduleTab('ff', () => {}, paintFF, 60000);
}

function paintFF() {
  const listEl = document.getElementById('ff-list');
  const chipsEl = document.getElementById('ff-chips');
  if (!listEl || !chipsEl) return;
  const mine = myLines();
  const all = activeReports();
  const minePart = all.filter((r) => r.line && mine.has(r.line));
  const list = ff.mine ? minePart : all;
  chipsEl.innerHTML = `
    <button class="chip ${ff.mine ? '' : 'chip-on'}" data-mine="0">全部 ${all.length}</button>
    <button class="chip ${ff.mine ? 'chip-on' : ''}" data-mine="1">我的线路 ${minePart.length}</button>`;

  const me = state.coords;
  listEl.innerHTML = list.length
    ? list
        .map((r) => {
          const p = productInfo(lineType(r.line));
          const dist = me && r.latitude != null ? distanceM(me, r) : null;
          return `<div class="dep-row ff-item" ${r.latitude != null ? `data-lat="${r.latitude}" data-lon="${r.longitude}"` : ''}>
          <span class="line-badge ${p.cls}">${esc(r.line || '?')}</span>
          <span class="dep-mid">
            <span class="dep-dir">${esc(r.stationName || '未知站点')}</span>
            <span class="dep-sub rt-sub">${r.directionName ? `<span class="rt-tag">→ ${esc(r.directionName)}</span>` : ''}${
            dist != null ? `<span class="rt-tag">离你 ${esc(fmtDist(dist))}</span>` : ''
          }${r.line && mine.has(r.line) ? `<span class="delay late">你的线路</span>` : ''}</span>
          </span>
          <span class="dep-cd-wrap"><span class="dep-cd" style="color:${ffColor(r.minutesAgo)}">${esc(ffAgo(r))}</span></span>
        </div>`;
        })
        .join('')
    : emptyState(ff.mine ? '你的线路最近 1 小时没有查票举报' : '最近 1 小时没有查票举报(或数据暂时拿不到)');

  // 地图:同一站的举报合成一个火点,越新越红,次数越多越大;你的线路加白边
  if (ff.map && ff.layer && window.L) {
    const L = window.L;
    ff.layer.clearLayers();
    const byStation = new Map();
    for (const r of list) {
      if (r.latitude == null) continue;
      const g = byStation.get(r.stationId) || { r, items: [] };
      g.items.push(r);
      byStation.set(r.stationId, g);
    }
    for (const { r, items } of byStation.values()) {
      const hit = items.some((x) => x.line && mine.has(x.line));
      const lines = [...new Set(items.map((x) => x.line || '?'))].join(' · ');
      L.circleMarker([r.latitude, r.longitude], {
        radius: 8 + 3 * Math.min(items.length - 1, 4),
        color: hit ? '#ffffff' : ffColor(r.minutesAgo),
        weight: hit ? 3 : 1,
        fillColor: ffColor(r.minutesAgo),
        fillOpacity: 0.85,
      })
        .bindPopup(`<b>${esc(r.stationName)}</b><br>${esc(lines)}<br>${esc(ffAgo(r))}${items.length > 1 ? ' · 共 ' + items.length + ' 条' : ''}`)
        .addTo(ff.layer);
    }
    if (me) {
      L.circleMarker([me.latitude, me.longitude], { radius: 6, color: '#fff', weight: 2, fillColor: '#4c8dff', fillOpacity: 1 })
        .bindPopup('你在这里')
        .addTo(ff.layer);
    }
  }
}

// ---- 常去:自己做的站牌卡 + 目的地卡 ----

// 同一轮刷新里多张目的地卡共用一次定位
let posJob = null;
function currentPosition() {
  if (!posJob) {
    posJob = getPosition()
      .then((c) => (state.coords = c))
      .catch((e) => {
        if (state.coords) return state.coords;
        throw e;
      })
      .finally(() => setTimeout(() => (posJob = null), 20000));
  }
  return posJob;
}

function renderSaved() {
  const h = document.getElementById('header');
  h.innerHTML = `
    <button id="sv-edit" class="hbtn hbtn-text">${state.svEdit ? '完成' : '编辑'}</button>
    <h1 class="htitle">常去</h1>
    <button id="refresh-btn" class="hbtn">⟳</button>`;
  document.getElementById('sv-edit').onclick = () => {
    state.svEdit = !state.svEdit;
    renderSaved();
  };
  document.getElementById('refresh-btn').onclick = () => {
    const b = document.getElementById('refresh-btn');
    b.classList.add('spin');
    loadSaved(true).finally(() => setTimeout(() => b.classList.remove('spin'), 500));
  };
  app.innerHTML = `
    <div class="search-wrap">
      <input id="sv-input" class="search-input" type="search" autocomplete="off"
        placeholder="添加:搜地址存成「xx家」,或搜站点做站牌" value="${esc(state.svQuery)}">
    </div>
    <div id="sv-results" class="list"></div>
    <div id="sv-add"></div>
    <div id="sv-cards" class="sv-cards"></div>`;

  const input = document.getElementById('sv-input');
  const results = document.getElementById('sv-results');
  let timer;
  input.addEventListener('input', () => {
    state.svQuery = input.value;
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) {
      results.innerHTML = '';
      return;
    }
    results.innerHTML = `<div class="loading">搜索中…</div>`;
    timer = setTimeout(async () => {
      try {
        const found = await searchStops(q, { addresses: true, poi: true, results: 12 });
        if (input.value.trim() !== q) return;
        // 柏林市内的排前面(VBB 也覆盖勃兰登堡,同名街道常常排在前面)
        const inBerlin = (x) => /Berlin/.test(x.name || x.address || '');
        const items = [...found.filter(inBerlin), ...found.filter((x) => !inBerlin(x))].slice(0, 8);
        state.svSearch = items;
        results.innerHTML = items.length ? items.map((s, i) => routeResultRow(s, i)).join('') : emptyState('没有找到匹配的站点或地址');
        results.querySelectorAll('.stop-row').forEach((row) => {
          row.onclick = () => startAdd(state.svSearch[+row.dataset.idx]);
        });
      } catch (err) {
        results.innerHTML = errorState('搜索失败:' + esc(err.message || ''));
      }
    }, 350);
  });

  // 卡片上的按钮统一在容器上处理
  document.getElementById('sv-cards').onclick = (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const list = getSaved();
    const i = list.findIndex((c) => c.id === el.dataset.id);
    if (i < 0) return;
    const c = list[i];
    const act = el.dataset.act;
    if (act === 'up' || act === 'down') {
      const j = act === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      setSaved(list);
      paintSavedCards();
    } else if (act === 'del') {
      if (!confirm('删除「' + cardTitle(c) + '」?')) return;
      list.splice(i, 1);
      setSaved(list);
      delete state.svData[c.id];
      paintSavedCards();
    } else if (act === 'open-stop' && !state.svEdit) {
      state.currentStop = { id: c.stopId, name: c.stopName };
      state.lineFilter = c.line;
      state.deps = [];
      stopTimers();
      render();
    } else if (act === 'toggle-place') {
      if (state.svOpen.has(c.id)) state.svOpen.delete(c.id);
      else state.svOpen.add(c.id);
      paintCard(c);
    } else if (act === 'rename') {
      const name = prompt('给这张卡起个名字(如 小王家、公司)', cardTitle(c));
      if (name == null) return;
      c.label = name.trim() || (c.kind === 'stop' ? null : c.label);
      setSaved(list);
      paintCard(c);
    } else if (act === 'route') {
      c.routeSel = el.dataset.sig || null;
      setSaved(list);
      paintCard(c);
    }
  };

  paintAddPanel();
  paintSavedCards();
  loadSaved();
  scheduleTab('saved', () => loadSaved(), paintSavedCards, 30000);
}

function cardTitle(c) {
  if (c.kind === 'stop') return c.label || cleanName(c.stopName) + (c.line ? ' · ' + c.line : '');
  return c.label;
}

// ---- 添加卡片 ----
function startAdd(item) {
  if (!item) return;
  document.getElementById('sv-results').innerHTML = '';
  const isStop = item.type !== 'location';
  if (isStop) {
    state.svAdd = { kind: 'stop', stop: { id: item.id, name: item.name }, deps: null, err: null, line: null, dir: null };
    paintAddPanel();
    departures(item.id, { duration: 120, results: 120 })
      .then((deps) => {
        if (state.svAdd && state.svAdd.stop.id === item.id) state.svAdd.deps = deps;
      })
      .catch((err) => {
        if (state.svAdd && state.svAdd.stop.id === item.id) state.svAdd.err = err.message || '加载失败';
      })
      .finally(() => onTab('saved') && paintAddPanel());
  } else {
    state.svAdd = { kind: 'place', item, label: placeLabel(item) };
    paintAddPanel();
  }
}

function paintAddPanel() {
  const el = document.getElementById('sv-add');
  if (!el) return;
  const a = state.svAdd;
  if (!a) {
    el.innerHTML = '';
    return;
  }
  if (a.kind === 'place') {
    el.innerHTML = `<div class="sv-addbox">
      <div class="sv-add-title">📍 ${esc(a.label)}</div>
      <div class="sv-add-label">起个名字</div>
      <input id="sv-name" class="search-input" value="${esc(a.label)}" placeholder="如 公司、学校">
      <div class="sv-add-actions">
        <button id="sv-save" class="btn-primary">添加目的地</button>
        <button id="sv-cancel" class="btn-ghost">取消</button>
      </div>
    </div>`;
  } else {
    let body;
    if (a.err) body = `<div class="sv-add-msg warn">加载该站线路失败:${esc(a.err)}</div>`;
    else if (!a.deps) body = `<div class="sv-add-msg">加载该站的线路…</div>`;
    else {
      const lines = [];
      for (const d of a.deps) if (d.line && !lines.some((l) => l.name === d.line.name)) lines.push(d.line);
      const dirs = a.line
        ? [...new Set(a.deps.filter((d) => d.line && d.line.name === a.line).map((d) => d.direction).filter(Boolean))]
        : [];
      body = `
        <div class="sv-add-label">选线路</div>
        <div class="chip-wrap">
          <button class="chip ${a.line ? '' : 'chip-on'}" data-line="">整站全部</button>
          ${lines
            .map(
              (l) => `<button class="chip ${a.line === l.name ? 'chip-on' : ''}" data-line="${esc(l.name)}" data-product="${esc(l.product || '')}">${esc(l.name)}</button>`
            )
            .join('')}
        </div>
        ${
          a.line
            ? `<div class="sv-add-label">选方向</div>
        <div class="chip-wrap">
          <button class="chip ${a.dir ? '' : 'chip-on'}" data-dir="">两个方向</button>
          ${dirs.map((d) => `<button class="chip ${a.dir === d ? 'chip-on' : ''}" data-dir="${esc(d)}">→ ${esc(cleanName(d))}</button>`).join('')}
        </div>`
            : ''
        }`;
    }
    el.innerHTML = `<div class="sv-addbox">
      <div class="sv-add-title">🚏 ${esc(cleanName(a.stop.name))}</div>
      ${body}
      <div class="sv-add-actions">
        <button id="sv-save" class="btn-primary" ${a.deps ? '' : 'disabled'}>添加站牌</button>
        <button id="sv-as-place" class="btn-ghost">改成目的地</button>
        <button id="sv-cancel" class="btn-ghost">取消</button>
      </div>
    </div>`;
    el.querySelectorAll('[data-line]').forEach((b) => {
      b.onclick = () => {
        a.line = b.dataset.line || null;
        a.product = b.dataset.product || null;
        a.dir = null;
        paintAddPanel();
      };
    });
    el.querySelectorAll('[data-dir]').forEach((b) => {
      b.onclick = () => {
        a.dir = b.dataset.dir || null;
        paintAddPanel();
      };
    });
    const asPlace = document.getElementById('sv-as-place');
    if (asPlace)
      asPlace.onclick = () => {
        state.svAdd = { kind: 'place', item: { type: 'stop', id: a.stop.id, name: a.stop.name }, label: cleanName(a.stop.name) };
        paintAddPanel();
      };
  }
  document.getElementById('sv-cancel').onclick = () => {
    state.svAdd = null;
    paintAddPanel();
  };
  document.getElementById('sv-save').onclick = () => {
    let card;
    if (a.kind === 'place') {
      const name = (document.getElementById('sv-name').value || '').trim() || a.label;
      card = { id: newCardId(), kind: 'place', label: name, to: toPlace(a.item) };
    } else {
      card = { id: newCardId(), kind: 'stop', stopId: a.stop.id, stopName: a.stop.name, line: a.line, product: a.line ? a.product : null, dir: a.dir };
    }
    setSaved([...getSaved(), card]);
    state.svAdd = null;
    state.svQuery = '';
    const input = document.getElementById('sv-input');
    if (input) input.value = '';
    paintAddPanel();
    paintSavedCards();
    loadCard(card, true);
    toast('已添加「' + cardTitle(card) + '」');
  };
}

// ---- 卡片数据 ----
function cardMatch(c, d) {
  return (!c.line || (d.line && d.line.name === c.line)) && (!c.dir || d.direction === c.dir);
}

function loadSaved(force = false) {
  return Promise.all(getSaved().map((c) => loadCard(c, force)));
}

async function loadCard(c, force = false) {
  const data = state.svData[c.id] || (state.svData[c.id] = {});
  try {
    if (c.kind === 'stop') {
      const deps = await departures(c.stopId, {
        duration: 60,
        results: 40,
        remarks: true,
        ...(c.line && c.product ? { products: [c.product] } : {}),
      });
      if (!onTab('saved')) return;
      data.deps = deps.filter((d) => cardMatch(c, d));
      data.err = null;
      data.ts = Date.now();
      setCachedDepartures('card:' + c.id, data.deps);
      paintCard(c);
      if (c.line) {
        data.alerts = await alertsFor(data.deps, stopNameRe(c.stopName));
        if (onTab('saved')) paintCard(c);
      }
    } else {
      if (!force && data.ts && Date.now() - data.ts < 55000) return; // 路线 1 分钟刷一次就够
      const coords = await currentPosition();
      if (!onTab('saved')) return;
      if (typeof c.to === 'object' && distanceM(coords, c.to) <= NEAR_M) {
        data.near = true;
      } else {
        const me = { latitude: +coords.latitude.toFixed(4), longitude: +coords.longitude.toFixed(4), address: '我的位置' };
        data.journeys = await diverseJourneys(me, c.to, { results: 6, products: HOME_PRODUCTS });
        data.near = false;
      }
      if (!onTab('saved')) return;
      data.err = null;
      data.ts = Date.now();
      paintCard(c);
    }
  } catch (err) {
    data.err = err.message || '加载失败';
    if (onTab('saved')) paintCard(c);
  }
}

// ---- 卡片渲染 ----
function paintSavedCards() {
  const el = document.getElementById('sv-cards');
  if (!el) return;
  const cards = getSaved();
  el.innerHTML = cards.length
    ? cards.map(cardHtml).join('')
    : `<div class="empty sv-empty">还没有常去的卡片。在上面搜索:<br>
        🚏 <b>搜站点</b> → 选线路和方向 → 做成自己的站牌<br>
        🏠 <b>搜地址</b> → 起名如「小王家」→ 随时看从当前位置怎么去</div>`;
  bindDetails(el);
}

function paintCard(card) {
  const c = getSaved().find((x) => x.id === card.id);
  const el = document.querySelector(`.sv-card[data-id="${card.id}"]`);
  if (!c || !el) return;
  el.outerHTML = cardHtml(c);
  const fresh = document.querySelector(`.sv-card[data-id="${c.id}"]`);
  if (fresh) bindDetails(fresh);
}

function cardTools(c) {
  if (!state.svEdit) return '';
  return `<span class="sv-tools">
    <button class="sv-tool" data-act="rename" data-id="${c.id}">✎</button>
    <button class="sv-tool" data-act="up" data-id="${c.id}">↑</button>
    <button class="sv-tool" data-act="down" data-id="${c.id}">↓</button>
    <button class="sv-tool sv-del" data-act="del" data-id="${c.id}">✕</button>
  </span>`;
}

function cardHtml(c) {
  const d = state.svData[c.id] || {};
  if (c.kind === 'stop') return stopCardHtml(c, d);
  return placeCardHtml(c, d);
}

function stopCardHtml(c, d) {
  const badge = c.line
    ? `<span class="line-badge sm ${productInfo(c.product).cls}">${esc(c.line)}</span>`
    : `<span class="sv-ico">🚏</span>`;
  const dirTxt = c.dir ? '→ ' + cleanName(c.dir) : c.line ? '两个方向' : '整站';
  const deps = (d.deps || getCachedDepartures('card:' + c.id) || [])
    .filter(upcoming)
    .sort(byWhen);

  let body;
  if (!deps.length) {
    body = `<div class="sv-msg ${d.err ? 'warn' : ''}">${d.err ? '⚠ ' + esc(d.err) : d.ts ? '近期没有班次' : '加载中…'}</div>`;
  } else if (c.line && c.dir) {
    // 单线路单方向:横排三个倒计时,像站牌
    body = `<div class="sv-times">${deps
      .slice(0, 3)
      .map((x) => {
        const m = minutesUntil(depWhen(x));
        const late = x.delay != null && x.delay >= 60 ? ` <span class="sv-late">+${Math.round(x.delay / 60)}</span>` : '';
        const off = x.cancelled ? ' sv-off' : '';
        return `<span class="sv-t${off}"><b class="${m !== null && m <= 2 && !x.cancelled ? 'urgent' : ''}">${esc(x.cancelled ? '取消' : countdownText(m))}</b><small>${esc(berlinTime(depWhen(x)))}${late}</small></span>`;
      })
      .join('')}</div>`;
  } else {
    body = `<div class="sv-deps">${deps.slice(0, 4).map(depRowHtml).join('')}</div>`;
  }
  return `<div class="sv-card" data-id="${c.id}">
    <div class="sv-head">${badge}<span class="sv-title">${esc(c.label || cleanName(c.stopName))}</span><span class="sv-dir">${esc(dirTxt)}</span>${cardTools(c)}</div>
    <div class="sv-body" data-act="open-stop" data-id="${c.id}">${body}</div>
    ${(() => {
      const ffl = c.line ? reportsOnLine(c.line) : reportsAtStation(c.stopName);
      return ffl.length ? `<div class="sv-ffline">${ffTag(ffl)}</div>` : '';
    })()}
    ${d.alerts && d.alerts.length ? `<div class="alerts sv-alerts">${alertsHtml(d.alerts)}</div>` : ''}
  </div>`;
}

function placeCardHtml(c, d) {
  const open = state.svOpen.has(c.id);
  const all = upcomingJourneys(d.journeys || []);

  // 按线路组合分组 → 可选路线(快的排前);选中的这会儿没车就先看全部
  const groups = new Map();
  for (const j of all) {
    const sig = routeSig(j);
    const g = groups.get(sig) || { sig, sample: j, minDur: Infinity };
    const dur = journeyMinutes(j);
    if (dur != null) g.minDur = Math.min(g.minDur, dur);
    groups.set(sig, g);
  }
  const sel = c.routeSel && groups.has(c.routeSel) ? c.routeSel : null;
  const rows = sel ? all.filter((j) => routeSig(j) === sel) : all;

  let body;
  if (d.near) {
    body = `<div class="sv-msg">你就在附近</div>`;
  } else if (!rows.length) {
    body = `<div class="sv-msg ${d.err ? 'warn' : ''}">${d.err ? '⚠ ' + esc(d.err) : d.ts ? '近期没有合适的方案' : '定位并规划中…'}</div>`;
  } else {
    const j = rows[0];
    const leaveIn = minutesUntil(legDep(j.legs[0]));
    const arr = berlinTime(legArr(j.legs[j.legs.length - 1]));
    const dur = journeyMinutes(j);
    const leave = leaveIn === null ? '' : leaveIn <= 0 ? '现在出门' : leaveIn + ' 分后出门';
    const options = [...groups.values()].sort((a, b) => a.minDur - b.minDur);
    const chips =
      options.length > 1
        ? `<div class="chip-wrap sv-routes">
          <button class="chip ${sel ? '' : 'chip-on'}" data-act="route" data-id="${c.id}" data-sig="">全部</button>
          ${options
            .map(
              (o) => `<button class="chip rt-chip ${sel === o.sig ? 'chip-on' : ''}" data-act="route" data-id="${c.id}" data-sig="${esc(o.sig)}">
              ${sigBadges(o.sample)}<span class="rt-dur">${o.minDur !== Infinity ? o.minDur + '′' : ''}</span></button>`
            )
            .join('')}
        </div>`
        : '';
    const note = c.routeSel && !sel ? `<div class="rt-note">你选的 ${esc(c.routeSel.replace(/›/g, ' › '))} 近期没有班次,先显示全部</div>` : '';
    body = `<div class="sv-best" data-act="toggle-place" data-id="${c.id}">
        <span class="rt-badges">${sigBadges(j)}</span>
        <span class="sv-best-mid"><b class="${leaveIn !== null && leaveIn <= 1 ? 'urgent' : ''}">${esc(leave)}</b>
          <small>${esc(arr)} 到${dur != null ? ' · 约 ' + dur + ' 分' : ''}</small>${ffTag(journeyInspectors(j))}</span>
        <span class="sv-more">${open ? '收起' : '更多 ' + all.length}</span>
      </div>
      ${open ? `${note}${chips}<div class="sv-jn">${rows.map(homeRowHtml).join('')}</div>` : ''}`;
  }
  const ico = /家|home/i.test(c.label || '') ? '🏠' : '📍';
  return `<div class="sv-card" data-id="${c.id}">
    <div class="sv-head"><span class="sv-ico">${ico}</span><span class="sv-title">${esc(c.label)}</span><span class="sv-dir">从当前位置</span>${cardTools(c)}</div>
    <div class="sv-body">${body}</div>
  </div>`;
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


// ---- 站点发车详情 ----
function renderDeparturesView() {
  const stop = state.currentStop;
  setHeader(cleanName(stop.name), true);
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
    const deps = await departures(stop.id, { remarks: true });
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
        paintDepartures();
      };
    });
  } else {
    filterBar.innerHTML = '';
  }

  // 丢弃已过站的车次(尤其来自缓存的),只保留即将到站/未知时间的
  let rows = state.deps.filter((d) => {
    const m = minutesUntil(depWhen(d));
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
function setHeader(title, back = false) {
  const h = document.getElementById('header');
  h.innerHTML = `
    ${back ? `<button id="back-btn" class="hbtn">‹</button>` : `<span class="hspace"></span>`}
    <h1 class="htitle">${esc(title)}</h1>
    ${back ? `<button id="refresh-btn" class="hbtn">⟳</button>` : `<span class="hspace"></span>`}`;
  const back_ = document.getElementById('back-btn');
  if (back_)
    back_.onclick = () => {
      stopTimers();
      state.currentStop = null;
      state.deps = [];
      state.lineFilter = null;
      render();
    };
  const refreshBtn = document.getElementById('refresh-btn');
  if (refreshBtn)
    refreshBtn.onclick = () => {
      refreshBtn.classList.add('spin');
      loadDepartures().finally(() => setTimeout(() => refreshBtn.classList.remove('spin'), 500));
    };
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
  else if (state.tab === 'saved') loadSaved();
  if (!state.currentStop) refreshInspectors();
});

// 注册 Service Worker(离线壳)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

render();
