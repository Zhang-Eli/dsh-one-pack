// Vendored from dsh-github-sync (MIT, Copyright (c) dsh-github-sync contributors).
// See ../../NOTICE. Adapted for One Pack: exposes HARD_BLOCK/DEFAULT_LIMITS so sections can
// document and extend the hard-block list; no behavioural change. Node built-ins only.
//
// 文件夹上传的扫描层：走目录、套排除清单、把密钥类文件硬拦下。
import { readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

/** 文件名一律命中就硬阻断，不给"再确认一次"的机会 */
export const HARD_BLOCK = [
  /^\.env(\..+)?$/i,
  /\.(key|pem|pfx|p12|kdbx|keystore)$/i,
  /^id_(rsa|ed25519|ecdsa)$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
];

export const DEFAULT_LIMITS = {
  maxFileBytes: 10 * 1024 * 1024,
  maxFiles: 800,
  maxTotalBytes: 120 * 1024 * 1024,
  maxDepth: 12,
};

const toPosix = (p) => p.split(sep).join('/');

function globMatch(name, pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + escaped + '$', 'i').test(name);
}

/** 任一路径段命中任一排除模式，即排除 */
export function isExcluded(relPath, patterns) {
  const segs = relPath.split('/');
  return segs.some((seg) => patterns.some((p) => p && globMatch(seg, p)));
}

export function isHardBlocked(relPath) {
  const name = relPath.split('/').pop() ?? relPath;
  return HARD_BLOCK.some((re) => re.test(name));
}

/**
 * 递归扫描。返回可上传文件 + 被挡下的条目，不写任何东西。
 */
export function scanFolder(root, { patterns = [], limits = {} } = {}) {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const files = [];
  const blocked = [];
  let totalBytes = 0;
  let dirs = 0;

  const walk = (dir, depth) => {
    if (depth > lim.maxDepth) {
      blocked.push({ rel: toPosix(dir).replace(toPosix(root), '').replace(/^\//, '') || '.', bytes: 0, reason: '目录层级过深' });
      return;
    }
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch (err) {
      blocked.push({ rel: dir, bytes: 0, reason: '无法读取：' + err.message });
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = toPosix(abs).slice(toPosix(root).length).replace(/^\//, '');
      if (!rel) continue;
      if (isHardBlocked(rel)) { blocked.push({ rel, bytes: 0, reason: '密钥类文件，硬阻断' }); continue; }
      if (isExcluded(rel, patterns)) continue;

      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) { dirs += 1; walk(abs, depth + 1); continue; }
      if (!st.isFile()) continue;
      if (st.size > lim.maxFileBytes) {
        blocked.push({ rel, bytes: st.size, reason: `超过 ${(lim.maxFileBytes / 1048576).toFixed(0)}MB，需单独确认` });
        continue;
      }
      if (files.length >= lim.maxFiles) {
        blocked.push({ rel, bytes: st.size, reason: `超过单批 ${lim.maxFiles} 个文件的上限` });
        continue;
      }
      if (totalBytes + st.size > lim.maxTotalBytes) {
        blocked.push({ rel, bytes: st.size, reason: '超过单批总量上限' });
        continue;
      }
      files.push({ rel, abs, bytes: st.size });
      totalBytes += st.size;
    }
  };

  walk(root, 0);
  return { files, blocked, dirs, totalBytes };
}

/** 单层目录浏览（给面板选子目录用） */
export function listDir(dir) {
  const dirs = [];
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) dirs.push({ name: entry.name, path: abs });
    else {
      let size = 0;
      try { size = statSync(abs).size; } catch { /* 忽略 */ }
      files.push({ name: entry.name, path: abs, bytes: size });
    }
  }
  dirs.sort((a, b) => (a.name < b.name ? -1 : 1));
  files.sort((a, b) => (a.name < b.name ? -1 : 1));
  return { dirs, files };
}