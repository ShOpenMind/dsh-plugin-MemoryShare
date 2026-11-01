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

export const STORE_FILE = 'memories.json'
export const STORE_VERSION = 1
export const SCOPES = ['user', 'workspace', 'session']

/** 淘汰顺序：user 最该保留，session 最先走。 */
const SCOPE_PRIORITY = { user: 0, workspace: 1, session: 2 }
const DAY_MS = 86400000

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
    this.entries = list.filter((entry) => entry && typeof entry.id === 'string' && typeof entry.text === 'string')
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

  /** 串行化的读-改-写。fn 返回 { entries, value }。 */
  async mutate(fn) {
    const run = this.chain.then(async () => {
      await this.load(true)
      const outcome = await fn(this.entries)
      this.entries = outcome.entries
      await this.persist()
      return outcome.value
    })
    this.chain = run.then(() => undefined, () => undefined)
    return run
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
   * @returns {Promise<{entry: object, duplicate: boolean, total: number}>}
   */
  async save(input) {
    const text = normalizeText(input?.text)
    if (text === '') throw new Error('memory-share: text 不能为空')
    const scope = SCOPES.includes(input?.scope) ? input.scope : 'user'
    const key = scopeKey(scope, input?.key)
    if (scope !== 'user' && key === '') {
      throw new Error(`memory-share: scope=${scope} 需要一个可用的键（工作区路径或会话 id）`)
    }
    const tags = Array.isArray(input?.tags)
      ? [...new Set(input.tags.map((tag) => normalizeText(tag)).filter(Boolean))].slice(0, 12)
      : []
    const ttlDays = Number.isFinite(Number(input?.ttlDays)) && Number(input.ttlDays) > 0
      ? Math.floor(Number(input.ttlDays))
      : undefined
    const fingerprint = fingerprintOf(text)

    return this.mutate((entries) => {
      const now = Date.now()
      const existing = entries.find((entry) => entry.fingerprint === fingerprint
        && entry.scope === scope
        && (entry.key ?? '') === key)
      if (existing !== undefined) {
        existing.updatedAt = now
        if (tags.length > 0) existing.tags = [...new Set([...(existing.tags ?? []), ...tags])]
        if (ttlDays !== undefined) existing.ttlDays = ttlDays
        return { entries, value: { entry: existing, duplicate: true, total: entries.length } }
      }
      const entry = {
        id: newId(entries),
        text,
        scope,
        key,
        fingerprint,
        tags,
        createdAt: now,
        updatedAt: now,
        source: input?.source ?? {},
      }
      if (ttlDays !== undefined) entry.ttlDays = ttlDays
      entries.push(entry)
      return { entries: this.evict(entries), value: { entry, duplicate: false, total: entries.length } }
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

  /** 修改一条的正文。指纹同步更新，避免改完还能被旧指纹命中去重。 */
  async update(id, text) {
    const target = normalizeText(id)
    if (target === '') throw new Error('memory-share: id 不能为空')
    const nextText = normalizeText(text)
    if (nextText === '') throw new Error('memory-share: text 不能为空')
    return this.mutate((entries) => {
      const entry = entries.find((item) => item.id === target)
      if (entry === undefined) return { entries, value: false }
      entry.text = nextText
      entry.fingerprint = fingerprintOf(nextText)
      entry.updatedAt = Date.now()
      return { entries, value: true }
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
