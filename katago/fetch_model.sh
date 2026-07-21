#!/usr/bin/env bash
#
# 下载 KataGo ONNX 模型到 katago/model/
# ----------------------------------------------------------------
# 浏览器端 KataGo 需要一个 .onnx 权重文件。推荐 28-block uint8 量化版
# (约 72MB，精度/速度平衡好，单线程 wasm 也能跑)。
#
# 用法:
#   bash katago/fetch_model.sh            # 下载默认 28-block 模型
#   bash katago/fetch_model.sh adam       # 下载另一个 28-block 变体(更激进)
#
# 说明: HuggingFace 官方站国内常被墙，本脚本默认优先使用国内镜像
#   hf-mirror.com，失败后再回退官方站。若都失败，可手动到
#   https://hf-mirror.com/kaya-go/kaya  (或官方 https://huggingface.co/kaya-go/kaya)
#   下载对应 .uint8.onnx，放到 katago/model/ 下(保持默认文件名)即可。
#
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="$DIR/model"
mkdir -p "$OUT_DIR"

# 默认模型(用户选定)。注意: HF 仓库里文件在同名子目录下。
DEFAULT_NAME="kata1-b28c512nbt-s12043015936-d5616446734"
ADAM_NAME="kata1-b28c512nbt-adam-s11165M-d5387M"

if [ "$1" = "adam" ]; then
  NAME="$ADAM_NAME"
else
  NAME="$DEFAULT_NAME"
fi

# 仓库内相对路径(子目录/文件) 与 本地扁平文件名(app 期望)
REPO_PATH="$NAME/$NAME.uint8.onnx"
FILE="$NAME.uint8.onnx"

# 候选下载源(按优先级尝试): 国内镜像优先
URLS=(
  "https://hf-mirror.com/kaya-go/kaya/resolve/main/$REPO_PATH"
  "https://huggingface.co/kaya-go/kaya/resolve/main/$REPO_PATH"
)

OUT="$OUT_DIR/$FILE"
echo "目标: $OUT"

for url in "${URLS[@]}"; do
  echo "尝试: $url"
  if command -v curl >/dev/null 2>&1; then
    if curl -L --fail -o "$OUT" "$url"; then
      echo "✅ 下载完成: $OUT"
      ls -lh "$OUT"
      echo "现在刷新网页即可。若之前已打开，请硬刷新(Cmd/Ctrl+Shift+R)。"
      exit 0
    fi
  elif command -v wget >/dev/null 2>&1; then
    if wget -O "$OUT" "$url"; then
      echo "✅ 下载完成: $OUT"
      ls -lh "$OUT"
      exit 0
    fi
  fi
  echo "  ⚠️ 该源失败，尝试下一个..."
done

echo "❌ 自动下载失败。请手动下载并放置到: $OUT"
echo "   打开 https://hf-mirror.com/kaya-go/kaya 找到 $REPO_PATH 下载即可。"
exit 1
