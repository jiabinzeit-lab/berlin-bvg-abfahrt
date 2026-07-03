// BVG 实时公交数据接口封装。
// 请求优先走自己的缓存代理(Netlify 函数:双镜像取更快者 + CDN 缓存 ~15s),
// 代理不可用时自动回退到直连公共 API。
// 文档:https://v6.bvg.transport.rest/
const API_BASE = 'https://v6.bvg.transport.rest';
const PROXY_BASE = 'https://berlin-bvg-abfahrt-8373.netlify.app/api/proxy';
const USE_PROXY = true;

const DEFAULT_TIMEOUT = 7000;

// 单次请求(带超时);429/503/非 2xx 抛错。
async function fetchOnce(fullUrl, timeout) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(fullUrl, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
    if (res.status === 429 || res.status === 503) throw new Error('服务器繁忙(' + res.status + ')');
    if (!res.ok) throw new Error('请求失败(' + res.status + ')');
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// 请求策略:优先缓存代理;仅当「代理本身不可达」时才回退直连。
// 代理已在服务器端竞速 bvg/vbb 两个源,若它明确回报上游 5xx/404,直连也会失败,不再多等。
async function fetchJSON(pathname, { timeout = DEFAULT_TIMEOUT } = {}) {
  if (USE_PROXY) {
    try {
      return await fetchOnce(PROXY_BASE + '?u=' + encodeURIComponent(pathname), timeout);
    } catch (err) {
      const msg = err.name === 'AbortError' ? '请求超时(接口无响应)' : err.message || '';
      if (/请求失败\(404\)/.test(msg)) throw new Error('请求失败(404)'); // 触发上层按站名重解析
      if (/请求失败\(50\d\)/.test(msg)) throw new Error('请求超时(接口无响应)'); // 上游挂,别再直连空等
      // 其它(代理超时/网络错 = 代理本身不可达)→ 落到下面直连兜底
    }
  }
  try {
    return await fetchOnce(API_BASE + pathname, timeout);
  } catch (err) {
    throw err.name === 'AbortError' ? new Error('请求超时(接口无响应)') : err;
  }
}

// 附近站点(按距离排序)
export function nearbyStops(latitude, longitude, results = 12) {
  const q = new URLSearchParams({
    latitude,
    longitude,
    results,
    linesOfStops: 'false',
    poi: 'false',
  });
  return fetchJSON('/locations/nearby?' + q.toString());
}

// 按名称搜索站点
export function searchStops(query, results = 10) {
  const q = new URLSearchParams({
    query,
    results,
    fuzzy: 'true',
    stops: 'true',
    addresses: 'false',
    poi: 'false',
  });
  return fetchJSON('/locations?' + q.toString());
}

// VBB 交通方式(用于按类型过滤,减小返回体积)
const ALL_PRODUCTS = ['suburban', 'subway', 'tram', 'bus', 'ferry', 'express', 'regional'];

// 某站的实时发车列表。products 传入允许的类型数组(如 ['subway','bus'])时,
// 只请求这些类型,payload 更小、更快。
export async function departures(stopId, { duration = 40, results = 30, products = null, retries, timeout } = {}) {
  const params = { duration, results, remarks: 'false', language: 'en' };
  if (products && products.length) {
    for (const p of ALL_PRODUCTS) params[p] = products.includes(p) ? 'true' : 'false';
  }
  const q = new URLSearchParams(params);
  const data = await fetchJSON('/stops/' + encodeURIComponent(stopId) + '/departures?' + q.toString(), {
    ...(retries != null ? { retries } : {}),
    ...(timeout != null ? { timeout } : {}),
  });
  // v6 返回 { departures: [...] }
  return Array.isArray(data) ? data : data.departures || [];
}
