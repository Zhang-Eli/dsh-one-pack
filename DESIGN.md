# One Pack — 设计契约（实现必须遵守）

One Pack 是一个 DSH host + web client 插件：把一个 DSH 环境里**可迁移**的东西打包同步到 GitHub 仓库，
在另一台机器/另一个 profile 上一键还原。包名 `dsh-one-pack`，插件条目 id `one-pack`，路由前缀 `/one-pack`，
状态目录 `$DSH_HOME/one-pack`。

只允许 Node 内置模块（`node:fs` `node:path` `node:os` `node:crypto` `node:zlib` `node:http` `node:child_process` 不用）。
**不要** import 任何 `@deepseek-ai/*` 包，**不要**读写/改写 profile 的 `cordis.patch.yml`、`package.json`、`pnpm-lock.yaml`。
所有 host 服务一律通过 `ctx.get(name)` 可选获取，缺失时降级并给出 warning。

## 1. 同步分区（sections）

| section | 默认 | 内容 | 远程路径 | 落地方式（pull） |
|---|---|---|---|---|
| `plugins` | **on** | pluginManager.listBundles() + listPlugins()：已装 bundle 的安装规格（installTarget.spec / name@version）、启停状态；已挂载条目的 enabled | `plugins/bundles.json` | pluginManager.installBundle(spec,{enabled,saveExact:true})；setBundleEnabled / setPluginEnabled |
| `settings` | **on** | configEditor.configuration() 中每个 entry 的 `override`（只导出显式用户覆盖，不导出 inherited 默认值）；敏感字段递归脱敏 | `settings/config.json` | 按 entry.id 匹配后 configEditor.edit(entry, () => override)；缺失条目 warning |
| `skills` | off | `$DSH_HOME/skills/**` 文件树（硬排除 + 体积上限） | `skills/<rel>` + `skills/_index.json` | 覆盖写（先备份）；远端为准，不删除本地多余技能 |
| `sessions` | off | 会话文件 `session.v4.jsonl.zstd` + 被引用附件 + 工作区注册信息 | `sessions/<project>/<id>.jsonl.zstd`、`sessions/attachments/<sha>.<ext>`、`sessions/_index.json` | 改 header.cwd → 写入本地 sessions 目录 → workspaceRegistry.resolveByPath/create + attachSession；body 前缀比较，分叉另存 fork |
| `files` | off | 用户显式登记的目录（`state.files.paths`）内的文件 | `files/<projectKey>/<rel>` + `files/_index.json` | 还原到原 cwd（不存在则用映射目录），冲突另存 `.remote-<stamp><ext>`；硬排除 + 体积上限 |

`$DSH_HOME` = `process.env.DSH_HOME || path.join(os.homedir(), '.dsh')`。
`projectKey(cwd)`：`/ \ :` 连续段折叠为 `-`，非 `[A-Za-z0-9._-]` 码元转 `~XXXX`（4 位大写 hex），两端加 `--`，截断 251（见 `lib/vendor/projectkey.mjs`）。

## 2. 密钥与状态

- GitHub token：credentials 服务，ref `ONE_PACK_GITHUB_TOKEN`，读不到时回退 `GITHUB_TOKEN`。
  **token 绝不下发给 web client**，接口只返回 `hasToken: boolean`。
- `$DSH_HOME/one-pack/state.json`：
  ```json
  {"schema":1,"device":{"id":"uuid","name":"hostname","platform":"win32"},
   "repo":"owner/repo","branch":"main",
   "sections":{"plugins":true,"settings":true,"skills":false,"sessions":false,"files":false},
   "files":{"paths":[],"patterns":[]},
   "lastSync":{"at":"ISO","commitSha":"...","direction":"push|pull"}|null,
   "remote":{"commitSha":"...","at":"ISO"}|null}
  ```
- `$DSH_HOME/one-pack/history.jsonl`：每次 execute 追加一行 `{at,direction,sections,ok,commitSha,summary,warnings,error}`。
- `$DSH_HOME/one-pack/backups/<yyyyMMddHHmmss>/…`：pull 覆盖前的备份（settings/config.json、被覆盖的 skills/sessions/files 文件、plugins 列表快照）。

