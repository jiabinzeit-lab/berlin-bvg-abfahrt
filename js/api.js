// VBB 实时公交数据接口封装。
// 数据来源:transport.rest 提供的免费公开 API(基于 HAFAS),无需 API key,已开启 CORS。
// VBB 覆盖柏林 + 勃兰登堡全域(含 Potsdam 等近郊),接口结构与 BVG 版完全一致。
// 文档:https://v6.vbb.transport.rest/
const API_BASE = 'https://v6.vbb.transport.rest';

// 带重试与退避的 fetch:该免费实例偶尔会返回 429(限流)/503(过载),重试即可恢复。
async function fetchJSON(pathname, { retries = 1 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(API_BASE + pathname, {
        headers: { Accept: 'application/json' },
      });
      if (res.status === 429 || res.status === 503) {
        throw new Error('服务器繁忙(' + res.status + ')');
      }
      if (!res.ok) {
        throw new Error('请求失败(' + res.status + ')');
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
      // 最后一次不再等待
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
      }
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
export async function departures(stopId, { duration = 40, results = 30, products = null } = {}) {
  const params = { duration, results, remarks: 'false', language: 'en' };
  if (products && products.length) {
    for (const p of ALL_PRODUCTS) params[p] = products.includes(p) ? 'true' : 'false';
  }
  const q = new URLSearchParams(params);
  const data = await fetchJSON('/stops/' + encodeURIComponent(stopId) + '/departures?' + q.toString());
  // v6 返回 { departures: [...] }
  return Array.isArray(data) ? data : data.departures || [];
}
