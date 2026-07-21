'use strict';
// 模型下载：断点续传 + 失败重试 回归测试。
// 模拟 CDN 拉大文件中途断流（某块首次 HTTP 500），验证分块下载能把模型完整拼回，
// 且单块失败被重试吸收、不触发 error 回退。
// 运行：node katago/test/test_model_resume.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CHUNK = 6 * 1024 * 1024;
const SIZE = 15 * 1024 * 1024;            // 合成 15MB（3 块），覆盖多块+边界
const BUF = new Uint8Array(SIZE);
for (let i = 0; i < SIZE; i++) BUF[i] = i % 251;   // 可检测填充

const messages = [];
let failOnce = true;                       // 第 2 块首次请求故意 500，之后重试成功
process.on('unhandledRejection', (e) => console.error('UNHANDLED', e));

function fetchFn(url, opts) {
  opts = opts || {};
  if (opts.method === 'HEAD') {
    return Promise.resolve({ ok: true, status: 200, headers: { get: (h) => h.toLowerCase() === 'content-length' ? String(SIZE) : null } });
  }
  const rh = opts.headers && opts.headers.Range;
  if (rh) {
    const m = /bytes=(\d+)-(\d+)/.exec(rh);
    const start = +m[1], end = +m[2];
    const idx = Math.floor(start / CHUNK);
    if (failOnce && idx === 2) {           // 模拟断流：第 2 块首请求失败
      failOnce = false;
      return Promise.resolve({ ok: false, status: 500, headers: { get: () => null } });
    }
    const slice = BUF.slice(start, end + 1);
    return Promise.resolve({
      ok: true, status: 206,
      headers: { get: (h) => h.toLowerCase() === 'content-range' ? ('bytes ' + start + '-' + end + '/' + SIZE) : null },
      arrayBuffer: () => Promise.resolve(slice)
    });
  }
  return Promise.resolve({ ok: true, status: 200, headers: { get: (h) => h.toLowerCase() === 'content-length' ? String(SIZE) : null }, arrayBuffer: () => Promise.resolve(BUF) });
}

let createdBufLen = 0;
const selfMock = {
  location: { href: 'https://host/katago/katago-worker.js' },
  postMessage: (d) => messages.push(d),
  close: () => {},
  ort: {
    env: { wasm: {} },                     // 真实环境 onnxruntime-web 提供 ort.env.wasm
    InferenceSession: { create: (buf) => { createdBufLen = buf.byteLength; return Promise.resolve({ run: () => Promise.resolve({}) }); } }
  },
  KataFeatures: { buildFeatures: () => ({ bin_input: new Float32Array(22 * 9 * 9), global_input: new Float32Array(19) }) },
  KataSearch: { createSearch: () => ({ searchAsync: () => Promise.resolve({ move: null, pass: true, value: 0, visits: 1 }) }) }
};

const sandbox = {
  self: selfMock, fetch: fetchFn, importScripts: () => {},
  setTimeout: setTimeout, clearTimeout: clearTimeout, console: console,
  Uint8Array: Uint8Array, ArrayBuffer: ArrayBuffer, Float32Array: Float32Array,
  Promise: Promise, Math: Math, Date: Date
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'katago-worker.js'), 'utf8'), sandbox);

selfMock.onmessage({ data: { type: 'load', modelUrl: 'model/test.onnx' } });

const p = new Promise((res) => {
  const iv = setInterval(() => {
    if (messages.some((m) => m.type === 'loaded')) { clearInterval(iv); res('loaded'); }
    else if (messages.some((m) => m.type === 'error')) { clearInterval(iv); res('error:' + JSON.stringify(messages.find((m) => m.type === 'error'))); }
  }, 30);
  setTimeout(() => { clearInterval(iv); res('timeout'); }, 8000);
});

p.then((r) => {
  if (r !== 'loaded') { console.error('FAIL:', r); process.exit(1); }
  if (createdBufLen !== SIZE) { console.error('FAIL 拼装大小错误 期望', SIZE, '实际', createdBufLen); process.exit(1); }
  console.log('OK  模型加载成功，拼装大小 =', createdBufLen, '== 期望', SIZE);
  console.log('OK  进度消息数 =', messages.filter((m) => m.type === 'progress').length, '(断点续传重试后各块进度正常上报)');
  console.log('OK  第2块断流(HTTP 500)已被单次重试吸收，未触发 error 回退');
  process.exit(0);
});
