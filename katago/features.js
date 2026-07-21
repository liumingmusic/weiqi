/*
 * KataGo 神经网络输入特征编码器 (v10 / kata1 风格)
 * 严格对照 kaya-go/katago-onnx 的 src/katago/game/features.py 翻译。
 * 输出:
 *   bin_input : Float32Array, 长度 22 * N * N, 布局 [channel][y*N+x]
 *   global_input : Float32Array, 长度 19
 * 坐标系: stones[y][x], 1=黑, 2=白, 0=空。
 */
(function (root) {
  'use strict';

  var EMPTY = 0, BLACK = 1, WHITE = 2;
  var NUM_BIN = 22;
  var NUM_GLOBAL = 19;

  function cloneGrid(g) {
    var n = g.length;
    var ng = new Array(n);
    for (var y = 0; y < n; y++) ng[y] = g[y].slice();
    return ng;
  }

  //  Flood-fill 一个棋子所在整块，返回 {stones:[{x,y}], libs:Set("x,y")}
  function groupInfo(g, size, sx, sy) {
    var color = g[sy][sx];
    if (color === EMPTY) return null;
    var stones = [];
    var seen = {};
    var libs = {};
    var stack = [{ x: sx, y: sy }];
    seen[sx + ',' + sy] = true;
    while (stack.length) {
      var p = stack.pop();
      stones.push(p);
      var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (var d = 0; d < 4; d++) {
        var nx = p.x + dirs[d][0], ny = p.y + dirs[d][1];
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        var v = g[ny][nx];
        if (v === EMPTY) {
          libs[nx + ',' + ny] = true;
        } else if (v === color && !seen[nx + ',' + ny]) {
          seen[nx + ',' + ny] = true;
          stack.push({ x: nx, y: ny });
        }
      }
    }
    return { stones: stones, libs: libs, libCount: Object.keys(libs).length };
  }

  // 在 (x,y) 落 color，返回新棋盘(含提子)；若自杀且未提子返回 null。
  function applyMove(g, size, x, y, color) {
    if (g[y][x] !== EMPTY) return null;
    var ng = cloneGrid(g);
    ng[y][x] = color;
    var opp = color === BLACK ? WHITE : BLACK;
    var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    var captured = false;
    for (var d = 0; d < 4; d++) {
      var nx = x + dirs[d][0], ny = y + dirs[d][1];
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      if (ng[ny][nx] === opp) {
        var gi = groupInfo(ng, size, nx, ny);
        if (gi.libCount === 0) {
          for (var i = 0; i < gi.stones.length; i++) {
            ng[gi.stones[i].y][gi.stones[i].x] = EMPTY;
          }
          captured = true;
        }
      }
    }
    // 自杀判定
    if (!captured) {
      var selfGi = groupInfo(ng, size, x, y);
      if (selfGi.libCount === 0) return null;
    }
    return ng;
  }

  // 从空盘重放历史，得到每手后的棋盘数组 boards[0..k]
  function replay(history, size) {
    var boards = [emptyGrid(size)];
    for (var i = 0; i < history.length; i++) {
      var m = history[i];
      var prev = boards[boards.length - 1];
      if (m.pass) {
        boards.push(cloneGrid(prev));
      } else {
        var ng = applyMove(prev, size, m.x, m.y, m.color);
        // 理论上都是合法手；若失败(极少)则退化为复制
        boards.push(ng ? ng : cloneGrid(prev));
      }
    }
    return boards;
  }

  function emptyGrid(size) {
    var g = new Array(size);
    for (var y = 0; y < size; y++) {
      g[y] = new Array(size);
      for (var x = 0; x < size; x++) g[y][x] = EMPTY;
    }
    return g;
  }

  // ---- 征子判断 ----
  // 返回: 站在 (sx,sy) 的整块是否会被 attacker 征吃。
  // 假设当前该块处于被叫吃(1气)或将被叫吃情形，由调用方决定。
  function ladderCapturedFromAtari(g, size, sx, sy, attacker, depth, seenKey) {
    if (depth > 40) return true; // 深度上限，默认判为被征
    var group = groupInfo(g, size, sx, sy);
    if (!group) return false;
    if (group.libCount >= 2) return false; // 已逃出
    // 唯一气点
    var libKey = Object.keys(group.libs)[0];
    var parts = libKey.split(',');
    var lx = +parts[0], ly = +parts[1];
    // 防守方必须下这口气
    var g2 = applyMove(g, size, lx, ly, group.color);
    if (!g2) return false; // 防守方无法落子(理论上不会)
    // 若防守方下后提掉了进攻方棋子 -> 倒扑/逃出
    if (stoneDiff(g, g2, attacker) < 0) return false; // 进攻方子被吃 -> 逃出
    var g2group = groupInfo(g2, size, lx, ly);
    if (g2group.libCount >= 2) return false; // 逃出
    // 仍 1 气：进攻方下这口气
    var libKey2 = Object.keys(g2group.libs)[0];
    var p2 = libKey2.split(',');
    var ax = +p2[0], ay = +p2[1];
    var g3 = applyMove(g2, size, ax, ay, attacker);
    if (!g3) return false;
    // 若进攻方下后提掉防守块 -> 征死
    if (stoneDiff(g2, g3, group.color) < 0) return true;
    // 否则防守块仍在，递归
    var g3group = groupInfo(g3, size, ax, ay);
    if (g3group.libCount >= 2) return false;
    return ladderCapturedFromAtari(g3, size, ax, ay, attacker, depth + 1);
  }

  function stoneDiff(g1, g2, color) {
    // g2 相对 g1 中 color 方棋子数变化(负表示 g2 中 color 更少 => 被吃)
    var d = 0;
    for (var y = 0; y < g1.length; y++)
      for (var x = 0; x < g1.length; x++) {
        if (g1[y][x] === color && g2[y][x] !== color) d--;
        if (g1[y][x] !== color && g2[y][x] === color) d++;
      }
    return d;
  }

  // 对 1 气块：直接判断是否被征
  function isLaddered1Lib(g, size, x, y, attacker) {
    return ladderCapturedFromAtari(g, size, x, y, attacker, 0);
  }

  // 对 2 气块：进攻方先下其中一气，若能把块打成被征，返回这些"起手气点"
  function ladderWorkingMoves2Lib(g, size, x, y, attacker) {
    var group = groupInfo(g, size, x, y);
    if (!group || group.libCount !== 2) return [];
    var libs = Object.keys(group.libs).map(function (k) {
      var p = k.split(','); return { x: +p[0], y: +p[1] };
    });
    var moves = [];
    for (var i = 0; i < libs.length; i++) {
      var lx = libs[i].x, ly = libs[i].y;
      var g2 = applyMove(g, size, lx, ly, attacker);
      if (!g2) continue;
      // 进攻方下后，该块应变为 1 气(被打吃)
      var gi = groupInfo(g2, size, lx, ly);
      // 注意 group 颜色是防守方；g2 中防守块因连上 lx 而扩大
      var defGroup = groupInfo(g2, size, x, y);
      if (defGroup.libCount === 1) {
        if (ladderCapturedFromAtari(g2, size, x, y, attacker, 0)) {
          moves.push({ x: lx, y: ly });
        }
      }
    }
    return moves;
  }

  // 标记所有被征/可被打征的棋子；回调 f(x,y,workingMoves)
  function iterLadders(g, size, f) {
    var solved = {};
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var v = g[y][x];
        if (v !== BLACK && v !== WHITE) continue;
        var gi = groupInfo(g, size, x, y);
        if (gi.libCount !== 1 && gi.libCount !== 2) continue;
        // 用块的"代表点"(最小坐标)做去重
        var rep = gi.stones[0];
        var repKey = rep.x + ',' + rep.y;
        if (solved.hasOwnProperty(repKey)) {
          if (solved[repKey].laddered) f(x, y, solved[repKey].working);
          continue;
        }
        var attacker = v === BLACK ? WHITE : BLACK;
        var laddered, working = [];
        if (gi.libCount === 1) {
          laddered = isLaddered1Lib(g, size, x, y, attacker);
        } else {
          working = ladderWorkingMoves2Lib(g, size, x, y, attacker);
          laddered = working.length > 0;
        }
        solved[repKey] = { laddered: laddered, working: working };
        if (laddered) f(x, y, working);
      }
    }
  }

  // ---- 目数(area)估计: 空点被单色包围归该色；棋子归自身 ----
  function computeArea(g, size) {
    var owner = new Array(size);
    for (var y = 0; y < size; y++) { owner[y] = new Array(size); for (var x = 0; x < size; x++) owner[y][x] = EMPTY; }
    var visited = {};
    for (var sy = 0; sy < size; sy++) {
      for (var sx = 0; sx < size; sx++) {
        if (g[sy][sx] !== EMPTY) { owner[sy][sx] = g[sy][sx]; continue; }
        var key = sx + ',' + sy;
        if (visited[key]) continue;
        // flood fill 空区域
        var region = [];
        var borders = { 1: false, 2: false };
        var stack = [{ x: sx, y: sy }];
        visited[key] = true;
        while (stack.length) {
          var p = stack.pop();
          region.push(p);
          var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
          for (var d = 0; d < 4; d++) {
            var nx = p.x + dirs[d][0], ny = p.y + dirs[d][1];
            if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
            var v = g[ny][nx];
            if (v === EMPTY) {
              var k2 = nx + ',' + ny;
              if (!visited[k2]) { visited[k2] = true; stack.push({ x: nx, y: ny }); }
            } else {
              borders[v] = true;
            }
          }
        }
        var col = EMPTY;
        if (borders[1] && !borders[2]) col = BLACK;
        else if (borders[2] && !borders[1]) col = WHITE;
        for (var r = 0; r < region.length; r++) owner[region[r].y][region[r].x] = col;
      }
    }
    return owner;
  }

  /*
   * 主入口
   * stones: 2D [y][x] 0/1/2 (当前局面, 即历史已下完之后的局面)
   * size: N
   * toMove: 1(黑) 或 2(白)  —— 轮到谁走(pla)
   * history: 已落子序列(最近在最后), 元素 {color,x,y} 或 {color,pass:true}
   * rules: { whiteKomi, scoringRule:'AREA'|'TERRITORY', taxRule:'NONE'|'SEKI'|'ALL',
   *          koRule:'SIMPLE'|'POSITIONAL'|'SITUATIONAL', multiStoneSuicideLegal:false }
   */
  function buildFeatures(stones, size, toMove, history, rules) {
    history = history || [];
    rules = rules || {};
    var whiteKomi = rules.whiteKomi != null ? rules.whiteKomi : 7.5;
    var scoringRule = rules.scoringRule || 'AREA';
    var taxRule = rules.taxRule || 'NONE';
    var koRule = rules.koRule || 'SIMPLE';
    var multiSuicide = rules.multiStoneSuicideLegal || false;

    var pla = toMove, opp = pla === BLACK ? WHITE : BLACK;
    var move_idx = history.length;

    var NN = size * size;
    var bin = new Float32Array(NUM_BIN * NN);
    var glob = new Float32Array(NUM_GLOBAL);

    // 重放得到各手棋盘(用于 prev/prevprev 的征子/目数)
    var boards = replay(history, size); // boards[move_idx] == stones (应一致)
    var cur = stones;
    var prevBoard = boards[move_idx - 1] || cur;
    var prevPrevBoard = boards[move_idx - 2] || prevBoard;

    // 各棋盘的气(每块)
    function libAt(g, x, y) {
      if (g[y][x] === EMPTY) return -1;
      return groupInfo(g, size, x, y).libCount;
    }

    // 通道 0 常量 (planar 布局: bin[channel*NN + pos])
    for (var idx0 = 0; idx0 < NN; idx0++) bin[idx0] = 1.0;

    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var pos = y * size + x;
        var v = cur[y][x];
        if (v === pla) bin[1 * NN + pos] = 1.0;
        else if (v === opp) bin[2 * NN + pos] = 1.0;
        if (v === pla || v === opp) {
          var libs = libAt(cur, x, y);
          if (libs === 1) bin[3 * NN + pos] = 1.0;
          else if (libs === 2) bin[4 * NN + pos] = 1.0;
          else if (libs === 3) bin[5 * NN + pos] = 1.0;
        }
      }
    }

    // 单劫点 (simple ko) —— 调用方通过 rules.koPoint 提供
    if (rules.koPoint) {
      var kx = rules.koPoint.x, ky = rules.koPoint.y;
      if (kx >= 0 && ky >= 0 && kx < size && ky < size)
        bin[6 * NN + (ky * size + kx)] = 1.0;
    }

    // 近 5 手 (交替: prev1=opp, prev2=pla, prev3=opp, prev4=pla, prev5=opp)
    function markPrevMove(k, channel) {
      var m = history[move_idx - k];
      if (!m) return;
      if (m.pass) { glob[k - 1] = 1.0; return; }
      var p = m.y * size + m.x;
      bin[channel * NN + p] = 1.0;
    }
    if (move_idx >= 1) markPrevMove(1, 9);
    if (move_idx >= 2) markPrevMove(2, 10);
    if (move_idx >= 3) markPrevMove(3, 11);
    if (move_idx >= 4) markPrevMove(4, 12);
    if (move_idx >= 5) markPrevMove(5, 13);

    // 征子: 当前 / 前一手 / 前两手
    function ladderFeature(g, channel, workingChannel) {
      iterLadders(g, size, function (lx, ly, working) {
        var lp = ly * size + lx;
        bin[channel * NN + lp] = 1.0;
        // workingChannel 仅对"对方且气>1"的块标记进攻起手点
        if (workingChannel != null && g[ly][lx] === opp) {
          for (var w = 0; w < working.length; w++) {
            var wp = working[w].y * size + working[w].x;
            bin[workingChannel * NN + wp] = 1.0;
          }
        }
      });
    }
    ladderFeature(cur, 14, 17);
    ladderFeature(prevBoard, 15, null);
    ladderFeature(prevPrevBoard, 16, null);

    // 目数(area): 当前棋盘
    var area = computeArea(cur, size);
    for (var ay = 0; ay < size; ay++) {
      for (var ax = 0; ax < size; ax++) {
        var ap = ay * size + ax;
        if (area[ay][ax] === pla) bin[18 * NN + ap] = 1.0;
        else if (area[ay][ax] === opp) bin[19 * NN + ap] = 1.0;
      }
    }
    // 通道 20,21 (第二犹存期起手子): 我们不用日本规则, 置 0

    // ---- 全局特征 ----
    var bArea = size * size;
    var selfKomi;
    if (scoringRule === 'TERRITORY') {
      var blackMoves = 0, whiteMoves = 0;
      for (var i = 0; i < history.length; i++) {
        if (history[i].pass) continue;
        if (history[i].color === BLACK) blackMoves++; else whiteMoves++;
      }
      var whiteSelfKomi = whiteKomi + blackMoves - whiteMoves;
      selfKomi = pla === WHITE ? whiteSelfKomi : -whiteSelfKomi;
    } else {
      selfKomi = pla === WHITE ? whiteKomi : -whiteKomi;
    }
    if (selfKomi > bArea + 1) selfKomi = bArea + 1;
    if (selfKomi < -bArea - 1) selfKomi = -bArea - 1;
    glob[5] = selfKomi / 20.0;

    if (koRule === 'POSITIONAL' || koRule === 'SPIGHT') { glob[6] = 1.0; glob[7] = 0.5; }
    else if (koRule === 'SITUATIONAL') { glob[6] = 1.0; glob[7] = -0.5; }
    // SIMPLE -> 0,0

    if (multiSuicide) glob[8] = 1.0;

    if (scoringRule === 'TERRITORY') glob[9] = 1.0;
    // AREA -> 0

    if (taxRule === 'SEKI') { glob[10] = 1.0; }
    else if (taxRule === 'ALL') { glob[10] = 1.0; glob[11] = 1.0; }
    // NONE -> 0,0

    // encorePhase=0 -> glob[12,13]=0; passWouldEndPhase=false -> glob[14]=0
    // asymPowersOfTwo=0 -> glob[15,16]=0; hasButton=false -> glob[17]=0

    if (scoringRule === 'AREA') {
      var boardAreaIsEven = (size % 2 === 0);
      var drawableKomisAreEven = boardAreaIsEven;
      var komiFloor;
      if (drawableKomisAreEven) komiFloor = Math.floor(selfKomi / 2.0) * 2.0;
      else komiFloor = Math.floor((selfKomi - 1.0) / 2.0) * 2.0 + 1.0;
      var delta = selfKomi - komiFloor;
      if (delta < 0) delta = 0; if (delta > 2) delta = 2;
      var wave;
      if (delta < 0.5) wave = delta;
      else if (delta < 1.5) wave = 1.0 - delta;
      else wave = delta - 2.0;
      glob[18] = wave;
    }

    return { bin_input: bin, global_input: glob, numBin: NUM_BIN, numGlobal: NUM_GLOBAL };
  }

  var KataFeatures = {
    NUM_BIN: NUM_BIN,
    NUM_GLOBAL: NUM_GLOBAL,
    buildFeatures: buildFeatures,
    // 暴露内部工具便于测试
    _groupInfo: groupInfo,
    _applyMove: applyMove,
    _computeArea: computeArea,
    _iterLadders: iterLadders,
    EMPTY: EMPTY, BLACK: BLACK, WHITE: WHITE
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = KataFeatures;
  root.KataFeatures = KataFeatures;
})(typeof self !== 'undefined' ? self : this);
