# One Pack 开发交接

> 给下一个开发 session 的「项目记忆」。发版或收工时更新；新 session 开场先读这份文档，再读
> `CHANGELOG.md` 与 `git log --oneline -10`。最后更新：2026-11-11（0.4.8 发布后）。

## 1. 当前状态

| 项 | 值 |
|---|---|
| 仓库 | `D:\Documents\deepseek-harness\default-workspace\one-pack`（git：https://github.com/Zhang-Eli/dsh-one-pack） |
| npm | `dsh-one-pack`，最新 **0.4.8**（0.4.8 是纯文档版本，代码与 0.4.7 相同） |
| git | HEAD `dda880c`，tag `v0.4.8`，main 已推送 |
| GitHub Release | v0.4.8（v0.4.7、v0.3.3 亦有） |
| 本地 DSH | 以 `link:` 方式安装在 `desktop` profile，改完代码用 `plugin_manager set_bundle` 关再开即可重载 |
| 测试 | `node --test test/*.test.mjs` → **55/55** 通过（~1.1s，纯离线） |
| 发布门禁 | `safeToPublish: true`，0 error / 3 warn（repo-missing 占位、git-tag-missing 等发布前正常项） |
| 插件市场 | awesome-dsh-plugin 条目已备好（`.tmp/awesome-entry/Zhang-Eli__dsh-one-pack.yml`），仓库满 24h 后（2026-11-11 18:13 Asia/Shanghai）提 PR，尚未提交 |

## 2. 架构地图

Host 半边与 client 半边都只用 Node/浏览器内置能力，不 import `@deepseek-ai/*`。

| 文件 | 职责 |
|---|---|
| `index.js`（~540 行） | Cordis host 入口：注册 `/one-pack/api` 路由、3 个工具（`one_pack_status` / `one_pack_setup` / `one_pack_sync`）、30s 定时器（在 `ctx.effect` 内，门禁探针不会留计时器） |
| `lib/orchestrator.mjs` | 核心 `SyncEngine`：preview → previewToken → 后台 job（`startJob/getJob/listJobs`）、push/pull 编排、schedule、token 解析与 `clearToken()` |
| `lib/cloud.mjs` | `CloudRepo`（GitHub Git Data API 提交、空仓库种子）、`parseRepo`、`ensureSyncRepo`（自动建私有仓库） |
| `lib/sections/{plugins,settings,skills,files}.mjs` | 各分区 export / planPull / applyPull 适配器 |
| `lib/sessions.mjs` | sessions 分区：导出、计划、落盘、挂工作区、附件；`planPull` 有本地 body sha256 快速路径 |
| `lib/schedule.mjs` | 定时推送的纯函数（`isValidTime/isScheduleDue/normalizeSchedule/nextRunAt`） |
| `lib/state.mjs` | `$DSH_HOME/one-pack/state.json` 的读写与规范化（分区默认 plugins/settings 开） |
| `lib/vendor/` | 从 dsh-github-sync 改造复用（MIT，见 NOTICE）：github/zstdframe/sessionlog/sessiondir/localsessions/attachments/guard/folders/projectkey |
| `client.js`（~2300 行） | Web 面板：连接与同步、分区、自动推送、预览弹窗、后台任务轮询、重启提醒、错误边界、页脚 |
| `test/` | structure / host-sync / host / sessions / repo / schedule / integration 七组，integration 用内存 fake GitHub 走完整 A push → B pull |

数据目录：`$DSH_HOME/one-pack/{state.json,history.jsonl,backups/,restore/}`。远端仓库结构见 README。

## 3. 常用命令

```bash
# 静态检查与测试
node --check index.js client.js
node --test test/*.test.mjs

# client 侧自检（工作区里的临时脚本）
node ../.tmp/check-client-keys.mjs     # i18n 键一致 + JSX 用到的 class 都有样式
node ../.tmp/client-smoke.mjs          # 模拟 __ModuleLoader__ 求值，验证注册与 HMR 重复加载

# 发布门禁
node ..\_gate_run.mjs "<本目录绝对路径>" ..\_gate_report.json

# 本地重载插件（在 DSH 会话里）
plugin_manager set_bundle dsh-one-pack enabled=false
plugin_manager set_bundle dsh-one-pack enabled=true
```

## 4. 发布流程（简版）

完整流程见技能 `dsh-plugin-publish`。要点：

