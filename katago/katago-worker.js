/*
 * KataGo (onnxruntime-web) Web Worker
 * ----------------------------------------------------------------
 * 在独立线程里加载 ONNX 权重、跑神经网络推理，并用 katago/search.js 的
 * 纯 JS PUCT 搜索选出落子。主线程(engine)通过 postMessage 通信，
 * 因此 UI 不会因推理卡死。
 *
 * 依赖 (importScripts 相对本 worker 所在目录 katago/)：
 *   ort/ort.min.js      onnxruntime-web 运行时(已打包进仓库, 离线可用)
 *   features.js         KataGo v10 特征编码器
 *   search.js           PUCT / MCTS 搜索
 *
 * 消息协议 (主线程 -> worker)：
 *   { type:'load',   modelUrl? }  加载模型
 *   { type:'genmove', grid, size, toMove, history, rules, visits }
 * 消息协议 (worker -> 主线程)：
 *   { type:'progress', value:0..1 }      模型下载进度
 *   { type:'loaded' }                     模型就绪
 *   { type:'thinking', value:0..1 }       搜索进度(每 expanded 一个节点)
 *   { type:'move', move, pass, winrate, value, visits }
 *   { type:'error', message }
 */
(function () {
  'use strict';

  // 默认模型(28-block uint8, 用户选定)。用户需先用 fetch_model.sh 下载到 model/。
  var DEFAULT_MODEL = 'model/kata1-b28c512nbt-s12043015936-d5616446734.uint8.onnx';

  importScripts('ort/ort.min.js');
  importScripts('features.js');
  importScripts('search.js');

  var ort = self.ort;
  var KataFeatures = self.KataFeatures;
  var KataSearch = self.KataSearch;

  var session = null;

  function configureOrt() {
    // importScripts 的基准目录
    var base = self.location.href.substring(0, self.location.href.lastIndexOf('/') + 1);
    // wasm 二进制所在目录(必须以 / 结尾)
    ort.env.wasmPaths = base + 'ort/';
    ort.env.wasm.simd = true;
    // 单线程：避免需要 COOP/COEP 跨域隔离，GitHub Pages 也能直接跑
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
  }

  // 带进度条的模型下载
  function fetchModel(modelUrl) {
    return fetch(modelUrl).then(function (resp) {
      if (!resp.ok) throw new Error('模型下载失败 HTTP ' + resp.status + ' (' + modelUrl + ')');
      var total = +resp.headers.get('content-length') || 0;
      var reader = resp.body.getReader();
      var chunks = [];
      var loaded = 0;
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return;
          chunks.push(r.value);
          loaded += r.value.length;
          if (total) self.postMessage({ type: 'progress', value: loaded / total });
          else self.postMessage({ type: 'progress', value: -1 }); // 未知大小->不确定进度
          return pump();
        });
      }
      return pump().then(function () {
        var buf = new Uint8Array(loaded);
        var off = 0;
        for (var i = 0; i < chunks.length; i++) { buf.set(chunks[i], off); off += chunks[i].length; }
        self.postMessage({ type: 'progress', value: 1 });
        return buf.buffer.slice(0, loaded);
      });
    });
  }

  function loadModel(modelUrl) {
    return fetchModel(modelUrl).then(function (arrayBuffer) {
      return ort.InferenceSession.create(arrayBuffer, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all'
      });
    }).then(function (s) {
      session = s;
      return s;
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
      // (已用真模型实测确认: 空盘 top 着法为角/星位, 非 pass。)
      var M = pol.dims[pol.dims.length - 1];          // moves = N*N+1
      var pdata = pol.data;                           // row-major, 通道0在最前
      var useM = Math.min(M, size * size + 1);
      var policy = new Float32Array(size * size + 1);
      for (var i = 0; i < useM; i++) policy[i] = pdata[i]; // 取通道0(主策略)原始 logits

      // value 头 [1,3]: 原始 logits, 顺序 [win, loss, draw], 均为 toMove(自方)视角。
      // (已用真模型实测确认: komi=0 空盘黑白对称; 黑大优 -> win≈1, 见 features 校验。)
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
        // res.value = 根局面网络 value (winP-lossP, [-1,1], toMove 视角)
        // 胜率 = (value+1)/2, 不用 sigmoid(会压缩到 0.27~0.73)
        var rootWin = res.value != null
          ? Math.max(0, Math.min(1, (res.value + 1) / 2))
          : 0.5;
        return {
          type: 'move',
          move: res.move,
          pass: res.pass,
          winrate: rootWin,
          value: res.value,
          visits: res.visits
        };
      });
  }

  self.onmessage = function (e) {
    var msg = e.data || {};
    if (msg.type === 'load') {
      try {
        configureOrt();
        var url = msg.modelUrl || DEFAULT_MODEL;
        loadModel(url).then(function () {
          self.postMessage({ type: 'loaded' });
        }).catch(function (err) {
          self.postMessage({ type: 'error', message: String((err && err.message) || err) });
        });
      } catch (err) {
        self.postMessage({ type: 'error', message: String((err && err.message) || err) });
      }
    } else if (msg.type === 'genmove') {
      if (!session) {
        self.postMessage({ type: 'error', message: '模型尚未加载' });
        return;
      }
      genmove(msg).then(function (r) {
        self.postMessage(r);
      }).catch(function (err) {
        self.postMessage({ type: 'error', message: String((err && err.message) || err) });
      });
    }
  };
})();
