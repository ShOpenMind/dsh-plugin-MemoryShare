// dsh-plugin-MemoryShare 网页客户端半区（构建前源码，经 tools/build.mjs 打包为 lib/client.js）。
// 在「设置 → 插件」里注册一个「记忆」标签页：列出全部长期记忆，可改正文、可删单条。
// 入口为纯 CJS（require 形式），与 dsh-plugin-mind-tree 的加载模式一致。
// License: MIT
const React = require('react')
const { TYPERT_REMOTE } = require('../lib/remote.js')

const PACKAGE_ID = 'dsh-plugin-memory-share'
const NAMESPACE = 'memoryShare'
const SLOT = 'settings.plugins.tab'
const h = React.createElement

const MESSAGES = {
  title: '记忆',
  hint: '这些是跨会话共享的长期记忆，会被注入每个会话的系统提示词。修改或删除立即生效。',
  refresh: '刷新',
  loading: '正在读取…',
  empty: '还没有任何记忆。让 agent「记住…」或在对话里陈述稳定偏好即可。',
  error: '读取失败',
  retry: '重试',
  save: '保存',
  cancel: '取消',
  edit: '编辑',
  remove: '删除',
  confirmRemove: '确认删除这条记忆？',
  total: '共',
  items: '条',
  cleared: '已删除',
  saved: '已保存',
}

const SCOPE_LABEL = { user: '全局', workspace: '工作区', session: '会话' }

/** 远程服务单例：mount 只做一次。 */
let servicePromise

function ensureService(ctx) {
  if (servicePromise === undefined) {
    servicePromise = (async () => {
      // 1) 先挂载描述符；"already mounted" 说明别人挂过了，属于良性。
      try {
        await ctx.remote.$mount(TYPERT_REMOTE)
      } catch (error) {
        const message = String(error?.message ?? error)
        if (!message.includes('already mounted')) throw error
      }
      // 2) 命名空间服务要过 inject 门禁：ctx.remote.memoryShare 不能裸取，
      //    必须用 `remote.<ns>` 声明注入（与 dsh-plugin-mind-tree 的 useService 同款写法）。
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('记忆服务不可用：宿主未暴露 memoryShare（重启 DSH 后重试）'))
        }, 8000)
        try {
          const fiber = ctx.inject([`remote.${NAMESPACE}`], (scope) => {
            const service = scope.remote[NAMESPACE]
            if (!service) return
            clearTimeout(timer)
            resolve(service)
          })
          Promise.resolve(fiber).catch((error) => {
            clearTimeout(timer)
            reject(error)
          })
        } catch (error) {
          clearTimeout(timer)
          reject(error)
        }
      })
    })().catch((error) => {
      servicePromise = undefined
      throw error
    })
  }
  return servicePromise
}

/** 拆掉 typert 的 {ok,value} 信封；兼容直接返回值。 */
function unwrap(result) {
  if (result && typeof result === 'object' && 'ok' in result) {
    if (result.ok === false) throw new Error(String(result.error?.message ?? result.error ?? '远程调用失败'))
    return result.value
  }
  return result
}

