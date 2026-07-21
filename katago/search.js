/*
 * PUCT / MCTS 搜索 (纯 JS, 可在 Node 中用 mock 评估函数测试)
 * 依赖 katago/features.js 的 _applyMove 判定合法性。
 *
 * evaluate(grid, size, toMove, history, rules) -> {
 *    policy: Float32Array(长度 N*N+1, 末位=pass), 未归一化的 logits 或概率均可
 *    value : number, 当前走子方视角的胜率映射 [-1,1] (正=对该方有利)
 * }
 */
(function (root) {
  'use strict';
  var KF = (typeof require !== 'undefined') ? require('./features.js') : root.KataFeatures;
  var EMPTY = 0;

  function legalMoves(grid, size, koPoint) {
    var moves = [];
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        if (grid[y][x] !== EMPTY) continue;
        if (koPoint && koPoint.x === x && koPoint.y === y) continue;
        var ng = KF._applyMove(grid, size, x, y, 1); // color 仅影响提子逻辑, 用 1 试探
        // applyMove 用指定 color; 需要分别试探双方? 实际合法性与试探色无关(提子对称), 但自杀判定需真实色
        if (ng) moves.push({ x: x, y: y });
      }
    }
    return moves;
  }

  // 对任意 color, 判断 (x,y) 是否合法
  function isLegal(grid, size, x, y, color, koPoint) {
    if (grid[y][x] !== EMPTY) return false;
    if (koPoint && koPoint.x === x && koPoint.y === y) return false;
    return KF._applyMove(grid, size, x, y, color) != null;
  }

  function softmax(arr) {
    var max = -Infinity;
    for (var i = 0; i < arr.length; i++) if (arr[i] > max) max = arr[i];
    var sum = 0;
    var out = new Float32Array(arr.length);
    for (var j = 0; j < arr.length; j++) { out[j] = Math.exp(arr[j] - max); sum += out[j]; }
    for (var k = 0; k < arr.length; k++) out[k] /= sum;
    return out;
  }

  function createSearch(evaluate, opts) {
    opts = opts || {};
    var cpuct = opts.cpuct != null ? opts.cpuct : 1.4;
    var dirichletAlpha = opts.dirichletAlpha != null ? opts.dirichletAlpha : 0.25;
    var dirichletWeight = opts.dirichletWeight != null ? opts.dirichletWeight : 0.2;

    function makeNode(grid, toMove, history, rules, isRoot) {
      return {
        grid: grid, toMove: toMove, history: history, rules: rules,
        children: null, // Map key "x,y"|"pass" -> child
        moves: null, priors: null,
        visits: 0, valueSum: 0, isRoot: !!isRoot
      };
    }

    function expand(node, evalResult) {
      var size = node.grid.length;
      var probs = softmax(evalResult.policy); // 归一化
      var moves = [];
      // 合法着手(含真实 color) + pass
      for (var y = 0; y < size; y++) {
        for (var x = 0; x < size; x++) {
          if (isLegal(node.grid, size, x, y, node.toMove, node.rules.koPoint))
            moves.push({ x: x, y: y });
        }
      }
      moves.push({ pass: true });
      var priors = new Map();
      var children = new Map();
      var M = size * size + 1;
      for (var i = 0; i < moves.length; i++) {
        var m = moves[i];
        var idx = m.pass ? M - 1 : m.y * size + m.x;
        var p = probs[idx] || 1e-9;
        if (m.pass) {
          priors.set('pass', p);
          children.set('pass', null);
        } else {
          priors.set(m.x + ',' + m.y, p);
          children.set(m.x + ',' + m.y, null);
        }
      }
      // 根节点加 dirichlet 噪声
      if (node.isRoot && dirichletWeight > 0) {
        var noise = sampleDirichlet(moves.length, dirichletAlpha);
        var k = 0;
        priors.forEach(function (val, key) {
          var nv = (1 - dirichletWeight) * val + dirichletWeight * noise[k];
          priors.set(key, nv); k++;
        });
        // 重新归一化
        var s = 0; priors.forEach(function (v) { s += v; });
        if (s > 0) priors.forEach(function (v, key) { priors.set(key, v / s); });
      }
      node.children = children;
      node.moves = moves;
      node.priors = priors;
      return node;
    }

    function selectChild(node) {
      var bestKey = null, best = -Infinity;
      var parentVisits = node.visits;
      node.children.forEach(function (_c, key) {
        var child = node._childData ? node._childData.get(key) : null;
        if (!child) {
          // 未访问过 -> 选它(用 prior 作为 U)
          var prior = node.priors.get(key) || 1e-9;
          var u = cpuct * prior * Math.sqrt(parentVisits + 1e-6);
          if (u > best) { best = u; bestKey = key; }
          return;
        }
        var prior = node.priors.get(key) || 1e-9;
        var q = child.valueSum / child.visits;
        var u = q + cpuct * prior * Math.sqrt(parentVisits + 1e-6) / (1 + child.visits);
        if (u > best) { best = u; bestKey = key; }
      });
      return bestKey;
    }

    // 递归选择到叶子; 维护路径上的 childData
    function descend(node) {
      var path = [node];
      var cur = node;
      while (cur.children) {
        var key = selectChild(cur);
        if (!cur._childData) cur._childData = new Map();
        var child = cur._childData.get(key);
        if (!child) {
          // 需要展开该子节点
          child = createChild(cur, key);
          cur._childData.set(key, child);
          path.push(child);
          return { leaf: child, path: path };
        }
        path.push(child);
        cur = child;
      }
      return { leaf: cur, path: path };
    }

    function createChild(parent, key) {
      var size = parent.grid.length;
      var opp = parent.toMove === 1 ? 2 : 1;
      var child;
      if (key === 'pass') {
        child = makeNode(parent.grid, opp, parent.history.concat([{ color: parent.toMove, pass: true }]), parent.rules, false);
      } else {
        var parts = key.split(',');
        var x = +parts[0], y = +parts[1];
        var ng = KF._applyMove(parent.grid, size, x, y, parent.toMove);
        var newHist = parent.history.concat([{ color: parent.toMove, x: x, y: y }]);
        child = makeNode(ng, opp, newHist, parent.rules, false);
      }
      return child;
    }

    function backup(path, leafValue) {
      // leafValue: 叶子处 NN 给出的 "叶子方(toMove)视角" 胜率 [-1,1]
      // 从叶子向上级联回溯(必须自底向上, 保证父读到的子值已被更新)
      for (var i = path.length - 1; i >= 0; i--) {
        var node = path[i];
        node.visits += 1;
        if (i === path.length - 1) {
          node.valueSum += leafValue; // 叶子: 直接记录自身视角 value
        } else {
          var child = path[i + 1];
          var childView = child.visits > 0 ? (child.valueSum / child.visits) : 0;
          node.valueSum += -childView; // 转回本节点(对手)视角取负
        }
      }
    }

    function search(rootGrid, toMove, history, rules, visits) {
      rules = rules || {};
      var root = makeNode(rootGrid, toMove, history || [], rules, true);
      var evalRoot = evaluate(rootGrid, rootGrid.length, toMove, history || [], rules);
      expand(root, evalRoot);
      for (var it = 0; it < visits; it++) {
        var d = descend(root);
        var leaf = d.leaf;
        // 若叶子是未展开的(非 root 的内节点已被展开过), 展开并评估
        if (!leaf.children) {
          var ev = evaluate(leaf.grid, leaf.grid.length, leaf.toMove, leaf.history, leaf.rules);
          expand(leaf, ev);
          // 取该叶子的 NN value (leaf.toMove 视角)
          var leafVal = ev.value;
          backup(d.path, leafVal);
        } else {
          // 叶子已展开(= 终局 或 之前展开): 用其已评估的 value
          // 取该节点最近一次评估 value 缓存
          var cached = leaf._lastValue != null ? leaf._lastValue : 0;
          backup(d.path, cached);
        }
      }
      // 选择根下访问最多的着手
      var bestKey = null, bestVisits = -1, bestValue = 0;
      root._childData.forEach(function (child, key) {
        if (child.visits > bestVisits) {
          bestVisits = child.visits; bestKey = key;
          bestValue = child.valueSum / child.visits;
        }
      });
      if (bestKey === 'pass' || bestKey == null) {
        return { move: null, pass: true, policy: evalRoot.policy, value: evalRoot.value, visits: root.visits, root: root };
      }
      var bp = bestKey.split(',');
      return {
        move: { x: +bp[0], y: +bp[1] }, pass: false,
        policy: evalRoot.policy, value: evalRoot.value, visits: root.visits, root: root,
        bestVisits: bestVisits
      };
    }

    // 异步版本: evaluate 可返回 Promise (例如浏览器端跑 ONNX 网络推理)
    // 用于 katago-worker.js (onnxruntime-web 的 session.run 是异步的)。
    async function searchAsync(rootGrid, toMove, history, rules, visits) {
      rules = rules || {};
      var root = makeNode(rootGrid, toMove, history || [], rules, true);
      var evalRoot = await evaluate(rootGrid, rootGrid.length, toMove, history || [], rules);
      expand(root, evalRoot);
      for (var it = 0; it < visits; it++) {
        var d = descend(root);
        var leaf = d.leaf;
        if (!leaf.children) {
          var ev = await evaluate(leaf.grid, leaf.grid.length, leaf.toMove, leaf.history, leaf.rules);
          expand(leaf, ev);
          var leafVal = ev.value;
          backup(d.path, leafVal);
        } else {
          var cached = leaf._lastValue != null ? leaf._lastValue : 0;
          backup(d.path, cached);
        }
      }
      var bestKey = null, bestVisits = -1, bestValue = 0;
      root._childData.forEach(function (child, key) {
        if (child.visits > bestVisits) {
          bestVisits = child.visits; bestKey = key;
          bestValue = child.valueSum / child.visits;
        }
      });
      if (bestKey === 'pass' || bestKey == null) {
        return { move: null, pass: true, policy: evalRoot.policy, value: evalRoot.value, visits: root.visits, root: root };
      }
      var bp = bestKey.split(',');
      return {
        move: { x: +bp[0], y: +bp[1] }, pass: false,
        policy: evalRoot.policy, value: evalRoot.value, visits: root.visits, root: root,
        bestVisits: bestVisits
      };
    }

    // 让 evaluate 在展开时已展开节点缓存 value
    var origExpand = expand;
    // 包装: 记录 _lastValue
    function expandWrap(node, ev) {
      node._lastValue = ev.value;
      return origExpand(node, ev);
    }
    expand = expandWrap;

    return { search: search, searchAsync: searchAsync, _legalMoves: legalMoves, _softmax: softmax };
  }

  function sampleDirichlet(n, alpha) {
    var out = new Float32Array(n);
    for (var i = 0; i < n; i++) out[i] = gammaSample(alpha);
    return out;
  }
  // 简化 Gamma 采样 (Marsaglia/Tsang) for alpha<1 近似
  function gammaSample(alpha) {
    if (alpha < 1) return gammaSample(1 + alpha) * Math.pow(Math.random(), 1 / alpha);
    var d = alpha - 1 / 3, c = 1 / Math.sqrt(9 * d);
    while (true) {
      var x, v;
      do { x = gaussian(); v = 1 + c * x; } while (v <= 0);
      v = v * v * v;
      var u = Math.random();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }
  function gaussian() {
    var u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  var api = { createSearch: createSearch, _isLegal: isLegal };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.KataSearch = api;
})(typeof self !== 'undefined' ? self : this);
