// 用真实的 cordis 运行时挂载一次插件，验证生命周期（inject / effect / 注销）而不只是 fake host。
// cordis 路径从 DSH_CORDIS 环境变量或常见的 asar-src 位置解析；找不到就 SKIP，保持可移植。
// 用法：node tools/cordis-mount-test.mjs
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as plugin from '../lib/index.js'

const CANDIDATES = [
  process.env.DSH_CORDIS,
  'C:/Users/11625/Documents/deepseek-harness/default-workspace/mindtree-dev/asar-src/dsh/node_modules/@deepseek-ai/cordis/lib/index.js',
].filter(Boolean)

const cordisPath = CANDIDATES.find((candidate) => existsSync(candidate))
if (cordisPath === undefined) {
  console.log('SKIP: 找不到 cordis（设置 DSH_CORDIS 指向 @deepseek-ai/cordis/lib/index.js）')
  process.exit(0)
}

const { Context } = await import(pathToFileURL(cordisPath).href)

const dir = mkdtempSync(join(tmpdir(), 'memory-share-cordis-'))
const sections = new Map()
const tools = new Map()

const ctx = new Context()
ctx.provide('systemPrompt', {
  section(spec) {
    sections.set(spec.name, spec)
    return () => sections.delete(spec.name)
  },
})
ctx.provide('tools', {
  register(def) {
    if (tools.has(def.name)) throw new Error(`工具重复注册：${def.name}`)
    tools.set(def.name, def)
    return () => tools.delete(def.name)
  },
})

ctx.plugin(plugin, { dataDir: dir })
await new Promise((resolve) => setTimeout(resolve, 150))

const checks = []
const check = (name, condition) => checks.push({ name, ok: Boolean(condition) })

check('插件已装载并注册提示词段', sections.has('memory-share'))
check('注册了三个工具', tools.size === 3)
check('工具名齐全', ['memory_save', 'memory_recall', 'memory_forget'].every((name) => tools.has(name)))
check('提示词段 order 为 100', sections.get('memory-share')?.order === 100)
check('通过 cordis 提供了 memoryShare 服务', typeof ctx.memoryShare?.list === 'function')

const block = sections.get('memory-share')?.text({
  agent: { id: 'sess-1', session: { header: { id: 'sess-1', cwd: 'C:\\work\\alpha' } } },
})
check('真实 cordis 下渲染出记忆块', typeof block === 'string' && block.startsWith('<memory-share>'))

const saved = await tools.get('memory_save').execute(
  { text: 'cordis 真实环境写入测试' },
  { agent: { id: 'sess-1', session: { header: { id: 'sess-1', cwd: 'C:\\work\\alpha' } } } },
)
check('保存返回 id', typeof saved.id === 'string' && saved.id.length > 0)

const again = sections.get('memory-share').text({
  agent: { id: 'sess-1', session: { header: { id: 'sess-1', cwd: 'C:\\work\\alpha' } } },
})
check('保存后立刻出现在提示词里', again.includes('cordis 真实环境写入测试'))

const listed = await ctx.memoryShare.list()
check('服务读回刚写入的条目', listed.total === 1 && listed.entries[0].id === saved.id)
check('服务改了正文后渲染跟随', (await ctx.memoryShare.update(saved.id, 'cordis 改过')) && sections.get('memory-share')
  .text({ agent: { id: 'sess-1', session: { header: { id: 'sess-1', cwd: 'C:\\work\\alpha' } } } })
  .includes('cordis 改过'))

// 注销插件：effect 必须把段和工具都撤掉
await ctx.registry.delete(plugin)
await new Promise((resolve) => setTimeout(resolve, 50))
check('注销后提示词段被移除', !sections.has('memory-share'))
check('注销后工具被移除', tools.size === 0)

rmSync(dir, { recursive: true, force: true })

let failed = 0
for (const item of checks) {
  console.log(`  ${item.ok ? '✓' : '✗'} ${item.name}`)
  if (!item.ok) failed += 1
}
console.log(`\n${checks.length - failed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
