# 弈 · 围棋自学

> 一个**完全免费、纯本地、免会员**的围棋自学站：AI 对练 + 死活题 + 数子，水墨中国风。
> 模型直接跑在浏览器里（KataGo WASM 本地推理），**无需联网、无需后端、无需账号**。

🌐 在线地址：[https://liumingmusic.github.io/weiqi/](https://liumingmusic.github.io/weiqi/)

---

## ✨ 功能一览

- **棋盘**：9 / 13 / 19 路全支持，SVG 渲染，水墨宣纸风格。
- **人机对弈（三档 AI）**
  - **初级**：轻量启发式 AI（纯 JS，秒回，适合入门练手）。
  - **中级 / 高级**：**KataGo 真模型**浏览器本地推理（onnxruntime-web + Web Worker），棋力接近强业余。
- **数子判定**：中国规则数目法（子 + 独占空点），可点选死子、实时显示黑白子/地/贴目与胜负；双方连续虚手自动数子。
- **打劫（ko）**：完整劫争禁着，落子回提会被拦下并提示「须先到别处行棋」。
- **让子（handicap）**：0 / 2～9 子标准位，让子后白先行。
- **死活题**：内置 **50 道**精选经典题（25 做活 / 25 杀棋，入门/初级/中级），点选校验、错题与进度统计、支持导入 SGF 题库。
- **SGF 导入 / 导出**：对局可导出 SGF 下载；死活题可导入 SGF 题集。
- **标注工具**：× / ○ / △ / 数字标记，便于摆变化图。
- **离线 & PWA**：Service Worker 缓存外壳，模型随仓库分发，装好后可**完全离线**使用；可「添加到主屏幕」当 App 用。
- **手机端适配**：响应式布局，小屏满宽可用。

---

## 🧱 技术架构

| 维度 | 说明 |
|---|---|
| 形态 | **纯静态站点**，无构建步骤、无后端、无会员墙 |
| 棋盘渲染 | 原生 SVG（`js/board.js` + `js/app.js`） |
| AI · 初级 | 启发式打分 AI（`js/ai.js`，提子/救援/连片/真眼判定） |
| AI · 中/高级 | **KataGo 28-block uint8 ONNX** 模型 · `onnxruntime-web@1.17.0` 单线程 SIMD WASM · PUCT/MCTS 搜索（`katago/`） |
| 推理隔离 | Web Worker（`katago/katago-worker.js`），主线程引擎封装带 `idle/loading/ready/fallback` 状态机 |
| 离线 | Service Worker（`sw.js`）+ PWA manifest，模型与 WASM 运行时缓存 |
| 持久化 | IndexedDB / localStorage（`js/store.js`）存进度与设置 |
| 风格 | 宣纸米白底 · 焦墨黑 · 朱砂红点缀 · 青灰辅助（中国水墨风） |

> 说明：KataGo 走**单线程** `ort-wasm-simd.wasm`，**无需 COOP/COEP 响应头**，因此 GitHub Pages 等普通静态托管即可直接运行。

---

## 🚀 本地运行

无需安装任何依赖，任意静态服务器即可：

```bash
# 在项目根目录
python3 -m http.server 8080
# 浏览器打开 http://127.0.0.1:8080/
```

> 直接双击 `index.html`（file://）也能跑基础功能，但 **KataGo 模型加载需要 http(s) 环境**（Worker / fetch 限制），建议用上面的本地服务器。

---

## 📁 目录结构

```
.
├── index.html              # 入口页面（对局 / 死活题两页）
├── css/style.css           # 水墨风样式 + 手机端适配
├── js/
│   ├── board.js            # 棋盘模型：落子/提子/打劫/数子/让子/克隆
│   ├── app.js              # SVG 渲染、交互、AI 接入、UI 状态
│   ├── ai.js               # 初级启发式 AI
│   ├── sgf.js              # SGF 导入/导出
│   ├── tsumego-data.js     # 50 道死活题数据
│   └── store.js            # IndexedDB 持久化
├── katago/
│   ├── katago-engine.js    # 主线程引擎封装（状态机 + 失败回退）
│   ├── katago-worker.js    # Web Worker：编码 + 推理 + PUCT
│   ├── features.js         # KataGo v10 特征编码器（22 通道 + 19 全局）
│   ├── search.js           # 纯 JS PUCT/MCTS 搜索
│   ├── ort/                # onnxruntime-web 运行时（ort.min.js + ort-wasm-simd.wasm）
│   ├── model/              # KataGo 模型（.onnx，随仓库分发）
│   ├── fetch_model.sh      # 从镜像下载模型的脚本
│   └── test/               # 单元/集成/真模型回归测试
├── sw.js                   # Service Worker（离线缓存）
├── manifest.webmanifest    # PWA 配置
└── icon.svg                # 站点图标
```

---

## 🤖 关于 AI 模型

- 仓库已自带模型 `katago/model/kata1-b28c512nbt-s12043015936-d5616446734.uint8.onnx`（约 72 MB），克隆即离线可用。
- 模型来源：KataGo 28-block 网络，权重来自 HuggingFace `kaya-go/kaya`（经国内镜像 `hf-mirror.com` 下载；`huggingface.co` 直连可能被墙）。
- 如需重新下载或换模型：

  ```bash
  bash katago/fetch_model.sh
  ```

  然后修改 `katago/katago-worker.js` 中的默认模型路径即可。

### WASM 运行时走 CDN（解决国内加载失败）

KataGo 的 WASM 运行时（`ort-wasm-simd.wasm`，约 10 MB）**默认从 jsDelivr CDN 加载**
（`fastly.jsdelivr.net` 国内镜像，返回 `Access-Control-Allow-Origin: *` 的合法 wasm）。
原因：GitHub Pages 对大文件在部分国内网络下会被拦截并返回 HTML 错误页，
导致 `WebAssembly.instantiate` 报 `expected magic word 00 61 73 6d, found 3c 21 44 4f`（即拿到 `<!DOCTYPE`）。
运行时按 `fastly.jsdelivr.net → cdn.jsdelivr.net → 本地 ort/` 三级回退，本地文件仍在仓库内兜底。
若想完全自托管，把 `katago/katago-worker.js` 里的 `ORT_WASM_CDNS` 改成你自己的 CDN 地址即可。

### 模型能否走公共 CDN？

目前**不行**：72 MB 模型没有「CORS 开放」的公共 CDN 可用——
jsDelivr gh 对 >50 MB 文件返回 403，hf-mirror 跳转后的真实地址未带 `Access-Control-Allow-Origin`（浏览器跨域会被拦）。
因此模型仍走 GitHub Pages 同源（无 CORS 问题，仅取决于网络能否拉大文件，已做分块断点续传+重试兜底）。
如果你要自己托管模型 CDN：把模型放到**腾讯云 COS / 阿里云 OSS** 等并配置 `Access-Control-Allow-Origin: *`，
再把地址填进 `katago/katago-worker.js` 的 `MODEL_MIRRORS` 数组即可自动回退使用。

---

## 🧪 测试

KataGo 相关逻辑带有可复跑测试（位于 `katago/test/`）：

```bash
# 纯 JS 单元测试（无需模型）
node katago/test/test_features.js      # 特征编码器 22/22
node katago/test/test_search.js        # MCTS 搜索 10/10
node katago/test/test_integration.js   # 编码+异步 PUCT 集成 15/15

# 真模型端到端回归（需系统装有 onnxruntime，如 anaconda 环境）
python3 katago/test/verify_model.py    # policy 形状 / 空盘非 PASS / 黑大优 / komi 对称 4/4
```

> 用真权重回归曾发现并修复两个致命编码 bug：① 特征应为 planar NCHW 布局（非交错）；② `value` 输出为 `[win, loss, draw]` logits（非 `[lead, win, loss]`）。

---

## 📦 部署（GitHub Pages）

本站通过 **GitHub Pages（`master` 分支根目录）** 部署，所有资源使用相对路径，无需额外 base 配置。

```bash
git add -A
git commit -m "你的改动说明"
git push origin master
# 在仓库 Settings → Pages 选择 master 分支 /(root) 即可（本项目已开启）
```

部署后访问：`https://<用户名>.github.io/weiqi/`

> 注意：72 MB 模型首次经 Pages 下载稍慢，但浏览器缓存 + Service Worker 之后只下一次，离线可用。

---

## 🗺️ 路线图 / 已知限制

- [x] 初级启发式 AI
- [x] 中/高级 KataGo WASM 真模型
- [x] 数子 / 打劫 / 让子 / SGF
- [x] 50 道死活题 + SGF 导入
- [x] 离线 PWA + 手机端
- [ ] 人人双人对下（暂不做，用户已定为不需要）
- [ ] 小程序 / 桌面 App 封装（模型已离线，可直接封装）

---

## 📄 许可证

本项目用于学习与交流。KataGo 模型权重请遵循其原始许可与 KataGo 项目条款使用。
