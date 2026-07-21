// 围棋 AI 引擎
// 初级(junior)：轻量启发式，即时、零下载，适合入门与让子陪练
// 中级(middle)/高级(advanced)：基于候选剪枝的 negamax 搜索（受限深度 + 时限）
//   说明：真·KataGo WASM 体积大、需加载数十 MB 模型，本环境不便打包；
//   这里用更强的搜索 AI 作为中/高级的可用实现，强度明显高于初级。
//   若日后要接入真 KataGo，只需在 chooseMove 中按 level 切换到 WASM 封装即可。
(function (global) {
  function opp(c) { return c === 1 ? 2 : 1; }

  // 局面评估（color 视角）：领地差 + 眼位差（鼓励做活/杀棋）
  function evaluate(board, color) {
    var s = board.score();
    var terr = color === 1 ? (s.black - s.white) : (s.white - s.black);
    var eyes = board.eyeCountFor(1) - board.eyeCountFor(2);
    return terr + 8 * eyes;
  }

  // 生成候选着法（启发式排序，取前 K 个）。靠近棋子或开局星位。
  function candidateMoves(board, color, K) {
    var n = board.size, pts = [], seen = {};
    var stoneCount = 0;
    for (var y = 0; y < n; y++)
      for (var x = 0; x < n; x++)
        if (board.grid[y][x]) stoneCount++;

    if (stoneCount === 0) {
      pts = board.starPoints();
    } else {
      for (var y2 = 0; y2 < n; y2++)
        for (var x2 = 0; x2 < n; x2++) {
          var v = board.grid[y2][x2];
          if (!v) continue;
          var nb = board._neighbors(x2, y2);
          for (var i = 0; i < nb.length; i++) {
            var nx = nb[i][0], ny = nb[i][1], key = nx + ',' + ny;
            if (board.grid[ny][nx] === 0 && !seen[key]) {
              seen[key] = true;
              pts.push([nx, ny]);
            }
          }
        }
    }

    var c = color, o = opp(color);
    var scored = [];
    for (var p = 0; p < pts.length; p++) {
      var px = pts[p][0], py = pts[p][1];
      // 合法性（自杀 / 劫争）
      var test = board.clone();
      var r = test.play(px, py, c);
      if (!r.ok) continue;
      var sc = 0;
      // 能吃子
      if (r.captured && r.captured.length) sc += 50 + 12 * r.captured.length;
      // 救自己被打吃的块
      var myG = board._group(px, py);
      if (myG && board._liberties(myG) === 1) sc += 40;
      // 贴身作战（相邻有敌子）
      var nb2 = board._neighbors(px, py);
      for (var k = 0; k < nb2.length; k++) {
        var ax = nb2[k][0], ay = nb2[k][1];
        if (board.grid[ay][ax] === o) {
          sc += 10;
          // 敌块仅一气 → 下一步可吃
          var og = board._group(ax, ay);
          if (og && board._liberties(og) === 1) sc += 30;
        }
      }
      // 填对方眼 = 杀棋好点
      if (board._isEye(px, py, o)) sc += 35;
      // 填自己眼 = 劣手
      if (board._isEye(px, py, c)) sc -= 60;
      // 占空（周围多为空）
      var empties = 0;
      for (var e = 0; e < nb2.length; e++)
        if (board.grid[nb2[e][1]][nb2[e][0]] === 0) empties++;
      sc += empties * 2;
      scored.push({ x: px, y: py, score: sc });
    }
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.slice(0, K);
  }

  // 初级：启发式贪心，无增益之着则停手（pass）
  function chooseJunior(board, color) {
    var cands = candidateMoves(board, color, 16);
    if (!cands.length) return null;
    // 估计“增益”：用浅层评估比较落子前后
    var base = evaluate(board, color);
    var best = null, bestGain = -1e9;
    for (var i = 0; i < cands.length; i++) {
      var m = cands[i];
      var t = board.clone();
      var r = t.play(m.x, m.y, color);
      if (!r.ok) continue;
      var gain = evaluate(t, color) - base;
      // 仍尊重启发分数，但要求有实际增益
      if (gain > bestGain) { bestGain = gain; best = m; }
    }
    // 没有任何能增益的着手 → 停手（填自己地/送死不算增益）
    if (bestGain <= 0.4) return null;
    return best;
  }

  function negamax(board, color, depth, breadth, deadline) {
    if (depth <= 0 || Date.now() > deadline) return evaluate(board, color);
    var cands = candidateMoves(board, color, breadth);
    if (!cands.length) return evaluate(board, color); // 无着可下 → 虚手
    var best = -1e9;
    for (var i = 0; i < cands.length; i++) {
      var m = cands[i];
      var c = board.clone();
      var r = c.play(m.x, m.y, color);
      if (!r.ok) continue;
      var val = -negamax(c, opp(color), depth - 1, breadth, deadline);
      if (val > best) best = val;
    }
    return best;
  }

  function chooseSearch(board, color, depth, breadth, budgetMs) {
    var deadline = Date.now() + budgetMs;
    var cands = candidateMoves(board, color, breadth);
    if (!cands.length) return null;
    var best = null, bestVal = -1e9;
    for (var i = 0; i < cands.length; i++) {
      if (Date.now() > deadline) break;
      var m = cands[i];
      var c = board.clone();
      var r = c.play(m.x, m.y, color);
      if (!r.ok) continue;
      var val = -negamax(c, opp(color), depth - 1, breadth, deadline);
      if (val > bestVal) { bestVal = val; best = m; }
    }
    // 仅当局面已较充分展开（棋子数 ≥ 路数）且毫无增益时，才“见好就收”停手；
    // 否则（开局/少子）必须落子，避免误判停手。
    if (bestVal <= 0.3) {
      var stones = 0;
      for (var y = 0; y < board.size; y++) for (var x = 0; x < board.size; x++) if (board.grid[y][x]) stones++;
      if (stones >= board.size) return null;
    }
    return best;
  }

  function chooseMove(board, color, opts) {
    opts = opts || {};
    var level = opts.level || 'junior';
    var n = board.size;
    if (level === 'junior') return chooseJunior(board, color);
    // 搜索深度/广度随棋盘缩小而加深，时限按档位提高
    var depth = level === 'advanced' ? 3 : 2;
    var breadth = level === 'advanced' ? 14 : 12;
    var budget = level === 'advanced' ? 1500 : 600;
    // 小棋盘可更深
    if (n <= 9) { depth += 1; budget = Math.min(budget * 2, 2000); }
    else if (n <= 13) { depth += 1; }
    return chooseSearch(board, color, depth, breadth, budget);
  }

  global.LightAI = { chooseMove: chooseMove, _candidateMoves: candidateMoves };
})(window);
