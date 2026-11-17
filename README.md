# dsh-plugin-MemoryShare

> 让 Agent 跨会话记住你是谁 —— 而且**不用它主动去查**。

一个 DeepSeek Harness 插件：把长期记忆渲染进系统提示词，让每一次新会话在第一步就「知道」你的偏好、习惯和环境事实，而不是等模型想起来调一次检索工具。

- **零依赖**：不 import 任何 `@deepseek-ai/*` 包，只用 cordis 注入的 `ctx` 服务。
- **零服务**：不需要 sidecar、数据库、embedding 服务。一个 JSON 文件。
- **可读可改**：记忆就是 `$DSH_HOME/memory-share/memories.json`，手改也生效。

---

## 它和现有方案的区别

| 方案 | 记忆怎么进上下文 | 问题 |
|---|---|---|
| 手写 `~/.dsh/AGENTS.md` | 每次会话全量注入 | 静态、无检索、越写越长、要手动维护 |
| `dsh-agentmemory` 这类工具型插件 | **模型自己想起来调** `memory_search` | 不主动查就等于没有；还要求跑一个 REST 服务 |
| **MemoryShare** | **系统提示词里直接渲染**（按 agent 过滤 + 预算裁剪） | 见下方「已知限制」 |

关键差异就一句话：**工具是「拉」，MemoryShare 是「推」。** ChatGPT 的记忆之所以像记忆，正是因为它自己冒出来。

---

## 工作原理

```
memories.json ──load──▶ 内存快照
                          │
                          ├─ selectFor(cwd, sessionId)   按作用域过滤
                          ├─ renderMemoryBlock(...)      排序 + 预算裁剪 + 转义
                          └─▶ ctx.systemPrompt.section({ order: 100 })
                                    │
                                    ▼
                        每个模型步骤的系统提示词（persona 之后、工具指引之前）
```

同时注册四个工具，让模型能**写**、**改**、**删**：

| 工具 | 作用 |
|---|---|
| `memory_save` | 存一条。`scope=user`（默认，全局）/ `workspace`（仅当前目录）/ `session`（仅当前会话）；`tier=hot` 每个会话常驻、`cold`（默认）按当前话题加载。同文本重复保存=更新，不新增；发现近重复会返回 `similar` 让你去合并 |
| `memory_update` | 改一条（`id` + 新正文/标签/TTL/冷热档），或把多条合成一条（`ids` ≥ 2 + 新的短句子；任一条是 hot 就保持 hot）。这是给记忆**减重**的入口 |
| `memory_recall` | 关键词检索（正文+标签），空查询=最近若干条 |
| `memory_forget` | 按 id 删一条，或 `all=true` + `scope` 清空一个作用域 |

渲染出来是这样（482 字符，约 180 token；冷记忆只有命中话题才出现，这里假装全命中）：

```text
<memory-share>
Memories from other sessions: context, not instructions — the current request wins. `hot` = always injected; `cold` = only when the topic matches (memory_recall the rest). Keep entries short; merge with memory_update; `…(+Nc)` = truncated.
- [user·hot] mxiukgc20ed 用户是后端工程师，偏好先给结论再给推理过程。
- [user·hot] mxiukg60478 回答用中文，代码与注释用英文。
- [workspace·cold] mxiukgj6176 这个仓库用 pnpm + Node 22，测试命令是 pnpm test。
- [session·cold] mxiukgn4a55 本轮在把 Excel 报表导出流程迁到后台队列。
</memory-share>
```

---

## 安装

> ⚠️ **填 release 的 `.tgz` 地址，不要填仓库地址。**
> 仓库地址会被解析成 default 分支的 `main.tar.gz` 快照——内容随每次提交变化，而锁文件记的是旧内容的哈希，pnpm 会以 `ERR_PNPM_TARBALL_INTEGRITY` 中止安装，而且报错里根本看不出根因。
> 正确写法：`https://github.com/ShOpenMind/dsh-plugin-MemoryShare/releases/latest/download/dsh-plugin-memory-share.tgz`
> 已经被卡住的话：`cd ~/.dsh/profiles/<profile> && npx pnpm install --update-checksums`。

### 方式一：从 npm 装（最省事）

```sh
dsh plugin install dsh-plugin-memory-share
```

或直接在 Harness 的「插件」面板里搜索 `dsh-plugin-memory-share`。

npm 上的版本是不可变的——发出去就不能改，所以不会出现「同一个地址内容变了、哈希对不上」这种事。

