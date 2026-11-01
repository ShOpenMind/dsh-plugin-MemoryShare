// 打印一段真实渲染结果，用来肉眼检查效果与 token 成本。
// 用法：node tools/demo.mjs
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../lib/index.js'

const dir = mkdtempSync(join(tmpdir(), 'memory-share-demo-'))

const sections = new Map()
const tools = new Map()
const ctx = {
  logger: { warn: (message) => console.error(message) },
  systemPrompt: { section: (spec) => { sections.set(spec.name, spec); return () => {} } },
  tools: { register: (def) => { tools.set(def.name, def); return () => {} } },
  effect: (fn) => fn(),
  on: () => () => {},
}

plugin.apply(ctx, { dataDir: dir })
await new Promise((resolve) => setTimeout(resolve, 60))

const exec = { agent: { id: 'sess-demo', session: { header: { id: 'sess-demo', cwd: 'C:\\work\\alpha' } } } }
const save = tools.get('memory_save').execute

await save({ text: '回答用中文，代码与注释用英文。', tags: ['language'] }, exec)
await save({ text: '用户是后端工程师，偏好先给结论再给推理过程。', tags: ['style'] }, exec)
await save({ text: '不要主动创建 git commit，除非明确要求。', tags: ['git'] }, exec)
await save({ text: '这个仓库用 pnpm + Node 22，测试命令是 pnpm test。', scope: 'workspace', tags: ['toolchain'] }, exec)
await save({ text: '本轮在把 Excel 报表导出流程迁到后台队列。', scope: 'session' }, exec)
await save({ text: '临时密码是 hunter2', scope: 'session', ttlDays: 1 }, exec)

const block = sections.get('memory-share').text({ agent: exec.agent })
console.log('──────────── system prompt 片段 ────────────')
console.log(block)
console.log('────────────────────────────────────────────')
console.log(`字符数：${block.length}　估算 token：约 ${Math.ceil(block.length / 2.5)}`)
console.log(`库文件：${join(dir, 'memories.json')}`)

rmSync(dir, { recursive: true, force: true })
