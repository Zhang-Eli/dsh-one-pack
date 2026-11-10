// One Pack · vendor/attachments.mjs
// 改造自 dsh-github-sync/lib/attachments.mjs（MIT License，原作者 dsh-github-sync contributors）。
// 改动：内容寻址根改为从 ../paths.mjs 的 attachmentsRoot() 导入；不 import 任何 @deepseek-ai/* 包。
//
// 会话附件：日志里以 { attachmentId: "sha256:…", mediaType, name, bytes } 引用，
// 实体存在 $DSH_HOME/attachments/v1/objects/<前2位>/<sha>（内容寻址）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { attachmentsRoot } from '../paths.mjs';
import { assertSha256 } from './guard.mjs';
import { decodeFrames } from './zstdframe.mjs';

const EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
};

export function extFor(mediaType, name) {
  const byType = EXT[String(mediaType || '').toLowerCase()];
  if (byType) return byType;
  const m = String(name || '').match(/\.([A-Za-z0-9]{1,8})$/);
  return m ? m[1].toLowerCase() : 'bin';
}

/** 本地实体路径（sha 必须是 64 位十六进制，防止拼出目录穿越） */
export function attachmentObjectPath(sha) {
  return join(attachmentsRoot(), 'objects', assertSha256(sha).slice(0, 2), sha);
}

/** 扫一份会话日志，取出它引用到的全部附件（去重） */
export function collectAttachmentRefs(buf) {
  const found = new Map();
  for (const text of decodeFrames(buf)) {
    if (!text.includes('attachmentId')) continue;
    for (const line of text.split('\n')) {
      if (!line.includes('attachmentId')) continue;
      let root;
      try { root = JSON.parse(line); } catch { continue; }
      const stack = [root];
      while (stack.length) {
        const v = stack.pop();
        if (!v || typeof v !== 'object') continue;
        const id = v.attachmentId;
        if (typeof id === 'string' && id.startsWith('sha256:')) {
          const sha = id.slice('sha256:'.length);
          if (/^[0-9a-f]{64}$/i.test(sha) && !found.has(sha)) {
            found.set(sha, {
              sha,
              attachmentId: id,
              mediaType: v.mediaType ?? '',
              name: typeof v.name === 'string' ? v.name : null,
              bytes: typeof v.bytes === 'number' ? v.bytes : 0,
            });
          }
        }
        for (const child of Object.values(v)) {
          if (child && typeof child === 'object') stack.push(child);
        }
      }
    }
  }
  return [...found.values()];
}

/** 把附件实体写回本地（已存在则跳过） */
export function restoreAttachment(sha, data) {
  const target = attachmentObjectPath(sha);
  if (existsSync(target)) return { written: false, target };
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, data);
  return { written: true, target };
}

export function readAttachment(sha) {
  const p = attachmentObjectPath(sha);
  return existsSync(p) ? readFileSync(p) : null;
}