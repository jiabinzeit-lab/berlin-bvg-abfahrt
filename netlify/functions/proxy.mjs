// 缓存代理:客户端 → 本函数 → bvg/vbb 双镜像(取先返回成功的)→ Netlify CDN 缓存 ~15s。
// 目的:1) 服务器端网络到上游更稳更快;2) 双镜像容错(一个挂了用另一个);3) CDN 缓存让高频/多人访问秒回。
// 安全:只允许代理 transport.rest 的 departures / locations 路径,不做开放代理。
const MIRRORS = ['https://v6.bvg.transport.rest', 'https://v6.vbb.transport.rest'];
const ALLOWED = [/^\/stops\/[^/]+\/departures(\?|$)/, /^\/locations(\?|\/|$)/];

export const config = { path: '/api/proxy' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

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

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: CORS });

  const path = new URL(req.url).searchParams.get('u') || '';
  if (!path.startsWith('/') || !ALLOWED.some((re) => re.test(path))) {
    return new Response(JSON.stringify({ error: 'bad or disallowed path' }), {
      status: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  // 并行竞速两个镜像:取先返回 2xx 的那个;都失败则汇总状态
  let seen404 = false;
  const attempts = MIRRORS.map(async (base) => {
    const r = await tryMirror(base, path, 5000);
    if (r.ok) return r; // 成功 → 参与 Promise.any 竞速
    if (r.status === 404) seen404 = true;
    throw new Error('mirror status ' + r.status);
  });

  try {
    const r = await Promise.any(attempts);
    return new Response(r.body, {
      status: 200,
      headers: {
        ...CORS,
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=10',
        // Netlify CDN:缓存 15s,之后 45s 内先返回旧结果再后台刷新(stale-while-revalidate)
        'Netlify-CDN-Cache-Control': 'public, s-maxage=15, stale-while-revalidate=45',
      },
    });
  } catch {
    // 全部失败:两源都 404(站点不存在)→ 返回 404 让客户端按站名重解析;否则 504
    const status = seen404 ? 404 : 504;
    return new Response(JSON.stringify({ error: 'all upstreams failed', status }), {
      status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
};
