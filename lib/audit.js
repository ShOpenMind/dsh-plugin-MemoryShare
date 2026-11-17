// dsh-plugin-MemoryShare 记忆成本审计：回答「谁在吃我的预算、哪些该合并、哪些该删」。
//
// 这段逻辑原本只写在 tools/audit.mjs 里；现在同一个报告有两个入口：
//   - bin/status.mjs --audit（插件装成命令后，用户直接敲）
//   - tools/audit.mjs（仓库内直接跑，便于开发时对比）
// 报告布局只留这一份实现，两个入口才不会各说各话。
//
// 只读，不写库；纯本地，不需要 DSH 运行时。
// License: MIT
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { similarityOf, estimateTokens } from './text.js'
import { normalizeTier } from './store.js'
import { renderMemoryBlock } from './render.js'

const DAY = 86400000

/**
 * 注入预算的默认上限（字）。宿主侧注入时按这个量截断；审计把它复述出来，
 * 是为了让「库比预算大多少」变成报告里显式的一行，而不是靠用户心算。
 */
export const DEFAULT_MAX_CHARS = 1800

/**
 * 审计用的相似阈值，比存储侧「命中即建议合并」的 SIMILAR_THRESHOLD（0.5）更松。
 * 审计宁可多列几对让人眼确认，也不要漏掉「半重复」的条目 —— 漏掉的成本是白花预算，
 * 多列的成本只是扫一眼。
 */
const PAIR_THRESHOLD = 0.35

/**
 * 记忆库位置：显式传入 > MEMORY_SHARE_DIR > DSH_HOME 下的默认目录。
 * 必须和宿主侧 store 的定位规则同源，否则审计看的是另一个库。
 */
export function resolveDataDir(explicit) {
  if (explicit) return explicit
  if (process.env.MEMORY_SHARE_DIR) return process.env.MEMORY_SHARE_DIR
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'memory-share')
}

/**
 * 读库。ENOENT 不算错误：从没存过记忆是正常状态，报告里写「没有记忆库」即可；
 * 别的错误（JSON 损坏、权限不足）照常抛，因为那确实需要人介入。
 */
