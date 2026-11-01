#!/bin/sh
# dsh-plugin-MemoryShare · 安装修复脚本(macOS)
#
# 症状:插件页安装时报 ERR_PNPM_TARBALL_INTEGRITY
# 原因:profile 里某个插件是从仓库 main 分支装的,内容变了但锁文件里的哈希没变。
# 作用:让本机接受已更新的依赖内容(等价于 pnpm install --update-checksums)。
#
# 来源:https://github.com/ShOpenMind/dsh-plugin-MemoryShare
# 许可:MIT

set -u

say() { printf '%s\n' "$*"; }

pause() {
  printf '\n按回车键关闭这个窗口…'
  read -r _ || true
}
trap pause EXIT

say '======================================'
say '  DSH 插件安装修复'
say '======================================'
say ''

BASE="$HOME/.dsh/profiles"
if [ ! -d "$BASE" ]; then
  say "× 找不到 $BASE"
  say '  请先安装并至少打开过一次 DeepSeek Harness。'
  exit 1
fi

# 优先 desktop;否则取最后一个带 package.json 的 profile
DIR="$BASE/desktop"
if [ ! -f "$DIR/package.json" ]; then
  FOUND=''
  for d in "$BASE"/*; do
    if [ -f "$d/package.json" ]; then FOUND="$d"; fi
  done
  if [ -z "$FOUND" ]; then
    say "× 在 $BASE 下找不到任何 profile"
    exit 1
  fi
  DIR="$FOUND"
fi

say "→ 目标 profile:$DIR"
cd "$DIR" || exit 1

say ''
say '→ 开始修复,通常 1～3 分钟,请不要关闭窗口…'
say ''

if command -v pnpm >/dev/null 2>&1; then
  pnpm install --update-checksums
else
  say '(没找到 pnpm,改用 npx —— 首次可能需要几十秒)'
  say ''
  npx --yes pnpm install --update-checksums
fi

STATUS=$?
say ''
if [ "$STATUS" -eq 0 ]; then
  say '✓ 修复完成。'
  say ''
  say '接下来三步:'
  say '  1. 回到 DeepSeek Harness 的插件页,重新点「安装」'
  say '  2. 装完后按 Command + Q 完全退出,再重新打开'
  say '  3. 打开 设置 → 内置插件 → 记忆'
else
  say "× 修复失败(退出码 $STATUS)。"
  say '  请把上面最后 15 行截图发回去。'
fi
