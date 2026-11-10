// One Pack · vendor/localsessions.mjs
// 改造自 dsh-github-sync/lib/localsessions.mjs（MIT License，原作者 dsh-github-sync contributors）。
// 改动：投影缓存根改为从 ../paths.mjs 的 projectCacheRoot() 导入；
//       sessionsRoot 由 sessiondir.mjs 内部使用，这里不再直接依赖；不 import 任何 @deepseek-ai/* 包。
//
// 本地会话扫描（只读）。标题走"从后往前解帧"，避免为了列个表把整份日志解一遍。
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { projectCacheRoot } from '../paths.mjs';
import { decodeFrame, walkFrames } from './zstdframe.mjs';
import { readHeader, sessionBody, sha256, SESSION_FILE } from './sessionlog.mjs';
import { projectDir } from './sessiondir.mjs';

/**
 * 标题优先从投影缓存取——宿主自己的标题就存在这儿（record.rows.title.val），
 * 比解日志快两个数量级；日志里的 session/title 事件可能离文件尾很远。
 */
export function readCachedTitle(id) {
  const file = join(projectCacheRoot(), `${id}.json`);
  if (!existsSync(file)) return null;
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    const v = j?.record?.rows?.title?.val;
    return typeof v === 'string' && v.trim() ? v : null;
  } catch {
    return null;
  }
}

/** 从最后一帧往前找 session/title（标题事件通常在尾部） */
export function readTitleFast(buf, maxFrames = 48) {
  const frames = walkFrames(buf);
  let scanned = 0;
  for (let i = frames.length - 1; i >= 0 && scanned < maxFrames; i--, scanned++) {
    let text;
    try { text = decodeFrame(buf, frames[i]).toString('utf8'); } catch { continue; }
    if (!text.includes('"session/title"')) continue;
    const lines = text.split('\n');
    for (let j = lines.length - 1; j >= 0; j--) {
      if (!lines[j].includes('"session/title"')) continue;
      try {
        const o = JSON.parse(lines[j]);
        if (o?.type === 'session/title') return o?.data?.title ?? null;
      } catch { /* 忽略 */ }
    }
  }
  return null;
}

/** 列出一个工作区（cwd）下的全部会话，按最近修改倒序 */
export function listSessionsForCwd(cwd) {
  const dir = projectDir(cwd);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const file = join(dir, entry, SESSION_FILE);
    if (!existsSync(file)) continue;
    let st;
    try { st = statSync(file); } catch { continue; }
    const row = { dirName: entry, file, bytes: st.size, mtimeMs: st.mtimeMs, id: null, title: null, header: null, error: null };
    try {
      const buf = readFileSync(file);
      row.header = readHeader(buf);
      row.id = row.header.id;
      row.title = readCachedTitle(row.id) ?? readTitleFast(buf);
      row.sha256 = sha256(buf);
      // body 哈希与长度：和远端索引比对，用来算"已同步 / 本地更新 / 远端更新 / 分叉"
      const body = sessionBody(buf);
      row.bodySha256 = sha256(body);
      row.bodyBytes = body.length;
    } catch (err) {
      row.error = err.message;
    }
    out.push(row);
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** 读单个会话的完整信息（含字节） */
export function readSessionFile(file) {
  const buf = readFileSync(file);
  const header = readHeader(buf);
  return { buf, header, title: readTitleFast(buf), bytes: buf.length, sha256: sha256(buf), file };
}