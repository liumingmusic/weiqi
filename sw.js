// Service Worker：缓存应用外壳，实现离线可用
// v6: 修复「旧 worker 被 SW 缓存死锁」的顽疾：
//     - install 改为逐个缓存(单文件失败不再让整个 SW 激活失败)
//     - 代码类资源(katago/ worker/engine/ort.min.js 等)改为 network-first，
//       保证浏览器永远拿到最新 worker，不再被旧 SW 缓存的旧 worker 卡住
//     - 大体积分片(ort-wasm-parts / model-parts)保持 cache-first(下载一次复用)
// v5: wasm 与模型改为同源 .js base64 分片自托管(katago/{ort-wasm-parts,model-parts}/)，
//     彻底绕开网络对 .wasm/.onnx 的二进制拦截；分片运行时缓存。
var CACHE = 'weiqi-v6';
var ASSETS = [
  './', './index.html', './manifest.webmanifest', './icon.svg',
  './css/style.css',
  './js/board.js', './js/sgf.js', './js/store.js', './js/ai.js',
  './js/tsumego-data.js', './js/app.js',
  // KataGo 引擎(小文件, 预缓存)。wasm/模型分片(共约 110MB) 体积大,
  // 不放预缓存(避免 install 超时), 由下方 fetch 运行时缓存, 首次在线用过一次即可离线。
  './katago/katago-engine.js', './katago/katago-worker.js', './katago/bundle-manifest.js',
  './katago/features.js', './katago/search.js', './katago/ort/ort.min.js'
];

self.addEventListener('install', function (e) {
  // 逐个缓存，单个失败不阻断整体安装(避免 v5 因某资源瞬时拉取失败而整个 SW 无法激活)
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

// 大体积分片：cache-first(下载一次复用)，后台静默刷新缓存
function isBigPart(url) {
  return url.indexOf('/ort-wasm-parts/') !== -1 || url.indexOf('/model-parts/') !== -1;
}

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  var url = e.request.url;

  if (isBigPart(url)) {
    e.respondWith(
      caches.match(e.request).then(function (hit) {
        var network = fetch(e.request).then(function (res) {
          if (res && res.status === 200 && (res.type === 'basic' || res.type === 'cors')) {
            caches.open(CACHE).then(function (c) { c.put(e.request, res.clone()); });
          }
          return res;
        }).catch(function () { return hit; });
        return hit || network;
      })
    );
    return;
  }

  // 其余资源(katago 代码/worker、页面、css、js 等)：network-first，
  // 保证代码永远最新；断网时回退缓存，再不行回退首页。
  e.respondWith(
    fetch(e.request).then(function (res) {
      if (res && res.status === 200 && (res.type === 'basic' || res.type === 'cors')) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(e.request).then(function (hit) {
        return hit || caches.match('./index.html');
      });
    })
  );
});
