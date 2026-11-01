#!/bin/sh
# 安装 dsh-plugin-memory-share(macOS 一键安装)
#
# 与之前那些「修 pnpm 锁文件」的脚本不同:本脚本**完全不碰 pnpm**。
# 它把插件目录直接放进 profile 的 node_modules,再改两行 package.json。
# 没有 install 动作,就没有哈希校验,也就没有 ERR_PNPM_TARBALL_INTEGRITY。
#
# 需要:python3(macOS 自带)。没有就什么都不做并提示。
# 安全:改前备份,改后校验;任何一步失败自动还原,不留半成品。
#
# 来源:https://github.com/ShOpenMind/dsh-plugin-MemoryShare · MIT

set -u

NAME="dsh-plugin-memory-share"
HERE=$(cd "$(dirname "$0")" && pwd)
TGZ="$HERE/plugin.tgz"

say() { printf '%s\n' "$*"; }
pause() {
  printf '\n按回车键关闭这个窗口…'
  read -r _ || true
}
trap pause EXIT
fail() { say "× $*"; exit 1; }

say '=========================================='
say '  安装：跨会话记忆插件'
say '=========================================='
say ''

[ -f "$TGZ" ] || fail "找不到 plugin.tgz —— 请把整个文件夹一起解压后再运行"
command -v python3 >/dev/null 2>&1 || fail '没找到 python3。请把这句话截图发回去。'

BASE="$HOME/.dsh/profiles"
[ -d "$BASE" ] || fail "找不到 $BASE —— 请先打开过一次 DeepSeek Harness"

DIR="$BASE/desktop"
if [ ! -f "$DIR/package.json" ]; then
  FOUND=''
  for d in "$BASE"/*; do
    [ -f "$d/package.json" ] && FOUND="$d"
  done
  [ -z "$FOUND" ] && fail "找不到可用的 profile"
  DIR="$FOUND"
fi

say "将安装到:$DIR"
say ''
say '这一步做三件事:'
say '  1. 把插件放进该 profile 的 node_modules'
say '  2. 在 package.json 里登记依赖与 bundle'
say '  3. 完成后请你重启 DeepSeek Harness'
say ''
printf '继续吗？输入 y 回车：'
read -r GO
case "$GO" in
  y|Y) ;;
  *) say '已取消,未做任何改动。'; exit 0 ;;
esac
say ''

STAMP=$(date +%Y%m%d-%H%M%S)
cp "$DIR/package.json" "$DIR/package.json.bak-$STAMP" || fail '备份失败（目录不可写？）'
say "→ 已备份 package.json.bak-$STAMP"

TMP=$(mktemp -d) || fail '创建临时目录失败'
trap 'rm -rf "$TMP"' EXIT

tar xzf "$TGZ" -C "$TMP" || fail '解压失败,插件包可能损坏'
SRC="$TMP/package"
[ -d "$SRC" ] || fail '插件包里没有 package 目录'

mkdir -p "$DIR/node_modules"
rm -rf "$DIR/node_modules/$NAME"
cp -R "$SRC" "$DIR/node_modules/$NAME" || fail '复制插件失败'
say '→ 插件已放入 node_modules'

python3 - "$DIR/package.json" "$NAME" <<'PY' || fail '修改 package.json 失败'
import json, sys
path, name = sys.argv[1], sys.argv[2]
with open(path, encoding='utf-8') as f:
    doc = json.load(f)
deps = doc.setdefault('dependencies', {})
deps[name] = 'file:./node_modules/' + name
profile = doc.setdefault('dsh', {}).setdefault('profile', {})
bundles = profile.setdefault('bundles', [])
if name not in bundles:
    bundles.append(name)
with open(path, 'w', encoding='utf-8') as f:
    json.dump(doc, f, ensure_ascii=False, indent=2)
    f.write('\n')
PY

# 校验:读不回来就还原
python3 -c 'import json,sys;json.load(open(sys.argv[1]))' "$DIR/package.json" 2>/dev/null || {
  cp "$DIR/package.json.bak-$STAMP" "$DIR/package.json"
  fail 'package.json 校验失败,已还原,未做任何改动'
}
say '→ package.json 校验通过'
say ''
say '✓ 安装完成。'
say ''
say '现在:'
say '  1. 按 Command + Q 完全退出 DeepSeek Harness'
say '  2. 重新打开'
say '  3. 设置 → 内置插件 → 记忆'
say ''
say '看到「共 0 条」就成功了。'
