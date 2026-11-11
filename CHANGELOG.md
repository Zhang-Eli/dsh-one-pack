# Changelog

## 0.4.8

- 文档版本：README 改为面向使用者的 7 章结构（它是什么 / 效果预览 / 快速开始 / 设计取舍 / 卸载与回滚 / 常见问题 / License），
  使用新 banner 与最新面板截图，移除开发者向章节与页脚链接
- 同步到 npm 页面（npm 展示发布时打包的 README）
- 无代码变更

## 0.4.7

- 默认统一使用 classic token：Token 区说明精简为一行「需要仓库读写权限；仅在访问私有仓库时需要」，不再介绍 fine-grained token 的勾选方式
- README 的生成步骤改为 classic token（生成页已预填 `repo`）一步到位
- `one_pack_setup` 工具说明同步改为 classic token / `repo` 权限

## 0.4.6

- 移除 Token 时同时清理所有 token 别名（`ONE_PACK_GITHUB_TOKEN` 与旧的 `GITHUB_TOKEN`），避免回退到权限不足的旧 token 导致「已连接」却推送 404
- 移除后面板明确显示「未连接」，并保留已保存的仓库名提示「填写 Token 后自动重连」；推送/拉取按钮与自动推送开关在无 token 时不可用
- 移除成功后立即清掉上次同步的错误提示，并刷新状态
- 测试：新增 DELETE /token 清理全部别名、`clearToken()` 清空回退引用的用例

## 0.4.5

- 后台同步在右上角有明确提示：推送中… / 拉取中…（带 spinner），不再是笼统的「后台同步中」
- 切到其它页面再回到 One Pack 时，会从 `status.activeJob` 恢复提示并继续轮询；任务完成后照常刷新最近历史、弹出结果
- 最近历史仍在同步完成后才写入（两段式 preview → 后台执行，执行完成才有记录）
- 测试：host status 断言 `activeJob` 字段

## 0.4.4

- 插件条目跨机匹配更准确：同步时除了 entryId，还会记录并比对 `moduleName`；升级/重装后 entryId 变化不再误报「本地没有插件条目」
- 只有在本机确实找不到（entryId 与 moduleName 都不匹配）时才提示一次，并说明「安装/更新对应插件后一般会自动出现」
- 拉取预览明细里超长说明会正常换行，不再把左侧标题挤成竖排
- 测试：新增 entryId 变化但 moduleName 一致时的匹配/启停用例

## 0.4.3

拉取预览明显更快：内容没变的会话不再下载。

- `planPull` 增加本地快速路径：先算本地会话 body 的 sha256，与远端索引 `sessions/_index.json` 里的 `bodySha` 一致（只是头帧 cwd 不同）时直接判定「跳过」，完全不请求远端 blob
- 之前每个远端会话都要串行发一次 GitHub blob GET，20+ 个会话就是 20+ 次往返；现在正常情况下拉取预览只需读一次索引
- 附件计划在快速路径下改为从本地会话引用收集（body 相同，引用也相同）
- 测试：新增「body 一致时不读取远端会话」用例

## 0.4.2

已归档的会话不再参与同步。

- Push 导出时跳过 `workspace.json` 里 `global.archivedSessionIds` 记录的所有会话（索引里的 sessions/projects 与远端文件都不再包含它们），并提示「已跳过 N 个已归档会话」
- Pull 规划时同样跳过本机已归档的会话：本机归档过的会话不会被远端版本重新拉回来
- 已归档会话的附件也不会再被导出（附件按导出会话的引用收集）
- 测试：新增归档会话的 export 跳过 / pull 跳过用例

## 0.4.1

丢弃未执行的预览计划，不再留下「有未执行的计划」小黄条。

- 右上角的「有未执行的计划」提示现在可以点击：点击即丢弃这份预览（不会改动远端），并立即刷新状态
- 关闭预览对话框（取消 / Esc / 点遮罩）时自动丢弃对应预览 token，不再把计划留在 host 内存里
- 面板发现存在未执行计划时，每 30 秒刷新一次状态；10 分钟过期后提示自动消失
- 新增 `POST /sync/discard`（可带 `token` 只丢一条，不带则清空）与 `engine.discardPreview()`

## 0.4.0

拉取会话后自动导入工作区、同步改为后台任务、需要时提示重启。