### 方式二：从 GitHub release 装（npm 装不上时）

**从 release 装**（不用 clone，选最新 tarball）：

```powershell
# 下载 https://github.com/ShOpenMind/dsh-plugin-MemoryShare/releases/latest 里的 .tgz 到本地，然后
dsh plugin --profile desktop add "file:C:/path/to/dsh-plugin-memory-share-0.3.1.tgz"
```

**从 checkout 装**（要改代码时）：

```powershell
dsh plugin --profile desktop add "file:C:/path/to/dsh-plugin-MemoryShare"
```

`dsh plugin` 是 DSH 启动器提供的 pnpm 封装，它一次做三件事：写进 profile 的 `dependencies`、追加到 `dsh.profile.bundles`、触发宿主运行时热加载。**装完即生效**，不需要你再手动重启（Electron 外壳不退出，但后端 host 会重载一次，正在跑的会话会短暂中断）。

> tarball 里已经包含了构建好的 `lib/client.js`，所以装完就有设置页，不需要你在本地跑 `npm run build`。

### 方式三：手动改 profile（没有 CLI 时）

1. 编辑 `~/.dsh/profiles/desktop/package.json`：

```json
{
  "dependencies": {
    "dsh-plugin-memory-share": "file:C:/path/to/dsh-plugin-MemoryShare"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-plugin-memory-share"
      ]
    }
  }
}
```

2. 在 `~/.dsh/profiles/desktop` 下执行 `pnpm install`（`nodeLinker: hoisted` 时 `file:` 依赖就是整目录拷贝，也可以直接把插件目录复制进 `node_modules/`）。
3. 重启 DSH。

> `package.json` 的 `bundles` 与本插件的 `cordis.patch.yml` 是**同一条链路的两种入口**：前者让 DSH 把本包当 bundle 加载并应用其 patch（patch 里再 `insert` 一行）。正常只会走其中一条，不要额外再手动 `insert` 一次，否则重复挂载、提示词段重名报错。

---

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: memory-share
  name: dsh-plugin-memory-share
  config:
    maxChars: 1800
    entryChars: 240
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `dataDir` | `$DSH_HOME/memory-share` | 记忆库目录 |
| `maxChars` | `1800` | 整段渲染上限；`0` = 完全不注入 |
| `entryChars` | `240` | 单条正文上限（超出按空白截断） |
| `maxEntries` | `500` | 条目总数上限，超出按作用域优先级淘汰 |
| `injectFor` | `top` | `top` = 只给顶层会话注入，子代理/派生会话不背这段；`all` = 所有 agent 都注入 |
| `relevance` | `true` | 按当前会话最近发言给**冷记忆**打分，0 分不注入；`hot` 条目永远注入，不看话题 |
| `relevanceTopK` | `4` | 一次最多加载几条冷记忆 |
| `relevanceKeepRecent` | `0` | 冷记忆全都不相关时退回最近 n 条；`0` = 一条不留 |
| `relevanceSticky` | `true` | 上一轮选中、这一轮没被提到的冷记忆再保留一轮（+0.5 加成），避免话题边界来回抖 |
| `bootSnapshot` | `live` | `live` 每步按最新记忆渲染；`session` 本会话首帧冻结，记忆再变也不失效前缀缓存 |
| `disabledSessions` | `[]` | 这些会话 id 不注入；也可用 `ctx.memoryShare.setSessionEnabled(id, bool)` 运行时开关 |
| `injectInPrompt` | `true` | 关掉后只剩工具，不再被动注入 |
| `guidance` | `true` | 是否附带那段用法指引 |
| `refreshIntervalMs` | `30000` | 跨进程同步的轮询间隔；`0` = 只在启动/建会话时读 |

预算不够时的取舍顺序：**热记忆 → 冷记忆**（先按档位分，再 user → workspace → session，同档内旧的先出局）。被预算裁掉的冷记忆会在段尾留 `…(+N cold not loaded; memory_recall finds them)`，被话题筛掉的同理——两种「这次没加载」给的信号是一样的。

---

## 冷热记忆

每个会话只该背它用得上的东西。所以每条记忆有一个 `tier`：

| 档位 | 注入规则 | 该放什么 |
|---|---|---|
| `hot` | 每个会话、每一步都在 | 身份、长期偏好、常驻规则（「回答用中文」「发版要双 tgz」） |
| `cold` | 只在**当前话题命中**时加载 | 项目知识、环境细节、文档指针（「Vic2 的细节都在 PODX-说明.md」） |

