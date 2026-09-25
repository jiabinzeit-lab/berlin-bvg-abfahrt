// 查票举报:来自 FreiFahren(开源非营利项目,汇总 Telegram 群 freiFahren_BE 与其 App 里的社群举报)。
// 接口公开、允许跨域:https://api.freifahren.org/v0/reports(默认最近 1 小时)
// 覆盖 U-Bahn / S-Bahn / Tram / 部分 Metrobus;普通公交(如 282)没有数据。
const API = 'https://api.freifahren.org/v0';
const TRANSIT_KEY = 'bvg.ff.transit.v1'; // 站点 + 线路站序,一天更新一次
const TRANSIT_TTL = 24 * 3600 * 1000;
const REPORTS_TTL = 60 * 1000; // 举报最多 1 分钟拉一次

let reports = [];
let reportsTs = 0;
let stations = null; // id → { name, coordinates: { latitude, longitude }, lines }
let lineStations = null; // 线路(去掉 -a/-b 变体后缀)→ [[站 id...], ...] 各变体的站序
let lineTypes = {}; // 线路 → subway / suburban / tram / bus
let job = null;

async function getJSON(path, timeout = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(API + path, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
    if (!res.ok) throw new Error('FreiFahren ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// M13-a / M13-b 这类变体归到同一条线
export const normLine = (id) => (id ? String(id).replace(/-[a-z]$/i, '') : null);

// 站名归一化,用来和 VBB 的站名对上(「U Schloßstr. (Berlin)」↔「Schloßstraße」)
export function normStation(name) {
  return (name || '')
    .toLowerCase()
    .replace(/\(berlin\)/g, '')
    .replace(/^(s\+u|u|s)\s+/, '')
    .replace(/ß/g, 'ss')
    .replace(/str\.?(?=\s|$|\/|\))/g, 'strasse')
    .replace(/straße/g, 'strasse')
    .replace(/\s+(bhf|bahnhof)\b/g, '')
    .replace(/[^a-z0-9äöü]+/g, '');
}

function indexTransit(data) {
  stations = data.stations;
  lineStations = {};
  lineTypes = {};
  for (const l of data.lines || []) {
    const k = normLine(l.id);
    lineTypes[k] = l.type;
    (lineStations[k] = lineStations[k] || []).push(l.stations || []);
  }
}

async function loadTransit() {
  if (stations) return;
  try {
    const c = JSON.parse(localStorage.getItem(TRANSIT_KEY));
    if (c && Date.now() - c.ts < TRANSIT_TTL && c.stations) return indexTransit(c);
  } catch {
    // 缓存坏了就重新拉
  }
  const [st, ln] = await Promise.all([getJSON('/transit/stations', 12000), getJSON('/transit/lines', 12000)]);
  const lines = (Array.isArray(ln) ? ln : []).map((l) => ({ id: l.id, type: l.type, stations: l.stations }));
  const data = { ts: Date.now(), stations: st, lines };
  indexTransit(data);
  try {
    localStorage.setItem(TRANSIT_KEY, JSON.stringify(data));
  } catch {
    // 存不下就只放内存
  }
}

// 拉最新举报(1 分钟内复用);返回是否有新数据
export function loadInspectors(force = false) {
  if (!force && Date.now() - reportsTs < REPORTS_TTL) return Promise.resolve(false);
  if (!job) {
    job = (async () => {
      await loadTransit();
      const list = await getJSON('/reports');
      reports = Array.isArray(list) ? list : [];
      reportsTs = Date.now();
      return true;
    })()
      .catch(() => false)
      .finally(() => (job = null));
  }
  return job;
}

export const inspectorsUpdatedAt = () => reportsTs;

// 给举报附上站名、坐标、方向名、几分钟前、是否已过期
function enrich(r, now) {
  const s = (stations && stations[r.stationId]) || {};
  const d = r.directionId && stations && stations[r.directionId];
  return {
    ...r,
    line: normLine(r.lineId),
    stationName: s.name || '',
    norm: normStation(s.name),
    latitude: s.coordinates && s.coordinates.latitude,
    longitude: s.coordinates && s.coordinates.longitude,
    directionName: d ? d.name : '',
    minutesAgo: Math.max(0, Math.round((now - new Date(r.timestamp).getTime()) / 60000)),
    expired: !!r.expiresAt && new Date(r.expiresAt).getTime() <= now,
  };
}

// 最近 1 小时的全部举报(含已过期),新的在前 —— 给「动态」信息流用
export function allReports() {
  const now = Date.now();
  return reports.map((r) => enrich(r, now)).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

// 仍有效的举报(未过期)
export function activeReports() {
  return allReports().filter((r) => !r.expired);
}

// 某条线上的举报(整条线任意站)
export function reportsOnLine(lineName) {
  return activeReports().filter((r) => r.line === lineName);
}

// 某站的举报(任意线路)
export function reportsAtStation(name) {
  const n = normStation(name);
  return n ? activeReports().filter((r) => r.norm === n) : [];
}

// 一段乘车(leg)上的举报:
//   已知线路的举报 → 只算同一条线,且在上车站、下车站或两站之间;
//   不知道线路的举报 → 只要在你上下车的站就算。
// (U3 在 Breitenbachplatz 查票,对坐 282 公交到 Breitenbachplatz 的人没影响)
export function reportsForLeg(leg) {
  if (!leg || !leg.line) return [];
  const name = leg.line.name;
  const o = normStation(leg.origin && leg.origin.name);
  const d = normStation(leg.destination && leg.destination.name);
  const variants = (lineStations && lineStations[name]) || [];
  return activeReports().filter((r) => {
    if (r.line && r.line !== name) return false;
    if (r.norm && (r.norm === o || r.norm === d)) return true; // 在你上下车的站
    if (!r.line) return false;
    for (const ids of variants) {
      const pos = (n) => ids.findIndex((id) => stations[id] && normStation(stations[id].name) === n);
      const i = pos(o);
      const j = pos(d);
      const k = ids.indexOf(r.stationId);
      if (i >= 0 && j >= 0 && k >= 0 && k >= Math.min(i, j) && k <= Math.max(i, j)) return true;
    }
    return false;
  });
}

// 线路的交通方式(用于徽章配色);未知时按名字猜
// FreiFahren 的类型名 → VBB 的交通方式名(S-Bahn 它叫 light_rail)
const TYPE_MAP = { light_rail: 'suburban', subway: 'subway', tram: 'tram', bus: 'bus' };

export function lineType(line) {
  if (!line) return null;
  if (lineTypes[line]) return TYPE_MAP[lineTypes[line]] || lineTypes[line];
  return /^U/.test(line) ? 'subway' : /^S/.test(line) ? 'suburban' : null;
}
