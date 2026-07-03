// VBB 实时公交数据接口封装。
// 数据来源:transport.rest 提供的免费公开 API(基于 HAFAS),无需 API key,已开启 CORS。
// VBB 覆盖柏林 + 勃兰登堡全域(含 Potsdam 等近郊),接口结构与 BVG 版完全一致。
// 文档:https://v6.vbb.transport.rest/
const API_BASE = 'https://v6.vbb.transport.rest';

// 该免费实例常见问题:429/503(过载)或「连上但不返回」的挂起。
// 关键:用 AbortController 加超时,挂起时快速中止而不是一直卡着;可选少量重试。
const DEFAULT_TIMEOUT = 7000;
async function fetchJSON(pathname, { retries = 1, timeout = DEFAULT_TIMEOUT } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(API_BASE + pathname, {
        headers: { Accept: 'application/json' },
        signal: ctrl.signal,
      });
      if (res.status === 429 || res.status === 503) {
        throw new Error('服务器繁忙(' + res.status + ')');
      }
      if (!res.ok) {
        throw new Error('请求失败(' + res.status + ')');
      }
      return await res.json();
    } catch (err) {
      lastErr = err.name === 'AbortError' ? new Error('请求超时(接口无响应)') : err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 500));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
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
