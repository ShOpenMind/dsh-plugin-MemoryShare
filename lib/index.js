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
import { renderMemoryBlock } from './render.js'

export const name = 'memoryShare'
/** 只声明必需的服务；两者都是 dsh-base 的常驻服务，缺失时 cordis 会等它出现而不是炸掉。 */
export const inject = ['systemPrompt', 'tools']

/** 提示词段的名称与位置：100 = persona 之后、工具指引之前。 */
const SECTION_NAME = 'memory-share'
const SECTION_ORDER = 100

const DEFAULTS = {
  dataDir: '',
  maxChars: 1600,
  entryChars: 240,
  maxEntries: 500,
  injectInPrompt: true,
  /** 'top' = 只给顶层会话注入，子代理/派生会话不背这段；'all' = 所有 agent 都注入。 */
  injectFor: 'top',
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
  options.guidance = options.guidance !== false
  options.refreshIntervalMs = Math.max(0, Math.floor(Number(options.refreshIntervalMs) || 0))
  return options
}

export function apply(ctx, config = {}) {
  const options = normalizeOptions(config)
  const store = new MemoryStore({
    dir: options.dataDir,
    maxEntries: options.maxEntries,
    logger: ctx.logger,
  })

  const warn = (message) => {
    try {
      (ctx.logger?.warn ?? console.warn)(`[memory-share] ${message}`)
    } catch {
      /* 日志失败不影响主流程 */
    }
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
        return renderMemoryBlock({
          entries: store.selectFor({ cwd, sessionId }),
          maxChars: options.maxChars,
          entryChars: options.entryChars,
          guidance: options.guidance,
        })
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
      'Save one durable fact to the shared long-term memory, which is injected into every future session on this machine.',
      'Use it when the user states a stable preference (language, tone, workflow), a personal or environment fact that will still matter next month,',
      'or asks you explicitly to remember something.',
      'Do not save task progress, transient state, secrets, or anything already derivable from the repository.',
      'scope=user applies to this person everywhere (default); workspace applies only to the current working directory; session only to this session.',
      'Saving the same text again updates the existing entry instead of duplicating it.',
      'Write the fact in the user\'s language.',
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
      'Search the shared long-term memory. Omit query to list the most recently updated entries.',
      'query is matched as case-insensitive keywords over the memory text and its tags.',
      'Results include ids usable with memory_forget.',
      'The memory block in your system prompt already shows what is currently injected, so use this mainly to look further back or to check a hunch.',
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
      'Delete from the shared long-term memory.',
      'Pass id to delete exactly one entry; pass all=true plus scope to clear a whole scope.',
      'Never delete because a fact is inconvenient for the current task — only when the user asks, or when the memory is provably wrong.',
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
