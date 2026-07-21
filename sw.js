// Service Worker：缓存应用外壳，实现离线可用
// v4: wasm 运行时改由 jsDelivr CDN 加载(修复国内网络把 GitHub Pages 大文件拦成 HTML
//     导致 WebAssembly.instantiate 报 "expected magic word" 的问题)；CDN 不可达回退本地。
var CACHE = 'weiqi-v4';
var ASSETS = [
  './', './index.html', './manifest.webmanifest', './icon.svg',
  './css/style.css',
  './js/board.js', './js/sgf.js', './js/store.js', './js/ai.js',
  './js/tsumego-data.js', './js/app.js',
  // KataGo 引擎(小文件, 预缓存)。ort-wasm-simd.wasm(10MB) 与 model(72MB) 体积大,
  // 不放预缓存(避免 install 超时), 由下方 fetch 运行时缓存, 首次在线用过一次即可离线。
  './katago/katago-engine.js', './katago/katago-worker.js',
  './katago/features.js', './katago/search.js', './katago/ort/ort.min.js'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(function (hit) {
      if (hit) return hit;
      return fetch(e.request).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
        return res;
      }).catch(function () { return caches.match('./index.html'); });
    })
  );
});
