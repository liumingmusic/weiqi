/*
 * features.js 单元测试 (planar NCHW 布局)
 * 布局: bin_input[channel * N*N + (y*N + x)]  —— 与 ONNX 模型 [1,22,H,W] 一致。
 * 运行: node katago/test/test_features.js
 */
const path = require('path');
const KF = require(path.join(__dirname, '..', 'features.js'));
const { BLACK, WHITE, EMPTY } = KF;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra != null ? JSON.stringify(extra) : ''); }
}
function grid(N) { return Array.from({ length: N }, () => new Array(N).fill(EMPTY)); }
// planar 取值: channel ch, 位置 p, 棋盘边长 N
function B(f, ch, p, N) { return f.bin_input[ch * N * N + p]; }

// --- 1. 空盘, 黑先 ---
{
  const N = 9, stones = grid(N);
  const f = KF.buildFeatures(stones, N, BLACK, [], { whiteKomi: 7.5, scoringRule: 'AREA', taxRule: 'NONE', koRule: 'SIMPLE' });
  ok('bin length=22*N*N', f.bin_input.length === 22 * N * N, f.bin_input.length);
  ok('glob length=19', f.global_input.length === 19, f.global_input.length);
  let ch0all1 = true;
  for (let p = 0; p < N * N; p++) if (B(f, 0, p, N) !== 1.0) ch0all1 = false;
  ok('ch0 全为1', ch0all1);
  let ch1zero = true, ch3zero = true;
  for (let p = 0; p < N * N; p++) { if (B(f, 1, p, N) !== 0) ch1zero = false; if (B(f, 3, p, N) !== 0) ch3zero = false; }
  ok('空盘 ch1=0', ch1zero); ok('空盘 ch3=0', ch3zero);
  ok('glob[5]=-0.375', Math.abs(f.global_input[5] - (-0.375)) < 1e-6, f.global_input[5]);
  ok('glob[18] in [-1,1]', Math.abs(f.global_input[18]) <= 1.0001, f.global_input[18]);
}

// --- 2. 单黑子居中, 黑先: ch1=1, 气=4 -> ch3/4/5=0 ---
{
  const N = 9, stones = grid(N);
  stones[4][4] = BLACK;
  const f = KF.buildFeatures(stones, N, BLACK, [], {});
  const pos = 4 * N + 4;
  ok('中心 ch1=1', B(f, 1, pos, N) === 1.0);
  ok('中心 ch2=0', B(f, 2, pos, N) === 0.0);
  ok('4气->ch3=0', B(f, 3, pos, N) === 0.0);
  ok('4气->ch4=0', B(f, 4, pos, N) === 0.0);
  ok('4气->ch5=0', B(f, 5, pos, N) === 0.0);
}

// --- 3. 黑子被叫吃(仅1气): ch3=1 ---
{
  const N = 9, stones = grid(N);
  stones[4][4] = BLACK;
  stones[3][4] = WHITE; stones[5][4] = WHITE; stones[4][3] = WHITE; // 只剩 (4,5) 一气
  const f = KF.buildFeatures(stones, N, BLACK, [], {});
  const pos = 4 * N + 4;
  ok('叫吃 ch3=1', B(f, 3, pos, N) === 1.0, B(f, 3, pos, N));
  ok('叫吃 ch4=0', B(f, 4, pos, N) === 0.0);
}

// --- 4. 单劫点: ch6 ---
{
  const N = 9, stones = grid(N);
  stones[4][4] = BLACK;
  const f = KF.buildFeatures(stones, N, BLACK, [], { koPoint: { x: 2, y: 2 } });
  const pos = 2 * N + 2;
  ok('ko ch6=1', B(f, 6, pos, N) === 1.0);
  ok('非ko点 ch6=0', B(f, 6, 0, N) === 0.0);
}

// --- 5. 历史: 白刚落一子, 黑先 -> ch9 在该点; glob[0]=0 ---
{
  const N = 9, stones = grid(N);
  stones[2][2] = WHITE; // 白上一步
  const f = KF.buildFeatures(stones, N, BLACK, [{ color: WHITE, x: 2, y: 2 }], {});
  const pos = 2 * N + 2;
  ok('prev1(opp) ch9=1', B(f, 9, pos, N) === 1.0);
  ok('glob[0]=0(非pass)', f.global_input[0] === 0.0);
}

// --- 6. 历史含 pass -> glob[0]=1 ---
{
  const N = 9, stones = grid(N);
  const f = KF.buildFeatures(stones, N, BLACK, [{ color: WHITE, pass: true }], {});
  ok('pass -> glob[0]=1', f.global_input[0] === 1.0);
}

// --- 7. 目数: 黑墙围空, (2,2) owner=黑 -> ch18=1 ---
{
  const N = 5, stones = grid(N);
  stones[1][2] = BLACK; stones[3][2] = BLACK; stones[2][1] = BLACK; stones[2][3] = BLACK;
  const f = KF.buildFeatures(stones, N, BLACK, [], {});
  const pos = 2 * N + 2;
  ok('围空 ch18=1', B(f, 18, pos, N) === 1.0, B(f, 18, pos, N));
  const wpos = 1 * N + 2;
  ok('墙上子 ch1=1 & ch18=1', B(f, 1, wpos, N) === 1.0 && B(f, 18, wpos, N) === 1.0);
}

// --- 8. 征子: 运行无异常, ch14 为数值 ---
{
  const N = 9, stones = grid(N);
  stones[1][1] = BLACK;
  stones[0][1] = WHITE; stones[1][0] = WHITE;
  KF._iterLadders(stones, N, function () {});
  const f = KF.buildFeatures(stones, N, BLACK, [], {});
  ok('ch14 为数值', typeof B(f, 14, 1 * N + 1, N) === 'number');
}

console.log(`\n特征编码器测试(planar): ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