function when(ms) {
  if (!ms) return ''
  const date = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function MemoryPage(props) {
  const { ctx } = props
  const [data, setData] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [loading, setLoading] = React.useState(true)
  const [editing, setEditing] = React.useState(null)
  const [draft, setDraft] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const [pendingRemove, setPendingRemove] = React.useState(null)

  const load = React.useCallback(() => {
    setLoading(true)
    setError(null)
    ensureService(ctx)
      .then((service) => service.list())
      .then(unwrap)
      .then((next) => { setData(next); setLoading(false) })
      .catch((err) => { setError(err?.message ?? String(err)); setLoading(false) })
  }, [ctx])

  React.useEffect(() => { load() }, [load])

  const commitEdit = React.useCallback(() => {
    if (editing === null) return
    const text = draft.trim()
    if (text === '') { setNotice('正文不能为空'); return }
    ensureService(ctx)
      .then((service) => service.update(editing, text))
      .then(unwrap)
      .then(() => { setEditing(null); setDraft(''); setNotice(MESSAGES.saved); load() })
      .catch((err) => setNotice(err?.message ?? String(err)))
  }, [ctx, editing, draft, load])

  const commitRemove = React.useCallback((id) => {
    ensureService(ctx)
      .then((service) => service.forget(id))
      .then(unwrap)
      .then((result) => { setPendingRemove(null); setNotice(`${MESSAGES.cleared} ${result?.removed ?? 0} ${MESSAGES.items}`); load() })
      .catch((err) => setNotice(err?.message ?? String(err)))
  }, [ctx, load])

  const header = h('div', { className: 'ms-head' },
    h('div', { className: 'ms-title' }, MESSAGES.title),
    h('div', { className: 'ms-count' },
      data === null ? '' : `${MESSAGES.total} ${data.total} ${MESSAGES.items}　全局 ${data.counts.user} · 工作区 ${data.counts.workspace} · 会话 ${data.counts.session}`),
    h('button', { className: 'ms-btn', onClick: load, disabled: loading }, MESSAGES.refresh))

  const hint = h('div', { className: 'ms-hint' }, MESSAGES.hint)

  if (loading && data === null) return h('div', { className: 'ms-root' }, header, hint, h('div', { className: 'ms-muted' }, MESSAGES.loading))

  if (error !== null) {
    return h('div', { className: 'ms-root' }, header, hint,
      h('div', { className: 'ms-error' }, `${MESSAGES.error}：${error}`),
      h('button', { className: 'ms-btn', onClick: load }, MESSAGES.retry))
  }

  const entries = data?.entries ?? []
  const rows = entries.length === 0
    ? [h('div', { className: 'ms-muted', key: 'empty' }, MESSAGES.empty)]
    : entries.map((entry) => {
      const isEditing = editing === entry.id
      return h('div', { className: 'ms-row', key: entry.id },
        h('div', { className: 'ms-row-head' },
          h('span', { className: `ms-scope ms-scope-${entry.scope}` }, SCOPE_LABEL[entry.scope] ?? entry.scope),
          h('code', { className: 'ms-id' }, entry.id),
          h('span', { className: 'ms-time' }, when(entry.updatedAt)),
          h('span', { className: 'ms-grow' }),
          isEditing
            ? [
              h('button', { className: 'ms-btn ms-primary', key: 'save', onClick: commitEdit }, MESSAGES.save),
              h('button', { className: 'ms-btn', key: 'cancel', onClick: () => { setEditing(null); setDraft('') } }, MESSAGES.cancel),
            ]
            : [
              h('button', { className: 'ms-btn', key: 'edit', onClick: () => { setEditing(entry.id); setDraft(entry.text) } }, MESSAGES.edit),
              pendingRemove === entry.id
                ? h('button', { className: 'ms-btn ms-danger', key: 'confirm', onClick: () => commitRemove(entry.id) }, MESSAGES.confirmRemove)
                : h('button', { className: 'ms-btn ms-danger', key: 'remove', onClick: () => setPendingRemove(entry.id) }, MESSAGES.remove),
            ]),
        isEditing
          ? h('textarea', {
            className: 'ms-textarea',
            value: draft,
            rows: 3,
            onChange: (event) => setDraft(event.target.value),
          })
          : h('div', { className: 'ms-text' }, entry.text))
    })

  return h('div', { className: 'ms-root' },
    header,
    hint,
    notice === '' ? null : h('div', { className: 'ms-notice' }, notice),
    h('div', { className: 'ms-list' }, rows))
}

const CSS = `
.ms-root{display:flex;flex-direction:column;gap:10px;font-size:13px;color:var(--dsw-alias-label-primary,#111827);height:100%;min-height:240px}
.ms-head{display:flex;align-items:baseline;gap:10px}
.ms-title{font-size:15px;font-weight:600}
.ms-count{color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px}
.ms-grow{flex:1}
.ms-hint{color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px;line-height:1.6}
.ms-muted{color:var(--dsw-alias-label-secondary,#6b7280);padding:16px 0}
.ms-error{color:var(--dsw-alias-label-danger,#b91c1c);padding:8px 0}
.ms-notice{color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px}
.ms-list{display:flex;flex-direction:column;gap:8px;overflow:auto}
.ms-row{border:1px solid var(--dsw-alias-border-base,#e5e7eb);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:6px}
.ms-row-head{display:flex;align-items:center;gap:8px}
.ms-scope{font-size:11px;padding:1px 6px;border-radius:999px;background:var(--dsw-alias-bg-muted,#f3f4f6)}
.ms-scope-user{background:#eef2ff}
.ms-scope-workspace{background:#ecfdf5}
.ms-scope-session{background:#fef3c7}
.ms-id{font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280)}
.ms-time{font-size:11px;color:var(--dsw-alias-label-secondary,#9ca3af)}
.ms-text{line-height:1.6;white-space:pre-wrap;word-break:break-word}
.ms-textarea{width:100%;box-sizing:border-box;font:inherit;line-height:1.5;padding:6px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-base,#d1d5db);resize:vertical;background:transparent;color:inherit}
.ms-btn{font:inherit;font-size:12px;padding:3px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-base,#d1d5db);background:transparent;color:inherit;cursor:pointer}
.ms-btn:disabled{opacity:.5;cursor:default}
.ms-primary{background:var(--dsw-alias-bg-accent,#111827);color:#fff;border-color:transparent}
.ms-danger{color:var(--dsw-alias-label-danger,#b91c1c)}
`

export const inject = ['slots', 'remote']

export function apply(ctx) {
  const style = document.createElement('style')
  style.dataset.dyn = PACKAGE_ID
  style.textContent = CSS
  document.head.appendChild(style)

  const dispose = ctx.slots.inject(SLOT, () => ctx.slots.register({
    name: SLOT,
    id: `${PACKAGE_ID}/memory`,
    order: 900,
    label: () => MESSAGES.title,
  }, (props) => h(MemoryPage, { ...props, ctx })))

  return () => {
    try { dispose?.() } catch { /* 卸载时槽已不可用 */ }
    style.remove()
  }
}
