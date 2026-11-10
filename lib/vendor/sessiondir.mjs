// One Pack · vendor/sessiondir.mjs
// 改造自 dsh-github-sync/lib/sessiondir.mjs（MIT License，原作者 dsh-github-sync contributors）。
// 改动：目录根改为从 ../../lib/paths.mjs 的 sessionsRoot() 导入；不 import 任何 @deepseek-ai/* 包。
//
// 会话目录解析：优先用 projectKey 算出的目录名；算不出来时，退回"读会话头里的绝对 cwd"来匹配。
// 这样即使不同平台/版本的键算法有差异（比如 Windows 盘符 vs macOS 斜杠路径），也能对上号。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sessionsRoot } from '../paths.mjs';
import { projectKey, samePath } from './projectkey.mjs';
import { SESSION_FILE, readHeader } from './sessionlog.mjs';

const cache = new Map();

/** 只看该目录里第一个可读会话的头帧，取出它记录的绝对 cwd */
function firstSessionCwd(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const buf = readFileSync(join(dir, e.name, SESSION_FILE));
      const cwd = readHeader(buf)?.cwd;
      if (cwd) return cwd;
    } catch { /* 坏文件/空目录，继续找下一个 */ }
  }
  return null;
}

/**
 * 某个 cwd 对应的会话目录（绝对路径）。
 * - 目录已存在 → 直接用（正常路径，零开销）
 * - 键算法与当前平台不符 → 扫一遍 sessions 根，按头帧 cwd 匹配（只扫一次，结果缓存）
 */
export function projectDir(cwd) {
  const key = projectKey(cwd);
  const root = sessionsRoot();
  const exact = join(root, key);
  if (existsSync(exact)) return exact;
  if (cache.has(key)) return cache.get(key);

  let found = exact;
  try {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const dir = join(root, e.name);
      const other = firstSessionCwd(dir);
      if (other && samePath(other, cwd)) { found = dir; break; }
    }
  } catch { /* sessions 根还不存在：按新工作区处理 */ }
  cache.set(key, found);
  return found;
}

/** 测试/诊断用：清掉缓存 */
export function resetProjectDirCache() {
  cache.clear();
}