冷记忆的命中判定：拿本会话最近 1200 字用户发言切词，跟条目的正文 + 标签比分数（标签权重 ×2），`relevanceTopK` 条以内。上一轮选中、这一轮没被提到的会保留一轮（`relevanceSticky`）——否则一句「好的」就能让上下文抖掉。全都没命中时还有 `relevanceKeepRecent` 兜底；会话还没开口（新会话第一步）时仍然是全量注入，宁可吵不可哑。

被筛掉的冷记忆不会消失：段尾会写 `…(+N cold not loaded; memory_recall finds them)`，模型知道「库里有、这次没加载」，需要时会用 `memory_recall` 取回来。旧库升级时缺失 `tier` 的条目按 **hot** 读入（升级不该悄悄让已有记忆变冷），只有 `memory_save` 默认写 cold——要不要常驻，是模型按内容判断的事。

---

## 记忆文件

`$DSH_HOME/memory-share/memories.json`（默认 `~/.dsh/memory-share/memories.json`）：

```json
{
  "version": 1,
  "updatedAt": "2026-11-01T07:00:00.000Z",
  "entries": [
    {
      "id": "mxiukg60478",
      "text": "回答用中文，代码与注释用英文。",
      "scope": "user",
      "key": "",
      "fingerprint": "回答用中文，代码与注释用英文。",
      "tags": ["language"],
      "tier": "hot",
      "createdAt": 1793520000000,
      "updatedAt": 1793520000000,
      "source": { "sessionId": "abc", "cwd": "C:\\work\\alpha" }
    }
  ]
}
```

- `key`：`user` 恒为空；`workspace` 是归一化后的目录路径；`session` 是会话 id。
- `fingerprint`：正文归一化后的小写形式，用来去重。
- `tier`（可选）：`hot` / `cold`；缺失按 `hot` 处理（兼容旧库）。
- `ttlDays`（可选）：到期后不再注入，但条目还在，可用 `memory_recall` 找回；过期超过 30 天后会被真正删除（宽限期是给 recall 留的，不是永久保留）。

单条正文超过 `entryChars` 时，截断处会留下 `…(+Nc)` 标记——`N` 是被省略的字符数。**不要把这个标记当成正文的一部分**：模型看到它就知道「这条还有尾巴，值得 recall 一次」。

写入是「临时文件 + rename」的原子替换，读的是 mtime 缓存，所以多个 DSH 进程同时开一个库也不会互相咬坏。

---

## 设计取舍

**1. 为什么放系统提示词，而不是 `agent/pre-step` 追加消息？**
`pre-step` 每步追加会**累积**在历史里（时间上下文插件就是这样，它本来就需要流水账）。记忆是低频变化的稳定事实，放系统提示词只占一份，且位置固定、可预期。代价是记忆变化时会重写系统节点——但变化本来就少，且段序在 100（靠前但不在最前），前缀复用损失可控。

**2. 为什么 order = 100？**
官方段位表：`HARNESS_IDENTITY -1000`、`DEPLOYMENT_PERSONA_PREFIX 0`、工具指引 `1000+`、`DELIVERABLE_FILE_REFERENCES 9000`、`HARNESS_SOURCE 10000`。放在 100 意味着「你是谁」之后、「你能做什么」之前 —— 模型先读到用户上下文，再读工具说明。

**3. 为什么不用 `ctx.storageDomain`？**
它是给宿主侧结构化记录用的，能力没问题，但会把数据藏在某个后端的私有格式里。记忆这种东西**必须能被用户直接打开看、直接改、直接备份**，一个可读 JSON 比抽象 KV 合适。代价是自己做原子写（见 `lib/store.js`，有测试兜底）。

**4. 为什么不做「自动抽取」？**
自动抽取要么再调一次模型（贵、慢、必然产生幻觉记忆），要么用正则猜（几乎一定猜错）。v0.1 选择：**靠系统提示词里那句指引，让模型在合适的时机自己调 `memory_save`**。这已经是「被动记忆」了——它不需要用户说「记住」。

**5. 为什么冷热只分两档，而不是标签 / 权重 / 自动摘要？**
两档表达的是**确定性**：`hot` 是「我知道它永远该在」，`cold` 是「它该在时自会出现」。标签体系要人维护、权重调参要凭感觉，而模型只需判断一次「这是不是常驻事实」，判断错了还能 `memory_update` 改档。自动摘要看着更省，实际是让模型对压缩产物二次推理——丢掉的恰好是细节，而细节正是 cold 记忆存在的理由。副作用也要认：冷记忆偶尔会有「该在却不在」的漏网（话题词没命中），所以段尾必须留那句 `cold not loaded`，把兜底交给 `memory_recall`。

