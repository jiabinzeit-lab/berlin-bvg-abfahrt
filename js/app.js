import { nearbyStops, searchStops, departures } from './api.js';
import { getFavorites, isFavorite, toggleFavorite, setFavoriteLine } from './store.js';

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
  tab: 'nearby', // nearby | search | favorites
  currentStop: null, // { id, name }
  deps: [], // 当前站点的发车数据
  lineFilter: null, // 只看某条线路时的线路名
  refreshTimer: null,
  tickTimer: null,
};

const app = document.getElementById('app');

// ---------- 视图渲染 ----------

function render() {
  if (state.currentStop) {
    renderDeparturesView();
  } else if (state.tab === 'nearby') {
    renderNearby();
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

function stopRow(stop, extra = '') {
  const dist = stop.distance != null ? `<span class="dist">${stop.distance} m</span>` : '';
  return `<button class="stop-row" data-stop-id="${esc(stop.id)}" data-stop-name="${esc(stop.name)}">
    <span class="stop-name">${esc(cleanName(stop.name))}</span>
    ${dist}${extra}
    <span class="chev">›</span>
  </button>`;
}

// ---- 附近 ----
async function renderNearby() {
  setHeader('附近站点');
  app.innerHTML = `<div class="loading">正在定位…</div>`;
  try {
    const pos = await getPosition();
    app.innerHTML = `<div class="loading">正在查找附近站点…</div>`;
    const stops = await nearbyStops(pos.latitude, pos.longitude);
    if (!stops.length) {
      app.innerHTML = emptyState('附近没有找到站点');
      return;
    }
    app.innerHTML = `<div class="list">${stops.map((s) => stopRow(s)).join('')}</div>`;
    bindStopRows();
  } catch (err) {
    app.innerHTML = errorState(
      err.code === 1 || /denied/i.test(err.message || '')
        ? '无法获取定位权限。请在浏览器/系统中允许定位,或改用「搜索」查站点。'
        : '获取附近站点失败:' + (err.message || '未知错误'),
      renderNearby
    );
  }
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
    app.innerHTML = emptyState('还没有收藏站点。<br>进入任意站点后点右上角 ☆ 即可收藏。');
    return;
  }
  app.innerHTML = `<div class="list">${favs
    .map((s) => stopRow(s, s.line ? `<span class="fav-line">只看 ${esc(s.line)}</span>` : ''))
    .join('')}</div>`;
  bindStopRows(true);
}

// ---- 站点发车详情 ----
function renderDeparturesView() {
  const stop = state.currentStop;
  const fav = isFavorite(stop.id);
  setHeader(cleanName(stop.name), true, fav);
  app.innerHTML = `
    <div id="filter-bar" class="filter-bar"></div>
    <div id="dep-list" class="dep-list"><div class="loading">加载发车信息…</div></div>`;
  loadDepartures();
}

async function loadDepartures() {
  const stop = state.currentStop;
  try {
    const deps = await departures(stop.id);
    state.deps = deps;
    paintDepartures();
    scheduleRefresh();
  } catch (err) {
    document.getElementById('dep-list').innerHTML = errorState(
      '获取发车信息失败:' + (err.message || ''),
      loadDepartures
    );
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
        // 若已收藏,记住该站默认只看的线路
        if (isFavorite(state.currentStop.id)) {
          setFavoriteLine(state.currentStop.id, state.lineFilter);
        }
        paintDepartures();
      };
    });
  } else {
    filterBar.innerHTML = '';
  }

  let rows = state.deps;
  if (state.lineFilter) rows = rows.filter((d) => d.line && d.line.name === state.lineFilter);

  if (!rows.length) {
    listEl.innerHTML = emptyState('近期暂无发车信息');
    return;
  }

  listEl.innerHTML = rows
    .map((d) => {
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
      const cd = countdownText(min);
      const urgent = min !== null && min <= 2 ? 'urgent' : '';
      return `<div class="dep-row ${d.cancelled ? 'cancelled' : ''}">
        <span class="line-badge ${p.cls}">${esc(d.line ? d.line.name : p.label)}</span>
        <span class="dep-mid">
          <span class="dep-dir">${esc(cleanName(d.direction) || '—')}</span>
          <span class="dep-sub">${delayTag}${cancelled}</span>
        </span>
        <span class="dep-cd ${urgent}">${esc(cd)}</span>
      </div>`;
    })
    .join('');
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
      const nowFav = toggleFavorite({
        id: state.currentStop.id,
        name: state.currentStop.name,
        line: state.lineFilter,
      });
      favBtn.textContent = nowFav ? '★' : '☆';
      favBtn.classList.toggle('faved', nowFav);
    };
  const refreshBtn = document.getElementById('refresh-btn');
  if (refreshBtn)
    refreshBtn.onclick = () => {
      refreshBtn.classList.add('spin');
      loadDepartures().finally(() => setTimeout(() => refreshBtn.classList.remove('spin'), 500));
    };
}

// ---------- 交互绑定 ----------
function bindStopRows(fromFav = false) {
  document.querySelectorAll('.stop-row').forEach((row) => {
    row.onclick = () => {
      const id = row.dataset.stopId;
      const name = row.dataset.stopName;
      // 若从收藏进入且该收藏记住了默认线路,自动应用过滤
      state.lineFilter = null;
      if (fromFav) {
        const fav = getFavorites().find((s) => s.id === id);
        if (fav && fav.line) state.lineFilter = fav.line;
      }
      state.currentStop = { id, name };
      state.deps = [];
      render();
    };
  });
}

// ---------- 定位 ----------
function getPosition() {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('设备不支持定位'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
      (err) => reject(err),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }
    );
  });
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

// 页面重新可见时刷新一次发车
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.currentStop) loadDepartures();
});

// 注册 Service Worker(离线壳)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

render();
