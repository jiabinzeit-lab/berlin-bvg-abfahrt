// 本地存储:收藏(站点 + 可选线路)与发车缓存。
const FAV_KEY = 'bvg.favorites.v1';
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

// ---------- 收藏 ----------
// 每条收藏 = { id, name, line|null, product|null }
// line 为 null 表示收藏整站;否则表示「该站的某条线路」。
export function getFavorites() {
  return read(FAV_KEY) || [];
}

function sameFav(f, id, line) {
  return f.id === id && (f.line || null) === (line || null);
}

export function isFavorite(id, line = null) {
  return getFavorites().some((f) => sameFav(f, id, line));
}

// 收藏 / 取消收藏(按 站点+线路 组合),返回收藏后的状态
export function toggleFavorite({ id, name, line = null, product = null }) {
  const list = getFavorites();
  const idx = list.findIndex((f) => sameFav(f, id, line));
  if (idx >= 0) {
    list.splice(idx, 1);
    write(FAV_KEY, list);
    return false;
  }
  list.push({ id, name, line: line || null, product: product || null });
  write(FAV_KEY, list);
  return true;
}

export function removeFavorite(id, line = null) {
  write(
    FAV_KEY,
    getFavorites().filter((f) => !sameFav(f, id, line))
  );
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
