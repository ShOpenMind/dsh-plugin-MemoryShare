// dsh-plugin-MemoryShare 文本工具：切词、相似度、token 估算。
//
// 三处必须用同一套算法，否则「提示合并」与「审计报告」会互相矛盾：
//   1. 宿主侧相关性筛选（index.js 的 pickRelevant）；
//   2. 存储侧近似重复检测（store.js 的 save，命中即建议合并）；
//   3. 成本审计（lib/audit.js）。
// 纯函数，无 IO，无依赖 —— 可以随便在热路径上调。
// License: MIT

/**
 * 切成可比较的记号集合：英文/数字按词，中文按二元字组。
 * 中文没有空格，按二元组切才能既容错（「鲸鱼娘」≈「鲸鱼娘桌宠」）又不需要分词表。
 */
export function tokensOf(text) {
  const out = new Set()
  const raw = String(text ?? '').toLowerCase()
  for (const word of raw.matchAll(/[a-z0-9_]{2,}/g)) out.add(word[0])
  for (const segment of raw.replace(/[^\u4e00-\u9fff]+/g, ' ').split(/\s+/)) {
    for (let i = 0; i + 1 < segment.length; i += 1) out.add(segment.slice(i, i + 2))
  }
  return out
}

/** 两个记号集合的 Jaccard 相似度；空集算不相似。 */
export function jaccardSets(left, right) {
  if (!(left instanceof Set) || !(right instanceof Set)) return 0
  if (left.size === 0 || right.size === 0) return 0
  const small = left.size <= right.size ? left : right
  const large = small === left ? right : left
  let shared = 0
  for (const token of small) if (large.has(token)) shared += 1
  return shared / (left.size + right.size - shared)
}

/** 两段文本的相似度（0..1）。 */
export function similarityOf(a, b) {
  return jaccardSets(tokensOf(a), tokensOf(b))
}

/**
 * 「该合并了」的默认阈值。Half of the tokens overlapping means the two entries are
 * talking about the same thing, not merely mentioning the same word.
 */
export const SIMILAR_THRESHOLD = 0.5

/** 是否是中文/全角字符（中文按字计费，比英文贵）。 */
export function isCjk(char) {
  return /[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/.test(char)
}

/** 中文按字、英文按词的粗估 token 数；只用于排序与告警，不当作计费依据。 */
export function estimateTokens(text) {
  const raw = String(text ?? '')
  let cjk = 0
  for (const char of raw) if (isCjk(char)) cjk += 1
  return Math.ceil(cjk * 0.9 + (raw.length - cjk) / 3.5)
}