## 3. 远端仓库布局

```
one-pack.json                 # 根清单：schema,updatedAt,device,sections 摘要,counts
README.md                     # 自动生成（人类可读概览）
plugins/bundles.json
settings/config.json
skills/_index.json
skills/<rel>
sessions/_index.json
sessions/<project>/<sessionId>.jsonl.zstd
sessions/attachments/<sha>.<ext>
files/_index.json
files/<projectKey>/<rel>
```

分文件格式（全部 `{schema:1, updatedAt, device:{id,name,platform}}` + 各自字段）：
- `plugins/bundles.json`: `{bundles:[{name,version,spec,enabled,saveExact}], plugins:[{id,enabled}], versionExemptions?:[]}`
- `settings/config.json`: `{entries:{<entryId>:{name, override:{...}}}, redacted:[["path","to","field"],...]}`
- `skills/_index.json`: `{files:{"<rel>":{"sha256":"...","size":123}}}`
- `sessions/_index.json`: `{projects:{"<project>":{"originalCwd":"...","title":"..."}}, sessions:{"<id>":{"project":"<project>","title":"...","bodySha":"<sha256>","bytes":123,"updatedAt":"ISO"}}, attachments:{"<sha>":{"bytes":123,"mediaType":"...","name":"...","ext":".png"}}}`
- `files/_index.json`: `{projects:{"<project>":{"originalCwd":"...","title":"..."}}, files:{"<project>/<rel>":{"sha256":"...","size":123}}}`
- `one-pack.json`: `{schema:1,updatedAt,device,sections:{plugins:{...summary},settings:{...},skills:{...},sessions:{...},files:{...}},files:{"<path>":"<sha256>"}}`
  （`files` 是本次推送全部文件的 sha256 表，orchestrator 用它做新增/变更/不变统计与 pull 跳读）

## 4. 两阶段 preview → execute

- `preview(direction, {sections, force})`：只读，计算计划与摘要，返回 `{token,direction,sections,createdAt,expiresAt,summary,warnings,items?}`；
  token 存在 host 内存 Map（10 分钟过期，一次性）。
- `execute(direction, {token})`：校验 token（方向/分区与 preview 一致），**重新计算计划**后落地；失败返回结构化 error（code/message）。
- push：exclude 未启用分区；若远端 `one-pack.json.updatedAt` 晚于本机 `state.lastSync.at` 且不是本设备 → preview 警告 `remote-ahead`（execute 时要求 `force`，否则返回 code `REMOTE_AHEAD`）。
- pull：总是先把即将覆盖的文件备份到 `backups/`；安装类操作先备份配置快照。
- 所有 commit 均为一次 `commitBatch`（一个原子提交），必要时带 base_tree。

## 5. Host 模块接口（精确）

### lib/paths.mjs（Lead 已写）
`dshHome() profileName() stateDir() statePath() historyPath() backupsDir() skillsRoot() sessionsRoot() attachmentsRoot() workspaceJsonPath()`

### lib/util.mjs（Lead 已写）
`sha256(data) ensureDir(dir) readJson(p,fallback) writeJson(p,v) stamp() nowIso() deepClone(v) redactSecrets(value) -> {value,paths} isSecretPath(segments) safeRelPath(p) -> string|null formatBytes(n)`

### lib/state.mjs（Lead 已写）
`export const SECTIONS`、`export class StateStore { read() write(s) update(fn) addHistory(e) history(limit=50) }`

