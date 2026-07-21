/*
 * KataEngine —— 主线程封装
 * ----------------------------------------------------------------
 * 负责：创建 Web Worker、管理模型加载状态(status)、转发 genmove 请求、
 * 把 Board 对象映射成 KataGo 特征所需的输入，以及在模型缺失/加载失败时
 * 让调用方(js/app.js)自动回退到内置的搜索型 AI (LightAI)。
 *
 * 对外 API：
 *   KataEngine.init(opts)              启动 worker 并开始加载模型
 *       opts.modelUrl                 可选, 覆盖默认模型路径
 *       opts.onProgress(p)            下载/加载进度 0..1 (-1=未知)
 *       opts.onStatus(s, p)           状态变化: idle|loading|ready|fallback
 *   KataEngine.status()               返回当前状态字符串
 *   KataEngine.ready()                返回 Promise，ready 时 resolve，fallback 时 reject
 *   KataEngine.genmove(board, color, opts)  返回 Promise<{move,pass,winrate,visits}>
 *                                       未就绪/出错时 reject(调用方回退 LightAI)
 */
(function (root) {
  'use strict';

  var WORKER_URL = 'katago/katago-worker.js';

  var worker = null;
  var status = 'idle';            // idle | loading | ready | fallback
  var progress = 0;
  var modelUrl = null;

  var loadResolve = null, loadReject = null;
  var genHandler = null;          // { resolve, reject } 当前在途的 genmove

  var cbProgress = null, cbStatus = null, cbThinking = null;

  function setStatus(s) {
    status = s;
    if (cbStatus) cbStatus(s, progress);
  }
  function setProgress(p) {
    progress = p;
    if (cbProgress) cbProgress(p);
  }

  function ensureWorker() {
    if (worker) return worker;
    try {
      worker = new Worker(WORKER_URL);
    } catch (e) {
      // 例如在 file:// 下或被浏览器策略阻止
      setStatus('fallback');
      if (loadReject) loadReject(new Error('无法创建 Worker: ' + e.message));
      return null;
    }
    worker.onmessage = function (e) {
      var d = e.data || {};
      if (d.type === 'progress') {
        setProgress(d.value);
      } else if (d.type === 'loaded') {
        setStatus('ready');
        setProgress(1);
        if (loadResolve) loadResolve();
      } else if (d.type === 'thinking') {
        // 搜索中的进度(由 worker 上报)，可复用 onProgress 显示
        if (d.value >= 0) setProgress(d.value);
        if (cbThinking) cbThinking(d.value);
      } else if (d.type === 'move') {
        if (genHandler) { genHandler.resolve(d); genHandler = null; }
      } else if (d.type === 'error') {
        // 加载期错误 -> fallback；生成期错误 -> 本次 genmove 失败
        if (status === 'loading' || status === 'idle') {
          setStatus('fallback');
          if (loadReject) loadReject(new Error(d.message || '模型加载失败'));
        }
        if (genHandler) { genHandler.reject(new Error(d.message || '推理失败')); genHandler = null; }
      }
    };
    worker.onerror = function (err) {
      var msg = (err && err.message) ? err.message : 'Worker 运行错误';
      if (status === 'loading' || status === 'idle') {
        setStatus('fallback');
        if (loadReject) loadReject(new Error(msg));
      }
      if (genHandler) { genHandler.reject(new Error(msg)); genHandler = null; }
    };
    return worker;
  }

  function init(opts) {
    opts = opts || {};
    cbProgress = opts.onProgress || null;
    cbStatus = opts.onStatus || null;
    cbThinking = opts.onThinking || null;
    modelUrl = opts.modelUrl || null;
    if (status === 'ready' || status === 'loading') return;
    var w = ensureWorker();
    if (!w) return; // fallback 已设置
    setStatus('loading');
    setProgress(0);
    var p = new Promise(function (res, rej) {
      loadResolve = res; loadReject = rej;
    });
    w.postMessage({ type: 'load', modelUrl: modelUrl });
    return p;
  }

  function ready() {
    if (status === 'ready') return Promise.resolve();
    if (status === 'fallback') return Promise.reject(new Error('KataGo 模型不可用，已回退'));
    return new Promise(function (res, rej) {
      loadResolve = res; loadReject = rej;
    });
  }

  // Board -> KataGo 特征输入
  function boardToInput(board, color) {
    var history = (board.history || []).map(function (h) {
      if (h.pass) return { color: h.color, pass: true };
      return { color: h.color, x: h.x, y: h.y };
    });
    var koPoint = board.koPoint
      ? { x: board.koPoint[0], y: board.koPoint[1] }
      : null;
    var rules = {
      whiteKomi: board.komi,
      scoringRule: 'AREA',
      taxRule: 'NONE',
      koRule: 'SIMPLE',
      multiStoneSuicideLegal: false,
      koPoint: koPoint
    };
    // 深拷贝 grid，避免特征编码器(梯子/区域计算)误改棋盘
    var grid = board.grid.map(function (row) { return row.slice(); });
    return {
      grid: grid,
      size: board.size,
      toMove: color,
      history: history,
      rules: rules
    };
  }

  // 返回 Promise<{move,pass,winrate,visits}> ；未就绪或出错则 reject
  function genmove(board, color, opts) {
    opts = opts || {};
    if (status !== 'ready' || !worker) {
      return Promise.reject(new Error('KataGo 未就绪'));
    }
    var input = boardToInput(board, color);
    input.type = 'genmove';
    input.visits = opts.visits || defaultVisits(board.size);
    return new Promise(function (res, rej) {
      genHandler = { resolve: res, reject: rej };
      worker.postMessage(input);
    });
  }

  // 不同棋盘尺寸给不同 visits：小棋盘可以多搜，大棋盘受 wasm 速度限制
  function defaultVisits(size) {
    if (size <= 9) return 40;
    if (size <= 13) return 24;
    return 16;
  }

  var api = {
    init: init,
    ready: ready,
    status: function () { return status; },
    genmove: genmove,
    defaultVisits: defaultVisits,
    _boardToInput: boardToInput
  };
  root.KataEngine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