- 会话导入：Pull 不再只是把 `session.v4.jsonl.zstd` 落盘，还会把会话挂到对应工作区；内容已一致而被 skip 的会话也会补挂，修复「拉取后工作区里看不到新会话」的问题。拉取结果会提示「已导入 N 个会话到工作区」
- 后台同步：确认执行后立即返回并继续在后台跑，面板顶部显示「后台同步中」chip，可以正常使用 DSH；完成/失败后用 toast 提示，不再整个界面卡在「推送中/拉取中」
- 重启提醒：Pull 落地内容需要重启才生效时弹窗（立即重启 / 好的）；「立即重启」会重新加载页面，仍不生效时请从应用菜单重启 DSH
- 新增路由 `POST /sync/start`、`GET /sync/job?id=`、`POST /restart`；host 内存任务表保留最近 20 个任务
- host 侧新增 `engine.startJob()/getJob()/listJobs()`；sessions 分区新增 `import` 计数与补挂逻辑
- 测试：新增后台任务、重启路由、skip 会话补挂用例

## 0.3.3

统一同步分区的分隔线，补齐卡片空白。

- 修复最后一行「会话」下方缺少虚线的问题：现在四行都有相同的分隔线
- 左侧同步分区会撑满卡片高度，不再在「会话」下方留出一片空白
- 自动推送区域去掉多余的分隔线，右侧层级更干净

## 0.3.2

暂时隐藏「工作区文件」分区。

- 面板的同步分区只显示 插件 / 设置 / 技能 / 会话 四项（计数也改为 x/4），工作区文件不再出现在界面上
- host 侧实现完整保留：`files` 分区、`state.files` 字段、`POST /state` 的 files 参数、`files/_index.json` 同步逻辑与相关测试都不动，之后调整交互时可直接放出
- 已开启该分区的旧配置仍保存在 state 里，恢复显示后继续生效

## 0.3.1

修复定时推送开关点了没反应的问题。

- 根因：`normalizeStatus` 只挑选已知字段返回，漏掉了 `schedule`，所以后端已保存 `enabled:true`，面板每次刷新仍按关闭渲染。现在 status 会带上 `schedule`，开关状态与时间框即时生效
- 切换开关/修改时间后仍会重新拉取 status，失败时在开关下方显示错误原因

## 0.3.0

按反馈继续精简面板，并加入每天定时自动推送。

- 去掉「已就绪，可以推送或拉取」提示行（按钮本身就是信号），只在尚未连好时显示警告
- 5 个同步分区从卡片底部整行移到左侧「连接」列、换 Token 操作下方，右侧只保留推送/拉取按钮，两侧高度更均衡
- 新增**定时推送**：默认每天 18:00 自动推送一次，可在同步区开关并调整时间（本地时间，DSH 运行时每 30 秒检查；当天已跑过不重复，过点后启动会补跑一次）
- 定时同步结果写入 state（`schedule.lastRunAt/lastOk/lastError`）并在面板显示失败原因；没有变更的定时推送不产生提交
- 面板底部新增「反馈问题」链接与「Developed by Zhang-Eli」署名（头像来自 GitHub，加载失败自动隐藏）
- 新增 `POST /one-pack/api/schedule`；`GET status` 返回 `schedule`；工具 `one_pack_status` 文本包含定时同步状态
- 新增 5 个 i18n 键，zh/en 各 185 键保持一致；新增 `lib/schedule.mjs` 与 7 个定时相关测试

## 0.2.5

修复点击「历史告警」后面板整片黑屏、无法返回的问题。

- 根因：告警在数据层是 `{ code, message }` 对象，历史展开块把对象直接交给 React 渲染，触发 `Objects are not valid as a React child`，整棵面板树被卸载，右侧只剩黑底。现在按 `code: message` 文本渲染，悬停提示也用 message
- 新增面板级错误边界：即使某个组件渲染出错，也只显示一张带错误信息和「重试」按钮的卡片，不再拖垮整个应用
- 新增 i18n 键 `panelError`，zh/en 各 180 键保持一致

## 0.2.4

按使用反馈收紧面板，只保留实际会用的操作。

- 连接区去掉「在 GitHub 打开」与「手动填写仓库」；已连接时只剩仓库名、设备与「更换 Token / 移除 Token」（未建仓时显示「创建私有仓库」）
- 「更换 Token」展开后是一行输入框 + 「生成新 Token ↗」直达 GitHub 生成页，不再显示长说明
- 修复推送/拉取按钮在纵向布局里被 flex 撑到 160px 高的问题，现在按内容高度紧凑排列，两侧不再出现大片空白
- 同步分区并入 hero 卡底部的整行区域，去掉独立卡框与每项说明小字，只留开关、名称与默认标记
- 最近历史的告警数量改为可点击按钮：点击展开该次同步的完整告警文本，悬停也有提示
- 历史每条摘要从「文件 N / 删除 N」改为本次同步涉及的分区列表（如「分区：插件、设置」）
- 新增 3 个 i18n 键，zh/en 各 179 键保持一致

