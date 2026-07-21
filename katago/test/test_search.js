const KF = require(require('path').join(__dirname,'..','features.js'));
const KS = require(require('path').join(__dirname,'..','search.js'));
const { BLACK, WHITE, EMPTY } = KF;

let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, extra != null ? JSON.stringify(extra) : ''); } }
function grid(N) { return Array.from({ length: N }, () => new Array(N).fill(EMPTY)); }
function legal(grid, N, x, y, color, ko) { return KS._isLegal(grid, N, x, y, color, ko); }

// 固定峰值 mock (用较大值使 softmax 后先验尖锐, 模拟真实 NN)
function peakMock(N, peak, value) {
  return function (grid, size, toMove, history, rules) {
    const M = size * size + 1;
    const pol = new Float32Array(M);
    if (peak === 'pass') pol[M - 1] = 10.0; else pol[peak.y * size + peak.x] = 10.0;
    return { policy: pol, value: value != null ? value : 0 };
  };
}

// --- 1. 空盘峰值 (4,4) -> 选中 (4,4) ---
{
  const N = 9, g = grid(N);
  const s = KS.createSearch(peakMock(N, { x: 4, y: 4 }, 0), {});
  const r = s.search(g, BLACK, [], {}, 200);
  ok('选中峰值(4,4)', r.move && r.move.x === 4 && r.move.y === 4, r.move);
}

// --- 2. 峰值在占位点(非法) -> 仍返回合法着手 ---
{
  const N = 9, g = grid(N);
  g[4][4] = WHITE; // (4,4) 被占
  const s = KS.createSearch(peakMock(N, { x: 4, y: 4 }, 0), {});
  const r = s.search(g, BLACK, [], {}, 200);
  ok('非法峰值->返回合法着手', r.move && legal(g, N, r.move.x, r.move.y, BLACK, null) && !(r.move.x === 4 && r.move.y === 4), r.move);
}

// --- 3. 峰值在 pass -> 返回 pass ---
{
  const N = 9, g = grid(N);
  const s = KS.createSearch(peakMock(N, 'pass', 0), {});
  const r = s.search(g, BLACK, [], {}, 200);
  ok('峰值pass->返回pass', r.pass === true && r.move === null, r);
}

// --- 4. 偏好吃子: mock policy = 吃子数, 应选中能吃子的点 ---
{
  const N = 9, g = grid(N);
  // 构造白棋被打吃: 白(4,4), 黑(3,4)(5,4)(4,3); 黑下(4,5)可提白(4,4)
  g[4][4] = WHITE; g[3][4] = BLACK; g[5][4] = BLACK; g[4][3] = BLACK;
  const captureMock = function (grid, size, toMove) {
    const M = size * size + 1; const pol = new Float32Array(M);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (grid[y][x] !== EMPTY) continue;
      const ng = KF._applyMove(grid, size, x, y, toMove);
      if (!ng) continue;
      // 数被提白子
      let cap = 0;
      for (let yy = 0; yy < size; yy++) for (let xx = 0; xx < size; xx++) if (grid[yy][xx] === WHITE && ng[yy][xx] === EMPTY) cap++;
      pol[y * size + x] = cap * 10 + 1;
    }
    return { policy: pol, value: 0 };
  };
  const s = KS.createSearch(captureMock, {});
  const r = s.search(g, BLACK, [], {}, 300);
  // 真实吃子点: 白(4,4) 的最后一气在 (x=5,y=4), 即 g[4][5]
  ok('偏好吃子->选中(5,4)', r.move && r.move.x === 5 && r.move.y === 4, r.move);
  ok('吃子着手合法', r.move && legal(g, N, r.move.x, r.move.y, BLACK, null), r.move);
}

// --- 5. 随机局面稳定性: 返回的必须是合法着手 ---
{
  const N = 9, g = grid(N);
  // 随机落若干子
  let cur = BLACK;
  const hist = [];
  for (let i = 0; i < 12; i++) {
    const x = (i * 3 + 1) % N, y = (i * 5 + 2) % N;
    if (g[y][x] === EMPTY && KF._applyMove(g, N, x, y, cur)) { g[y][x] = cur; hist.push({ color: cur, x, y }); cur = cur === BLACK ? WHITE : BLACK; }
  }
  const mock = function (grid, size, toMove) {
    const M = size * size + 1; const pol = new Float32Array(M);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (grid[y][x] === EMPTY) pol[y * size + x] = Math.random();
    return { policy: pol, value: Math.random() * 2 - 1 };
  };
  const s = KS.createSearch(mock, {});
  for (let t = 0; t < 5; t++) {
    const r = s.search(g, BLACK, hist.slice(), {}, 150);
    const okMove = r.pass || (r.move && legal(g, N, r.move.x, r.move.y, BLACK, null));
    ok('随机局面# ' + t + ' 合法', okMove, r.move);
  }
}

console.log(`\n搜索测试: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
