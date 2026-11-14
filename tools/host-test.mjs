// dsh-plugin-MemoryShare 宿主侧测试：用一个最小 fake host 挂载插件，验证注入、工具、预算与落盘。
// 不依赖 DSH 运行时，`node tools/host-test.mjs` 直接跑。
// License: MIT
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../lib/index.js'
import { MemoryStore, isExpired } from '../lib/store.js'
import { renderMemoryBlock } from '../lib/render.js'

/* ------------------------------------------------------------------ 断言 */

class AssertionError extends Error {}

function ok(value, message) {
  if (!value) throw new AssertionError(message)
}

function equal(actual, expected, message) {
  if (actual !== expected) throw new AssertionError(`${message}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`)
}

function includes(haystack, needle, message) {
  if (!String(haystack).includes(needle)) {
    throw new AssertionError(`${message}（未找到 ${JSON.stringify(needle)}）\n--- 实际内容 ---\n${haystack}`)
  }
}

function excludes(haystack, needle, message) {
  if (String(haystack).includes(needle)) {
    throw new AssertionError(`${message}（不应出现 ${JSON.stringify(needle)}）\n--- 实际内容 ---\n${haystack}`)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ------------------------------------------------------------------ fake host */

function createHost() {
  const sections = new Map()
  const tools = new Map()
  const disposers = []
  const listeners = new Map()

  const ctx = {
    logger: { warn: () => {} },
    systemPrompt: {
      section(spec) {
        sections.set(spec.name, spec)
        return () => sections.delete(spec.name)
      },
    },
    tools: {
      register(def) {
        if (tools.has(def.name)) throw new Error(`工具重复注册：${def.name}`)
        tools.set(def.name, def)
        return () => tools.delete(def.name)
      },
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
      return () => {}
    },
    provide(name, value) {
      ctx[name] = value
      return () => { delete ctx[name] }
    },
    get(name) {
      return ctx[name]
    },
  }

  return {
    ctx,
    sections,
    tools,
    listeners,
    dispose() {
      while (disposers.length > 0) disposers.pop()?.()
    },
  }
}

function agentFor(cwd, sessionId) {
  return { id: sessionId, session: { header: { id: sessionId, cwd } } }
}

function sectionText(host, cwd = 'C:\\work\\alpha', sessionId = 's-alpha') {
  const section = host.sections.get('memory-share')
  ok(section !== undefined, '已注册 memory-share 提示词段')
  return section.text({ agent: agentFor(cwd, sessionId) })
}

async function mount(config) {
  const host = createHost()
  plugin.apply(host.ctx, config)
  await sleep(60) // 等首次 load 完成
  return host
}

function readStore(dir) {
  const file = join(dir, 'memories.json')
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, 'utf8'))
}

function seedStore(dir, entries) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'memories.json'), JSON.stringify({ version: 1, entries }, null, 2), 'utf8')
}

function entry(text, overrides = {}) {
  const now = Date.now()
  return {
    id: overrides.id ?? `m${Math.random().toString(36).slice(2, 9)}`,
    text,
    scope: overrides.scope ?? 'user',
    key: overrides.key ?? '',
    fingerprint: text.toLowerCase(),
    tags: overrides.tags ?? [],
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    source: {},
    ...(overrides.ttlDays === undefined ? {} : { ttlDays: overrides.ttlDays }),
  }
}

/* ------------------------------------------------------------------ 用例 */

const tests = []
const test = (title, fn) => tests.push({ title, fn })

test('空库：只有指引，没有条目', async (dir) => {
  const host = await mount({ dataDir: dir })
  const text = sectionText(host)
  includes(text, '<memory-share>', '渲染出记忆块')
  includes(text, 'Long-term memories shared by every session', '带用法指引')
  includes(text, '(no memories stored yet)', '空库有明确提示')
})

