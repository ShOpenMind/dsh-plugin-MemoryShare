// dsh-plugin-MemoryShare 远程契约：宿主与网页客户端之间唯一的数据面。
// 同时被宿主（经 ./typert）和客户端构建（打包进 lib/client.js）引用，因此只依赖 zod。
// License: MIT
import z from 'zod'

export const PACKAGE = 'dsh-plugin-memory-share'
export const NAMESPACE = 'memoryShare'

export const MemoryEntrySchema = z.object({
  id: z.string(),
  text: z.string(),
  scope: z.enum(['user', 'workspace', 'session']),
  key: z.string(),
  tags: z.array(z.string()),
  createdAt: z.number(),
  updatedAt: z.number(),
  ttlDays: z.number().optional(),
})

export const MemoryListSchema = z.object({
  entries: z.array(MemoryEntrySchema),
  total: z.number(),
  counts: z.object({ user: z.number(), workspace: z.number(), session: z.number() }),
  dataDir: z.string(),
})

export const MemoryMutationSchema = z.object({
  ok: z.boolean().optional(),
  removed: z.number().optional(),
})

const STRING = (name) => ({ name, wire: name, source: 'json', codec: { mode: 'strict', typeSymbol: `${PACKAGE}#${name}`, create: () => z.string() } })

export const LIST_DESCRIPTOR = {
  id: `${PACKAGE}#memoryShare/list`,
  service: NAMESPACE,
  namespace: NAMESPACE,
  method: 'list',
  invocation: { kind: 'direct' },
  parameters: [],
  cancellation: { parameter: 'signal' },
  result: { mode: 'strict', typeSymbol: `${PACKAGE}#MemoryList`, create: () => MemoryListSchema },
}

export const UPDATE_DESCRIPTOR = {
  id: `${PACKAGE}#memoryShare/update`,
  service: NAMESPACE,
  namespace: NAMESPACE,
  method: 'update',
  invocation: { kind: 'direct' },
  parameters: [STRING('id'), STRING('text')],
  cancellation: { parameter: 'signal' },
  result: { mode: 'strict', typeSymbol: `${PACKAGE}#MemoryMutation`, create: () => MemoryMutationSchema },
}

export const REMOVE_DESCRIPTOR = {
  id: `${PACKAGE}#memoryShare/forget`,
  service: NAMESPACE,
  namespace: NAMESPACE,
  method: 'forget',
  invocation: { kind: 'direct' },
  parameters: [STRING('id')],
  cancellation: { parameter: 'signal' },
  result: { mode: 'strict', typeSymbol: `${PACKAGE}#MemoryMutation`, create: () => MemoryMutationSchema },
}

export const TYPERT_REMOTE = {
  package: PACKAGE,
  descriptors: [LIST_DESCRIPTOR, UPDATE_DESCRIPTOR, REMOVE_DESCRIPTOR],
}

/** 方法名不能与 RemoteNamespaceService 原型的保留成员冲突（remove 就在其中）。 */
export const RESERVED_NAMES = ['remove', 'ctx', 'empty', 'invokeRemote']
