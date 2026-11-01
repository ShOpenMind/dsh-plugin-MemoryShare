// 构建客户端 bundle：src/client.jsx → lib/client.js（DSH 模块加载器格式）。
// esbuild 与 zod 都不在本包里，按「本地 node_modules → desktop profile → mind-tree」的顺序解析；
// 也可用 ESBUILD_HOME / MEMORY_SHARE_ZOD 显式指定。
// License: MIT
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_ID = 'dsh-plugin-memory-share'

const CANDIDATES = [
  process.env.ESBUILD_HOME,
  'C:/Users/11625/.dsh/profiles/desktop/package.json',
  'C:/Users/11625/Documents/deepseek-harness/default-workspace/mindtree-dev/dsh-plugin-mind-tree/package.json',
].filter(Boolean)

/** 依次从候选 package.json 解析依赖；找不到返回 undefined。 */
function resolveFromCandidates(specifier) {
  for (const anchor of CANDIDATES) {
    try {
      return createRequire(anchor).resolve(specifier)
    } catch {
      /* 换下一个 */
    }
  }
  return undefined
}

let build
try {
  ({ build } = await import('esbuild'))
} catch {
  const entry = resolveFromCandidates('esbuild')
  if (entry === undefined) {
    console.error('[memory-share] 找不到 esbuild：请设置 ESBUILD_HOME 指向任意含 esbuild 的 package.json')
    process.exit(1)
  }
  const pkgDir = dirname(dirname(entry)) // .../esbuild/lib/main.js → .../esbuild
  ;({ build } = await import(pathToFileURL(join(pkgDir, 'lib', 'main.js')).href))
}

const zodEntry = process.env.MEMORY_SHARE_ZOD ?? resolveFromCandidates('zod')
const alias = zodEntry === undefined ? {} : { zod: dirname(zodEntry) }
if (zodEntry === undefined) console.warn('[memory-share] 未解析到 zod，构建可能失败')

const result = await build({
  entryPoints: [join(root, 'src', 'client.jsx')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome120'],
  write: false,
  external: ['react', 'react-dom', '@deepseek-ai/*'],
  alias,
  jsx: 'transform',
  loader: { '.jsx': 'jsx' },
  logLevel: 'warning',
  legalComments: 'none',
})

const code = result.outputFiles[0].text
const wrapped = `/*! dsh-plugin-memory-share · 作者:ShOpenMind · MIT License */
window.__ModuleLoader__.load({id:${JSON.stringify(PACKAGE_ID)},factory:function(require){
'use strict';
var module = { exports: {} };
var exports = module.exports;
${code}
return module.exports.default ?? module.exports;
}});
`

mkdirSync(join(root, 'lib'), { recursive: true })
writeFileSync(join(root, 'lib', 'client.js'), wrapped)
console.log(`[memory-share] built lib/client.js (${(wrapped.length / 1024).toFixed(1)} KiB)`)
