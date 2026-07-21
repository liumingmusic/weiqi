/*
 * KataGo (onnxruntime-web) Web Worker —— 自托管打包版
 * ----------------------------------------------------------------
 * 在独立线程加载 ONNX 权重、跑神经网络推理，并用 katago/search.js 的纯 JS
 * PUCT 搜索选出落子。主线程(engine)通过 postMessage 通信，UI 不会因推理卡死。
 *
 * 依赖 (importScripts 相对本 worker 所在目录 katago/)：
 *   ort/ort.min.js           onnxruntime-web 运行时(JS，随仓库发布)
 *   bundle-manifest.js       分片数量清单 { wasmParts, modelParts }
 *   ort-wasm-parts/part_*.js wasm 运行时 base64 分片(同源 JS，规避网络拦截)
 *   model-parts/part_*.js    KataGo 权重 base64 分片(同源 JS，规避网络拦截)
 *   features.js / search.js  特征编码器 / PUCT 搜索
 *
 * 为什么不用 .wasm / .onnx 直链？
 *   部分网络(公司/校园/地区防火墙)会对 .wasm 或大体积二进制请求返回 HTML 拦截页，
 *   导致 WebAssembly.instantiate 拿到 <!DOCTYPE -> CompileError "expected magic word"。
 *   把 wasm 与模型都 base64 化进同源 .js 分片后，浏览器按普通 JS 加载(同域、无扩展名
 *   拦截)，运行时再解码回字节交给 onnxruntime，彻底绕开二进制拦截。
 *
 * 消息协议 (主线程 -> worker)：
 *   { type:'load' }                   加载模型(从分片)
 *   { type:'genmove', grid, size ...} 推理落子
 * 消息协议 (worker -> 主线程)：
 *   { type:'progress', value:0..1 }   加载进度
 *   { type:'loaded' }                 就绪
 *   { type:'thinking', value:0..1 }   搜索进度
 *   { type:'move', ... }              落子结果
 *   { type:'error', message }         错误(主线程据此回退内置 AI)
 */
