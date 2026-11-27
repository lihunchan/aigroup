#!/bin/bash
# 给群里的 Claude 做一次性登录（用你平时的 Claude 账号）。
# 为什么需要：Claude 桌面应用的登录状态不对外共享；群里的 Claude 是独立运行的 Claude Code，
# 需要它自己的登录。登录信息由 Claude Code 自己保存在系统钥匙串里，本程序不接触你的密码。
cd "$(dirname "$0")" || exit 1
. ./server/find-node.sh

NODE="$(find_node)"
if [ -z "$NODE" ]; then
  no_node_help
  read -r -p "按回车键关闭…" _
  exit 1
fi

"$NODE" server/main.js --login-claude
status=$?
echo
if [ "$status" -eq 0 ]; then
  echo "登录完成。回到群聊页面，点左下角的 Claude →「重新检测」，就可以让它发言了。"
else
  echo "登录没有完成，可以再双击一次重试。"
fi
read -r -p "按回车键关闭…" _
exit "$status"
