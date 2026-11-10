# One Pack · DSH 环境一键搬家

> 一个插件，把已装插件 / DSH 设置 / 插件设置 / 技能 / 会话 / 工作区文件打包同步到 GitHub。
> 换机器、换 profile、重装 DSH 之后，装好 One Pack、配一次仓库和 token，点 Pull 就还原。

- 宿主半边：`index.js` + `lib/`（只依赖 Node 内置模块）
- Web 半边：`client.js`（侧栏入口 + 主面板）
- 数据目录：`$DSH_HOME/one-pack/`
- 远端仓库：一个 GitHub 仓库（建议 **private**），一个原子 commit 一次同步

## 功能

| 分区 | 默认 | 同步什么 | 怎么还原 |
| --- | --- | --- | --- |
| 已装插件 `plugins` | 开 | 已安装 bundle 的安装规格、版本、启停状态；已挂载条目的启停 | `pluginManager.installBundle()` / `setBundleEnabled()` / `setPluginEnabled()` |
| 设置 `settings` | 开 | `configEditor` 里每个条目的**显式用户覆盖**（DSH 设置 + 插件设置都在这里），敏感字段自动脱敏 | 按条目 id `configEditor.edit()` |
| 技能 `skills` | 关 | `$DSH_HOME/skills/**` | 备份后覆盖写，不删除本地多余技能 |
| 会话 `sessions` | 关 | `session.v4.jsonl.zstd` + 被引用附件 + 工作区注册信息 | 改 header.cwd → 落盘 → 注册 workspace，body 前缀比较、分叉另存 |
| 工作区文件 `files` | 关 | 你显式登记的目录 | 还原到原 cwd，冲突另存 `.remote-<时间戳><扩展名>` |

所有分区都能单独开关，也可以在一次同步里只选部分分区（工具参数 `sections`）。

## 安装

### 本地开发安装（当前）

```bash
# 在 DSH 里用 plugin_manager 安装本地 bundle（绝对路径）
# 或让 agent 执行：plugin_manager install_bundle("<仓库绝对路径>")
```

安装后在「插件」页启用 One Pack，侧栏会出现 One Pack 图标。

### 从 npm 安装（发布后）

```bash
dsh plugin --profile desktop add dsh-one-pack
```

也可以在 DSH 里让 agent 调用 `plugin_manager install_bundle("dsh-one-pack")`（等价；`--profile` 换成你要安装的 profile）。

## 使用

1. 侧栏打开 **One Pack**。
2. 点 GitHub Token 旁的 **生成 Token ↗** 直达 GitHub 生成页：classic token 勾选 `repo`；fine-grained token 至少给目标仓库 `Contents: Read and write`，要自动建仓再加 `Administration: Read and write`。保存 token。
3. 保存 token 后如果还没配置仓库，面板会**自动**在该账号下创建私有同步仓库 `dsh-one-pack-sync` 并填好仓库地址；已有同名仓库则直接复用。也可以点「自动创建私有仓库」手动触发，或改成自己的 `owner/repo`。
4. 打开要同步的分区（默认是插件 + 设置）。
5. 点 **Push** → 看预览摘要 → 确认执行。
6. 到新机器：装 One Pack、保存 token（同样会自动建仓/复用仓库）→ 点 **Pull** → 确认。

也可以用 agent 工具：

```
one_pack_status
one_pack_sync { direction: "push", phase: "preview" }
one_pack_sync { direction: "push", phase: "execute", previewToken: "..." }
one_pack_setup  { token: "github_pat_...", createRepo: true }
one_pack_setup  { repo: "me/dsh-pack", branch: "main" }
```

> Push / Pull 都是两段式：preview 只读并返回 10 分钟有效的 token，execute 必须带同一 token；
> Pull 落地前会把将被覆盖的数据备份到 `$DSH_HOME/one-pack/backups/<时间戳>/`。

## 远端仓库结构

```
one-pack.json          # 清单：设备、时间、各分区摘要、文件 sha256
README.md              # 自动生成的可读概览
plugins/bundles.json
settings/config.json
skills/_index.json  skills/<rel>
sessions/_index.json  sessions/<project>/<sessionId>.jsonl.zstd  sessions/attachments/<sha>.<ext>
files/_index.json     files/<projectKey>/<rel>
```

跨机还原时，项目目录靠 `sessions/_index.json` 里的 `originalCwd` 映射：本机有同路径就用同路径，
没有就落到第一个可用工作区（并在结果里给出 warning）。会话文件只改头帧里的 cwd，正文字节原样保留，
所以已有的会话日志链不会被破坏。

## 安全

- token 只进 DSH credentials（`ONE_PACK_GITHUB_TOKEN`），**永不写入仓库、永不返回给 Web 界面**。
- 自动建仓只会在当前没有配置仓库（或你显式点按钮）时触发；同名私有仓库已存在时直接复用，**不会覆盖已有仓库**。
- `settings` 导出时递归脱敏字段名匹配 `api_key / token / secret / password / credential / private_key / authorization / cookie` 的值（写成 `***`，pull 时不写回）。
- `skills` / `files` 内置硬排除：`.env*`、`*.key/*.pem/*.pfx/*.p12`、`id_rsa`、`.npmrc`、`.netrc` 等；
  另有默认排除 `node_modules/.git/.idea/.vscode/__pycache__/*.log/*.tmp/*.bak`。
- 文件同步有体积上限（单文件 10MB、单次 50MB/800 文件），超限跳过并 warning。

## 开发

```bash
node --check index.js
node --test test/*.test.mjs
```

- `lib/orchestrator.mjs`：preview/execute 编排、根清单、删除远端陈旧文件
- `lib/cloud.mjs`：GitHub Git Data / Contents API 封装（一次同步 = 一个 commit）
- `lib/sections/*.mjs`：四个轻量分区
- `lib/sessions.mjs` + `lib/vendor/*`：zstd 多帧会话/附件（vendored 自 dsh-github-sync，MIT，见 NOTICE）

## 许可

MIT。vendored 部分版权归 dsh-github-sync 作者，见 [NOTICE](./NOTICE)。