# Changelog

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