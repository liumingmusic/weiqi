// Service Worker：缓存应用外壳，实现离线可用
// v7: 修复「大分片 fetch 抛 Response body is already used」导致 worker 加载模型失败回退的顽疾。
//     根因：对同一 e.request 既调 caches.match() 又调 fetch()，caches.match 会锁住 Request，
//     使随后 fetch 返回的响应 body 被视为已使用，再 res.clone() 即抛错。
//     修法：fetch 前先 e.request.clone() 分开使用；并去掉「命中缓存仍后台二次 fetch」的竞态。
// v6: install 逐个缓存容错 + 代码 network-first + 大分片 cache-first，防旧 worker 被 SW 缓存死锁。
// v5: wasm 与模型改为同源 .js base64 分片自托管，绕开网络对 .wasm/.onnx 的二进制拦截。
var CACHE = 'weiqi-v7';
var ASSETS = [
  './', './index.html', './manifest.webmanifest', './icon.svg',
  './css/style.css',
  './js/board.js', './js/sgf.js', './js/store.js', './js/ai.js',
  './js/tsumego-data.js', './js/app.js',
  './katago/katago-engine.js', './katago/katago-worker.js', './katago/bundle-manifest.js',
  './katago/features.js', './katago/search.js', './katago/ort/ort.min.js'
];

self.addEventListener('install', function (e) {
  // 逐个缓存，单个失败不阻断整体安装
  e.waitUntil((function () {
    return caches.open(CACHE).then(function (c) {
      return Promise.all(ASSETS.map(function (u) {
        return c.add(u).catch(function (err) {
          console.warn('[SW] precache skip:', u, err && err.message);
        });
      }));
    }).then(function () { return self.skipWaiting(); });
  })());
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

// 大体积分片：cache-first(下载一次复用)，避免重复拉 110MB
function isBigPart(url) {
  return url.indexOf('/ort-wasm-parts/') !== -1 || url.indexOf('/model-parts/') !== -1;
}

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  var url = e.request.url;

  // 大体积分片：cache-first。克隆请求，分别用于 match 与 fetch，杜绝 Request 被锁。
  if (isBigPart(url)) {
    e.respondWith((function () {
      var req = e.request.clone();
      return caches.open(CACHE).then(function (c) {
        return c.match(req).then(function (hit) {
          if (hit) return hit;                 // 命中即返回，不再发起网络(无竞态)
          return fetch(req).then(function (res) {
            if (res && res.status === 200 && (res.type === 'basic' || res.type === 'cors')) {
              c.put(req, res.clone());         // 先克隆再缓存，原始响应留给调用方
            }
            return res;
          }).catch(function () { return hit; });
        });
      });
    })());
    return;
  }

  // 其余资源(katago 代码/worker、页面、css、js 等)：network-first，保证代码永远最新；
  // 断网时回退缓存，再不行回退首页。
  e.respondWith((function () {
    var req = e.request.clone();
    return fetch(req).then(function (res) {
      if (res && res.status === 200 && (res.type === 'basic' || res.type === 'cors')) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) {
        return hit || caches.match('./index.html');
      });
    });
  })());
});
