#!/bin/bash
# 找一个能用的 Node.js（18 及以上），找到就打印它的路径。
# 顺序：自己指定的（环境变量 AIGROUP_NODE）→ 系统里装的 → ChatGPT 桌面应用自带的那一份。
find_node() {
  local c major
  for c in \
    "$AIGROUP_NODE" \
    "$(command -v node 2>/dev/null)" \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    "$HOME/.volta/bin/node" \
    "$HOME"/.nvm/versions/node/*/bin/node \
    "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" \
    "/Applications/ChatGPT.app/Contents/Resources/node" \
    "/Applications/Codex.app/Contents/Resources/cua_node/bin/node"
  do
    [ -n "$c" ] && [ -x "$c" ] || continue
    major=$("$c" -p 'process.versions.node.split(".")[0]' 2>/dev/null)
    if [ -n "$major" ] && [ "$major" -ge 18 ] 2>/dev/null; then
      echo "$c"
      return 0
    fi
  done
  return 1
}

no_node_help() {
  echo "没有找到 Node.js 运行环境，群聊程序启动不了。"
  echo
  echo "解决办法（任选其一）："
  echo "  1. 安装 ChatGPT 桌面应用——它自带一份 Node.js，本程序会自动借用；"
  echo "  2. 到 https://nodejs.org 下载安装 Node.js（选 LTS 版）。"
  echo
}
