// Service Worker:缓存应用外壳,实现离线打开与快速加载。
// 实时发车数据始终走网络(不缓存),保证倒计时准确。
const CACHE = 'bvg-shell-v1';
const SHELL = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/api.js',
  './js/store.js',
  './manifest.webmanifest',
  './icons/icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // API 请求:永远走网络,不缓存
  if (url.hostname.endsWith('transport.rest')) return;
  if (e.request.method !== 'GET') return;

  // 应用外壳:优先缓存,回退网络
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request).catch(() => caches.match('./index.html')))
  );
});