### lib/cloud.mjs（owner: host-sync）
```js
export function parseRepo(input) // 'owner/repo' | URL | git@ → {owner,repo,name}; 非法抛错
export class CloudRepo {
  constructor({ token, repo, branch = 'main', userAgent })   // repo: 'owner/repo'
  async state()      // -> { empty, commitSha, treeSha, files: Map<path,{path,sha,size}> }
  async readFile(pathOrEntry, snapshot)  // -> Buffer|null   （按 blob sha 读，带缓存）
  async readText(path, snapshot)         // -> string|null
  async readJson(path, snapshot)         // -> object|null
  async commit({ writes, deletes, message, snapshot })  // writes:[{path,content:string|Buffer}]
                     // -> { commitSha, files, firstCommit }
}
```
基于 `lib/vendor/github.mjs`（从 dsh-github-sync MIT 代码改造，保留版权头 + 仓库根 NOTICE）。
自动建仓（v0.2）：`export const DEFAULT_REPO_NAME = 'dsh-one-pack-sync'`、
`export async function ensureSyncRepo({ token, name?, client? }) -> { repo, login, name, created, private }`
（`GET /user` 取 login → 查 /repos 存在则复用，不存在则 `POST /user/repos` 建私有空仓）；
GitHubClient 新增 `userInfo()` / `repoMetaOrNull(owner,name)` / `createUserRepo({name,isPrivate,description})`。

### section 适配器（owner: host-sync，除 sessions）
`lib/sections/plugins.mjs`、`settings.mjs`、`skills.mjs`、`files.mjs` 各自默认导出：
```js
export default {
  name: 'plugins',
  defaultEnabled: true,
  // ctx = { state, store, svc, warn(msg) }；svc 可能缺服务
  async export(ctx)     // -> { files:[{path,content:string|Buffer}], summary:object, warnings:string[] }
  async planPull(ctx, remote)  // remote = { snapshot, readJson, readText, readFile }；只读
                        // -> { actions:[{kind,title?,detail?}], summary, warnings, context }
  async applyPull(ctx, remote, plan) // -> { warnings, applied:{...}, restartRequired?:bool }
}
```
约定：`export()` 的 path 必须已带 section 前缀（如 `plugins/bundles.json`、`skills/xxx`），根清单由 orchestrator 统一生成。
`planPull()` 不得写本地；`applyPull()` 只落地自己分区。

### lib/sessions.mjs（owner: sessions-sync）
```js
export default {
  name: 'sessions', defaultEnabled: false,
  async export(ctx)          // 见上；扫描 ctx.state 里登记的 workspace（svc.workspaceRegistry.list()）对应 cwd 的会话
  async planPull(ctx, remote),
  async applyPull(ctx, remote, plan),
}
export { readSessionHeader, rewriteSessionCwd, sessionBody, compareSessions } from './vendor/sessionlog.mjs'
```
会话来源：`svc.workspaceRegistry.list()` 每个 workspace 的 `path` → `listSessionsForCwd(cwd)`（vendor/localsessions.mjs）。
导出时只导 `state.sessions.ids` 未指定则导全部非归档会话？—— v1：导出各 workspace 现有全部会话（标题取缓存），附件按 body 引用收集。
apply 后：`svc.workspaceRegistry.resolveByPath(header.cwd)`，无则 `create(header.cwd, title)`（目录必须存在，否则跳过该会话并 warning）再 `attachSession(sessionId)`。

### lib/orchestrator.mjs（owner: Lead）
```js
export class SyncEngine {
  constructor({ store, svc, cloudFactory?, repoCreator? })  // 后两个仅测试注入
  async status()                       // -> { state(脱敏), hasToken, repoValid, pending:boolean, lastSync }
  async autoCreateRepo({ name? })      // -> { repo, login, name, created, private }；写回 state.repo
  async preview(direction, opts)       // -> PreviewResult（含 token）
  async execute(direction, opts)       // -> ExecuteResult
}
```
`svc` = `{ pluginManager, configEditor, settings, workspaceRegistry, credentials, connection, webServer }`（可能 undefined）。

## 6. HTTP API（owner: Lead 接线，host-sync 不写路由）

前缀 `/one-pack/api`，全部先过 `svc.connection?.requestRejection(req)`（401/403 直接返回），JSON 响应
`{ok:true,result}` / `{ok:false,error:{code,message}}`。端点：
- `GET  /status` → `engine.status()`
- `POST /state` `{repo?,branch?,sections?,files?}` → 保存（不触发同步）
- `POST /token` `{token}` → `credentials.set('ONE_PACK_GITHUB_TOKEN', token)`；`DELETE /token` → unset
- `POST /repo/auto` `{name?}` → `engine.autoCreateRepo()`：用已保存 token 在所属账号下创建（或复用）私有同步仓库，写回 `state.repo`；
  错误码 `NO_TOKEN` / `INVALID_REPO_NAME` / `GITHUB_UNAUTHORIZED` / `GITHUB_FORBIDDEN` / `REPO_CREATE_FAILED`
