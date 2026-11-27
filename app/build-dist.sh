#!/bin/bash
# 打出"发给别人"的安装包：dist/AI 群聊.dmg
#
#   · 软件里自带程序本体（server/、web/）和运行环境（Node.js），不依赖这台电脑上的任何东西；
#   · 三家的命令行工具（Claude Code、Codex、Antigravity CLI）不放进安装包：
#     对方第一次打开软件时，由软件从各家官方下载（见 server/tools.js）。
# 只用到 macOS 自带的工具。
#
#   bash app/fetch-node.sh     先把官方的 Node.js 取回来（只需要做一次）
#   bash app/build-dist.sh     打包，结果在 dist/ 里
#
# 调试用的环境变量：AIGROUP_APP_ID（应用标识）、AIGROUP_APP_PORT（端口）、AIGROUP_APP_DEBUG=1（打开调试命令）。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
NAME="AI 群聊"
ID="${AIGROUP_APP_ID:-local.aigroup.app}"
VERSION="$(cat "$HERE/VERSION" 2>/dev/null || echo 1.0)"
OUT_DIR="${1:-$ROOT/dist}"
VENDOR="$HERE/vendor/node"
MIN_MACOS="13.5"   # 运行环境（Node.js 24）和 Claude Code 要求的最低系统版本

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
STAGE="$TMP/stage"
APP="$STAGE/$NAME.app"
C="$APP/Contents"
mkdir -p "$C/MacOS" "$C/Resources/app" "$C/Resources/node"

# 1. 程序本体和外壳
/usr/bin/rsync -a --exclude '.DS_Store' "$ROOT/server" "$ROOT/web" "$C/Resources/app/"
cp "$HERE/launcher.js" "$C/Resources/launcher.js"
cp "$HERE/AppIcon.icns" "$C/Resources/AppIcon.icns"
cp "$HERE/stub.sh" "$C/MacOS/aigroup"
chmod 755 "$C/MacOS/aigroup"

# 2. 运行环境：官方的 Node.js（由 app/fetch-node.sh 取回来放在 app/vendor/node/ 下）
ARCHS=""
for a in arm64 x64; do
  if [ -x "$VENDOR/$a/bin/node" ]; then
    mkdir -p "$C/Resources/node/$a/bin"
    cp "$VENDOR/$a/bin/node" "$C/Resources/node/$a/bin/node"
    ARCHS="$ARCHS $a"
  fi
done
if [ -z "$ARCHS" ]; then
  echo "还没有运行环境：请先运行  bash app/fetch-node.sh  把官方的 Node.js 取回来。" >&2
  exit 1
fi
[ -f "$VENDOR/LICENSE" ] && cp "$VENDOR/LICENSE" "$C/Resources/node/LICENSE"

# 3. 软件的基本信息
cat > "$C/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$NAME</string>
  <key>CFBundleDisplayName</key><string>$NAME</string>
  <key>CFBundleIdentifier</key><string>$ID</string>
  <key>CFBundleExecutable</key><string>aigroup</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>$MIN_MACOS</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>LSArchitecturePriority</key><array><string>arm64</string><string>x86_64</string></array>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>AIGroupMode</key><string>bundled</string>
  <key>AIGroupPort</key><string>${AIGROUP_APP_PORT:-4848}</string>
  <key>AIGroupDebug</key><string>${AIGROUP_APP_DEBUG:-0}</string>
</dict>
</plist>
PLIST
/usr/bin/plutil -lint "$C/Info.plist" >/dev/null

# 4. 签名（本机自签。里面的 Node.js 保持官方原来的签名不动）
/usr/bin/codesign --force --sign - "$APP" 2>/dev/null
/usr/bin/codesign --verify --strict "$APP"

# 5. 安装包：软件 + 通往"应用程序"的快捷方式 + 一页说明
ln -s /Applications "$STAGE/Applications"
cp "$HERE/dist-readme.txt" "$STAGE/先看这里.txt"
mkdir -p "$OUT_DIR"
rm -rf "$OUT_DIR/$NAME.app" "$OUT_DIR/$NAME.dmg"
/usr/bin/hdiutil create -quiet -volname "$NAME" -srcfolder "$STAGE" -ov -format UDZO -fs HFS+ "$OUT_DIR/$NAME.dmg"
# 另外留一份没装进安装包的软件，方便在本机直接试
/usr/bin/ditto "$APP" "$OUT_DIR/$NAME.app"

SIZE="$(du -h "$OUT_DIR/$NAME.dmg" | cut -f1 | tr -d ' ')"
echo "打包好了（版本 $VERSION，支持的处理器：$ARCHS）"
echo "  安装包：$OUT_DIR/$NAME.dmg（$SIZE）"
echo "  本机试用：$OUT_DIR/$NAME.app"
