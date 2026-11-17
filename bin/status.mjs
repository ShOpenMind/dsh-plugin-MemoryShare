#!/usr/bin/env node
// dsh-plugin-memory-share 状态检查：磁盘版本 vs 运行中版本 vs 记忆库概况。
// 用法：dsh-plugin-memory-share [--json] [--dir <路径>]
//       dsh-plugin-memory-share --audit [--json] [--dir <路径>]
// 退出码：0 一致 / 1 版本不一致或库损坏（仅默认模式）/ 2 无法读取
//
// --audit 是「记账」不是「体检」：版本不一致也返回 0，免得把「该合并了」当成故障让脚本挂掉。
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { buildReport, formatReport, resolveDataDir } from '../lib/audit.js'

// 手写 argv 循环：两个布尔开关加一个路径参数，不值得为此引依赖（插件要求零运行时依赖）。
// 未知参数保持旧行为——忽略而不是报错，免得以后加参数时把老脚本用挂。
function parseArgs(argv) {
  const options = { json: false, audit: false, help: false, dir: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') options.json = true
    else if (arg === '--audit') options.audit = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--dir' && i + 1 < argv.length) {
      i += 1
      options.dir = argv[i]
    } else if (arg.startsWith('--dir=')) options.dir = arg.slice('--dir='.length)
  }
  return options
}

const USAGE = [
  'dsh-plugin-memory-share —— 状态检查 / 记忆成本审计',
  '',
  '用法：dsh-plugin-memory-share [--json] [--dir <路径>]',
  '      dsh-plugin-memory-share --audit [--json] [--dir <路径>]',
  '',
  '选项：',
  '  （无参数）   对比磁盘版本与运行中版本，打印记忆库概况；版本不一致时退出码 1',
  '  --audit      打印记忆成本审计（预算占用、条目成本、可能重复、过期条目），退出码 0',
  '  --json       输出 JSON；与 --audit 组合时输出审计报告',
  '  --dir <路径> 指定记忆库目录（默认 $MEMORY_SHARE_DIR，否则 $DSH_HOME/memory-share）',
  '  -h, --help   打印本帮助',
].join('\n')

const options = parseArgs(process.argv.slice(2))

if (options.help) {
  process.stdout.write(`${USAGE}\n`)
  process.exit(0)
}

const dataDir = resolveDataDir(options.dir)

if (options.audit) {
  // 审计是只读汇报，不参与健康判断：版本对不上也让默认模式去报警。
  try {
    const report = await buildReport({ dir: dataDir })
    process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report))
    process.exitCode = 0
  } catch (error) {
    process.stderr.write(`${error?.stack ?? error}\n`)
    process.exitCode = 2
  }
} else {
  // 以下为默认行为：文案与退出码保持与改动前逐字一致，别顺手「优化」措辞。
  async function readJson(path) {
    try {
      return JSON.parse(await readFile(path, 'utf8'))
    } catch {
      return undefined
    }
  }

  const pkg = await readJson(new URL('../package.json', import.meta.url))
  const runtime = await readJson(join(dataDir, 'runtime.json'))
  const store = await readJson(join(dataDir, 'memories.json'))

  let storeStat
  try {
    storeStat = await stat(join(dataDir, 'memories.json'))
  } catch {
    storeStat = undefined
  }

  const entries = Array.isArray(store?.entries) ? store.entries : []
  const counts = { user: 0, workspace: 0, session: 0 }
  for (const entry of entries) {
    if (counts[entry.scope] !== undefined) counts[entry.scope] += 1
  }

  const diskVersion = pkg?.version ?? 'unknown'
  const runVersion = runtime?.version
  const consistent = runVersion === undefined ? null : runVersion === diskVersion

  const report = {
    dataDir,
    diskVersion,
    running: runtime === undefined ? null : {
      version: runVersion,
      pid: runtime.pid,
      startedAt: runtime.startedAt,
      node: runtime.node,
    },
    consistent,
    memories: {
      total: entries.length,
      counts,
      bytes: storeStat?.size ?? 0,
      updatedAt: storeStat?.mtime?.toISOString() ?? null,
    },
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    const line = (label, value) => process.stdout.write(`${label.padEnd(14)}${value}\n`)
    process.stdout.write('dsh-plugin-memory-share\n')
    process.stdout.write('─'.repeat(46) + '\n')
    line('数据目录', dataDir)
    line('磁盘版本', diskVersion)
    if (runtime === undefined) {
      line('运行中版本', '（没有 runtime.json —— 插件未在此机器上启动过，或从未重启过后加载）')
    } else {
      line('运行中版本', `${runVersion}${consistent ? '  ✓ 一致' : '  ✗ 与磁盘不一致，需要重启 DSH'}`)
      line('进程', `pid ${runtime.pid}　启动于 ${runtime.startedAt}`)
    }
    line('记忆条目', `${entries.length} 条　全局 ${counts.user} · 工作区 ${counts.workspace} · 会话 ${counts.session}`)
    line('文件大小', `${(report.memories.bytes / 1024).toFixed(1)} KiB`)
    line('最后写入', report.memories.updatedAt ?? '（还没有记忆库）')
  }

  process.exitCode = consistent === false ? 1 : 0
}
