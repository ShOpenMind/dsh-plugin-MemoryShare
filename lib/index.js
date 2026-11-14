// dsh-plugin-MemoryShare 宿主半区。
// 一句话：让记忆「自己出现」，而不是等模型想起来去查。
//
// 组成：
//   1. 一段动态 system prompt 段（order 100，紧跟 persona 之后），把当前 agent 可见的记忆渲染进去；
//   2. 三个工具 memory_save / memory_recall / memory_forget；
//   3. 文件库 $DSH_HOME/memory-share/memories.json（见 store.js）。
//
// 刻意不依赖任何 @deepseek-ai/* 包：只用 cordis 注入的 ctx 服务 + 标准 JSON Schema，
// 这样插件能装在任意 profile 下而不需要 DSH 的内部模块解析（与 dsh-agentmemory 的做法一致，但它多依赖了 dsh-tools）。
// License: MIT
import { MemoryStore, defaultDataDir, normalizeKey, SCOPES } from './store.js'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { renderMemoryBlock } from './render.js'

export const name = 'memoryShare'
/** 只声明必需的服务；两者都是 dsh-base 的常驻服务，缺失时 cordis 会等它出现而不是炸掉。 */
export const inject = ['systemPrompt', 'tools']

/** 提示词段的名称与位置：100 = persona 之后、工具指引之前。 */
const SECTION_NAME = 'memory-share'
const SECTION_ORDER = 100
/** bootSnapshot=session 时最多冻结多少会话的块，防止无界增长。 */
const FROZEN_LIMIT = 200

const DEFAULTS = {
  dataDir: '',
  maxChars: 1600,
  entryChars: 240,
  maxEntries: 500,
  injectInPrompt: true,
  /** 'top' = 只给顶层会话注入，子代理/派生会话不背这段；'all' = 所有 agent 都注入。 */
  injectFor: 'top',
  /** 按当前对话话题筛选 workspace/session 条目；user 条目始终注入。 */
  relevance: true,
  /** 筛选后最多保留几条非 user 条目。 */
  relevanceTopK: 4,
  /** 全都不相关时退回最近 n 条；0 = 一条都不留（严格模式）。 */
  relevanceKeepRecent: 0,
  /** 'live' = 每步按最新记忆渲染；'session' = 本会话首次渲染后冻结，保护前缀缓存。 */
  bootSnapshot: 'live',
  /** 这些会话 id 不注入（服务方法可运行时开关）。 */
  disabledSessions: [],
  guidance: true,
  refreshIntervalMs: 30000,
}

/** 从 agent 上取会话身份；任何一层缺失都不抛错。 */
function identityOf(agent) {
  const header = agent?.session?.header
  return {
    sessionId: String(agent?.id ?? header?.id ?? ''),
    cwd: typeof header?.cwd === 'string' ? header.cwd : '',
  }
}

/**
 * 判断一个 agent 是不是派生出来的（子代理/subagent/fork）。
 * 只认「正向标记」，拿不到证据时一律当顶层 —— 宁可多注入，也不能让主会话的记忆凭空消失。
 */
function isDerivedAgent(agent) {
  try {
    const header = agent?.session?.header
    if (header?.origin === 'subagent' || header?.origin === 'fork') return true
    if (typeof header?.parentSessionId === 'string' && header.parentSessionId !== '') return true
    if (typeof agent?.parentSessionId === 'string' && agent.parentSessionId !== '') return true
  } catch {
    /* 字段形状变了就当顶层 */
  }
  return false
}

/* ---------------- 话题相关性筛选 ----------------
 * 没有向量模型，靠字面重合打分：英文/数字按词切，中文按二元字组切，标签算双倍。
 * 拿不到对话内容时返回 undefined —— 调用方据此退回「全量注入」，宁可吵，不可哑。
 */

/** 把一段文本切成可比较的记号集合。 */
function tokensOf(text) {
  const out = new Set()
  const raw = String(text ?? '').toLowerCase()
  for (const word of raw.matchAll(/[a-z0-9_]{2,}/g)) out.add(word[0])
  for (const segment of raw.replace(/[^\u4e00-\u9fff]+/g, ' ').split(/\s+/)) {
    for (let i = 0; i + 1 < segment.length; i += 1) out.add(segment.slice(i, i + 2))
  }
  return out
}

