import { searchStops, departures } from './api.js';
import {
  getFavorites,
  isFavorite,
  toggleFavorite,
  getCachedDepartures,
  setCachedDepartures,
  getPinnedStop,
  setPinnedStop,
} from './store.js';

// ---------- 「附近」栏固定盯的站点与线路 ----------
const PINNED = {
  query: 'Breitenbachplatz', // 用于首次解析站点 ID
  name: 'U Breitenbachplatz',
  lines: ['282', '101', '248', 'U3', '186'], // 只看这几路
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
  tab: 'nearby', // nearby(固定站点) | search | favorites
  currentStop: null, // { id, name }
  deps: [], // 当前站点的发车数据
  lineFilter: null, // 只看某条线路时的线路名
  pinnedDeps: [], // 固定站点的发车数据
  refreshTimer: null,
  tickTimer: null,
};

const app = document.getElementById('app');

// ---------- 视图渲染 ----------

function render() {
  if (state.currentStop) {
    renderDeparturesView();
  } else if (state.tab === 'nearby') {
    renderPinned();
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

// ---- 附近:固定站点看板(U Breitenbachplatz,只看指定几路车)----
function renderPinned() {
  const h = document.getElementById('header');
  h.innerHTML = `
    <span class="hspace"></span>
    <h1 class="htitle">${esc(PINNED.name)}</h1>
    <button id="refresh-btn" class="hbtn">⟳</button>`;
  document.getElementById('refresh-btn').onclick = () => {
    const b = document.getElementById('refresh-btn');
    b.classList.add('spin');
    loadPinned().finally(() => setTimeout(() => b.classList.remove('spin'), 500));
  };
  app.innerHTML = `<div id="pin-list" class="dep-list"><div class="loading">加载中…</div></div>`;
  loadPinned();
}

async function loadPinned() {
  const listEl = document.getElementById('pin-list');
  try {
    // 解析并缓存站点 ID(仅首次需要联网,之后永久走缓存)
    let stop = getPinnedStop(PINNED.query);
    if (!stop) {
      const results = await searchStops(PINNED.query);
      stop =
        results.find((s) => /Breitenbachplatz/i.test(s.name) && s.products && s.products.subway) ||
        results.find((s) => /Breitenbachplatz/i.test(s.name)) ||
        results[0];
      if (!stop) throw new Error('未找到该站点');
      setPinnedStop(PINNED.query, stop);
    }

    // 秒开:先渲染缓存,再后台刷新
    if (!state.pinnedDeps.length) {
      const cached = getCachedDepartures(stop.id);
      if (cached && cached.length) {
        state.pinnedDeps = cached;
        paintPinned();
      }
    }

    const refreshBtn = document.getElementById('refresh-btn');
    if (refreshBtn) refreshBtn.classList.add('spin');

    // 只请求地铁 + 公交,payload 更小、更快
    const deps = await departures(stop.id, { duration: 60, results: 40, products: ['subway', 'bus'] });
    if (state.tab !== 'nearby' || state.currentStop) return; // 用户已离开该栏
    state.pinnedDeps = deps;
    setCachedDepartures(stop.id, deps);
    paintPinned();
  } catch (err) {
    if (!state.pinnedDeps.length && listEl) {
      listEl.innerHTML = errorState('加载失败:' + (err.message || ''), loadPinned);
    }
  } finally {
    const refreshBtn = document.getElementById('refresh-btn');
    if (refreshBtn) refreshBtn.classList.remove('spin');
    if (state.tab === 'nearby' && !state.currentStop) schedulePinnedRefresh();
  }
}

function paintPinned() {
  const listEl = document.getElementById('pin-list');
  if (!listEl) return;
  const allow = new Set(PINNED.lines);
  const rows = state.pinnedDeps
    .filter((d) => d.line && allow.has(d.line.name))
    .filter((d) => {
      const m = minutesUntil(d.when);
      return m === null || m >= 0;
    })
    .sort((a, b) => new Date(a.when || 0) - new Date(b.when || 0));

  if (!rows.length) {
    listEl.innerHTML = emptyState('近期暂无这几路车(' + PINNED.lines.join('、') + ')的班次');
    return;
  }
  listEl.innerHTML = rows.map(depRowHtml).join('');
}

function schedulePinnedRefresh() {
  clearInterval(state.refreshTimer);
  clearInterval(state.tickTimer);
  state.refreshTimer = setInterval(loadPinned, 30000);
  state.tickTimer = setInterval(() => {
    if (state.tab === 'nearby' && !state.currentStop) paintPinned();
  }, 10000);
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
  else if (state.tab === 'nearby') loadPinned();
});

// 注册 Service Worker(离线壳)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

render();
