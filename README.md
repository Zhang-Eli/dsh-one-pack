# One Pack

[![npm version](https://img.shields.io/npm/v/dsh-one-pack?color=blue)](https://www.npmjs.com/package/dsh-one-pack)
[![license](https://img.shields.io/npm/l/dsh-one-pack)](./LICENSE)
[![node](https://img.shields.io/node/v/dsh-one-pack)](https://nodejs.org)
[![GitHub release](https://img.shields.io/github/v/release/Zhang-Eli/dsh-one-pack)](https://github.com/Zhang-Eli/dsh-one-pack/releases)

**把整个 DSH 环境打包到一个私有 GitHub 仓库，换机器、换 profile、重装 DSH 之后一键还原。**

One Pack is a DSH plugin that syncs an entire DSH environment — installed bundles, DSH & plugin
settings, skills, sessions and explicitly registered workspace folders — through a private GitHub
repository. Fill in one token, and the repository is created for you.

![One Pack 面板](https://raw.githubusercontent.com/Zhang-Eli/dsh-one-pack/main/docs/panel.png)

---

## 为什么需要它

装好 DSH 之后，真正花时间的从来不是装 DSH 本身，而是：把插件一个个装回来、重新调设置、
找回 skills、把会话和工作区接回来。One Pack 把这些变成一个可重复的动作：

- **一次填 token**：保存后自动创建（或复用）私有仓库 `dsh-one-pack-sync`，不用手填 owner/repo；
- **Push 前先看计划**：两段式预览，列出将新增/更新/跳过的内容，确认后才真正写入；
- **Pull 前先备份**：被覆盖的数据先落到 `$DSH_HOME/one-pack/backups/<时间戳>/`；
- **同步在后台跑**：确认后立即返回，界面不阻塞，完成后用通知汇报结果；
- **会话真正回到工作区**：不只是把文件拉下来，还会自动挂载到对应 workspace（已存在但未挂载的会话也会补挂）；
- **可选定时推送**：默认每天 18:00 自动 Push 一次，时间可调。

## 安装

要求：Node.js >= 22，DSH >= `0.2.1-rc.5`。

### 从 npm 安装（推荐）

```bash
dsh plugin --profile desktop add dsh-one-pack
```

或者在 DSH 里让 agent 安装：

```
plugin_manager install_bundle("dsh-one-pack")
```

把 `--profile desktop` 换成你实际使用的 profile 名。安装后侧栏出现 One Pack 图标。

### 本地开发安装

```bash
git clone https://github.com/Zhang-Eli/dsh-one-pack.git
# 然后在 DSH 里执行（替换成仓库的绝对路径）：
plugin_manager install_bundle("D:/path/to/dsh-one-pack")
```

One Pack 自身通过 `link:` 安装时不会把自己的安装状态写进远端仓库——它只同步可以在别的机器上复现的
npm / git 安装，避免新机器拉取到一个指向不存在本地目录的链接包。

## 快速开始

1. 侧栏打开 **One Pack**。
2. 点 **生成 Token ↗**，GitHub 会打开 classic token 创建页（已预填 `repo` 权限），点 **Generate token**，
   把 token 粘回面板保存。
3. 保存后自动创建私有仓库并显示 `已连接 <你的账号>/dsh-one-pack-sync`。
4. 在新机器上重复第 1–3 步（同一个账号、同名仓库会自动复用），然后点 **Pull**。

> 想换一个仓库？可以用 `one_pack_setup { repo: "owner/repo" }` 工具，或直接改
> `$DSH_HOME/one-pack/state.json` 的 `repo` 字段（改完刷新面板）。自动建仓只会写入默认仓库名，
> 不会覆盖已有仓库。

## 面板说明

| 区域 | 能做什么 |
| --- | --- |
| 连接 | 显示连接状态与仓库；保存/更换/移除 token；移除后立即断开，不会再误发请求 |
| 同步 | **推送** / **拉取** 两个按钮；上次同步时间与 commit；同步中的错误和重试入口 |
| 同步分区 | 分区开关（插件 / 设置 / 技能 / 会话；工作区文件暂时隐藏），默认开启「插件 + 设置」 |
| 定时推送 | 开关 + 时间选择；只在 DSH 运行时生效，无变更不会产生提交 |
| 最近历史 | 最近 10 次同步：方向、成功/失败、commit、涉及分区；告警可点开查看原文 |

**后台执行**：确认 Push/Pull 后任务在 Host 侧继续执行，右上角显示「推送中… / 拉取中…」。
可以切到别的页面，回来时提示会自动恢复并继续轮询；完成后再写历史记录并弹 toast。

**重启提醒**：如果 Pull 的内容需要重启才完全生效（例如插件更新、插件启停变化），会弹窗询问
「立即重启 / 好的」。立即重启 = 重新加载 Web 页面；若仍有插件没生效，从应用菜单重启一次 DSH。

## 同步分区

| 分区 | 默认 | 同步内容 | 落地方式 |
| --- | --- | --- | --- |
| `plugins` 插件 | 开 | 已安装 bundle 的安装规格、版本、启停状态；已挂载条目的启停 | `installBundle()` / `setBundleEnabled()` / `setPluginEnabled()` |
| `settings` 设置 | 开 | `configEditor` 中每个条目的**显式用户覆盖**（DSH 设置与插件设置都在这里）；敏感值脱敏 | 按条目 id `configEditor.edit()` |
| `skills` 技能 | 关 | `$DSH_HOME/skills/**` | 备份后覆盖写，不删除本地多余技能 |
| `sessions` 会话 | 关 | `session.v4.jsonl.zstd` + 被引用附件 + 工作区注册信息；**跳过已归档会话** | 改 header.cwd → 落盘 → 自动挂载工作区；body 前缀比较，分叉另存 |
| `files` 工作区文件 | 关 | 你显式登记的目录（当前面板隐藏，host 实现保留） | 还原到原 cwd，冲突另存 `.remote-<时间戳><扩展名>` |

- 每个分区独立开关；工具调用还可以用 `sections` 只同步其中一部分。
- `files` 分区目前在面板中隐藏（功能代码保留），可通过 `POST /one-pack/api/state` 的 `files` 字段登记目录，
  后续版本会按新的交互方式重新开放。
- 不是 npm 包、且无法在别的机器复现的 bundle（`link:` / `file:` / `workspace:` 安装，以及 One Pack 自身）
  不会导出；Pull 时也会跳过，只给一条 warning 说明。

## 同步机制

- **两段式**：`preview` 只读，计算计划并返回 10 分钟有效的一次性 `previewToken`；`execute` 必须带同一个
  token，Host 会重新计算后落地。关闭预览对话框会丢弃该计划，不留下「待执行」状态。
- **一个同步 = 一个 commit**：内容按 sha256 去重，没有变化时不会产生空提交，并返回 `NOTHING_TO_SYNC`。
- **原子写入与备份**：Pull 前把将被覆盖的 state / settings / plugins 备份到
  `$DSH_HOME/one-pack/backups/<时间戳>/`；单文件、单分区写入都是先写临时文件再 rename。
- **后台任务**：`POST /one-pack/api/sync/start` 返回 job；`GET /one-pack/api/sync/job?id=<jobId>` 轮询。
- **定时推送**：Host 每 30 秒检查一次，当天该时间点已执行过则不重复；过点后首次启动会补跑一次；
  失败原因写入 state 并显示在面板。

## Agent 工具与 HTTP API

在 DSH 会话里可以直接用这些工具：

```
one_pack_status
one_pack_setup  { token: "ghp_...", createRepo: true }
one_pack_setup  { repo: "me/dsh-pack", branch: "main", sections: { skills: true } }
one_pack_sync   { direction: "push", phase: "preview" }
one_pack_sync   { direction: "push", phase: "execute", previewToken: "..." }
```

对应的 HTTP 接口（面板使用，Host 本地鉴权）：

```
GET    /one-pack/api/status
GET    /one-pack/api/sections
GET    /one-pack/api/history?limit=10
POST   /one-pack/api/state
POST   /one-pack/api/token         DELETE /one-pack/api/token
POST   /one-pack/api/repo/auto
POST   /one-pack/api/schedule
POST   /one-pack/api/sync          # preview
POST   /one-pack/api/sync/start    # 后台 execute
GET    /one-pack/api/sync/job?id=
POST   /one-pack/api/restart
```

## 远端仓库结构

```
one-pack.json                 # 清单：设备、更新时间、各分区摘要、文件 sha256 表
README.md                     # 自动生成的可读概览
plugins/bundles.json
settings/config.json
skills/_index.json  skills/<rel>
sessions/_index.json  sessions/<project>/<sessionId>.jsonl.zstd  sessions/attachments/<sha>.<ext>
files/_index.json     files/<projectKey>/<rel>
```

跨机还原时，会话目录靠 `sessions/_index.json` 的 `originalCwd` 映射：本机有同路径就用同路径，
没有就落到第一个可用工作区并给出 warning。会话文件只改头帧里的 `cwd`，正文字节原样保留，
因此已有的 append-only 会话日志链不会被破坏。

## 安全

- **token 只存 Host**：写入 DSH credentials（`ONE_PACK_GITHUB_TOKEN`），永不写入仓库、永不返回给 Web 界面；
  面板只能看到「已保存 / 未保存」。移除 token 会同时清理所有兼容引用，随后立即断开连接。
- **自动建仓不覆盖**：只在当前没有配置仓库时触发；同名私有仓库存在就复用，不会动已有仓库。
- **设置脱敏**：导出 `settings` 时递归匹配 `api_key / token / secret / password / credential / private_key /
  authorization / cookie` 等字段名，值写成 `***`；Pull 时这些字段保留本机值，不写回远端占位符。
- **硬排除**：`.env*`、`*.key/*.pem/*.pfx/*.p12/*.kdbx`、`id_rsa/id_ed25519`、`.npmrc`、`.netrc` 等；
  另有默认排除 `node_modules/.git/.idea/.vscode/__pycache__/*.log/*.tmp/*.bak`。
- **体积上限**：单文件 10MB、单次 50MB / 2000 文件、深度 12；超限跳过并 warning。附件单文件上限 25MB。

## 常见问题

**Token 需要什么权限？**
classic token 勾选 `repo`（自动创建私有仓库也需要它）。One Pack 的「生成 Token ↗」已经预填好。

**为什么我的某个插件没有被同步？**
它是 `link:` / `file:` / `workspace:` 安装的本地目录插件，别的机器装不回来，One Pack 会主动跳过并提示。
发布到 npm / git 安装后再同步，或把源码放到 git 里各机器分别安装。

**点了 Push 没看到历史记录？**
历史在同步真正完成后才写入；右上角「推送中…」表示还在跑。完成后会自动出现在最近历史里。

**为什么需要重启？**
插件安装/更新、插件启停这类变更要等插件重新加载；Pull 结果发现这类变更时会提示重启。

**会同步密钥吗？**
不会。设置中的敏感字段脱敏，skills/files 有密钥文件硬排除，token 永远不会进仓库。

## 开发

```bash
git clone https://github.com/Zhang-Eli/dsh-one-pack.git
cd dsh-one-pack
node --check index.js client.js
node --test test/*.test.mjs     # 55 个用例，含跨机 push/pull 集成测试（全离线）
```

目录：

| 路径 | 作用 |
| --- | --- |
| `index.js` | Host 半边：HTTP 路由、工具、定时器、服务接线 |
| `client.js` | Web 半边：侧栏入口与主面板（React，`window.__ModuleLoader__`） |
| `lib/orchestrator.mjs` | preview/execute 编排、后台任务、根清单、远端清理 |
| `lib/cloud.mjs` | GitHub Git Data / Contents API（一次同步 = 一个 commit）、自动建仓 |
| `lib/sections/*.mjs` | plugins / settings / skills / files 四个分区 |
| `lib/sessions.mjs` | 会话分区：多帧 zstd、cwd 重写、工作区挂载、归档过滤 |
| `lib/vendor/*` | 会话/附件/GitHub 底层实现（vendored 自 dsh-github-sync，MIT，见 [NOTICE](./NOTICE)） |

## 许可

[MIT](./LICENSE)。`lib/vendor/` 部分版权归 dsh-github-sync 作者所有，详见 [NOTICE](./NOTICE)。

---

- 反馈问题：[GitHub Issues](https://github.com/Zhang-Eli/dsh-one-pack/issues)
- 更新记录：[CHANGELOG.md](./CHANGELOG.md)

Developed by [Zhang-Eli](https://github.com/Zhang-Eli)