---

## 已知限制

- **子代理也会看到记忆**。插件挂在全局，subagent 的系统提示词里同样有这一段。预算固定，成本可控，但语义上它们并不都需要。
- **没有搜索和手工新建**。设置页可以看/改/删，但没有搜索框，也不能凭空新建一条（写记忆要带作用域和来源，属于工具面的职责）。
- **检索是关键词，不是语义**。`memory_recall` 做的是大小写不敏感的子串匹配，中文按整词命中。好处是零依赖、行为可预测；坏处是同义改述搜不到。
- **单机单用户假设**。DSH 是本地 harness，所以「全局」= 这台机器上的所有会话。没有多租户隔离。
- **记忆会污染**。模型可能存进不该存的东西（临时结论、错误推断、文档里已经写过的内容）。对策是三件套：`memory_save` 在近重复时返回 `similar` 逼你合并、`memory_update` 能改写而不是只能追加、`--audit` 定期看谁在吃预算。但**没有自动清理**——预算是一个人（模型或你）要主动维持的。

---

## 给写客户端插件的人

这一节是踩出来的，不是读文档读出来的：DSH 的客户端插件 API 没有公开文档，以下四条全部来自「跑起来才发现」。

### 一个能跑的客户端插件由四块组成

| 块 | 内容 |
|---|---|
| `package.json` | `dsh.client = { platform: 'web', inject: [...], external: [...] }`，`inject` 列出的包要同时出现在 `external` |
| `src/client.jsx` | **CJS 入口**（`const React = require('react')`），不是 ESM |
| `tools/build.mjs` | esbuild 打 `format: 'cjs'` + `platform: 'browser'`，再包一层 `window.__ModuleLoader__.load({id, factory})` |
| 注册 | `ctx.slots.inject(slotName, () => ctx.slots.register({...}, render))`，返回的 disposer 要在 `apply` 的返回值里释放 |

`inject` 里声明的是**服务**，不是包名依赖：用到 `ctx.slots` 就得注入 `slots`，用到 `ctx.remote` 就得注入 `remote`。

### 坑 1：远程方法名不能撞保留成员

```
client api: method "memoryShare/remove" conflicts with its namespace service
```

`@deepseek-ai/dsh-api-gateway` 挂载远程方法时会检查名字是否撞上 `RemoteNamespaceService` 的原型成员和 `REMOTE_NAMESPACE_FIELDS`（`ctx` / `empty` / `invokeRemote` 等）。`remove` 就在里面。

**对策**：描述符里的 `method` 别用 `remove`、`get`、`set`、`list` 这类通用动词的裸名——本项目把删除叫 `forget`。撞了的话报错发生在 `$mount` 时，且只报第一个撞的，改完再跑可能撞第二个。

### 坑 2：`$mount` 只能成功一次

```
client api: direct method memoryShare/list is already mounted
```

同一页面里只要有两个 bundle 实例（旧版本残留、StrictMode 双执行、热重载），第二次 `$mount` 就抛这个。

**对策**：把挂载做成幂等——捕获 `already mounted` 视为成功，继续用命名空间；真正的挂载失败才向上抛。

### 坑 3：`ctx.remote.<namespace>` 不能裸取

```
cannot get property "remote.memoryShare" without inject
```

命名空间服务是**独立注册的服务**，访问必须声明注入。正确写法是先 `$mount`，再：

```js
ctx.inject([`remote.${NAMESPACE}`], (scope) => {
  const service = scope.remote[NAMESPACE]   // 只有在这个 scope 里才拿得到
})
```

`inject` 会在命名空间出现时回调，所以「先挂载、再 inject」的顺序不能反——反过来会永远等不到。

### 坑 4：部署时 `lib/client.js` 会被进程占用

`Copy-Item` 覆盖会报「文件正由另一进程使用」。**对策**：先复制成 `client.next.js`，再用 `Move-Item -Force` 原子替换。

### 最小调用骨架

```js
let servicePromise
function ensureService(ctx) {
  if (servicePromise === undefined) {
    servicePromise = (async () => {
      try { await ctx.remote.$mount(TYPERT_REMOTE) }
      catch (e) { if (!String(e?.message).includes('already mounted')) throw e }
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('命名空间未出现')), 8000)
        ctx.inject([`remote.${NAMESPACE}`], (scope) => {
          clearTimeout(timer)
          resolve(scope.remote[NAMESPACE])
        })
      })
    })().catch((e) => { servicePromise = undefined; throw e })
  }
  return servicePromise
}
```

