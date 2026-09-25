// 本地存储:常去卡片、发车缓存、固定站点 id 等。
const DEP_KEY = 'bvg.depcache.v1';

function read(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}
function write(key, val) {
  localStorage.setItem(key, JSON.stringify(val));
}

// ---------- 常去 ----------
// 卡片两种:
//   站牌 { id, kind: 'stop', stopId, stopName, line|null, product|null, dir|null }(line/dir 为 null = 不限)
//   目的地 { id, kind: 'place', label, to }(to = 站点 id,或 { latitude, longitude, address })
const SAVED_KEY = 'bvg.saved.v1';
const OLD_FAV_KEY = 'bvg.favorites.v1';

export function newCardId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function getSaved() {
  let list = read(SAVED_KEY);
  if (!Array.isArray(list)) {
    // 首次:把旧「收藏」迁移成站牌卡
    list = (read(OLD_FAV_KEY) || []).map((f) => ({
      id: newCardId(),
      kind: 'stop',
      stopId: f.id,
      stopName: f.name,
      line: f.line || null,
      product: f.product || null,
      dir: null,
    }));
    write(SAVED_KEY, list);
  }
  return list;
}

export function setSaved(list) {
  write(SAVED_KEY, list);
}

// ---------- 固定站点 ID 解析缓存 ----------
// 「附近」栏固定盯某一站,首次按站名解析出 ID 后永久缓存,之后直接用。
const PIN_KEY = 'bvg.pinnedstop.v1';
export function getPinnedStop(query) {
  const m = read(PIN_KEY) || {};
  return m[query] || null;
}
export function setPinnedStop(query, stop) {
  const m = read(PIN_KEY) || {};
  m[query] = { id: stop.id, name: stop.name };
  write(PIN_KEY, m);
}

// ---------- 发车缓存(用于秒开) ----------
// 按站点 id 缓存最近一次发车数据。倒计时基于绝对时间计算,缓存数据也能正确倒计时。
export function getCachedDepartures(id) {
  const all = read(DEP_KEY) || {};
  return all[id] ? all[id].deps : null;
}

export function setCachedDepartures(id, deps) {
  const all = read(DEP_KEY) || {};
  all[id] = { ts: Date.now(), deps };
  // 限制缓存条目数,淘汰最旧的
  const ids = Object.keys(all);
  if (ids.length > 30) {
    ids
      .map((k) => [k, all[k].ts])
      .sort((a, b) => a[1] - b[1])
      .slice(0, ids.length - 30)
      .forEach(([k]) => delete all[k]);
  }
  write(DEP_KEY, all);
}

// ---------- 「Home」路牌:去固定站点的路线 ----------
// 用户选中的路线(线路组合签名,如 "186›U3";null = 全部),下次打开沿用。
const ROUTE_PREF_KEY = 'bvg.homeroute.v1';
export function getRoutePref() {
  return read(ROUTE_PREF_KEY);
}
export function setRoutePref(sig) {
  write(ROUTE_PREF_KEY, sig || null);
}

// 最近一次的换乘方案(秒开用;显示前会丢弃已发车的)
const HOME_JN_KEY = 'bvg.homejn.v1';
export function getCachedHomeJourneys() {
  const c = read(HOME_JN_KEY);
  return c && Array.isArray(c.journeys) ? c : null;
}
export function setCachedHomeJourneys(journeys, src) {
  try {
    write(HOME_JN_KEY, { ts: Date.now(), src, journeys });
  } catch {
    // 配额满就不缓存,不影响使用
  }
}

// ---------- 「动态」栏关注的线路(排最上面)----------
const FOLLOW_KEY = 'bvg.ff.follow.v1';
export function getFollowLines() {
  const v = read(FOLLOW_KEY);
  return Array.isArray(v) ? v : ['U3', 'U9'];
}
export function setFollowLines(lines) {
  write(FOLLOW_KEY, lines);
}
