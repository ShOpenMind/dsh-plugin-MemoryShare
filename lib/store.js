// dsh-plugin-MemoryShare 存储层：一个进程内可同步读取、磁盘上原子写入的 JSON 记忆库。
// 设计约束（见 README「设计取舍」）：
//   1. 渲染发生在系统提示词组装里，是同步调用 —— 所以读走内存快照，写才碰磁盘；
//   2. 多个 DSH 进程可能同时开同一个库 —— 所以写入串行化 + 临时文件 rename；
//   3. 记忆是长期资产，损坏不能静默丢失 —— 坏文件改名备份后再从空库开始。
// License: MIT
import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { jaccardSets, tokensOf, SIMILAR_THRESHOLD } from './text.js'

export const STORE_FILE = 'memories.json'
export const STORE_VERSION = 1
export const SCOPES = ['user', 'workspace', 'session']
/** 冷热两档：hot 每次会话都注入；cold 只在当前话题命中时注入。 */
export const TIERS = ['hot', 'cold']

/** 淘汰顺序：user 最该保留，session 最先走。 */
const SCOPE_PRIORITY = { user: 0, workspace: 1, session: 2 }
const DAY_MS = 86400000
/**
 * TTL 过期后再留这么多天。
 * 过期条目本该「不再注入但还能 recall 回来」，可它永远不会自己消失 —— 攒几年就是垃圾。
 * 给一段宽限期，让模型/用户有机会在过期后被提醒时把它捡回来，之后随写入顺手清掉。
 */
const PRUNE_GRACE_DAYS = 30

/** 默认数据目录：$DSH_HOME/memory-share（DSH 自身的 home）。 */
export function defaultDataDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'memory-share')
}

/** 作用域键归一化：Windows 下大小写不敏感，避免同一目录两条记忆。 */
export function normalizeKey(value) {
  if (typeof value !== 'string' || value.trim() === '') return ''
  const resolved = resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** 记忆文本归一化：折叠空白、去首尾。 */
export function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * 作用域键归一化：只有 workspace 是路径，需要 resolve + 大小写归一；
 * session 键是会话 id 字符串，绝不能当路径处理（否则会被 resolve 成磁盘路径）。
 */
export function scopeKey(scope, value) {
  if (scope === 'user') return ''
  if (scope === 'workspace') return normalizeKey(value)
  return normalizeText(value)
}

function fingerprintOf(text) {
  return normalizeText(text).toLowerCase()
}

/** 标签归一化：去空、去重、限 12 个。 */
function normalizeTags(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((tag) => normalizeText(tag)).filter(Boolean))].slice(0, 12)
}

/**
 * 冷热归一化。读盘时缺字段按 hot 处理 —— 老库没有这个概念，
 * 升级瞬间把已有记忆全变成「不相关就不出现」等于悄悄删记忆。
 * 新写入（save）才默认 cold，由调用方按内容决定要不要常驻。
 */
export function normalizeTier(value, fallback = 'hot') {
  if (value === 'hot' || value === 'cold') return value
  return fallback
}

/**
 * TTL 归一化：undefined = 不改变（用于修改场景）；0 = 明确清掉有效期；正数为天数。
 * 与 save 的语义分开，否则「改正文时顺手把 TTL 重置」会是个很难发现的坑。
 */
function ttlOf(value) {
  if (value === undefined || value === null || value === '') return undefined
  const days = Number(value)
  if (!Number.isFinite(days) || days < 0) return undefined
  return Math.floor(days)
}

/** TTL 过期判定（未设置 ttlDays 视为永不过期）。 */
export function isExpired(entry, now = Date.now()) {
  const ttl = Number(entry?.ttlDays)
  if (!Number.isFinite(ttl) || ttl <= 0) return false
  return now >= (Number(entry.createdAt) || 0) + ttl * DAY_MS
}