test('memory_save：写入、落盘、返回 id', async (dir) => {
  const host = await mount({ dataDir: dir })
  const saved = await host.tools.get('memory_save').execute(
    { text: '用户要求所有回答用中文，代码注释用英文。' },
    { agent: agentFor('C:\\work\\alpha', 's-alpha') },
  )
  ok(saved.id.startsWith('m'), 'id 形如 m…')
  equal(saved.scope, 'user', '默认 scope 是 user')
  equal(saved.duplicate, false, '首次保存不是重复')
  const file = readStore(dir)
  equal(file.entries.length, 1, '磁盘上有一条')
  equal(file.entries[0].text, '用户要求所有回答用中文，代码注释用英文。', '正文原样保存')
  includes(sectionText(host), '代码注释用英文', '下一次渲染就能看到')
})

test('重复保存：更新而不是新增', async (dir) => {
  const host = await mount({ dataDir: dir })
  const tool = host.tools.get('memory_save')
  const exec = { agent: agentFor('C:\\work\\alpha', 's-alpha') }
  const first = await tool.execute({ text: '偏好简短回答' }, exec)
  const second = await tool.execute({ text: '  偏好简短回答  ' }, exec)
  equal(second.id, first.id, '同一文本复用同一条目')
  equal(second.duplicate, true, '标记为重复')
  equal(readStore(dir).entries.length, 1, '磁盘上仍然只有一条')
})

test('workspace 作用域：只在对应目录可见', async (dir) => {
  const host = await mount({ dataDir: dir })
  await host.tools.get('memory_save').execute(
    { text: '本仓库用 pnpm，不用 npm。', scope: 'workspace' },
    { agent: agentFor('C:\\work\\alpha', 's-alpha') },
  )
  includes(sectionText(host, 'C:\\work\\alpha', 's-alpha'), '本仓库用 pnpm', '同目录可见')
  excludes(sectionText(host, 'C:\\work\\beta', 's-beta'), '本仓库用 pnpm', '别的目录不可见')
  // 大小写不敏感只在 Windows 上成立；POSIX 下 'C:' 与 'c:' 是两个不同目录。
  if (process.platform === 'win32') {
    includes(sectionText(host, 'c:\\WORK\\ALPHA', 's-alpha'), '本仓库用 pnpm', '大小写不敏感')
  }
})

test('session 作用域：只在对应会话可见', async (dir) => {
  const host = await mount({ dataDir: dir })
  await host.tools.get('memory_save').execute(
    { text: '这次任务的目标是把 Excel 导出成 PDF。', scope: 'session' },
    { agent: agentFor('C:\\work\\alpha', 's-alpha') },
  )
  includes(sectionText(host, 'C:\\work\\alpha', 's-alpha'), 'Excel 导出成 PDF', '原会话可见')
  excludes(sectionText(host, 'C:\\work\\alpha', 's-other'), 'Excel 导出成 PDF', '别的会话不可见')
})

test('memory_recall：关键词检索与空查询', async (dir) => {
  const host = await mount({ dataDir: dir })
  const save = host.tools.get('memory_save')
  await save.execute({ text: '用户住在杭州。', tags: ['location'] }, { agent: agentFor('C:\\w', 's1') })
  await save.execute({ text: '用户偏好 TypeScript 而不是 JavaScript。', tags: ['language'] }, { agent: agentFor('C:\\w', 's1') })
  const recall = host.tools.get('memory_recall')

  const hit = await recall.execute({ query: '杭州' }, { agent: agentFor('C:\\w', 's1') })
  equal(hit.count, 1, '关键词命中一条')
  includes(hit.summary, '用户住在杭州', '摘要里带正文')

  const tagged = await recall.execute({ query: 'language' }, { agent: agentFor('C:\\w', 's1') })
  equal(tagged.count, 1, '标签也可检索')

  const all = await recall.execute({}, { agent: agentFor('C:\\w', 's1') })
  equal(all.count, 2, '空查询返回全部')

  const miss = await recall.execute({ query: '不存在的词' }, { agent: agentFor('C:\\w', 's1') })
  equal(miss.count, 0, '无命中返回 0')
})

