#!/bin/bash
# 双击启动 AI 群聊：启动本机服务，并自动打开浏览器。
# 用完后关掉这个终端窗口（或按 Ctrl+C）就停止了。
cd "$(dirname "$0")" || exit 1
. ./server/find-node.sh

NODE="$(find_node)"
if [ -z "$NODE" ]; then
  no_node_help
  read -r -p "按回车键关闭…" _
  exit 1
fi

"$NODE" server/main.js --open
status=$?
if [ "$status" -ne 0 ]; then
  echo
  read -r -p "启动没有成功（见上面的提示）。按回车键关闭…" _
fi
exit "$status"