(function () {
  'use strict';

  importScripts('ort/ort.min.js');
  importScripts('bundle-manifest.js');
  importScripts('features.js');
  importScripts('search.js');

  var ort = self.ort;
  var KataFeatures = self.KataFeatures;
  var KataSearch = self.KataSearch;
  var BUNDLE = self.__BUNDLE__ || { wasmParts: 3, modelParts: 18 };

  var session = null;

  function configureOrt() {
    ort.env.wasm.simd = true;
    ort.env.wasm.numThreads = 1;     // 单线程：无需 COOP/COEP，GitHub Pages 可直接跑
    ort.env.wasm.proxy = false;
    // 不设置 wasmPaths：运行时字节由 ort-wasm-parts 分片解码后直接赋给
    // ort.env.wasm.wasmBinary，onnxruntime 不会再发起任何 .wasm 网络请求。
  }

  // 本 worker 所在目录(拼分片 URL，确保同源)
  function basePath() {
    return self.location.href.substring(0, self.location.href.lastIndexOf('/') + 1);
  }

  function b64ToBytes(b64) {
    var bin = atob(b64);
    var len = bin.length;
    var u8 = new Uint8Array(len);
    for (var i = 0; i < len; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  // 并行下载某 bundle 的 base64 分片(.js 同源)，解码并拼接为单个 Uint8Array。
  // dir 形如 'ort-wasm-parts/' 或 'model-parts/'；count 来自 BUNDLE。
  function loadBundle(dir, count, label, onProgress) {
    var base = basePath();
    var urls = [];
    for (var i = 0; i < count; i++) {
      urls.push(base + dir + 'part_' + (i < 10 ? '0' + i : i) + '.js');
    }
    var parts = new Array(count);
    var done = 0;
    return Promise.all(urls.map(function (u, idx) {
      return fetch(u).then(function (r) {
        if (!r.ok) throw new Error(label + ' 分片 #' + idx + ' 下载失败 HTTP ' + r.status);
        return r.text();
      }).then(function (txt) {
        parts[idx] = b64ToBytes((txt || '').trim());
        done++;
        if (onProgress) onProgress(done / count, label);
      });
    })).then(function () {
      var total = 0, k;
      for (k = 0; k < parts.length; k++) total += parts[k].length;
      var out = new Uint8Array(total);
      var off = 0;
      for (k = 0; k < parts.length; k++) { out.set(parts[k], off); off += parts[k].length; }
      return out;
    });
  }

  function loadAll() {
    // 1) wasm 运行时(小)：加载并注入 wasmBinary
    return loadBundle('ort-wasm-parts/', BUNDLE.wasmParts, 'wasm', function (f) {
      self.postMessage({ type: 'progress', value: 0.02 * f });
    }).then(function (wasmBytes) {
      configureOrt();
      ort.env.wasm.wasmBinary = wasmBytes;
      self.postMessage({ type: 'progress', value: 0.05 });
      // 2) 模型权重(大)：进度条主要反映这部分
      return loadBundle('model-parts/', BUNDLE.modelParts, 'model', function (f) {
        self.postMessage({ type: 'progress', value: f });
      });
    }).then(function (modelBytes) {
      return ort.InferenceSession.create(modelBytes, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all'
      });
    }).then(function (s) {
      session = s;
      self.postMessage({ type: 'loaded' });
    });
  }

  // 单次神经网络推理 -> { policy:Float32Array(N*N+1), value:[-1,1], winrate:[0,1] }
  function netEvaluate(grid, size, toMove, history, rules) {
    var feats = KataFeatures.buildFeatures(grid, size, toMove, history, rules);
    var bin = new Float32Array(feats.bin_input);     // [22*N*N] channel-major
    var glob = new Float32Array(feats.global_input); // [19]
    var feeds = {
      bin_input: new ort.Tensor('float32', bin, [1, 22, size, size]),
      global_input: new ort.Tensor('float32', glob, [1, 19])
    };
    return session.run(feeds).then(function (out) {
      var pol = out.policy || out[session.outputNames[0]];
      var val = out.value || out[session.outputNames[1]];
      // policy 形状 [1,6,M] (M=N*N+1)。通道 0 = 主策略(toMove 视角), 即前 M 个值。
      var M = pol.dims[pol.dims.length - 1];          // moves = N*N+1
      var pdata = pol.data;                           // row-major, 通道0在最前
      var useM = Math.min(M, size * size + 1);
      var policy = new Float32Array(size * size + 1);
      for (var i = 0; i < useM; i++) policy[i] = pdata[i]; // 取通道0(主策略)原始 logits

      // value 头 [1,3]: 原始 logits, 顺序 [win, loss, draw], 均为 toMove(自方)视角。
      var vd = val.data;
      var mx = Math.max(vd[0], vd[1], vd[2]);
      var ew = Math.exp(vd[0] - mx), el = Math.exp(vd[1] - mx), ed = Math.exp(vd[2] - mx);
      var sm = ew + el + ed;
      var winP = ew / sm, lossP = el / sm, drawP = ed / sm;
      var winrate = winP + 0.5 * drawP;               // [0,1] 自方(toMove)胜率
      var value = winP - lossP;                        // [-1,1] 供 PUCT 回溯

      return { policy: policy, value: value, winrate: winrate };
    });
  }

  function genmove(msg) {
    var size = msg.size;
    var visits = msg.visits || 20;
    var visitCount = 0;
    // 推理看门狗：单线程 WASM 偶有 session.run 永不动(浏览器策略/内存压力)。
    // 若超过阈值仍无进度回报，主动自杀并上报错误，由主线程重建 worker 并回退。
    var watchdog = setTimeout(function () {
      try { self.postMessage({ type: 'error', message: 'AI 推理看门狗触发：worker 无响应，已终止', reqId: msg.reqId }); } catch (e) {}
      try { self.close(); } catch (e) {}
    }, 28000);
    var evaluate = function (grid, sz, tm, hist, rl) {
      visitCount++;
      return netEvaluate(grid, sz, tm, hist, rl).then(function (r) {
        self.postMessage({ type: 'thinking', value: visitCount / visits });
        return r;
      });
    };
    var search = KataSearch.createSearch(evaluate, {
      cpuct: 1.4, dirichletAlpha: 0.25, dirichletWeight: 0.2
    });
    return search.searchAsync(msg.grid, msg.toMove, msg.history, msg.rules, visits)
      .then(function (res) {
        clearTimeout(watchdog);
        var rootWin = res.value != null
          ? Math.max(0, Math.min(1, (res.value + 1) / 2))
          : 0.5;
        return {
          type: 'move',
          reqId: msg.reqId,
          move: res.move,
          pass: res.pass,
          winrate: rootWin,
          value: res.value,
          visits: res.visits
        };
      })
      .catch(function (err) {
        clearTimeout(watchdog);
        throw err;
      });
  }

  self.onmessage = function (e) {
    var msg = e.data || {};
    if (msg.type === 'load') {
      try {
        loadAll().catch(function (err) {
          self.postMessage({ type: 'error', message: String((err && err.message) || err) });
        });
      } catch (err) {
        self.postMessage({ type: 'error', message: String((err && err.message) || err) });
      }
    } else if (msg.type === 'genmove') {
      if (!session) {
        self.postMessage({ type: 'error', message: '模型尚未加载', reqId: msg.reqId });
        return;
      }
      genmove(msg).then(function (r) {
        self.postMessage(r);
      }).catch(function (err) {
        self.postMessage({ type: 'error', message: String((err && err.message) || err), reqId: msg.reqId });
      });
    }
  };
})();
