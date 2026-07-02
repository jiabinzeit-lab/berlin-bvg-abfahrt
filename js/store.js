// 收藏站点的本地存储(localStorage)。
const KEY = 'bvg.favorites.v1';

function read() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || [];
  } catch {
    return [];
  }
}

function write(list) {
  localStorage.setItem(KEY, JSON.stringify(list));
}

export function getFavorites() {
  return read();
}

export function isFavorite(id) {
  return read().some((s) => s.id === id);
}

// 收藏时可附带默认过滤的线路(用于「只看某条线路」)
export function toggleFavorite(stop) {
  const list = read();
  const idx = list.findIndex((s) => s.id === stop.id);
  if (idx >= 0) {
    list.splice(idx, 1);
    write(list);
    return false;
  }
  list.push({ id: stop.id, name: stop.name, line: stop.line || null });
  write(list);
  return true;
}

// 记住某个收藏站点默认只看哪条线路
export function setFavoriteLine(id, line) {
  const list = read();
  const s = list.find((x) => x.id === id);
  if (s) {
    s.line = line;
    write(list);
  }
}
