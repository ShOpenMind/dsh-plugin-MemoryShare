// dsh-plugin-MemoryShare 记忆成本审计：回答「谁在吃我的预算、哪些该合并、哪些该删」。
// 用法：node tools/audit.mjs [--json] [--dir <数据目录>]
// 等价于 `dsh-plugin-memory-share --audit`（报告逻辑在 lib/audit.js，两个入口共用一份排版）。
// 只读，不写库；纯本地，不需要 DSH 运行时。
// License: MIT
import { buildReport, formatReport, resolveDataDir } from '../lib/audit.js'

const args = process.argv.slice(2)
const asJson = args.includes('--json')

// --dir 同时接受 `--dir 路径` 与 `--dir=路径`（bin/status.mjs 支持同两种写法，保持一致）。
// 缺值时回落到默认目录，和旧脚本「有参数但没值就忽略」的行为一致。
let dir
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--dir' && i + 1 < args.length) {
    i += 1
    dir = args[i]
  } else if (args[i].startsWith('--dir=')) {
    dir = args[i].slice('--dir='.length)
  }
}

try {
  const report = await buildReport({ dir: resolveDataDir(dir) })
  process.stdout.write(asJson ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report))
  process.exitCode = 0
} catch (error) {
  process.stderr.write(`${error?.stack ?? error}\n`)
  process.exitCode = 2
}