test('memory_forget：按 id 删除与清空作用域', async (dir) => {
  const host = await mount({ dataDir: dir })
  const exec = { agent: agentFor('C:\\work\\alpha', 's-alpha') }
  const saved = await host.tools.get('memory_save').execute({ text: '临时结论 A' }, exec)
  const forget = host.tools.get('memory_forget')

  const removed = await forget.execute({ id: saved.id }, exec)
  equal(removed.removed, 1, '删除一条')
  excludes(sectionText(host), '临时结论 A', '删掉后不再渲染')

  await host.tools.get('memory_save').execute({ text: '清理测试 1' }, exec)
  await host.tools.get('memory_save').execute({ text: '清理测试 2' }, exec)
  const cleared = await forget.execute({ all: true, scope: 'user' }, exec)
  equal(cleared.removed, 2, '清空 user 作用域')
  equal(readStore(dir).entries.length, 0, '磁盘清空')

  let threw = false
  try {
    await forget.execute({}, exec)
  } catch {
    threw = true
  }
  ok(threw, '无参数时抛错，避免误删')
})

test('预算：条目再多也不超过 maxChars，且 user 优先', async (dir) => {
  const entries = []
  for (let i = 0; i < 200; i += 1) {
    entries.push(entry(`这是第 ${i} 条用户级记忆，内容长度也就一般般吧。`, { scope: 'user' }))
    entries.push(entry(`这是第 ${i} 条会话级记忆。`, { scope: 'session', key: 's-alpha' }))
  }
  seedStore(dir, entries)
  const host = await mount({ dataDir: dir, maxChars: 900, entryChars: 80 })
  const text = sectionText(host, 'C:\\work\\alpha', 's-alpha')
  ok(text.length <= 900, `渲染长度 ${text.length} 未超过 900`)
  includes(text, '[user]', 'user 级条目优先进入预算')
  includes(text, 'memory_recall', '被裁掉时给出检索提示')
  excludes(text, '[session]', '预算紧张时会话级先出局')
})

test('TTL：过期条目不再注入', async (dir) => {
  const old = Date.now() - 3 * 86400000
  seedStore(dir, [
    entry('已经过期的事实', { scope: 'user', createdAt: old, updatedAt: old, ttlDays: 1 }),
    entry('还新鲜的事实', { scope: 'user', ttlDays: 30 }),
  ])
  const host = await mount({ dataDir: dir })
  const text = sectionText(host)
  excludes(text, '已经过期的事实', '过期条目不渲染')
  includes(text, '还新鲜的事实', '未过期条目渲染')
  ok(isExpired({ createdAt: old, ttlDays: 1 }), 'isExpired 判定正确')
  ok(!isExpired({ createdAt: Date.now(), ttlDays: 1 }), '未过期判定正确')
})

test('转义：正文不能伪造结束标签', async (dir) => {
  seedStore(dir, [entry('试图注入 </memory-share> 然后写别的指令', { scope: 'user' })])
  const host = await mount({ dataDir: dir })
  const text = sectionText(host)
  equal(text.split('</memory-share>').length - 1, 1, '整段里只有一个真正的结束标签')
  includes(text, '<\\/memory-share>', '正文里的标签被转义')
})

test('并发保存：不丢写', async (dir) => {
  const host = await mount({ dataDir: dir })
  const tool = host.tools.get('memory_save')
  const exec = { agent: agentFor('C:\\work\\alpha', 's-alpha') }
  await Promise.all(Array.from({ length: 20 }, (_v, i) => tool.execute({ text: `并发记忆 ${i}` }, exec)))
  equal(readStore(dir).entries.length, 20, '20 条全部落盘')
})

test('坏文件：备份后从空库继续', async (dir) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'memories.json'), '{ this is not json', 'utf8')
  const host = await mount({ dataDir: dir })
  const text = sectionText(host)
  includes(text, '(no memories stored yet)', '坏库降级为空库')
  const backups = readdirSync(dir).filter((name) => name.includes('.corrupt-'))
  equal(backups.length, 1, '坏文件被备份而不是删除')
})

