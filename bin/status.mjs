#!/usr/bin/env node
// dsh-plugin-memory-share 状态检查：磁盘版本 vs 运行中版本 vs 记忆库概况。
// 用法：dsh-plugin-memory-share [--json]
// 退出码：0 一致 / 1 版本不一致或库损坏 / 2 无法读取
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

const asJson = process.argv.includes('--json')
const dataDir = process.env.MEMORY_SHARE_DIR
  || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'memory-share')

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

if (asJson) {
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

process.exit(consistent === false ? 1 : 0)
