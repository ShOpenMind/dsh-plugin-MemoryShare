#!/bin/sh
# dsh-plugin-MemoryShare · 安装修复脚本 v3(macOS)
#
# 症状:插件页报 ERR_PNPM_TARBALL_INTEGRITY,重试无效,wanted 哈希一直不变。
# 判断:锁文件没被更新过 —— 旧哈希还钉在里面。
# 做法:先把 mind-tree 的安装源换成固定 tarball(尽力而为),
#       然后**删掉 pnpm-lock.yaml**,让 pnpm 完全重新解析。
#       没有旧锁文件 = 没有旧哈希可对,这是唯一能保证绕开的办法。
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
say '  DSH 插件安装修复 v3'
say '======================================'
say ''

BASE="$HOME/.dsh/profiles"
if [ ! -d "$BASE" ]; then
  say "× 找不到 $BASE"
  exit 1
fi

DIR="$BASE/desktop"
if [ ! -f "$DIR/package.json" ]; then
  FOUND=''
  for d in "$BASE"/*; do
    if [ -f "$d/package.json" ]; then FOUND="$d"; fi
  done
  [ -z "$FOUND" ] && { say "× 找不到任何 profile"; exit 1; }
  DIR="$FOUND"
fi

say "→ profile:$DIR"
cd "$DIR" || exit 1

STAMP=$(date +%Y%m%d-%H%M%S)
cp package.json "package.json.bak-$STAMP" || exit 1
[ -f pnpm-lock.yaml ] && cp pnpm-lock.yaml "pnpm-lock.yaml.bak-$STAMP"
say "→ 已备份(*.bak-$STAMP)"
say ''

say '──── 诊断:package.json 里的 mind-tree ────'
grep -n 'mind-tree' package.json 2>/dev/null || say '(没有找到)'
say '──────────────────────────────────────'
say ''

# 换成固定 tarball(失败也不影响后面的兜底)
sed -i '' -E 's#"dsh-plugin-mind-tree": "[^"]*"#"dsh-plugin-mind-tree": "'"$MIND_TREE_URL"'"#' package.json 2>/dev/null

say '──── 修改后 ────'
grep -n 'dsh-plugin-mind-tree' package.json 2>/dev/null || say '(没有找到)'
say '--------------------------------'
say ''

# 删锁文件:这是关键。没有旧锁,就没有旧哈希。
if [ -f pnpm-lock.yaml ]; then
  rm -f pnpm-lock.yaml
  say '→ 已删除 pnpm-lock.yaml(旧哈希的载体),将从头解析依赖'
else
  say '→ 本来就没有 pnpm-lock.yaml'
fi
say ''
say '→ 开始安装,2～5 分钟,请勿关闭窗口…'
say ''

if command -v pnpm >/dev/null 2>&1; then
  pnpm install
else
  say '(没找到 pnpm,改用 npx)'
  npx --yes pnpm install
fi

STATUS=$?
say ''
if [ "$STATUS" -eq 0 ]; then
  say '✓ 修复完成。'
  say ''
  say '接下来:'
  say '  1. 回插件页,重新点「安装」'
  say '  2. 装完按 Command + Q 完全退出,再打开'
  say '  3. 设置 → 内置插件 → 记忆'
else
  say "× 失败(退出码 $STATUS)。"
  say "  备份在 $DIR/*.bak-$STAMP,可还原。"
  say '  请截图上面「诊断」那一段和最后 20 行发回去。'
fi
