// 앱 화면(HTML/JS/CSS)만 캐시한다. 덱·이미지·풀이 기록은 web-api.js가 IndexedDB에 따로 캐시한다.
const V = 'odap-v2';
const SHELL = ['./', 'index.html', 'renderer.js', 'web-api.js', 'styles.css', 'manifest.webmanifest',
  'katex/katex.min.css', 'katex/katex.min.js', 'katex/contrib/auto-render.min.js', 'icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// 같은 출처 요청만: 네트워크 우선(업데이트가 바로 반영), 실패하면 캐시
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(V).then((c) => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
