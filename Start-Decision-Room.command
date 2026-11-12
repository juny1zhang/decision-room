#!/bin/zsh
# Load the user's normal macOS login environment (including common nvm setups).
# The application path is passed as a positional argument, never interpolated
# into shell program text. No dependencies or global settings are changed.

decision_room_dir="${0:A:h}"

if [[ ! -f "$decision_room_dir/server.mjs" ]]; then
  print -u2 -- '找不到 server.mjs。请先完整解压应用，再运行这个启动器。'
  read -r '?按 Enter 关闭…'
  exit 1
fi

cd -- "$decision_room_dir" || exit 1

/bin/zsh -lic '
  if ! command -v node >/dev/null 2>&1; then
    print -u2 -- "找不到 Node.js。请安装 Node.js 18 或更新版本，或在已启用 Node/nvm 的终端运行 node server.mjs。"
    exit 127
  fi
  exec node "$1"
' decision-room-launcher "$decision_room_dir/server.mjs"

decision_room_status=$?
if (( decision_room_status != 0 )); then
  print -u2 -- ''
  print -u2 -- '启动未完成。请查看上方提示，或按 README 在终端运行 node server.mjs --check。'
  read -r '?按 Enter 关闭…'
fi
exit "$decision_room_status"
