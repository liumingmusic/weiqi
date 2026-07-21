// 围棋棋盘模型（基础规则：落子 / 提子 / 悔棋）
// 颜色约定：1 = 黑，2 = 白，0 = 空
(function (global) {
  function Board(size) {
    this.size = size || 19;
    this.reset();
  }

  Board.prototype.reset = function (size) {
    if (size) this.size = size;
    this.grid = [];
    for (var y = 0; y < this.size; y++) {
      var row = [];
      for (var x = 0; x < this.size; x++) row.push(0);
      this.grid.push(row);
    }
    this.history = [];   // 每一步 {x, y, color, captured:[...]}
    this.lastMove = null;
    this.current = 1;    // 黑先
    this.deadStones = {};                 // 数子时标记的死子："x,y"
    this.komi = (this.size === 19) ? 7.5 : 0.5; // 贴目（中国规则）
    this.koPoint = null;                  // 劫争禁着点：[x,y]，提单子后对方不能立即回提
    this.handicap = 0;                    // 让子数（0 表示无让子）
    this.handicapStones = [];             // 让子坐标（供 SGF 导出）
  };

  // 直接落子（用于摆题 / 让子，不校验规则）
  Board.prototype.setStone = function (x, y, color) {
    if (this.inBounds(x, y)) this.grid[y][x] = color;
  };

  // 让子点（标准位点），按常见次序返回前 n 个
  Board.prototype.handicapPoints = function (n) {
    var pts;
    if (this.size === 19) pts = [[3, 15], [15, 3], [3, 3], [15, 15], [9, 9], [9, 3], [3, 9], [15, 9], [9, 15]];
    else if (this.size === 13) pts = [[3, 9], [9, 3], [3, 3], [9, 9], [6, 6], [6, 3], [3, 6], [9, 6], [6, 9]];
    else pts = [[2, 6], [6, 2], [2, 2], [6, 6], [4, 4], [4, 2], [2, 4], [6, 4], [4, 6]];
    return pts.slice(0, n);
  };

  // 摆放让子：黑棋放在让子点，白先（current = 2）
  Board.prototype.applyHandicap = function (n) {
    this.handicap = 0;
    this.handicapStones = [];
    if (!n || n < 2) { this.current = 1; return; }
    var pts = this.handicapPoints(n);
    for (var i = 0; i < pts.length; i++) {
      this.setStone(pts[i][0], pts[i][1], 1);
      this.handicapStones.push(pts[i]);
    }
    this.handicap = n;
    this.current = 2; // 白先
  };

  // 统计某色“真眼”数量（用于死活判定 / AI 评估）
  Board.prototype.eyeCountFor = function (color) {
    var n = 0;
    for (var y = 0; y < this.size; y++)
      for (var x = 0; x < this.size; x++)
        if (this.grid[y][x] === 0 && this._isEye(x, y, color)) n++;
    return n;
  };

  // 返回某块棋的气数（用于死活判定）
  Board.prototype.groupLiberties = function (x, y) {
    var g = this._group(x, y);
    return g ? this._liberties(g) : 0;
  };

  Board.prototype.inBounds = function (x, y) {
    return x >= 0 && y >= 0 && x < this.size && y < this.size;
  };

  Board.prototype.get = function (x, y) {
    return this.grid[y][x];
  };

  Board.prototype._neighbors = function (x, y) {
    var self = this;
    return [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]].filter(function (p) {
      return p[0] >= 0 && p[1] >= 0 && p[0] < self.size && p[1] < self.size;
    });
  };

  // 收集与 (x,y) 同色相连的整块棋子
  Board.prototype._group = function (x, y) {
    var color = this.grid[y][x];
    if (!color) return null;
    var stack = [[x, y]];
    var seen = {};
    seen[x + ',' + y] = true;
    var group = [];
    while (stack.length) {
      var p = stack.pop();
      group.push(p);
      var nb = this._neighbors(p[0], p[1]);
      for (var i = 0; i < nb.length; i++) {
        var nx = nb[i][0], ny = nb[i][1];
        var key = nx + ',' + ny;
        if (!seen[key] && this.grid[ny][nx] === color) {
          seen[key] = true;
          stack.push([nx, ny]);
        }
      }
    }
    return group;
  };

  // 计算一块棋的气（相邻空点数）
  Board.prototype._liberties = function (group) {
    var lib = {};
    for (var i = 0; i < group.length; i++) {
      var nb = this._neighbors(group[i][0], group[i][1]);
      for (var j = 0; j < nb.length; j++) {
        var nx = nb[j][0], ny = nb[j][1];
        if (this.grid[ny][nx] === 0) lib[nx + ',' + ny] = true;
      }
    }
    return Object.keys(lib).length;
  };

  // 落子。返回 {ok, captured, suicide, ko}
  Board.prototype.play = function (x, y, color) {
    if (!this.inBounds(x, y)) return { ok: false };
    if (this.grid[y][x] !== 0) return { ok: false };
    // 劫争禁着：不能立即回提上一步刚提掉的劫点（须先到别处行棋）
    if (this.koPoint && this.koPoint[0] === x && this.koPoint[1] === y) {
      return { ok: false, ko: true };
    }
    var c = color || this.current;
    this.grid[y][x] = c;

    var captured = [];
    var opp = (c === 1) ? 2 : 1;
    var nb = this._neighbors(x, y);
    for (var i = 0; i < nb.length; i++) {
      var nx = nb[i][0], ny = nb[i][1];
      if (this.grid[ny][nx] === opp) {
        var g = this._group(nx, ny);
        if (g && this._liberties(g) === 0) {
          for (var k = 0; k < g.length; k++) {
            this.grid[g[k][1]][g[k][0]] = 0;
            captured.push(g[k]);
          }
        }
      }
    }

    // 自杀判定（自己无气且未提子）→ 撤回
    var myGroup = this._group(x, y);
    if (captured.length === 0 && this._liberties(myGroup) === 0) {
      this.grid[y][x] = 0;
      return { ok: false, suicide: true };
    }

    // 计算劫点：仅当“提 1 子且己方落子块仅剩 1 气”时才构成劫，禁止对方立即回提
    var newKo = null;
    if (captured.length === 1 && this._liberties(myGroup) === 1) {
      newKo = [captured[0][0], captured[0][1]];
    }

    this.history.push({ x: x, y: y, color: c, captured: captured, prevKo: this.koPoint });
    this.koPoint = newKo;
    this.lastMove = { x: x, y: y, color: c };
    this.current = (c === 1) ? 2 : 1;
    return { ok: true, captured: captured };
  };

  Board.prototype.undo = function () {
    if (!this.history.length) return false;
    var last = this.history.pop();
    if (!last.pass) {
      var opp = (last.color === 1) ? 2 : 1;
      for (var i = 0; i < last.captured.length; i++) {
        var p = last.captured[i];
        this.grid[p[1]][p[0]] = opp;
      }
      this.grid[last.y][last.x] = 0;
    }
    this.current = last.color;
    this.koPoint = (last.prevKo != null) ? last.prevKo : null;
    this.lastMove = this.history.length ? this.history[this.history.length - 1] : null;
    return true;
  };

  // 虚手（停一手），用于无棋可下时
  Board.prototype.pass = function (color) {
    var c = color || this.current;
    this.history.push({ pass: true, color: c, prevKo: this.koPoint });
    this.koPoint = null;
    this.lastMove = null;
    this.current = (c === 1) ? 2 : 1;
    return true;
  };

  // 判断 (x,y) 是否为 color 的“真眼”（AI 不应去填自己的眼）
  Board.prototype._isEye = function (x, y, color) {
    if (this.grid[y][x] !== 0) return false;
    var orth = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
    var count = 0;
    for (var i = 0; i < orth.length; i++) {
      var ox = orth[i][0], oy = orth[i][1];
      if (ox < 0 || oy < 0 || ox >= this.size || oy >= this.size) continue;
      count++;
      if (this.grid[oy][ox] !== color) return false;
    }
    var opp = (color === 1) ? 2 : 1;
    var diag = [[x - 1, y - 1], [x + 1, y - 1], [x - 1, y + 1], [x + 1, y + 1]];
    var oppDiag = 0;
    for (var j = 0; j < diag.length; j++) {
      var dx = diag[j][0], dy = diag[j][1];
      if (dx < 0 || dy < 0 || dx >= this.size || dy >= this.size) continue;
      if (this.grid[dy][dx] === opp) oppDiag++;
    }
    if (count < 4) return oppDiag === 0; // 边/角眼：对角不能有敌子
    return oppDiag <= 1;                  // 中腹眼：至多一个敌子对角
  };

  // 浅克隆（供 AI 试算，不共享 grid）
  Board.prototype.clone = function () {
    var b = Object.create(Board.prototype);
    b.size = this.size;
    b.grid = this.grid.map(function (row) { return row.slice(); });
    b.history = [];
    b.lastMove = this.lastMove;
    b.current = this.current;
    b.komi = this.komi;
    b.deadStones = {};
    return b;
  };

  // 星位（小目）坐标
  Board.prototype.starPoints = function () {
    var n = this.size;
    if (n === 9) return [[2, 2], [6, 2], [2, 6], [6, 6], [4, 4]];
    if (n === 13) return [[3, 3], [9, 3], [3, 9], [9, 9], [6, 6]];
    if (n === 19) return [[3, 3], [9, 3], [15, 3], [3, 9], [9, 9], [15, 9], [3, 15], [9, 15], [15, 15]];
    return [];
  };

  // 数子（中国规则 · 数目法 / 数子法）
  // 得分 = 己方盘上棋子 + 己方独占的空点（地）；白方另加贴目。
  // deadStones 中的棋子视为已死，按提掉处理（计入对方地）。
  Board.prototype.score = function (komi) {
    komi = (komi == null) ? (this.komi || 0) : komi;
    var size = this.size;

    // 有效盘：死子当作空点
    var eff = [];
    for (var y = 0; y < size; y++) {
      var row = [];
      for (var x = 0; x < size; x++) {
        var v = this.grid[y][x];
        if (v && this.deadStones[x + ',' + y]) v = 0;
        row.push(v);
      }
      eff.push(row);
    }

    var blackStones = 0, whiteStones = 0;
    for (var y2 = 0; y2 < size; y2++)
      for (var x2 = 0; x2 < size; x2++) {
        if (eff[y2][x2] === 1) blackStones++;
        else if (eff[y2][x2] === 2) whiteStones++;
      }

    // 空点区域洪泛，判定归属
    var visited = {};
    var blackTerr = 0, whiteTerr = 0, dame = 0;
    for (var y3 = 0; y3 < size; y3++)
      for (var x3 = 0; x3 < size; x3++) {
        if (eff[y3][x3] !== 0) continue;
        var key = x3 + ',' + y3;
        if (visited[key]) continue;
        var stack = [[x3, y3]];
        visited[key] = true;
        var region = [];
        var touchB = false, touchW = false;
        while (stack.length) {
          var p = stack.pop();
          region.push(p);
          var nb = this._neighbors(p[0], p[1]);
          for (var i = 0; i < nb.length; i++) {
            var nx = nb[i][0], ny = nb[i][1];
            var cv = eff[ny][nx];
            if (cv === 0) {
              var nk = nx + ',' + ny;
              if (!visited[nk]) { visited[nk] = true; stack.push([nx, ny]); }
            } else if (cv === 1) touchB = true;
            else if (cv === 2) touchW = true;
          }
        }
        if (touchB && !touchW) blackTerr += region.length;
        else if (touchW && !touchB) whiteTerr += region.length;
        else dame += region.length;
      }

    var black = blackStones + blackTerr;
    var white = whiteStones + whiteTerr + komi;
    var diff = black - white;
    var winner = diff > 0 ? 1 : (diff < 0 ? 2 : 0);
    return {
      black: black, white: white,
      blackStones: blackStones, whiteStones: whiteStones,
      blackTerr: blackTerr, whiteTerr: whiteTerr,
      dame: dame, komi: komi,
      winner: winner, margin: Math.abs(diff)
    };
  };

  Board.prototype.toggleDead = function (x, y) {
    if (!this.grid[y][x]) return false;
    var k = x + ',' + y;
    if (this.deadStones[k]) delete this.deadStones[k];
    else this.deadStones[k] = true;
    return true;
  };
  Board.prototype.isDead = function (x, y) {
    return !!this.deadStones[x + ',' + y];
  };
  Board.prototype.clearDead = function () { this.deadStones = {}; };

  global.WeiqiBoard = Board;
})(window);
