// 集成测试: features.js + search.js(searchAsync) + engine.boardToInput 映射
// 用 mock 异步 evaluate 模拟 ONNX 推理，验证整条链路与 Board->input 映射正确。
// 布局: bin_input 为 planar NCHW, bin[channel*N*N + (y*N+x)]。
// 运行: node katago/test/test_integration.js
const path = require('path');
const base = path.join(__dirname, '..');
const KataFeatures = require(path.join(base, 'features.js'));
const KataSearch = require(path.join(base, 'search.js'));
const Engine = require(path.join(base, 'katago-engine.js'));

function makeBoard(size) {
  const grid = [];
  for (let y = 0; y < size; y++) grid.push(new Array(size).fill(0));
  return { size, grid, history: [], komi: 0.5, koPoint: null, current: 1 };
}
function B(feats, ch, p, N) { return feats.bin_input[ch * N * N + p]; }

(async () => {
  let pass = 0, fail = 0;
  function check(name, cond) { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name); } }

  // --- 1. boardToInput 映射 ---
  const board = makeBoard(9);
  board.grid[4][4] = 1; // 放一颗黑子
  const input = Engine._boardToInput(board, 2); // 白方走
  check('input.size=9', input.size === 9);
  check('input.toMove=2 (白)', input.toMove === 2);
  check('input.grid 深拷贝(互不影响)', input.grid[4][4] === 1 && input.grid !== board.grid);
  check('rules.whiteKomi=0.5', input.rules.whiteKomi === 0.5);
  check('rules.koPoint=null', input.rules.koPoint === null);
  check('history 为空数组', Array.isArray(input.history) && input.history.length === 0);

  // --- 2. buildFeatures 能跑通(不抛错, 输出尺寸正确) ---
  const feats = KataFeatures.buildFeatures(input.grid, input.size, input.toMove, input.history, input.rules);
  check('bin_input 长度=22*N*N', feats.bin_input.length === 22 * 9 * 9);
  check('global_input 长度=19', feats.global_input.length === 19);
  // 黑子(1)在 (x=4,y=4) -> channel1(pla) 当 toMove=2 时为对手, 应为0; channel2(opp) 应为1
  const p = 4 * 9 + 4;
  check('opp 通道含该黑子 (ch2=1)', B(feats, 2, p, 9) === 1);
  check('pla 通道不含该黑子 (ch1=0)', B(feats, 1, p, 9) === 0);

  // --- 3. searchAsync 用异步 mock evaluate ---
  function mockEval(size) {
    return async function (grid, sz, tm, hist, rules) {
      const policy = new Float32Array(sz * sz + 1);
      policy[2 * sz + 2] = 12.0;
      for (let i = 0; i < policy.length - 1; i++) policy[i] += 0.1;
      return { policy, value: 0.5, winrate: 0.77 };
    };
  }
  const search = KataSearch.createSearch(mockEval(9), { cpuct: 1.4, dirichletAlpha: 0.25, dirichletWeight: 0.2 });
  const res = await search.searchAsync(input.grid, input.toMove, input.history, input.rules, 30);
  check('searchAsync 返回 Promise 结果', res && (res.move || res.pass));
  check('选点合法(非占位且为空)', res.move && input.grid[res.move.y][res.move.x] === 0);
  check('visits 被正确累计', res.visits > 0);
  console.log('    选中:', res.move ? `(${res.move.x},${res.move.y})` : 'pass', ' visits=', res.visits);

  // --- 4. 全满棋盘 -> 只能 pass ---
  const full = makeBoard(5);
  for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) full.grid[y][x] = ((x + y) % 2) + 1;
  const inp2 = Engine._boardToInput(full, 1);
  const f2 = KataFeatures.buildFeatures(inp2.grid, inp2.size, inp2.toMove, inp2.history, inp2.rules);
  check('满盘特征长度正确', f2.bin_input.length === 22 * 25);
  const s2 = KataSearch.createSearch(mockEval(5), {});
  const r2 = await s2.searchAsync(inp2.grid, 1, inp2.history, inp2.rules, 10);
  check('满盘只能 pass', r2.pass === true);

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