1. `npm view dsh-one-pack version` 确认线上版本；`git status` 干净。
2. 改 `package.json` 版本 + `CHANGELOG.md`；跑测试与门禁；`npm pack --dry-run` 记下 shasum。
3. `git commit` → `git tag v<ver>` → `git push origin main` → `git push origin v<ver>`。
4. `npm publish --access public`；首次/新版会 staged 审核，`npm view` 先看不到属正常，轮询 registry
   直到 `dist-tags.latest` 更新，并比对 `npm view dsh-one-pack@<ver> dist.shasum` 与本地 shasum。
5. `gh release create v<ver>`。
6. 发版后更新本文件的「当前状态」与「下一步」，并提交。

## 5. 关键设计与坑（改代码前先看）

- **client.js 顶层不要加页面级 guard**：HMR 会以新 rev 重新执行 bundle，跳过 `load()` 会被 loader 判为
  `loaded without registering`，面板从运行页面消失。现在的写法是 `try { load(...) } catch (e) { 只吞 duplicate factory registration }`。
- **发布门禁的 React stub 没有 `Component`**：错误边界用 `BoundaryBase = (React && React.Component) || class {...}` 回退，不要直接 `extends React.Component`。
- **manifest 的 `files` 是 sha256，不是 git blob sha**：push 变化检测只与 `one-pack.json` 里记录的 sha256 比较；
  和 Git tree 的 SHA-1 比会永远「有变更」，产生空提交。
- **分区 payload 不能带导出时间戳**：曾因 `updatedAt: nowIso()` 导致每次预览都有「变更」；sessions 索引顶层的
  `updatedAt` 已删，只有每行基于 mtime 的时间保留。
- **会话比较只比 body**：头帧 `cwd` 跨机不同，比整个文件会把全部会话判成分叉；写入时只重压头帧、尾部字节保留。
- **会话拉取要「导入」**：只写文件不会出现在工作区；`applyPull` 对 `skip`/`fork` 且本地存在的会话也会补 `attachSession`。
- **已归档会话不同步**：导出与规划都读 `$DSH_HOME/storages/workspace.json` 的 `global.archivedSessionIds` 跳过。
- **token 有两个引用**：`ONE_PACK_GITHUB_TOKEN` 与兼容旧版的 `GITHUB_TOKEN`；移除时必须都清（`clearToken()`），
  否则回退到旧 token 会出现「已连接但推送 404」。
- **不可复现的 bundle 要跳过**：`link:`/`file:`/`workspace:` 安装与 One Pack 自身不导出、不拉取，只给 warning。
- **「立即重启」= 页面重载**：DSH 桌面端没有可靠的进程重启 API；弹窗文案与实际行为要保持一致。
- **工作区文件分区暂时隐藏**：`client.js` 的 `HIDDEN_SECTIONS = new Set(['files'])` 隐藏入口，Host 实现与测试保留。
- **测试要用真实形状的 fake**：integration 的 fake cloud 的 `state().files` 用 `sha1`，曾因 fixture 与真实 Git 形状不符漏掉空提交 bug。

## 6. 已知限制与下一步候选

- [ ] 提交 awesome-dsh-plugin 市场 PR（需仓库满 24h，见第 1 节）。
- [ ] 工作区文件分区：设计「添加目录」交互后重新开放（当前只能通过 `one_pack_setup` / state 手填 `files.paths`）。
- [ ] link 安装插件的跨机开发：曾讨论三档（git 管源码 / 打包插件目录 + pull 后自动 link / 不做），未拍板。
- [ ] README 英文版（当前只有中文；banner 与正文里的中文对英文用户不友好）。
- [ ] 面板在窄屏 / 高缩放的进一步适配；错误边界的「重试」目前只重新渲染。
- [ ] PR 流程与 CI：目前没有 GitHub Actions，测试靠本地跑。

## 7. 新 session 开场清单

1. 读本文件 + `CHANGELOG.md` 最近两条 + `git log --oneline -10`。
2. 跑 `node --test test/*.test.mjs`，确认 55/55。
3. 确认当前版本与线上版本：`grep '"version"' package.json`、`npm view dsh-one-pack version`。
4. 确认本地安装：`plugin_manager list_bundles` 里 `dsh-one-pack` 为 link、enabled。
5. 明确本次任务属于哪个阶段（修 bug / 新功能 / 文档 / 发布），完成后更新第 1 节与第 6 节。