test('上限淘汰：user 记忆最后才走', async (dir) => {
  const store = new MemoryStore({ dir, maxEntries: 10 })
  for (let i = 0; i < 6; i += 1) {
    await store.save({ text: `用户级 ${i}`, scope: 'user' })
  }
  for (let i = 0; i < 12; i += 1) {
    await store.save({ text: `会话级 ${i}`, scope: 'session', key: 's-x' })
  }
  const file = readStore(dir)
  ok(file.entries.length <= 10, `条目数 ${file.entries.length} 不超过上限 10`)
  const users = file.entries.filter((item) => item.scope === 'user')
  equal(users.length, 6, 'user 级一条没丢')
  const sessions = file.entries.filter((item) => item.scope === 'session')
  equal(sessions.length, 4, '先砍会话级')
})

test('渲染纯函数：maxChars=0 不输出', async () => {
  const text = renderMemoryBlock({ entries: [entry('x')], maxChars: 0 })
  equal(text, '', '预算为 0 时返回空串')
  const tiny = renderMemoryBlock({ entries: [entry('x')], maxChars: 12 })
  equal(tiny, '', '预算小到放不下时返回空串而不是半截标签')
})

test('关闭注入：段落返回空串', async (dir) => {
  const host = await mount({ dataDir: dir, injectInPrompt: false })
  equal(sectionText(host), '', 'injectInPrompt:false 时不输出')
})

test('管理服务：ctx.memoryShare 的 list / update / remove', async (dir) => {
  const host = await mount({ dataDir: dir })
  const exec = { agent: agentFor('C:\\work\\alpha', 's-alpha') }
  const saved = await host.tools.get('memory_save').execute({ text: '服务测试甲' }, exec)
  await host.tools.get('memory_save').execute({ text: '服务测试乙', scope: 'workspace' }, exec)

  const service = host.ctx.memoryShare
  ok(service !== undefined, 'ctx.memoryShare 已提供')
  equal(typeof service.list, 'function', 'list 可用')

  const listed = await service.list()
  equal(listed.total, 2, '列出全部两条')
  equal(listed.counts.user, 1, 'user 计数')
  equal(listed.counts.workspace, 1, 'workspace 计数')
  equal(listed.dataDir, dir, '带上数据目录，便于界面显示')

  equal((await service.update(saved.id, '服务测试甲（改）')).ok, true, '更新成功')
  const afterUpdate = await service.list()
  ok(afterUpdate.entries.some((entry) => entry.text === '服务测试甲（改）'), '正文已改')
  includes(sectionText(host), '服务测试甲（改）', '渲染跟着变')

  equal((await service.remove(saved.id)).removed, 1, '删除返回 1')
  equal((await service.list()).total, 1, '只剩一条')
  equal((await service.remove('不存在的 id')).removed, 0, '删不存在的返回 0')
})

test('injectFor=top：子代理不注入，主会话照常', async (dir) => {
  const host = await mount({ dataDir: dir })
  await host.tools.get('memory_save').execute({ text: '全局事实' }, { agent: agentFor('C:\\w', 's1') })
  const section = host.sections.get('memory-share')

  ok(section.text({ agent: agentFor('C:\\w', 's1') }).includes('全局事实'), '顶层会话注入')
  const derived = { id: 'sub', session: { header: { id: 'sub', cwd: 'C:\\w', origin: 'subagent' } } }
  equal(section.text({ agent: derived }), '', '子代理不注入')
  const forked = { id: 'fork', session: { header: { id: 'fork', cwd: 'C:\\w', parentSessionId: 's1' } } }
  equal(section.text({ agent: forked }), '', '有父会话标记的也不注入')
  ok(section.text({ agent: { id: 'unknown' } }).includes('全局事实'), '无标记按顶层处理')

  const hostAll = await mount({ dataDir: dir, injectFor: 'all' })
  ok(hostAll.sections.get('memory-share').text({ agent: derived }).includes('全局事实'), 'all 模式下子代理也注入')
})

