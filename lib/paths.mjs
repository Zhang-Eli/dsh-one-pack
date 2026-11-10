// One Pack · 路径常量
// 只依赖 Node 内置模块。$DSH_HOME 与 profile 名可被环境变量覆盖。
import { homedir } from 'node:os';
import { join } from 'node:path';

/** DSH 数据根目录：$DSH_HOME 或 ~/.dsh */
export function dshHome() {
  const env = process.env.DSH_HOME;
  if (typeof env === 'string' && env.trim()) return env.trim();
  return join(homedir(), '.dsh');
}

/** 当前 profile 名：$DSH_PROFILE 或 'desktop' */
export function profileName() {
  const env = process.env.DSH_PROFILE;
  if (typeof env === 'string' && env.trim()) return env.trim();
  return 'desktop';
}

/** One Pack 自己的数据目录：$DSH_HOME/one-pack */
export function stateDir() {
  return join(dshHome(), 'one-pack');
}

export function statePath() {
  return join(stateDir(), 'state.json');
}

export function historyPath() {
  return join(stateDir(), 'history.jsonl');
}

export function backupsDir() {
  return join(stateDir(), 'backups');
}

export function skillsRoot() {
  return join(dshHome(), 'skills');
}

export function sessionsRoot() {
  return join(dshHome(), 'sessions');
}

/** 附件内容寻址根：$DSH_HOME/attachments/v1（对象在 objects/<sha前2>/<sha>） */
export function attachmentsRoot() {
  return join(dshHome(), 'attachments', 'v1');
}

export function workspaceJsonPath() {
  return join(dshHome(), 'storages', 'workspace.json');
}

/** 会话投影缓存：$DSH_HOME/storages/session_projcache/sessions/<id>.json */
export function projectCacheRoot() {
  return join(dshHome(), 'storages', 'session_projcache', 'sessions');
}

export function profileDir() {
  return join(dshHome(), 'profiles', profileName());
}