async function readStore(dir) {
  try {
    return JSON.parse(await readFile(join(dir, 'memories.json'), 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

/** 库不存在时的报告骨架：键名与正常报告一致，消费方不必为缺库写特判。 */
function emptyReport(dataDir, maxChars) {
  return {
    dataDir,
    exists: false,
    entries: 0,
    totalChars: 0,
    totalTokens: 0,
    scopes: {
      user: { entries: 0, chars: 0 },
      workspace: { entries: 0, chars: 0 },
      session: { entries: 0, chars: 0 },
    },
    expired: [],
    similarPairs: [],
    tiers: { hot: { entries: 0, chars: 0 }, cold: { entries: 0, chars: 0 } },
    renderedChars: 0,
    renderedTokens: 0,
    residentChars: 0,
    residentTokens: 0,
    shown: 0,
    dropped: 0,
    rows: [],
    budget: maxChars,
  }
}

/**
 * 汇总一份审计报告。纯只读：不改库、不依赖运行中的 DSH。
 *
 * @param {object} [options]
 * @param {string} [options.dir]      记忆库目录，默认走 resolveDataDir()
 * @param {number} [options.now]      时间基准（便于测试与回放），默认 Date.now()
 * @param {number} [options.maxChars] 注入预算（字），默认 DEFAULT_MAX_CHARS
 * @param {number} [options.entryChars] 单条正文上限（字），默认与宿主 DEFAULTS 一致
 * @returns {Promise<object>} 与旧版 `tools/audit.mjs --json` 同构，另加 budget/renderedChars
 */
export async function buildReport({
  dir = resolveDataDir(),
  now = Date.now(),
  maxChars = DEFAULT_MAX_CHARS,
  entryChars = 240,
} = {}) {
  const store = await readStore(dir)
  if (store === undefined) return emptyReport(dir, maxChars)

  const entries = (Array.isArray(store?.entries) ? store.entries : []).map((entry) => {
    const text = String(entry.text ?? '')
    return {
      id: String(entry.id ?? ''),
      scope: String(entry.scope ?? ''),
      key: String(entry.key ?? ''),
      tier: normalizeTier(entry.tier),
      tags: Array.isArray(entry.tags) ? entry.tags : [],
      chars: text.length,
      tokens: estimateTokens(text),
      ageDays: Math.max(0, Math.round((now - (Number(entry.updatedAt) || now)) / DAY)),
      // 过期条目渲染时会被跳过，但文件里还占着位置，审计要把它点出来提醒清理。
      // daysLeft 从 createdAt 起算（而不是 updatedAt），因为 TTL 的语义是「存多久」。
      ttlDays: (() => {
        const ttl = Number(entry.ttlDays)
        if (!Number.isFinite(ttl) || ttl <= 0) return undefined
        const left = Math.ceil(((Number(entry.createdAt) || now) + ttl * DAY - now) / DAY)
        return { ttlDays: ttl, daysLeft: left, expired: left <= 0 }
      })(),
      text,
    }
  })

  const byCost = [...entries].sort((a, b) => b.chars - a.chars)
  const counts = { user: 0, workspace: 0, session: 0 }
  const chars = { user: 0, workspace: 0, session: 0 }
  const tiers = { hot: { entries: 0, chars: 0 }, cold: { entries: 0, chars: 0 } }
  for (const entry of entries) {
    counts[entry.scope] = (counts[entry.scope] ?? 0) + 1
    chars[entry.scope] = (chars[entry.scope] ?? 0) + entry.chars
    tiers[entry.tier].entries += 1
    tiers[entry.tier].chars += entry.chars
  }

  // 两两比对是 O(n²)，但记忆库的量级（几十条）远不到需要索引优化的程度；
  // 真到了几千条，该先怀疑预算而不是优化这里。
  const pairs = []
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const score = similarityOf(entries[i].text, entries[j].text)
      if (score >= PAIR_THRESHOLD) pairs.push({ a: entries[i].id, b: entries[j].id, score: Number(score.toFixed(2)) })
    }
  }
  pairs.sort((a, b) => b.score - a.score)

  const totalChars = entries.reduce((sum, entry) => sum + entry.chars, 0)
  const totalTokens = entries.reduce((sum, entry) => sum + entry.tokens, 0)
  const expired = entries.filter((entry) => entry.ttlDays?.expired === true)

  // 库内正文字数 ≠ 实际上行成本：注入块还带指引、作用域与 id 前缀，条目多了还要截断。
  // 以前这里直接拿 totalChars 比预算（实测 72%），而真实渲染已经是 98%，
  // 容易让人误以为「还很宽裕」。既然审计的目的是回答「装得下吗」，就直接渲染一遍。
  const rendered = renderMemoryBlock({ entries, maxChars, entryChars })
  // 注入块里每条都带自己的 id，数一下出现几次就知道预算砍掉了谁。
  const shown = rendered === '' ? 0 : entries.filter((entry) => entry.id && rendered.includes(entry.id)).length
  // 常驻成本 = 热记忆 + 指引 + id 前缀：这部分每个会话都要付，与话题无关。
  // 冷记忆只在话题命中时追加，所以上面的 rendered 是全量命中的上限，不能当日常成本看。
  const hotEntries = entries.filter((entry) => entry.tier === 'hot')
  const resident = renderMemoryBlock({ entries: hotEntries, maxChars, entryChars })

  return {
    dataDir: dir,
    entries: entries.length,
    totalChars,
    totalTokens,
    budget: maxChars,
    renderedChars: rendered.length,
    renderedTokens: estimateTokens(rendered),
    residentChars: resident.length,
    residentTokens: estimateTokens(resident),
    shown,
    dropped: entries.length - shown,
    tiers,
    scopes: Object.fromEntries(Object.keys(counts).map((scope) => [scope, { entries: counts[scope], chars: chars[scope] }])),
    expired: expired.map((entry) => entry.id),
    similarPairs: pairs,
    // text 只在计算期内部用；对外给 60 字预览，避免 --json 把整个库再抄一遍。
    rows: byCost.map(({ text, ...rest }) => ({ ...rest, preview: text.slice(0, 60) })),
  }
}

/**
 * 把人读报告排成终端里那一段多行文本。
 *
 * @param {object} report    buildReport() 的返回值
 * @param {number|object} [maxChars] 覆盖报告自带的预算（数字，或 { maxChars }）
 * @returns {string} 以换行结尾，调用方直接 process.stdout.write 即可
 */
export function formatReport(report, maxChars = undefined) {
  const dataDir = String(report?.dataDir ?? resolveDataDir())

  // 没有库时只给一行：没有东西可审计，排版反而添乱。
  if (report?.exists === false) return `没有记忆库：${join(dataDir, 'memories.json')}\n`

  const rawBudget = maxChars ?? report?.budget ?? DEFAULT_MAX_CHARS
  const parsedBudget = Number(rawBudget?.maxChars ?? rawBudget)
  const budget = Number.isFinite(parsedBudget) && parsedBudget > 0 ? parsedBudget : DEFAULT_MAX_CHARS

  const entries = Number(report?.entries ?? 0)
  const totalChars = Number(report?.totalChars ?? 0)
  const totalTokens = Number(report?.totalTokens ?? 0)
  const renderedChars = Number(report?.renderedChars ?? 0)
  const shown = Number(report?.shown ?? entries)
  const dropped = Number(report?.dropped ?? 0)
  const scopes = report?.scopes ?? {}
  const rows = Array.isArray(report?.rows) ? report.rows : []
  const pairs = Array.isArray(report?.similarPairs) ? report.similarPairs : []
  const expired = Array.isArray(report?.expired) ? report.expired : []

  const out = []
  const line = (label, value) => out.push(`${label.padEnd(12)}${value}`)
  out.push('记忆审计' + '─'.repeat(40))
  line('数据目录', dataDir)
  line('条目', `${entries} 条 · ${(totalChars / 1024).toFixed(1)} KiB · 约 ${totalTokens} token`)
  // 这一行是审计的重点：注入块的真实大小对上预算。库内正文字数只是材料，
  // 指引 + id 前缀 + 截断才是实际成本，所以按渲染结果算，而不是按正文加总。
  const usedPercent = budget > 0 ? Math.round((renderedChars / budget) * 100) : 0
  const residentChars = Number(report?.residentChars ?? renderedChars)
  const residentPercent = budget > 0 ? Math.round((residentChars / budget) * 100) : 0
  const tiers = report?.tiers ?? {}
  const hotCount = Number(tiers.hot?.entries ?? 0)
  const coldCount = Number(tiers.cold?.entries ?? 0)
  const coverage = dropped > 0
    ? `${shown} 条注入，${dropped} 条被省略（只能靠 memory_recall 查）`
    : `${shown} 条全部注入，无省略`
  // 都快顶到上限时点一句「余量」，比让人自己拿 1546 和 1600 做减法更直观。
  const room = Math.max(0, budget - renderedChars)
  const roomNote = dropped === 0 && room < 150 ? `，余量只剩 ${room} 字` : ''
  // 冷记忆只在话题命中时出现，所以「常驻」与「满载」分开报：
  // 常驻是每个会话都付的钱；满载是这次话题最坏情况下会付的钱。
  line('预算', `${budget} 字注入上限`)
  line('常驻成本', `${residentChars} 字实际注入（热记忆 + 指引），占预算 ${residentPercent}%`)
  if (coldCount > 0 || renderedChars !== residentChars) {
    line('满载上限', `冷记忆全命中时 ${renderedChars} 字，占预算 ${usedPercent}%${roomNote}`)
  }
  line('条目覆盖', `${coverage}（正文 ${totalChars} 字，其余是指引与 id 前缀）`)
  line('冷热', `热 ${hotCount} 条/${tiers.hot?.chars ?? 0} 字 恒常注入 · 冷 ${coldCount} 条/${tiers.cold?.chars ?? 0} 字 按话题加载`)
  line('作用域', ['user', 'workspace', 'session'].map((scope) => `${scope} ${scopes[scope]?.entries ?? 0} 条/${scopes[scope]?.chars ?? 0} 字`).join('   '))
  if (expired.length > 0) line('已过期', `${expired.length} 条（不再注入，但仍在文件里）：${expired.join(' ')}`)
  out.push('')
  out.push('按正文成本排序（正文字符 / 估算 token / 更新于 / 作用域·冷热 / id）')
  for (const row of rows) {
    // rows 里只有 60 字预览；折叠空白后截 54 字，人在终端里看到的和以前一样。
    const preview = String(row.preview ?? '').replace(/\s+/g, ' ').slice(0, 54)
    const lane = `${String(row.scope).padEnd(11)}${String(row.tier ?? 'cold').padEnd(5)}`
    out.push(`  ${String(row.chars).padStart(5)}c ${String(row.tokens).padStart(5)}t  ${String(row.ageDays).padStart(4)}d  ${lane} ${row.id}  ${preview}`)
  }
  if (pairs.length > 0) {
    out.push('')
    out.push(`可能重复/该合并（正文二元组 Jaccard ≥ ${PAIR_THRESHOLD}）`)
    for (const pair of pairs) out.push(`  ${pair.score}  ${pair.a} ↔ ${pair.b}`)
  }
  return `${out.join('\n')}\n`
}
