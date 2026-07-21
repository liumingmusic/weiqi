/*
 * KataGo (onnxruntime-web) Web Worker
 * ----------------------------------------------------------------
 * 在独立线程里加载 ONNX 权重、跑神经网络推理，并用 katago/search.js 的
 * 纯 JS PUCT 搜索选出落子。主线程(engine)通过 postMessage 通信，
 * 因此 UI 不会因推理卡死。
 *
 * 依赖 (importScripts 相对本 worker 所在目录 katago/)：
 *   ort/ort.min.js      onnxruntime-web 运行时(本地打包兜底；wasm 二进制优先走 jsDelivr CDN)
 *   features.js         KataGo v10 特征编码器
 *   search.js           PUCT / MCTS 搜索
 * 说明：wasm 运行时优先从 jsDelivr(fastly 国内镜像, CORS:*) 加载，避免 GitHub Pages
 *       大文件被网络拦截成 HTML 导致 WebAssembly 实例化失败；CDN 不可达时回退本地 ort/。
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

  // wasm 运行时优先走 CDN（国内网络对 GitHub Pages 的 10MB 大文件常被拦截成 HTML，
  // 导致 WebAssembly.instantiate 拿到 <!DOCTYPE -> CompileError "expected magic word"）。
  // jsDelivr(fastly 为国内镜像) 返回 CORS:* 的合法 wasm；按顺序回退，最后才用本地。
  var ORT_WASM_CDNS = [
    'https://fastly.jsdelivr.net/npm/onnxruntime-web@1.17.0/dist/',
    'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.0/dist/'
  ];

  function configureOrt() {
    // importScripts 的基准目录(本地 wasm 回退用)
    var base = self.location.href.substring(0, self.location.href.lastIndexOf('/') + 1);
    self.__localWasm = base + 'ort/';
    ort.env.wasm.simd = true;
    // 单线程：避免需要 COOP/COEP 跨域隔离，GitHub Pages 也能直接跑
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    // 默认优先 CDN wasm；loadModel 失败会自动回退到本地
    ort.env.wasm.wasmPaths = ORT_WASM_CDNS[0];
  }

  // 断点续传 + 失败重试的模型下载。
  // GitHub Pages 对 72MB 大文件偶发断流，若一次性流式读取则直接失败回退；
  // 这里用 Range 分块下载，单块失败自动重试、断点续传，避免整包重下或失败。
  var CHUNK_SIZE = 6 * 1024 * 1024;   // 每块 6MB
  var CHUNK_RETRY = 6;                // 单块最多重试次数
  var WHOLE_RETRY = 3;                // 整包兜底最多重试轮数

  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function fetchHead(url) {
    return fetch(url, { method: 'HEAD' }).then(function (r) {
      if (!r.ok) return 0;
      return +r.headers.get('content-length') || 0;
    }).catch(function () { return 0; });
  }

  // 单块下载：失败自动重试（断点续传由 Range 保证从 start 起）
  function fetchChunk(url, start, end, attempt) {
    return fetch(url, { headers: { Range: 'bytes=' + start + '-' + (end - 1) } })
      .then(function (r) {
        if (r.status !== 206 && r.status !== 200) throw new Error('分块下载 HTTP ' + r.status + ' (' + start + '-' + end + ')');
        return r.arrayBuffer();
      })
      .then(function (buf) { return new Uint8Array(buf); })
      .catch(function (err) {
        if (attempt >= CHUNK_RETRY) throw err;
        return delay(700 * attempt).then(function () { return fetchChunk(url, start, end, attempt + 1); });
      });
  }

  // 整包兜底（服务器不支持 Range 时）：失败整体重试
  function fetchWhole(url, attempt) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('模型下载失败 HTTP ' + r.status + ' (' + url + ')');
      return r.arrayBuffer();
    }).then(function (buf) { return new Uint8Array(buf); })
      .catch(function (err) {
        if (attempt >= WHOLE_RETRY) throw err;
        return delay(1000 * attempt).then(function () { return fetchWhole(url, attempt + 1); });
      });
  }

  function fetchModel(modelUrl) {
    return fetchHead(modelUrl).then(function (total) {
      // 拿不到大小或文件很小：整包下载（带整体重试）
      if (!total || total <= CHUNK_SIZE) {
        return fetchWhole(modelUrl, 0).then(function (u8) {
          self.postMessage({ type: 'progress', value: 1 });
          return u8.buffer.slice(0, u8.length);
        });
      }
      var chunks = [];
      function next(i) {
        var start = i * CHUNK_SIZE;
        if (start >= total) {
          var buf = new Uint8Array(total);
          var off = 0;
          for (var k = 0; k < chunks.length; k++) { buf.set(chunks[k], off); off += chunks[k].length; }
          self.postMessage({ type: 'progress', value: 1 });
          return buf.buffer.slice(0, total);
        }
        var end = Math.min(start + CHUNK_SIZE, total);
        return fetchChunk(modelUrl, start, end, 0).then(function (u8) {
          chunks.push(u8);
          var loaded = 0;
          for (var k = 0; k < chunks.length; k++) loaded += chunks[k].length;
          self.postMessage({ type: 'progress', value: loaded / total });
          return next(i + 1);
        });
      }
      return next(0);
    }).catch(function (err) {
      // HEAD/分块路径失败（如服务器不支持 Range）：退化到整包重试
      return fetchWhole(modelUrl, 0).then(function (u8) {
        self.postMessage({ type: 'progress', value: 1 });
        return u8.buffer.slice(0, u8.length);
      });
    });
  }

  // 创建推理会话；把 wasm 来源作为可变参数，便于失败切换。
  function createSession(arrayBuffer, wasmPaths) {
    ort.env.wasm.wasmPaths = wasmPaths;
    return ort.InferenceSession.create(arrayBuffer, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all'
    });
  }

  // 模型下载来源回退链：先本地(Pages 同源)，再可选镜像(用户自建 OSS/COS，需 CORS:*)。
  // 注意：hf-mirror 等公共镜像跳转后无 ACAO，浏览器跨域会被拦，不能直接用；
  // 若要自备模型 CDN，把地址填进 MODEL_MIRRORS 即可(需服务端返回 Access-Control-Allow-Origin:*)。
  var MODEL_MIRRORS = [];

  function loadModel(modelUrl) {
    var sources = [modelUrl].concat(MODEL_MIRRORS);
    function trySource(i) {
      if (i >= sources.length) return Promise.reject(new Error('模型所有来源均下载失败'));
      return fetchModel(sources[i]).catch(function (err) {
        if (i + 1 < sources.length) {
          self.postMessage({ type: 'progress', value: -1 });
          return trySource(i + 1);
        }
        throw err;
      });
    }
    return trySource(0).then(function (arrayBuffer) {
      // wasm 来源三级回退：CDN(fastly) -> CDN(cdn) -> 本地
      var candidates = ORT_WASM_CDNS.concat([self.__localWasm]);
      function tryWasm(j) {
        if (j >= candidates.length) return Promise.reject(new Error('所有 wasm 来源均失败'));
        return createSession(arrayBuffer, candidates[j]).catch(function (e) {
          if (j + 1 < candidates.length) {
            self.postMessage({ type: 'progress', value: -1 }); // 切换来源，进度转为不确定
            return tryWasm(j + 1);
          }
          throw e;
        });
      }
      return tryWasm(0);
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
        // res.value = 根局面网络 value (winP-lossP, [-1,1], toMove 视角)
        // 胜率 = (value+1)/2, 不用 sigmoid(会压缩到 0.27~0.73)
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