/** 一条记忆对当前话题的得分；标签命中按两倍计。 */
function scoreEntry(entry, queryTokens) {
  let score = 0
  for (const token of tokensOf(entry.text)) if (queryTokens.has(token)) score += 1
  for (const tag of entry.tags ?? []) {
    for (const token of tokensOf(tag)) if (queryTokens.has(token)) score += 2
  }
  return score
}

/**
 * 按相关性挑条目：pinnedScopes 里的永远保留，其余按得分排序。
 * 得分 0 的直接丢掉 —— 这正是「问插件时不要看到维多利亚2」的实现。
 */
function pickRelevant(entries, { queryTokens, pinnedScopes = ['user'], topK = 4, keepRecent = 0 }) {
  const pinned = []
  const scored = []
  for (const entry of entries) {
    if (pinnedScopes.includes(entry.scope)) {
      pinned.push(entry)
      continue
    }
    const score = scoreEntry(entry, queryTokens)
    if (score > 0) scored.push({ entry, score })
  }
  scored.sort((a, b) => b.score - a.score || (Number(b.entry.updatedAt) || 0) - (Number(a.entry.updatedAt) || 0))
  const picked = scored.slice(0, topK).map((item) => item.entry)
  if (picked.length === 0 && keepRecent > 0) {
    const rest = entries.filter((entry) => !pinnedScopes.includes(entry.scope))
    rest.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
    picked.push(...rest.slice(0, keepRecent))
  }
  return [...pinned, ...picked]
}

function normalizeOptions(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const options = { ...DEFAULTS, ...raw }
  options.dataDir = typeof options.dataDir === 'string' && options.dataDir.trim() !== ''
    ? options.dataDir.trim()
    : defaultDataDir()
  options.maxChars = Math.max(0, Math.floor(Number(options.maxChars) || 0))
  options.entryChars = Math.max(40, Math.floor(Number(options.entryChars) || DEFAULTS.entryChars))
  options.maxEntries = Math.max(10, Math.floor(Number(options.maxEntries) || DEFAULTS.maxEntries))
  options.injectInPrompt = options.injectInPrompt !== false
  options.injectFor = options.injectFor === 'all' ? 'all' : 'top'
  options.relevance = options.relevance !== false
  options.relevanceTopK = Math.max(0, Math.floor(Number(options.relevanceTopK) || 0))
  options.relevanceKeepRecent = Math.max(0, Math.floor(Number(options.relevanceKeepRecent) || 0))
  options.bootSnapshot = options.bootSnapshot === 'session' ? 'session' : 'live'
  options.disabledSessions = Array.isArray(options.disabledSessions)
    ? options.disabledSessions.map((id) => String(id)).filter(Boolean)
    : []
  options.guidance = options.guidance !== false
  options.refreshIntervalMs = Math.max(0, Math.floor(Number(options.refreshIntervalMs) || 0))
  return options
}

/**
 * 写一份「运行中实例」标记，供 CLI 对比磁盘版本与进程版本。
 * 失败不影响插件 —— 最多少一条诊断信息。
 */
async function writeRuntimeMarker(dir) {
  try {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'runtime.json'), JSON.stringify({
      name: pkg.name,
      version: pkg.version,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      node: process.version,
    }, null, 2))
  } catch {
    /* 忽略 */
  }
}

