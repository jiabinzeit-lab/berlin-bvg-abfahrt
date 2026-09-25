// 数据代理:客户端 → 本函数 → 数据源 → Netlify CDN 缓存 ~15s。
// vbb:直接用 hafas-client 调 VBB 官方 HAFAS 后端(transport.rest 就是它的一层包装,
//      公共 transport.rest 经常整体挂掉,所以不再依赖它);HAFAS 出错时才回退 transport.rest 镜像。
// db:德铁源,仍走 transport.rest(独立后端,不同 id 空间)。
// 返回的 JSON 结构与 transport.rest v6 一致,前端无需区分。
// 安全:只放行 departures / locations / journeys / trips 几类只读查询,不做开放代理。
import { createClient } from 'hafas-client';
import { profile as vbbProfile } from 'hafas-client/p/vbb/index.js';

const hafas = createClient(vbbProfile, 'berlin-bvg-abfahrt (jiabin.zeit@gmail.com)');

const MIRRORS = {
  vbb: ['https://v6.bvg.transport.rest', 'https://v6.vbb.transport.rest'],
  db: ['https://v6.db.transport.rest'],
};
const ALLOWED = [/^\/stops\/[^/]+\/departures(\?|$)/, /^\/locations(\?|\/|$)/, /^\/journeys(\?|$)/, /^\/trips\/[^/?]+(\?|$)/];
const PRODUCTS = ['suburban', 'subway', 'tram', 'bus', 'ferry', 'express', 'regional'];

export const config = { path: '/api/proxy' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body, status = 200, cache = false) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json',
      ...(cache
        ? {
            'Cache-Control': 'public, max-age=10',
            // Netlify CDN:缓存 15s,之后 45s 内先返回旧结果再后台刷新(stale-while-revalidate)
            'Netlify-CDN-Cache-Control': 'public, s-maxage=15, stale-while-revalidate=45',
          }
        : {}),
    },
  });
}

function withTimeout(promise, ms) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => (t = setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), ms))),
  ]).finally(() => clearTimeout(t));
}

// ---------- vbb:hafas-client 直连 ----------
const bool = (v, dflt) => (v == null ? dflt : v === 'true');
const num = (v, dflt) => (v == null || v === '' ? dflt : Number(v));

function productsOf(q) {
  if (!PRODUCTS.some((p) => q.has(p))) return undefined;
  const out = {};
  for (const p of PRODUCTS) if (q.has(p)) out[p] = q.get(p) === 'true';
  return out;
}

// from / to:站点 id,或 prefix.latitude / .longitude / .address 坐标
function placeOf(q, prefix) {
  if (q.get(prefix)) return q.get(prefix);
  return {
    type: 'location',
    latitude: Number(q.get(prefix + '.latitude')),
    longitude: Number(q.get(prefix + '.longitude')),
    address: q.get(prefix + '.address') || 'Position',
  };
}

async function viaHafas(path) {
  const url = new URL('http://x' + path);
  const q = url.searchParams;
  const p = url.pathname;
  const language = q.get('language') || 'en';
  let m;

  if (p === '/locations/nearby') {
    return hafas.nearby(
      { type: 'location', latitude: Number(q.get('latitude')), longitude: Number(q.get('longitude')) },
      { results: num(q.get('results'), 8), poi: bool(q.get('poi'), false), linesOfStops: bool(q.get('linesOfStops'), false), language }
    );
  }
  if (p === '/locations') {
    return hafas.locations(q.get('query') || '', {
      results: num(q.get('results'), 10),
      fuzzy: bool(q.get('fuzzy'), true),
      stops: bool(q.get('stops'), true),
      addresses: bool(q.get('addresses'), true),
      poi: bool(q.get('poi'), true),
      linesOfStops: false,
      language,
    });
  }
  if ((m = p.match(/^\/stops\/([^/]+)\/departures$/))) {
    return hafas.departures(decodeURIComponent(m[1]), {
      duration: num(q.get('duration'), 10),
      results: num(q.get('results'), undefined),
      products: productsOf(q),
      remarks: bool(q.get('remarks'), true),
      language,
    });
  }
  if (p === '/journeys') {
    return hafas.journeys(placeOf(q, 'from'), placeOf(q, 'to'), {
      results: num(q.get('results'), 3),
      stopovers: bool(q.get('stopovers'), false),
      remarks: bool(q.get('remarks'), true),
      products: productsOf(q),
      language,
    });
  }
  if ((m = p.match(/^\/trips\/([^/]+)$/))) {
    return hafas.trip(decodeURIComponent(m[1]), {
      stopovers: bool(q.get('stopovers'), true),
      remarks: bool(q.get('remarks'), true),
      polyline: bool(q.get('polyline'), false),
      language,
    });
  }
  throw Object.assign(new Error('unsupported'), { code: 'UNSUPPORTED' });
}

// ---------- 兜底:transport.rest 镜像竞速 ----------
async function tryMirror(base, path, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(base + path, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
    return { ok: res.ok, status: res.status, body: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

async function viaMirrors(bases, path) {
  let seen404 = false;
  const attempts = bases.map(async (base) => {
    const r = await tryMirror(base, path, 5000);
    if (r.ok) return r;
    if (r.status === 404) seen404 = true;
    throw new Error('mirror status ' + r.status);
  });
  try {
    return json((await Promise.any(attempts)).body, 200, true);
  } catch {
    // 全部失败:都 404(站点不存在)→ 404 让客户端按站名重解析;否则 504
    const status = seen404 ? 404 : 504;
    return json({ error: 'all upstreams failed', status }, status);
  }
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: CORS });

  const params = new URL(req.url).searchParams;
  const path = params.get('u') || '';
  const src = params.get('src') || 'vbb';
  if (!MIRRORS[src] || !path.startsWith('/') || !ALLOWED.some((re) => re.test(path))) {
    return json({ error: 'bad or disallowed request' }, 400);
  }

  if (src === 'vbb') {
    try {
      return json(await withTimeout(viaHafas(path), 8000), 200, true);
    } catch (err) {
      // 站点/车次不存在 → 404(客户端据此按站名重解析);其它错误再试镜像
      if (err && err.isHafasError && err.code === 'NOT_FOUND') return json({ error: err.message, status: 404 }, 404);
      console.log('hafas failed:', err && (err.code || err.message));
    }
  }
  return viaMirrors(MIRRORS[src], path);
};
