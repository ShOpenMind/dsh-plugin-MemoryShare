#!/bin/sh
# dsh-plugin-MemoryShare · 安装修复脚本 v2(macOS)
#
# 症状:插件页安装时报 ERR_PNPM_TARBALL_INTEGRITY,反复重试无效。
# 原因:profile 里 dsh-plugin-mind-tree 是从 GitHub main 分支装的,
#       main 每次提交都会让 archive/main.tar.gz 变一次,锁文件里的哈希永远追不上。
# 做法:把这条依赖的安装源换成固定的 release tarball,再重装依赖。
#       换完以后 main 怎么提交都不会再影响安装。
#
# 来源:https://github.com/ShOpenMind/dsh-plugin-MemoryShare
# 许可:MIT

set -u

MIND_TREE_URL="https://github.com/ShOpenMind/dsh-plugin-mind-tree/releases/latest/download/dsh-plugin-mind-tree.tgz"

say() { printf '%s\n' "$*"; }
pause() {
  printf '\n按回车键关闭这个窗口…'
  read -r _ || true
}
trap pause EXIT

say '======================================'
say '  DSH 插件安装修复 v2'
say '======================================'
say ''

BASE="$HOME/.dsh/profiles"
if [ ! -d "$BASE" ]; then
  say "× 找不到 $BASE"
  say '  请先安装并至少打开过一次 DeepSeek Harness。'
  exit 1
fi

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

STAMP=$(date +%Y%m%d-%H%M%S)
cp package.json "package.json.bak-$STAMP" || exit 1
[ -f pnpm-lock.yaml ] && cp pnpm-lock.yaml "pnpm-lock.yaml.bak-$STAMP"
say "→ 已备份配置(后缀 .bak-$STAMP)"
say ''

# 关键一步:把 mind-tree 的安装源从「仓库地址/main」换成固定 tarball
if grep -q 'dsh-plugin-mind-tree' package.json 2>/dev/null; then
  sed -i '' -E "s#\"dsh-plugin-mind-tree\": \"[^\"]*\"#\"dsh-plugin-mind-tree\": \"$MIND_TREE_URL\"#" package.json
  if grep -q 'dsh-plugin-mind-tree.*releases/latest/download' package.json; then
    say '→ 已把 mind-tree 的安装源改成 release tarball(不再跟随 main 分支)'
  else
    say '! 没改成功(maybe 格式不同),继续尝试安装…'
  fi
else
  say '→ package.json 里没有 mind-tree,跳过这一步'
fi

# JSON 自检:改坏了就还原,别把她的 DSH 弄到起不来
if command -v python3 >/dev/null 2>&1; then
  if ! python3 -c 'import json;json.load(open("package.json"))' 2>/dev/null; then
    say '× package.json 改坏了,正在还原…'
    cp "package.json.bak-$STAMP" package.json
    say '  已还原,未做任何改动。'
    exit 1
  fi
  say '→ package.json 校验通过'
fi

say ''
say '→ 开始安装,通常 1～3 分钟,请不要关闭窗口…'
say ''

if command -v pnpm >/dev/null 2>&1; then
  pnpm install --update-checksums
else
  say '(没找到 pnpm,改用 npx)'
  say ''
  npx --yes pnpm install --update-checksums
fi

STATUS=$?
say ''
if [ "$STATUS" -eq 0 ]; then
  say '✓ 修复完成。'
  say ''
  say '接下来:'
  say '  1. 回插件页,重新点「安装」(装记忆插件)'
  say '  2. 装完按 Command + Q 完全退出,再打开'
  say '  3. 打开 设置 → 内置插件 → 记忆'
else
  say "× 还是失败了(退出码 $STATUS)。"
  say "  配置已备份在 $DIR/package.json.bak-$STAMP"
  say '  请把上面最后 20 行截图发回去。'
fi
