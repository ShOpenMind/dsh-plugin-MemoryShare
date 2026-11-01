# macOS 安装说明 · dsh-plugin-MemoryShare

> 作者:**ShOpenMind** · 仓库:<https://github.com/ShOpenMind/dsh-plugin-MemoryShare> · MIT License
>
> 纯 JavaScript 实现(无原生依赖),**Windows / macOS / Linux 通用**。包里的 `lib/client.js` 已经构建好,**不需要你在 Mac 上跑构建**。

装上之后,agent 会跨会话记住你的偏好——你不用每次重新解释自己是谁。

---

## 一、准备:Node.js 与 DeepSeek Harness

1. 安装 **Node.js 22+**:官网 <https://nodejs.org> 下载 LTS 的 macOS 安装包,Apple 芯片选 **Apple Silicon**,老 Intel 选 **Intel**;或 `brew install node`。
   验证:终端输入 `node -v`,显示 `v22.x` 或更高。

2. 启动 DSH(两种方式任选):

   ```sh
   npx @deepseek-ai/dsh web
   ```

   首次会下载依赖,完成后浏览器打开 <http://127.0.0.1:3080>。

   > **用桌面版 App**(`/Applications/DeepSeek Harness.app`)的话跳过这步,直接打开 App。
   > 下文的「重启」对桌面版 = **完全退出(`Command + Q`)再打开**。

---

## 二、安装插件(三选一)

### 方式 1:填地址一步装好(推荐)

打开 DSH → 左侧「**插件**」→「**添加插件**」,粘贴:

```
https://github.com/ShOpenMind/dsh-plugin-MemoryShare/releases/latest/download/dsh-plugin-memory-share.tgz
```

点「安装」,再到插件列表里把 **dsh-plugin-memory-share** 启用,然后 **重启一次 DSH**。

### 方式 2:本地 tarball

把 `dsh-plugin-memory-share-0.2.0.tgz` 放到 `~/Downloads`,然后:

```sh
dsh plugin --profile desktop add "file:$HOME/Downloads/dsh-plugin-memory-share-0.2.0.tgz"
```

（`desktop` 换成你实际的 profile 名;没有 `dsh` 命令就用方式 1 或 3。）

### 方式 3:从源码装(要改代码时)

```sh
git clone https://github.com/ShOpenMind/dsh-plugin-MemoryShare.git
cd dsh-plugin-MemoryShare
npm install          # 只有这一步需要联网
npm run build        # 重新生成 lib/client.js
dsh plugin --profile desktop add "file:$PWD"
```

---

## 三、确认装好了

1. **重启 DSH**(桌面版 `Command + Q` 再打开;终端版 `Control + C` 后重新 `npx @deepseek-ai/dsh web`)。
2. 打开 **设置 → 内置插件**,顶部应该多出一个 **「记忆」** 标签页。
3. 里面会显示:条数、各作用域计数、你的记忆列表。

第一次装是空的,显示「还没有任何记忆」。

---

## 四、开始用

记忆**不需要你操作界面**。正常聊天即可:

| 你说 | 发生什么 |
|---|---|
| 「记住:回答用中文」 | agent 调 `memory_save`,存为全局记忆 |
| 「记住,这个项目用 pnpm」 | 存为工作区记忆,只在那个目录生效 |
| 「你记得我喜欢什么吗」 | agent 从系统提示词里直接读出来 |

想管理:设置 → 内置插件 → 记忆,可以**编辑**正文、**删除**(点两次确认)。

数据在 `~/.dsh/memory-share/memories.json`,纯 JSON,想备份直接拷这个文件。

---

## 五、常见问题

**设置里没有「记忆」标签页**
多半是没重启,或插件没启用。检查 `~/.dsh/profiles/<profile>/package.json`:
`dependencies` 里有 `dsh-plugin-memory-share`,`dsh.profile.bundles` 里也有它。

**想临时关掉**
在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 加:

```yaml
- id: memory-share
  disabled: true
```

**觉得 token 花得多**
默认配置每步多约 600 token（大部分可被缓存）。要更省:

```yaml
- id: memory-share
  config:
    maxChars: 600      # 默认 1600
    guidance: false    # 去掉用法指引
```

**记忆写错了**
直接在设置页里改;或编辑 `memories.json`(30 秒内自动热加载)。

---

## 六、卸载

```sh
dsh plugin --profile desktop remove dsh-plugin-memory-share
```

或改 `cordis.patch.yml` 加 `disabled: true` 临时停用。记忆文件不会自动删除,要清就 `rm -rf ~/.dsh/memory-share`。

---

MIT License · <https://github.com/ShOpenMind/dsh-plugin-MemoryShare>
