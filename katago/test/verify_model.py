#!/usr/bin/env python3
"""
真模型端到端验证 (需已下载 model/ 下的 .onnx, 并有 onnxruntime + numpy)。
用 Node 调 features.js 生成真实输入张量, 再用 onnxruntime 跑推理, 校验:
  1. 输入/输出张量形状 (bin[1,22,H,W], global[1,19], policy[1,6,M], value[1,3])
  2. planar 布局正确 (空盘首选着法为角/星位, 而非 PASS)
  3. value = [win, loss, draw] (黑大优 -> win≈1)
  4. komi=0 空盘黑白先胜率对称
用法:
  python3 katago/test/verify_model.py
依赖: onnxruntime, numpy, node(用于运行 features.js)
"""
import os, sys, json, subprocess, tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
KATA = os.path.join(ROOT, 'katago')
MODEL = os.path.join(KATA, 'model', 'kata1-b28c512nbt-s12043015936-d5616446734.uint8.onnx')

def find_node():
    for c in [
        '/Users/Zhuanz/.workbuddy/binaries/node/versions/22.22.2/bin/node',
        '/usr/local/bin/node', 'node']:
        if c == 'node' or os.path.exists(c):
            return c
    return 'node'

def encode(cases):
    """cases: list of (grid, toMove, komi). 返回同长度的 [{bin,glob}]."""
    script = '''
const KF = require(process.argv[2]);
const cases = JSON.parse(process.argv[3]);
const out = cases.map(c => {
  const r = KF.buildFeatures(c.grid, c.grid.length, c.toMove, [], {
    whiteKomi: c.komi, scoringRule:'AREA', taxRule:'NONE', koRule:'SIMPLE',
    multiStoneSuicideLegal:false, koPoint:null });
  return { bin: Array.from(r.bin_input), glob: Array.from(r.global_input) };
});
process.stdout.write(JSON.stringify(out));
'''
    with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False) as f:
        f.write(script); tmp = f.name
    try:
        res = subprocess.run([find_node(), tmp, os.path.join(KATA, 'features.js'),
                              json.dumps(cases)], capture_output=True, text=True, check=True)
        return json.loads(res.stdout)
    finally:
        os.unlink(tmp)

def empty(n): return [[0]*n for _ in range(n)]

def main():
    try:
        import onnxruntime as ort, numpy as np
    except ImportError:
        print('SKIP: 需要 onnxruntime 与 numpy'); return 0
    if not os.path.exists(MODEL):
        print('SKIP: 模型未下载 ->', MODEL); return 0

    N = 19
    # 局面: A 空盘黑先(komi7.5); B 黑大优黑先; 对称 komi=0 黑先/白先
    gB = empty(N)
    for y in range(N): gB[y][9] = 1
    gB[0][17]=2; gB[0][18]=2; gB[1][18]=2
    cases = [
        {'grid': empty(N), 'toMove': 1, 'komi': 7.5},   # A
        {'grid': gB,       'toMove': 1, 'komi': 7.5},   # B
        {'grid': empty(N), 'toMove': 1, 'komi': 0.0},   # C 黑先
        {'grid': empty(N), 'toMove': 2, 'komi': 0.0},   # D 白先
    ]
    enc = encode(cases)
    sess = ort.InferenceSession(MODEL, providers=['CPUExecutionProvider'])
    names = [o.name for o in sess.get_outputs()]

    def run(e):
        b = np.array(e['bin'], np.float32).reshape(1, 22, N, N)
        g = np.array(e['glob'], np.float32).reshape(1, 19)
        r = dict(zip(names, sess.run(None, {'bin_input': b, 'global_input': g})))
        v = r['value'][0]; sm = np.exp(v)/np.exp(v).sum()
        p0 = r['policy'][0, 0]; ps = np.exp(p0-p0.max()); ps /= ps.sum()
        return sm, ps, r['policy'].shape

    npass = nfail = 0
    def ok(name, cond, extra=''):
        nonlocal npass, nfail
        if cond: npass += 1; print('  PASS', name)
        else: nfail += 1; print('  FAIL', name, extra)

    smA, psA, polshape = run(enc[0])
    smB, psB, _ = run(enc[1])
    smC, _, _ = run(enc[2])
    smD, _, _ = run(enc[3])

    ok('policy 形状 [1,6,M]', polshape[1] == 6 and polshape[2] == N*N+1, str(polshape))
    top1 = int(np.argmax(psA))
    ok('空盘首选非 PASS (planar 布局正确)', top1 != N*N, 'top=%d' % top1)
    ok('黑大优 win>0.9 (value=[win,loss,draw])', float(smB[0]) > 0.9, str(np.round(smB,3)))
    ok('komi=0 黑白先胜率对称', abs(float(smC[0]) - float(smD[0])) < 0.02,
       'b=%.4f w=%.4f' % (smC[0], smD[0]))

    print('\n真模型验证: %d 通过, %d 失败' % (npass, nfail))
    return 1 if nfail else 0

if __name__ == '__main__':
    sys.exit(main())