---

## 状态检查

```sh
dsh-plugin-memory-share            # 人读
dsh-plugin-memory-share --json     # 给脚本用
dsh-plugin-memory-share --audit    # 记忆成本审计：谁在吃预算、哪些该合并、哪些已过期
dsh-plugin-memory-share --audit --json
```

默认输出磁盘版本、**运行中版本**（插件启动时写的 `runtime.json`）、条目数与作用域分布。两边版本不一致时退出码为 1——用来回答「我装的和跑的是不是同一个版本」。

`--audit` 是只读的记账，不写库、也不因为版本不一致而报错（审计是「该收拾了」，不是故障）。它回答三个问题：

```
条目          8 条 · 1.1 KiB · 约 614 token
预算          1800 字注入上限
常驻成本        713 字实际注入（热记忆 + 指引），占预算 40%
满载上限        冷记忆全命中时 1624 字，占预算 90%
条目覆盖        8 条全部注入，无省略（正文 1136 字，其余是指引与 id 前缀）
冷热          热 3 条/365 字 恒常注入 · 冷 5 条/771 字 按话题加载
作用域         user 7 条/1031 字   workspace 1 条/105 字   session 0 条/0 字

按正文成本排序（正文字符 / 估算 token / 更新于 / 作用域·冷热 / id）
    228c    90t     0d  user       cold  mkjgm2ibdce  鲸鱼娘桌宠在 C:\Users\11625\whale-girl-desktop（Electron）：主进程
```

三行数字的分工：**常驻成本**是每个会话都要付的底价（热记忆 + 指引，砍不掉）；**满载上限**是话题全命中时的最坏情况（冷记忆全进来）；**条目覆盖**点名谁被预算挤掉了。三者都**按真实渲染算，不是正文加总**——注入块还带用法指引、`[作用域·冷热] id` 前缀，条目超长还会被截断，这堆开销在旧版审计里是看不见的（实测正文 1136 字时满载已 90%，旧版只报一条 72%）。只要出现「N 条被省略」，那些记忆就只在模型主动 `memory_recall` 时才出现，等于「存了但没用」，该用 `memory_update` 合并、或把文档里已有的内容改成一句指针。`冷热` 那行不想要常驻成本太高就直接改档：**hot 越少，冷启动越便宜**。`--json` 输出同一份数据（`entries` / `budget` / `residentChars` / `renderedChars` / `shown` / `dropped` / `tiers` / `similarPairs` / `expired`），方便接进自己的脚本。

## 开发

```bash
node tools/build.mjs              # src/client.jsx → lib/client.js（改客户端后必跑）
node tools/host-test.mjs          # 31 个用例：注入、冷热、作用域、去重、合并、预算、TTL、清理、转义、并发、坏文件恢复…
node tools/cordis-mount-test.mjs  # 用真实 cordis 挂载一次，验证 inject / effect / 注销
node tools/demo.mjs               # 打印一段真实渲染结果，肉眼看效果与 token 成本
node tools/audit.mjs              # 等价于 bin/status.mjs --audit，改报告排版时用
```

`host-test` 用一个最小 fake host（`{ systemPrompt, tools, effect, on }`）挂载插件，和真实加载器走同一条 `apply()` 路径；`cordis-mount-test` 则直接从 DSH 安装目录加载 `@deepseek-ai/cordis`，验证服务注入、`ctx.effect` 注册与 `ctx.registry.delete()` 注销后段和工具都被撤掉（找不到 cordis 时自动 SKIP，保持可移植）。

```
lib/store.js         存储：原子写、去重、作用域、TTL、过期清理、合并
lib/text.js          切词 / Jaccard / token 估算（纯函数，三处共用）
lib/render.js        渲染：排序、预算裁剪、标签转义（纯函数）
lib/audit.js         成本审计报告（纯读，CLI 与 tools/audit.mjs 共用）
lib/index.js         宿主入口：提示词段 + 四个工具 + ctx.memoryShare 服务
lib/remote.js        远程契约：zod schema + typert 描述符（宿主与客户端共用）
lib/typert.host.js   反射清单，由 DSH 的 typert 加载器校验
src/client.jsx       设置页源码（CJS，构建前）
lib/client.js        构建产物（由 tools/build.mjs 生成，一并提交）
tools/               构建、测试与演示
```

MIT License.