function newId(entries) {
  const taken = new Set(entries.map((entry) => entry.id))
  // 短 id 让模型更容易原样回引（forget 靠它定位），同时保留时间序 + 随机后缀。
  const stamp = Date.now().toString(36).slice(-6)
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = `m${stamp}${randomBytes(2).toString('hex')}`
    if (!taken.has(id)) return id
  }
  return `m${stamp}${randomBytes(4).toString('hex')}`
}

export class MemoryStore {
  /**
   * @param {object} options
   * @param {string} [options.dir] 数据目录
   * @param {number} [options.maxEntries] 条目上限，超出按作用域优先级淘汰
   * @param {{warn?: Function}} [options.logger]
   */
  constructor({ dir = defaultDataDir(), maxEntries = 500, logger } = {}) {
    this.dir = dir
    this.file = join(dir, STORE_FILE)
    this.maxEntries = Math.max(10, Number(maxEntries) || 500)
    this.logger = logger
    this.entries = []
    this.loaded = false
    this.mtimeMs = -1
    this.chain = Promise.resolve()
  }

  warn(message) {
    try {
      (this.logger?.warn ?? console.warn)(`[memory-share] ${message}`)
    } catch {
      /* 日志失败不能影响主流程 */
    }
  }

  /** 同步快照：供系统提示词渲染使用。 */
  snapshot() {
    return this.entries
  }

  /** 读取磁盘；mtime 未变则复用内存。force 时强制重读。 */
  async load(force = false) {
    let stat
    try {
      stat = await fs.stat(this.file)
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.entries = []
        this.loaded = true
        this.mtimeMs = 0
        return this.entries
      }
      throw error
    }
    if (!force && this.loaded && stat.mtimeMs === this.mtimeMs) return this.entries

