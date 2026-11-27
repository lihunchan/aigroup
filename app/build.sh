#!/bin/bash
# 把 app/launcher.js 打包成「AI 群聊.app」。只用到 macOS 自带的工具，不需要安装开发环境。
#
#   bash app/build.sh               更新已经装在"应用程序"（/Applications）里的那一份；
#                                   那里没有的话，打包到程序文件夹里（AI 群聊.app）
#   bash app/build.sh <某处/名字.app>  打包到指定的位置
#
# 平时改 server/ 和 web/ 里的程序不用重新打包；只有改了 app/ 里的东西才需要。
# 调试用的环境变量：AIGROUP_APP_ID（应用标识）、AIGROUP_APP_HOME（记下的程序文件夹位置）、
#                 AIGROUP_APP_PORT（端口）、AIGROUP_APP_DEBUG=1（打开调试命令）。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
NAME="AI 群聊"
ID="${AIGROUP_APP_ID:-local.aigroup.chat}"
# 默认的输出位置：软件如果已经装进"应用程序"，就更新那一份——免得电脑里出现两个同名的软件。
DEFAULT="$ROOT/$NAME.app"
INSTALLED="/Applications/$NAME.app"
if [ "$(/usr/bin/plutil -extract CFBundleIdentifier raw "$INSTALLED/Contents/Info.plist" 2>/dev/null)" = "$ID" ]; then
  DEFAULT="$INSTALLED"
fi
OUT="${1:-$DEFAULT}"
VERSION="1.0"

case "$OUT" in
  *.app) ;;
  *) echo "输出位置要以 .app 结尾：$OUT" >&2; exit 1 ;;
esac

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
APP="$TMP/build.app"

# 1. 编译成"保持运行"的小程序
/usr/bin/osacompile -l JavaScript -s -o "$APP" "$HERE/launcher.js" 2>/dev/null

# 2. 改名、换图标、写入设置
PLIST="$APP/Contents/Info.plist"
put() { /usr/bin/plutil -replace "$1" -string "$2" "$PLIST"; }
put CFBundleName "$NAME"
put CFBundleDisplayName "$NAME"
put CFBundleIdentifier "$ID"
put CFBundleShortVersionString "$VERSION"
put CFBundleVersion "$VERSION"
put LSApplicationCategoryType "public.app-category.productivity"
put AIGroupHome "${AIGROUP_APP_HOME:-$ROOT}"   # 程序文件夹的位置：软件被挪到"应用程序"后靠它找回来
put AIGroupPort "${AIGROUP_APP_PORT:-}"
put AIGroupDebug "${AIGROUP_APP_DEBUG:-0}"
/usr/bin/plutil -replace NSHighResolutionCapable -bool true "$PLIST"
# 窗口里显示的是本机地址上的网页（http://127.0.0.1），要明确允许
/usr/bin/plutil -replace NSAppTransportSecurity -json '{"NSAllowsLocalNetworking":true}' "$PLIST"
put NSAppleEventsUsageDescription "群里的 AI 成员想要控制其他应用。"
# 默认带的这些权限说明用不上：去掉以后，摄像头、麦克风、通讯录之类的访问会被系统直接拒绝
for k in NSAppleMusicUsageDescription NSCalendarsUsageDescription NSCameraUsageDescription \
         NSContactsUsageDescription NSHomeKitUsageDescription NSMicrophoneUsageDescription \
         NSPhotoLibraryUsageDescription NSRemindersUsageDescription NSSiriUsageDescription \
         NSSystemAdministrationUsageDescription CFBundleIconName; do
  /usr/bin/plutil -remove "$k" "$PLIST" 2>/dev/null || true
done
rm -f "$APP/Contents/Resources/Assets.car"
cp "$HERE/AppIcon.icns" "$APP/Contents/Resources/applet.icns"

# 3. 重新签名（本机自签；改过内容后不签的话系统会认为它被改坏了）
/usr/bin/codesign --force --sign - "$APP" 2>/dev/null
/usr/bin/codesign --verify "$APP"

# 4. 放到位。只替换同名的旧版本，不碰别的东西
if [ -e "$OUT" ]; then
  if [ -f "$OUT/Contents/Resources/Scripts/main.scpt" ]; then
    rm -rf "$OUT"
  else
    echo "$OUT 已经存在，而且不是本脚本打包出来的，没有动它。" >&2
    exit 1
  fi
fi
mkdir -p "$(dirname "$OUT")"
mv "$APP" "$OUT"
touch "$OUT"
echo "打包好了：$OUT"