- `POST /sync` `{direction:'push'|'pull', phase:'preview'|'execute', sections?, force?, token?}` → preview/execute 结果
- `POST /schedule` `{enabled?, time?, direction?}` → `engine.updateSchedule()`，保存每天定时推送设置（`time` 为 `HH:MM` 本地时间）；
  错误码 `INVALID_SCHEDULE`。`GET /status` 额外返回 `schedule:{enabled,time,direction,lastRunAt,lastOk,lastError}`
- `POST /sync/start` `{direction:'push'|'pull', token, force?}` → 202 `{job}`：后台执行一次 execute（消费 preview token），立即返回任务 id
- `GET  /sync/job?id=<jobId>` → `{job:{id,direction,status:'running'|'done'|'failed',startedAt,finishedAt,result,error}}`；未知 id → `JOB_NOT_FOUND`
- `POST /sync/discard` `{token?}` → 丢弃未执行的预览（不带 token 清空全部），返回 `{discarded}`
- `POST /restart` → 200 `{mode:'reload'}`：客户端收到后刷新页面（One Pack 不做进程级重启）
- `GET  /history?limit=20` → 历史
- `GET  /sections` → 分区元信息（name/defaultEnabled/已启用）

## 7. Agent 工具（Lead 接线）

- `one_pack_status`（只读）：仓库、device、分区开关、最近同步、待执行 preview。
- `one_pack_sync` `{direction, phase, sections?, force?, previewToken?}`。
- `one_pack_setup` `{repo?, token?, branch?, sections?, createRepo?}`：写配置/凭据；`createRepo=true` 时保存 token 后自动建私有仓库。

## 8. Web UI（owner: client-ui）

侧栏 `sidebar.panellist`（id `one-pack`, order 30, label 来自 locale）+ `main` 面板（key `one-pack`）。
面板（0.3.0 起）：
- 顶部 hero 卡：左列连接区（未保存 token 时只有一个 Token 输入框 +「保存并创建仓库」，保存后自动建私有仓库；已连接时只显示仓库名、设备，以及「更换 Token / 移除 Token」文字操作，未建仓时显示「创建私有仓库」），连接操作下方是 5 个同步分区开关（开关 + 名称 + 默认标记，无独立卡框、无说明小字）；右列同步区（推送/拉取两个紧凑主按钮 + 上次同步 + 定时推送开关与时间 + 连接就绪/需配置提示）。
- hero 卡底部：`PanelFooter` 页脚——左侧「反馈问题」链接（GitHub issues），右侧「Developed by Zhang-Eli」+ GitHub 头像（加载失败自动隐藏）。
- 下方最近历史：每条显示方向/结果/时间/commit，副标题为本次同步的分区列表；告警数量可点击展开全文。
- preview 摘要对话框保留（items/warnings + 确认执行）；确认后改走 `POST /sync/start`，面板不阻塞，顶部显示「后台同步中」chip，`pollJob` 轮询 `GET /sync/job`，完成后 toast + 刷新状态/历史。
- 拉取结果 `applied.restartRequired` 为 true 时弹 `RestartDialog`（立即重启 / 好的）；「立即重启」先 `POST /restart` 再 `location.reload()`。拉取结果含会话导入时额外提示「已导入 N 个会话到工作区」。
- 全部文案走 locale（zh/en），颜色只用 `var(--dsw-alias-*)`。
- 错误边界 `PanelBoundary` 包住整个面板，渲染异常只显示错误卡片 + 重试，不再黑屏。
client.js 只需 fetch `/one-pack/api/*`，不碰 host 内部。
host 侧 `lib/schedule.mjs` 提供 `normalizeSchedule` / `isScheduleDue` / `nextRunAt`；`index.js` 用 `ctx.effect` 内的 30s 定时器 + 启动 8s 预热调用 `engine.tickSchedule()`（gate 探针不执行 effect 回调，因此门禁子进程不会遗留计时器）。