export function apply(ctx, config = {}) {
  const options = normalizeOptions(config)
  const store = new MemoryStore({
    dir: options.dataDir,
    maxEntries: options.maxEntries,
    logger: ctx.logger,
  })

  // 会话级开关与 boot 快照（bootSnapshot: 'session' 时按会话冻结渲染结果）
  const sessionOff = new Set(options.disabledSessions)
  const frozenBlocks = new Map()
  void writeRuntimeMarker(options.dataDir)

  const warn = (message) => {
    try {
      (ctx.logger?.warn ?? console.warn)(`[memory-share] ${message}`)
    } catch {
      /* 日志失败不影响主流程 */
    }
  }

  // 最近的用户发言（按会话），用于相关性打分。读不到就保持空 —— 空 = 退回全量注入。
  const recentText = new Map()
  try {
    ctx.on('session/event', (payload) => {
      const event = payload?.event ?? payload
      if (event?.type !== 'user/message') return
      const sessionId = String(
        payload?.session?.header?.id ?? payload?.session?.id ?? payload?.sessionId ?? '',
      )
      if (sessionId === '') return
      const source = event.data?.source
      // 跳过插件自己注入的消息（时间上下文、指令等），只要人说的
      if (source?.kind !== undefined && source.kind !== 'user' && source.kind !== 'user-rpc') return
      const blocks = Array.isArray(event.data?.content) ? event.data.content : []
      const text = blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join(' ')
      if (text.trim() === '') return
      const prev = recentText.get(sessionId) ?? ''
      recentText.set(sessionId, `${prev} ${text}`.slice(-1200).trim())
    }, { global: true })
  } catch (error) {
    warn(`订阅会话事件失败，相关性筛选将退回全量注入：${error?.message ?? error}`)
  }

  // 启动即加载；失败只记日志，不阻塞插件装载。
  store.load().catch((error) => warn(`记忆库加载失败：${error?.message ?? error}`))

  // ---------------------------------------------------------------- 提示词段
  ctx.effect(() => ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: (context) => {
      if (!options.injectInPrompt) return ''
      if (options.injectFor === 'top' && isDerivedAgent(context?.agent)) return ''
      try {
        const { sessionId, cwd } = identityOf(context?.agent)
        if (sessionOff.has(sessionId)) return ''
        if (options.bootSnapshot === 'session') {
          const frozen = frozenBlocks.get(sessionId)
          if (frozen !== undefined) return frozen
        }
        const visible = store.selectFor({ cwd, sessionId })
        const queryText = options.relevance ? recentText.get(sessionId) : undefined
        const entries = queryText === undefined || queryText.trim() === ''
          ? visible // 不知道在聊什么 → 全量注入（宁可吵，不可哑）
          : pickRelevant(visible, {
            queryTokens: tokensOf(queryText),
            pinnedScopes: ['user'],
            topK: options.relevanceTopK,
            keepRecent: options.relevanceKeepRecent,
          })
        const block = renderMemoryBlock({
          entries,
          maxChars: options.maxChars,
          entryChars: options.entryChars,
          guidance: options.guidance,
        })
        if (options.bootSnapshot === 'session' && sessionId !== '') {
          if (frozenBlocks.size >= FROZEN_LIMIT) frozenBlocks.delete(frozenBlocks.keys().next().value)
          frozenBlocks.set(sessionId, block)
        }
        return block
      } catch (error) {
        warn(`渲染记忆失败：${error?.message ?? error}`)
        return ''
      }
    },
  }), 'memoryShare.section')

  // ---------------------------------------------------------------- 三个工具
  ctx.effect(() => ctx.tools.register({
    name: 'memory_save',
    description: [
      'Save one durable fact to long-term memory; it is injected into every future session.',
      'Use for stable preferences, personal or environment facts that still matter next month, or an explicit request to remember something.',
      'Never for task progress, transient state, secrets, or anything derivable from the repository.',
      'scope: user (default, everywhere), workspace (this directory), session (this session).',
      'Saving the same text updates that entry. Write in the user\'s language.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {
        text: {
          type: 'string',
          description: 'The fact, as one self-contained sentence that still makes sense out of context.',
        },
        scope: {
          type: 'string',
          enum: SCOPES,
          description: 'user (default), workspace, or session.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional short tags to make memory_recall easier.',
        },
        ttlDays: {
          type: 'integer',
          description: 'Optional time-to-live in days; the entry stops being injected after that.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['summary', 'id', 'scope', 'duplicate', 'total'],
        properties: {
          summary: { type: 'string', description: '给模型看的一句话结果。' },
          id: { type: 'string', description: '记忆 id，可交给 memory_forget。' },
          scope: { type: 'string', description: '实际写入的作用域。' },
          duplicate: { type: 'boolean', description: '是否命中了已有条目。' },
          total: { type: 'integer', description: '库内条目总数。' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value?.summary ?? 'memory_save 完成' }],
    },
    async execute(args, exec) {
      const { sessionId, cwd } = identityOf(exec?.agent)
      const scope = SCOPES.includes(args?.scope) ? args.scope : 'user'
      const key = scope === 'user' ? '' : (scope === 'workspace' ? cwd : sessionId)
      if (scope !== 'user' && key === '') {
        throw new Error(`memory_save: scope=${scope} 不可用 —— 当前调用拿不到${scope === 'workspace' ? '工作区路径' : '会话 id'}`)
      }
      const result = await store.save({
        text: args?.text,
        scope,
        key,
        tags: args?.tags,
        ttlDays: args?.ttlDays,
        source: { sessionId, cwd },
      })
      const verb = result.duplicate ? '已更新已有记忆' : '已记住'
      return {
        summary: `${verb}（${scope}）：${result.entry.text.slice(0, 120)}　#${result.entry.id}　共 ${result.total} 条`,
        id: result.entry.id,
        scope,
        duplicate: result.duplicate,
        total: result.total,
      }
    },
  }), 'memoryShare.tool.save')

  ctx.effect(() => ctx.tools.register({
    name: 'memory_recall',
    description: [
      'Search long-term memory by case-insensitive keywords over text and tags; omit query to list the most recent entries.',
      'The memory block already shows what is injected, so use this to look further back. Results carry ids for memory_forget.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Keywords to match; omit to list recent entries.' },
        scope: { type: 'string', enum: SCOPES, description: 'Restrict to one scope.' },
        limit: { type: 'integer', description: 'Maximum results (default 20, max 200).' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['summary', 'count', 'entries'],
        properties: {
          summary: { type: 'string', description: '给模型看的一句话结果。' },
          count: { type: 'integer', description: '返回条数。' },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'scope', 'text'],
              properties: {
                id: { type: 'string' },
                scope: { type: 'string' },
                text: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value?.summary ?? 'memory_recall 完成' }],
    },
    async execute(args, exec) {
      const { sessionId, cwd } = identityOf(exec?.agent)
      const scope = SCOPES.includes(args?.scope) ? args.scope : undefined
      const key = scope === undefined || scope === 'user'
        ? ''
        : (scope === 'workspace' ? cwd : sessionId)
      if (scope !== undefined && scope !== 'user' && key === '') {
        throw new Error(`memory_recall: scope=${scope} 不可用`)
      }
      const entries = await store.list({ scope, key, query: args?.query, limit: args?.limit })
      const text = entries.length === 0
        ? '没有匹配的记忆。'
        : entries.map((entry) => `[${entry.scope}] ${entry.id} ${entry.text}${(entry.tags ?? []).length > 0 ? `  #${entry.tags.join(' #')}` : ''}`).join('\n')
      return {
        summary: entries.length === 0
          ? '没有匹配的记忆。'
          : `找到 ${entries.length} 条记忆：\n${text}`,
        count: entries.length,
        entries: entries.map((entry) => ({
          id: entry.id,
          scope: entry.scope,
          text: entry.text,
          ...(Array.isArray(entry.tags) && entry.tags.length > 0 ? { tags: entry.tags } : {}),
        })),
      }
    },
  }), 'memoryShare.tool.recall')

  ctx.effect(() => ctx.tools.register({
    name: 'memory_forget',
    description: [
      'Delete from long-term memory: id removes one entry, all=true plus scope clears a whole scope.',
      'Only when the user asks or the memory is provably wrong.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'The memory id to delete.' },
        all: { type: 'boolean', description: 'With scope: delete every entry of that scope.' },
        scope: { type: 'string', enum: SCOPES, description: 'Scope used together with all=true.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['summary', 'removed'],
        properties: {
          summary: { type: 'string', description: '给模型看的一句话结果。' },
          removed: { type: 'integer', description: '删除条数。' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value?.summary ?? 'memory_forget 完成' }],
    },
    async execute(args, exec) {
      const { sessionId, cwd } = identityOf(exec?.agent)
      if (typeof args?.id === 'string' && args.id.trim() !== '') {
        const removed = await store.remove(args.id)
        return {
          summary: removed ? `已删除 #${args.id}` : `没有找到 #${args.id}`,
          removed: removed ? 1 : 0,
        }
      }
      if (args?.all === true && SCOPES.includes(args?.scope)) {
        const scope = args.scope
        const key = scope === 'user' ? '' : (scope === 'workspace' ? cwd : sessionId)
        if (scope !== 'user' && key === '') throw new Error(`memory_forget: scope=${scope} 不可用`)
        const removed = await store.clear(scope, key)
        return { summary: `已清空 ${scope} 作用域的 ${removed} 条记忆`, removed }
      }
      throw new Error('memory_forget: 需要 id，或 all=true 加 scope')
    },
  }), 'memoryShare.tool.forget')

  // ---------------------------------------------------------------- 管理服务
  // 设置页（以及任何其它插件）通过 ctx.memoryShare 读写。只暴露三个方法：
  // 读全量、改单条、删单条。没有「新建」——写一条记忆需要作用域与来源判断，
  // 那属于工具面；UI 手工新建应该单独设计表单，而不是复用 save。
  const service = {
    /** 全量列表（含过期条目），供设置页展示与统计。 */
    async list() {
      const entries = await store.list({ limit: 500, includeExpired: true })
      const counts = { user: 0, workspace: 0, session: 0 }
      for (const entry of entries) counts[entry.scope] = (counts[entry.scope] ?? 0) + 1
      return {
        entries: entries.map((entry) => ({
          id: entry.id,
          text: entry.text,
          scope: entry.scope,
          key: entry.key ?? '',
          tags: entry.tags ?? [],
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
          ...(entry.ttlDays === undefined ? {} : { ttlDays: entry.ttlDays }),
        })),
        total: entries.length,
        counts,
        dataDir: options.dataDir,
      }
    },
    /** 改一条的正文。 */
    async update(id, text) {
      return { ok: await store.update(id, text) }
    },
    /** 删一条。 */
    async remove(id) {
      return { removed: (await store.remove(id)) ? 1 : 0 }
    },
    /** 远程方法名必须是 forget：remove 与 RemoteNamespaceService 原型的保留成员冲突。 */
    async forget(id) {
      return { removed: (await store.remove(id)) ? 1 : 0 }
    },
    /** 会话级开关：false = 该会话不再注入；下次 assemble 生效。 */
    async setSessionEnabled(sessionId, enabled) {
      const id = String(sessionId ?? '')
      if (id === '') throw new Error('memory-share: sessionId 不能为空')
      if (enabled === false) sessionOff.add(id)
      else sessionOff.delete(id)
      frozenBlocks.delete(id)
      return { sessionId: id, enabled: enabled !== false }
    },
    /** 当前被关掉的会话、以及已冻结的会话。 */
    async listSessions() {
      return { disabled: [...sessionOff], frozen: [...frozenBlocks.keys()] }
    },
  }
  // Typert 反射绑定：网页客户端据此把这三个方法挂到 ctx.remote.memoryShare 上。
  service.typertRemote = Object.freeze({ service, serviceKey: 'memoryShare', namespace: 'memoryShare' })
  if (typeof ctx.provide === 'function') ctx.provide('memoryShare', service)

  // ---------------------------------------------------------------- 新鲜度
  // 其它进程/会话改了库，本进程最多 refreshIntervalMs 后看到；磁盘 mtime 未变则零成本。
  if (options.refreshIntervalMs > 0) {
    ctx.effect(() => {
      const timer = setInterval(() => {
        store.load().catch((error) => warn(`记忆库刷新失败：${error?.message ?? error}`))
      }, options.refreshIntervalMs)
      timer.unref?.()
      return () => clearInterval(timer)
    }, 'memoryShare.refresh')
  }

  // 新会话建立时立刻对齐一次，避免刚写下的记忆在下一个会话里迟到半分钟。
  try {
    ctx.on('agent/created', () => {
      store.load().catch(() => {})
    }, { global: true })
  } catch {
    /* 老版本 cordis 不支持 global 选项时降级为定时刷新 */
  }
}

/** 供测试与诊断使用。 */
export const internals = { SECTION_NAME, SECTION_ORDER, DEFAULTS, normalizeOptions, normalizeKey }