## 0.2.3

面板重设计：主界面只保留「连接 + 同步」「同步内容」「最近历史」，去掉重复的状态卡和仓库/分支表单。

- 顶部一张 hero 卡：左侧是连接状态（已连接时只显示仓库名和「更换 Token / 移除 / 手动填写仓库」等文字操作），右侧是推送/拉取两个主按钮与上次同步信息
- 首次使用只有一个输入框：保存一次 Token 后自动创建私有同步仓库；分支、仓库、保存配置等字段默认隐藏，收进「手动填写仓库」
- 独立状态卡与同步卡合并，不再重复展示仓库/分支/设备；分区开关改为两列紧凑网格
- 新增连接区 i18n 文案，zh/en 各 176 键保持一致

## 0.2.2

真机同步复核时发现的三个问题：重复推送会产生空提交、链接安装的插件会被带到别的机器、会话分区 index 带时间戳。

- Push 现在按内容哈希对比远端，只上传真正变化的文件；没有任何变化时直接抛 `NOTHING_TO_SYNC`，不再产生空提交。比较基准是 One Pack 自己写在 `one-pack.json` 里的 sha256（Git 树的 blob sha 是 SHA-1，直接比较会把每个文件都误判成已变更）
- 各分区 payload 移除 `updatedAt` 等易变时间戳（会话条目仍保留基于 mtime 的时间），同样的本机状态总是得到同样的字节，preview 能正确显示「不变」
- plugins 分区不再导出无法在其它机器复现的 bundle：`link:` / `file:` / `workspace:` 安装的包，以及 One Pack 自身（未发布前无法从 npm 装回）。导出的包只保留可复现的 npm 规格，其余以 warning 列出
- pull 端对远端遗留的链接安装条目同样跳过并给出 warning，而不是尝试安装一个本机不存在的路径
- 集成测试新增「二次推送幂等」与「不可复现 bundle 被过滤」断言
- 真机验证：`Zhang-Eli/dsh-one-pack-sync` 首次 push/pull 成功（commit `aa6eb79`），修复后同一状态再次 preview push 显示 0 变更

## 0.2.1

修复 0.2.0 刷新/热更新后侧栏入口消失的问题。

- client 半边不再使用页面级 `__DSH_ONE_PACK_CLIENT_LOADED__` 标志。该标志会让模块加载器在 HMR 失效重载（invalidated，随后以新 revision URL 重新执行）时认为「脚本已执行但未注册」，从而把面板从运行中的页面移除
- 改为只忽略 `duplicate factory registration` 这一种重复注册错误（双份插入时避免拖垮 web boot），其它加载错误继续抛出
- 新增回归断言：client.js 不得出现页面级标志、必须容忍重复注册错误；离线冒烟覆盖「重复求值」与「HMR 重注册」两条路径

## 0.2.0

配置更省事：不用再手动去 GitHub 建仓、填 owner/repo。

- 面板 Token 区新增「生成 Token ↗」按钮，直达 GitHub 预填 `repo` scope 的 token 生成页
- 保存 token 后若尚未配置仓库，自动在 token 所属账号下创建（或复用）私有同步仓库 `dsh-one-pack-sync`，并写回仓库配置
- 仓库行新增「自动创建私有仓库」按钮，可随时手动触发
- 新增 `POST /one-pack/api/repo/auto` 与 `ensureSyncRepo()`；`one_pack_setup` 新增 `createRepo` 参数
- 自动建仓遇到 401/403 时返回可操作的权限提示（classic 需要 `repo`，fine-grained 需要 `Administration: write`）
- 新增 `test/repo.test.mjs`（建仓/复用/权限/写回 state）共 7 项，测试总数 42

## 0.1.0

首个版本。

- 五个可独立开关的同步分区：`plugins`、`settings`、`skills`、`sessions`、`files`
- GitHub 仓库作为同步后端：Git Data API 一次同步一个原子 commit；空仓库自动种子提交
- 两段式 preview → execute，preview token 10 分钟有效、一次性
- Pull 前自动备份到 `$DSH_HOME/one-pack/backups/`
- settings 分区只导出显式用户覆盖，敏感字段递归脱敏
- sessions 分区支持 zstd 多帧会话、跨机 cwd 重写、body 前缀比较、分叉另存、附件内容寻址还原
- Web UI：侧栏入口 + 主面板（仓库/token/分区开关/预览确认/历史）
- Agent 工具：`one_pack_status`、`one_pack_sync`、`one_pack_setup`