test('相关性：按当前话题筛选，user 条目始终保留', async (dir) => {
  const host = await mount({ dataDir: dir })
  const exec = { agent: agentFor('C:\\work\\alpha', 's-alpha') }
  const save = host.tools.get('memory_save').execute
  await save({ text: 'Vic2 阵营系统用 alliance_with = TAG 判定结盟', scope: 'workspace', tags: ['vic2', 'mod'] }, exec)
  await save({ text: 'DSH 插件安装用 dsh plugin add 命令，包名形如 dsh-plugin-xxx', scope: 'workspace', tags: ['dsh', 'plugin'] }, exec)
  await save({ text: '用户偏好中文回答', scope: 'user' }, exec)

  const say = (sessionId, text) => {
    for (const fn of host.listeners.get('session/event') ?? []) {
      fn({
        session: { header: { id: sessionId } },
        event: { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } },
      })
    }
  }

  say('s-alpha', '帮我装一个 DSH 插件')
  let block = sectionText(host, 'C:\\work\\alpha', 's-alpha')
  includes(block, 'dsh plugin add', '话题相关的条目保留')
  excludes(block, 'alliance_with', '话题无关的条目被过滤掉')
  includes(block, '用户偏好中文回答', 'user 条目不受筛选影响')

  say('s-alpha', '维多利亚2 的阵营怎么结盟')
  block = sectionText(host, 'C:\\work\\alpha', 's-alpha')
  includes(block, 'alliance_with', '话题切换后相关条目重新出现')

  block = sectionText(host, 'C:\\work\\alpha', 's-other')
  includes(block, 'alliance_with', '没有对话记录的会话退回全量注入')
})

test('bootSnapshot=session：同一会话复用首帧，不随记忆变化', async (dir) => {
  const host = await mount({ dataDir: dir, bootSnapshot: 'session' })
  const exec = { agent: agentFor('C:\\work\\alpha', 's-alpha') }
  await host.tools.get('memory_save').execute({ text: '第一条记忆' }, exec)

  const first = sectionText(host, 'C:\\work\\alpha', 's-alpha')
  includes(first, '第一条记忆', '首次渲染包含已有记忆')

  await host.tools.get('memory_save').execute({ text: '第二条记忆' }, exec)
  const second = sectionText(host, 'C:\\work\\alpha', 's-alpha')
  excludes(second, '第二条记忆', '同会话第二次渲染被冻结')
  equal(second, first, '冻结后内容完全一致')

  const other = sectionText(host, 'C:\\work\\alpha', 's-beta')
  includes(other, '第二条记忆', '新会话看到最新记忆')
})

test('会话级开关：配置与服务方法都能关掉注入', async (dir) => {
  const host = await mount({ dataDir: dir, disabledSessions: ['s-off'] })
  const exec = { agent: agentFor('C:\\work\\alpha', 's-off') }
  await host.tools.get('memory_save').execute({ text: '会话开关测试' }, exec)

  equal(sectionText(host, 'C:\\work\\alpha', 's-off'), '', '配置里的会话不注入')

  const service = host.ctx.memoryShare
  const on = await service.setSessionEnabled('s-off', true)
  equal(on.enabled, true, '服务方法重新开启')
  includes(sectionText(host, 'C:\\work\\alpha', 's-off'), '会话开关测试', '开启后恢复注入')

  await service.setSessionEnabled('s-live', false)
  equal(sectionText(host, 'C:\\work\\alpha', 's-live'), '', '运行时关闭即时生效')

  const state = await service.listSessions()
  includes(state.disabled.join(','), 's-live', 'listSessions 反映当前关闭的会话')
})

/* ------------------------------------------------------------------ 运行 */

let passed = 0
let failed = 0
const only = process.argv[2]

for (const { title, fn } of tests) {
  if (only !== undefined && !title.includes(only)) continue
  const dir = mkdtempSync(join(tmpdir(), 'memory-share-'))
  try {
    await fn(dir)
    passed += 1
    console.log(`  ✓ ${title}`)
  } catch (error) {
    failed += 1
    console.log(`  ✗ ${title}`)
    console.log(`    ${error instanceof AssertionError ? error.message : error?.stack ?? error}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
