#!/bin/bash
# 把官方的 Node.js（运行环境）取回来，放到 app/vendor/node/ 下，供 app/build-dist.sh 打包用。
# 只需要做一次；想换新版本时再运行一次即可。
#
#   · 来源：https://nodejs.org/dist/（Node.js 官方），取 24.x 这条长期支持线的最新版；
#   · Apple 芯片（arm64）和 Intel（x64）各取一份，每份约 50 MB；
#   · 下载后用官方公布的 SHA-256 校验，并确认是 Node.js 基金会签名的程序。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
VENDOR="$HERE/vendor/node"
BASE="https://nodejs.org/dist/latest-v24.x"
TEAM="HX7739G8FX"   # Apple 发给 Node.js 基金会的开发者编号

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "查询最新版本…"
/usr/bin/curl -fsSL --max-time 40 "$BASE/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"

for a in arm64 x64; do
  file="$(grep -E "node-v[0-9.]+-darwin-$a\.tar\.gz$" "$TMP/SHASUMS256.txt" | awk '{print $2}' | head -1)"
  want="$(grep -E "node-v[0-9.]+-darwin-$a\.tar\.gz$" "$TMP/SHASUMS256.txt" | awk '{print $1}' | head -1)"
  if [ -z "$file" ] || [ -z "$want" ]; then echo "没有找到 $a 的安装包" >&2; exit 1; fi
  echo "下载 $file …"
  /usr/bin/curl -fL --progress-bar --max-time 900 "$BASE/$file" -o "$TMP/$file"
  got="$(/usr/bin/shasum -a 256 "$TMP/$file" | cut -d' ' -f1)"
  if [ "$got" != "$want" ]; then echo "校验没有通过：$file" >&2; exit 1; fi
  dir="${file%.tar.gz}"
  /usr/bin/tar -xzf "$TMP/$file" -C "$TMP" "$dir/bin/node" "$dir/LICENSE"
  if ! /usr/bin/codesign --verify --strict -R "=anchor apple generic and certificate leaf[subject.OU] = \"$TEAM\"" "$TMP/$dir/bin/node"; then
    echo "签名不对：$file 里的 node 不是 Node.js 基金会签名的" >&2; exit 1
  fi
  rm -rf "$VENDOR/$a"
  mkdir -p "$VENDOR/$a/bin"
  mv "$TMP/$dir/bin/node" "$VENDOR/$a/bin/node"
  cp "$TMP/$dir/LICENSE" "$VENDOR/LICENSE"
  echo "${dir#node-}" > "$VENDOR/$a/VERSION"
  echo "  ✓ $a：${dir#node-}（校验和签名都对）"
done
echo "取回来了：$VENDOR"
