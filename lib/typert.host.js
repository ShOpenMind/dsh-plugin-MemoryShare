// 严格反射清单，由 DSH Typert 加载器校验。结构对齐 dsh-plugin-mind-tree。
// License: MIT
import { PACKAGE, NAMESPACE, LIST_DESCRIPTOR, UPDATE_DESCRIPTOR, REMOVE_DESCRIPTOR } from './remote.js'

export const TYPERT = {
  package: PACKAGE,
  face: 'host',
  schemas: [],
  invocations: [LIST_DESCRIPTOR, UPDATE_DESCRIPTOR, REMOVE_DESCRIPTOR],
  model: {
    services: [{
      key: NAMESPACE,
      exportName: 'MemoryShareService',
      description: '只读为主的管理面：列出全部长期记忆条目、修改单条正文、删除单条。写入记忆仍走 memory_save 工具，不在本服务上暴露。',
      summary: '跨会话长期记忆的查看与维护',
      tags: ['memory', 'long-term-memory', 'settings'],
      members: [
        { kind: 'method', name: 'list', signature: 'list(): Promise<MemoryList>' },
        { kind: 'method', name: 'update', signature: 'update(id: string, text: string): Promise<MemoryMutation>' },
        { kind: 'method', name: 'forget', signature: 'forget(id: string): Promise<MemoryMutation>' },
      ],
      types: [],
    }],
    events: [],
    objects: [],
  },
}

export default TYPERT
