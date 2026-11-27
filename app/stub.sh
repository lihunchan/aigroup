#!/bin/bash
# 「AI 群聊」的启动入口（发给别人的那种打包方式用，见 app/build-dist.sh）。
#
# 真正的外壳是软件包里的 Resources/launcher.js，由系统自带的 osascript 运行——
# 软件里因此不带任何需要编译的程序，不挑系统版本，Apple 芯片和 Intel 的电脑都能用。
SELF="$0"
case "$SELF" in /*) ;; *) SELF="$PWD/$SELF" ;; esac
BUNDLE="$(cd "$(dirname "$SELF")/../.." && pwd)"
export AIGROUP_BUNDLE="$BUNDLE"
# 让系统把接下来的进程仍然当作本软件：程序坞里的名字和图标、菜单栏上的名字都跟着本软件走。
export CFProcessPath="$SELF"
exec /usr/bin/osascript -l JavaScript "$BUNDLE/Contents/Resources/launcher.js"