    const raw = await fs.readFile(this.file, 'utf8')
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      const backup = `${this.file}.corrupt-${Date.now()}`
      await fs.rename(this.file, backup).catch(() => {})
      this.warn(`记忆库无法解析，已备份为 ${backup} 并从空库开始`)
      this.entries = []
      this.loaded = true
      this.mtimeMs = 0
      return this.entries
    }
    const list = Array.isArray(parsed?.entries) ? parsed.entries : []
    this.entries = list
      .filter((entry) => entry && typeof entry.id === 'string' && typeof entry.text === 'string')
      .map((entry) => ({
        ...entry,
        tags: normalizeTags(entry.tags),
        tier: normalizeTier(entry.tier),
      }))
    this.loaded = true
    this.mtimeMs = stat.mtimeMs
    return this.entries
  }

  /** 原子落盘：先写临时文件再 rename，避免读到半个 JSON。 */
  async persist() {
    await fs.mkdir(this.dir, { recursive: true })
    const payload = JSON.stringify({
      version: STORE_VERSION,
      updatedAt: new Date().toISOString(),
      entries: this.entries,
    }, null, 2)
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`
    await fs.writeFile(tmp, payload, 'utf8')
    await fs.rename(tmp, this.file)
    const stat = await fs.stat(this.file)
    this.mtimeMs = stat.mtimeMs
  }

  /** 串行化的读-改-写。fn 返回 { entries, value }。写入时顺手清掉早已过期的条目。 */
  async mutate(fn) {
    const run = this.chain.then(async () => {
      await this.load(true)
      const outcome = await fn(this.entries)
      this.entries = this.sweep(outcome.entries ?? this.entries)
      await this.persist()
      return outcome.value
    })
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }

  /** 清掉过期超过宽限期的条目（过期但不该马上消失：给它被 recall 捡回来的机会）。 */
  sweep(entries, now = Date.now()) {
    const cutoff = now - PRUNE_GRACE_DAYS * DAY_MS
    const next = entries.filter((entry) => !isExpired(entry, cutoff))
    return next.length === entries.length ? entries : next
  }

  /** 超出上限时淘汰：先 session，再 workspace，最后 user；同作用域内旧的先走。 */
  evict(entries) {
    if (entries.length <= this.maxEntries) return entries
    const sorted = [...entries].sort((a, b) => {
      const byScope = (SCOPE_PRIORITY[a.scope] ?? 9) - (SCOPE_PRIORITY[b.scope] ?? 9)
      if (byScope !== 0) return byScope
      return (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0)
    })
    const keep = new Set(sorted.slice(0, this.maxEntries).map((entry) => entry.id))
    return entries.filter((entry) => keep.has(entry.id))
  }

  /**
   * 保存一条记忆。同一 (文本指纹, scope, key) 视为同一条，更新而不新增。
   *
   * 另外做一次「近重复」检查：意思相近但没到逐字重复时，返回 similar 提示，
   * 由调用方（工具层）建议用 memory_update 合并 —— 记忆块的预算是固定的，
   * 两条内容重叠的记忆等于白白摊薄了所有其它记忆。
   * @returns {Promise<{entry: object, duplicate: boolean, total: number, similar: ({id: string, score: number}|null)}>}
   */
  async save(input) {
    const text = normalizeText(input?.text)
    if (text === '') throw new Error('memory-share: text 不能为空')
    const scope = SCOPES.includes(input?.scope) ? input.scope : 'user'
    const key = scopeKey(scope, input?.key)
    if (scope !== 'user' && key === '') {
      throw new Error(`memory-share: scope=${scope} 需要一个可用的键（工作区路径或会话 id）`)
    }
    const tags = normalizeTags(input?.tags)
    /** 新记忆默认冷：只有调用方明确说「这条要常驻」才进热记忆。 */
    const tier = normalizeTier(input?.tier, 'cold')
    /** save 里 0 与「不设」等价：没有有效期就是永不过期。 */
    const ttlDays = ttlOf(input?.ttlDays) || undefined
    const fingerprint = fingerprintOf(text)
    const tokens = tokensOf(text)

    return this.mutate((entries) => {
      const now = Date.now()
      const existing = entries.find((entry) => entry.fingerprint === fingerprint
        && entry.scope === scope
        && (entry.key ?? '') === key)
      if (existing !== undefined) {
        existing.updatedAt = now
        if (tags.length > 0) existing.tags = [...new Set([...(existing.tags ?? []), ...tags])]
        if (ttlDays !== undefined) existing.ttlDays = ttlDays
        if (input?.tier !== undefined) existing.tier = tier
        return { entries, value: { entry: existing, duplicate: true, total: entries.length, similar: null } }
      }
      let similar = null
      for (const other of entries) {
        if (other.scope !== scope || (other.key ?? '') !== key) continue
        if (other.fingerprint === fingerprint) continue
        const score = jaccardSets(tokens, tokensOf(other.text))
        if (score >= SIMILAR_THRESHOLD && (similar === null || score > similar.score)) {
          similar = { id: other.id, score: Number(score.toFixed(2)) }
        }
      }
      const entry = {
        id: newId(entries),
        text,
        scope,
        key,
        fingerprint,
        tags,
        tier,
        createdAt: now,
        updatedAt: now,
        source: input?.source ?? {},
      }
      if (ttlDays !== undefined) entry.ttlDays = ttlDays
      entries.push(entry)
      const next = this.evict(entries)
      return { entries: next, value: { entry, duplicate: false, total: next.length, similar } }
    })
  }

  /**
   * 检索。query 为空时返回最近的条目；否则按命中词数排序。
   * @returns {Promise<object[]>}
   */
  async list({ scope, key, query, limit = 20, includeExpired = false } = {}) {
    await this.load()
    const now = Date.now()
    const max = Math.max(1, Math.min(200, Number(limit) || 20))
    const tokens = normalizeText(query).toLowerCase().split(/\s+/).filter(Boolean)
    const wantedKey = scope === undefined ? '' : scopeKey(scope, key)

    let rows = this.entries.filter((entry) => {
      if (!includeExpired && isExpired(entry, now)) return false
      if (scope !== undefined && entry.scope !== scope) return false
      if (scope && scope !== 'user' && (entry.key ?? '') !== wantedKey) return false
      return true
    })

    if (tokens.length > 0) {
      const scored = []
      for (const entry of rows) {
        const haystack = `${entry.text} ${(entry.tags ?? []).join(' ')}`.toLowerCase()
        const score = tokens.reduce((sum, token) => (haystack.includes(token) ? sum + 1 : sum), 0)
        if (score > 0) scored.push({ entry, score })
      }
      scored.sort((a, b) => b.score - a.score || (Number(b.entry.updatedAt) || 0) - (Number(a.entry.updatedAt) || 0))
      return scored.slice(0, max).map((item) => item.entry)
    }

    rows = rows.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
    return rows.slice(0, max)
  }

  /** 删除一条。返回是否真的删掉了。 */
  async remove(id) {
    const target = normalizeText(id)
    if (target === '') throw new Error('memory-share: id 不能为空')
    return this.mutate((entries) => {
      const next = entries.filter((entry) => entry.id !== target)
      return { entries: next, value: next.length !== entries.length }
    })
  }

  /**
   * 修改一条记忆（正文 / 标签 / 有效期）。指纹跟着正文走，
   * 否则改完还能被旧指纹命中去重，等于留下一个「改不动的幽灵条目」。
   * @param {string} id
   * @param {string|{text?: string, tags?: string[], ttlDays?: number}} patch 传字符串等价于只改正文
   * @returns {Promise<{ok: boolean, entry?: object}>}
   */
  async revise(id, patch) {
    const target = normalizeText(id)
    if (target === '') throw new Error('memory-share: id 不能为空')
    const fields = typeof patch === 'string' ? { text: patch } : (patch ?? {})
    const nextText = fields.text === undefined ? undefined : normalizeText(fields.text)
    if (nextText === '') throw new Error('memory-share: text 不能为空')
    const tags = normalizeTags(fields.tags)
    const ttlDays = ttlOf(fields.ttlDays)
    const tier = fields.tier === undefined ? undefined : normalizeTier(fields.tier, 'hot')
    if (nextText === undefined && tags.length === 0 && ttlDays === undefined && tier === undefined) {
      throw new Error('memory-share: 需要 text / tags / ttlDays / tier 中的至少一项')
    }
    return this.mutate((entries) => {
      const entry = entries.find((item) => item.id === target)
      if (entry === undefined) return { entries, value: { ok: false } }
      if (nextText !== undefined) {
        entry.text = nextText
        entry.fingerprint = fingerprintOf(nextText)
      }
      if (tags.length > 0) entry.tags = [...new Set([...(entry.tags ?? []), ...tags])].slice(0, 12)
      if (ttlDays !== undefined) {
        if (ttlDays === 0) delete entry.ttlDays
        else entry.ttlDays = ttlDays
      }
      if (tier !== undefined) entry.tier = tier
      entry.updatedAt = Date.now()
      return { entries, value: { ok: true, entry } }
    })
  }

  /** 兼容旧的单参数写法：只改正文。返回是否改到了。 */
  async update(id, text) {
    const result = await this.revise(id, { text })
    return result.ok === true
  }

  /**
   * 合并多条为一条：用于「库太胖」时的收缩。
   * 规则：并集标签、取最早的 createdAt、保留列表里第一条的 id 作为句柄，
   * 正文由调用方重写成一句更短的话 —— 合并必须变短，否则只是换了个写法。
   * @returns {Promise<{ok: boolean, entry?: object, removed: number, savedChars: number, missing: string[]}>}
   */
  async merge({ ids, text, tags, ttlDays, tier } = {}) {
    const wanted = [...new Set((Array.isArray(ids) ? ids : []).map((id) => normalizeText(id)).filter(Boolean))]
    if (wanted.length < 2) throw new Error('memory-share: 合并至少需要 2 个 id（改单条用 memory_update 的 id）')
    const nextText = normalizeText(text)
    if (nextText === '') throw new Error('memory-share: 合并需要一句新的 text（把几条写成一句更短的）')
    const extraTags = normalizeTags(tags)
    const ttl = ttlOf(ttlDays)

    return this.mutate((entries) => {
      const found = wanted.map((id) => entries.find((entry) => entry.id === id)).filter(Boolean)
      const missing = wanted.filter((id) => !found.some((entry) => entry.id === id))
      if (found.length < 2) return { entries, value: { ok: false, removed: 0, savedChars: 0, missing } }
      const [scope, key] = [found[0].scope, found[0].key ?? '']
      if (found.some((entry) => entry.scope !== scope || (entry.key ?? '') !== key)) {
        throw new Error('memory-share: 只能合并同一作用域的条目（user / workspace / session 不可混）')
      }

      const now = Date.now()
      const fingerprint = fingerprintOf(nextText)
      // 合并结果的冷热：调用方说了算；没说时只要有一条是热的就保持热 ——
      // 合并是收缩手段，不该顺手把一条常驻记忆降级成按话题加载。
      const mergedTier = tier === undefined
        ? (found.some((entry) => entry.tier === 'hot') ? 'hot' : 'cold')
        : normalizeTier(tier, 'cold')
      const merged = {
        id: found[0].id,
        text: nextText,
        scope,
        key,
        fingerprint,
        tags: [...new Set([...found.flatMap((entry) => entry.tags ?? []), ...extraTags])].slice(0, 12),
        tier: mergedTier,
        createdAt: Math.min(...found.map((entry) => Number(entry.createdAt) || now)),
        updatedAt: now,
        source: found[0].source ?? {},
      }
      // 有效期：没显式给、且原来几条完全一致时沿用，否则视为「不再过期」——
      // 猜一个不是调用方意图，丢掉 TTL 至少是可见的、可再改回来的。
      const keptTtl = ttl ?? (found.every((entry) => entry.ttlDays === found[0].ttlDays) ? found[0].ttlDays : undefined)
      if (keptTtl !== undefined && keptTtl > 0) merged.ttlDays = keptTtl

      const drop = new Set(found.map((entry) => entry.id))
      const next = []
      let absorbed = 0
      let before = 0
      for (const entry of entries) {
        if (drop.has(entry.id)) {
          before += String(entry.text ?? '').length
          continue
        }
        // 合并后的正文若与库里另一条逐字相同，顺带把那一条也收掉，别留重复
        if (entry.fingerprint === fingerprint && entry.scope === scope && (entry.key ?? '') === key) {
          absorbed += 1
          before += String(entry.text ?? '').length
          continue
        }
        next.push(entry)
      }
      next.push(merged)
      return {
        entries: this.evict(next),
        value: {
          ok: true,
          entry: merged,
          removed: found.length + absorbed - 1,
          savedChars: Math.max(0, before - nextText.length),
          missing,
        },
      }
    })
  }

  /** 清空某个作用域（user 即清空全部 user 级记忆）。返回删除条数。 */
  async clear(scope, key) {
    if (!SCOPES.includes(scope)) throw new Error(`memory-share: 未知 scope ${scope}`)
    const wantedKey = scopeKey(scope, key)
    return this.mutate((entries) => {
      const next = entries.filter((entry) => !(entry.scope === scope && (entry.key ?? '') === wantedKey))
      return { entries: next, value: entries.length - next.length }
    })
  }

  /** 同步筛选出对某个 agent 可见的记忆（渲染热路径）。 */
  selectFor({ cwd, sessionId, now = Date.now() } = {}) {
    const workspaceKey = normalizeKey(cwd)
    const sessionKey = normalizeText(sessionId)
    return this.entries.filter((entry) => {
      if (isExpired(entry, now)) return false
      if (entry.scope === 'user') return true
      if (entry.scope === 'workspace') return workspaceKey !== '' && entry.key === workspaceKey
      if (entry.scope === 'session') return sessionKey !== '' && entry.key === sessionKey
      return false
    })
  }
}
