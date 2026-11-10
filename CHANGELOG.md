# Changelog

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