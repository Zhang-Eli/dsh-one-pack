// One Pack · vendor/sessionlog.mjs
// 改造自 dsh-github-sync/lib/sessionlog.mjs（MIT License，原作者 dsh-github-sync contributors）。
// 改动：只依赖 ./zstdframe.mjs + node:crypto；不 import 任何 @deepseek-ai/* 包。
//
// 会话日志的读与改写。
// 硬事实（实测）：首帧只含 header 一行；之后每批追加各自成帧；append-only。
import { createHash } from 'node:crypto';
import { decodeFrame, decodeFrames, encodeFrames, encodeOne, walkFrames } from './zstdframe.mjs';

export const SESSION_FILE = 'session.v4.jsonl.zstd';
export const SUPPORTED_VERSION = 4;

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function readHeader(buf) {
  const frames = walkFrames(buf);
  const text = decodeFrame(buf, frames[0]).toString('utf8');
  const line = text.split('\n', 1)[0];
  const header = JSON.parse(line);
  if (header.type !== 'session') throw new Error('首帧不是 session header');
  return header;
}

/** 向后找最后一条 session/title 事件 */
export function readTitle(buf) {
  const texts = decodeFrames(buf);
  for (let i = texts.length - 1; i >= 0; i--) {
    if (!texts[i].includes('"type":"session/title"')) continue;
    const lines = texts[i].split('\n');
    for (let j = lines.length - 1; j >= 0; j--) {
      if (!lines[j].includes('"type":"session/title"')) continue;
      try {
        const o = JSON.parse(lines[j]);
        if (o?.type === 'session/title') return o?.data?.title ?? null;
      } catch { /* 忽略 */ }
    }
  }
  return null;
}

/** 统计事件类型数量（谨慎使用：要解全部帧） */
export function eventHistogram(buf) {
  const counts = new Map();
  for (const text of decodeFrames(buf)) {
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const t = JSON.parse(line).type;
        counts.set(t, (counts.get(t) ?? 0) + 1);
      } catch { /* 忽略 */ }
    }
  }
  return counts;
}

/**
 * 改写会话：换 id（可选）、换 cwd（跨机重映射的核心）、加标题后缀（可选）。
 * 只重压受影响的帧，其余帧文本原样重压——帧数保持不变。
 */
export function rewriteSession(buf, { newCwd, newId, titleSuffix } = {}) {
  const old = readHeader(buf);
  const frames = walkFrames(buf);

  // 只改 cwd（插件里唯一会走的路）：只重写头帧，其余帧字节原样保留，
  // 这样跨机之后两边的 body 仍然是同一条 append-only 字节链。
  if (!newId && !titleSuffix) {
    if (!newCwd || newCwd === old.cwd) return { buffer: buf, header: old, frames: frames.length };
    const first = decodeFrame(buf, frames[0]).toString('utf8');
    const nl = first.indexOf('\n');
    const line = nl === -1 ? first : first.slice(0, nl);
    const rest = nl === -1 ? '' : first.slice(nl);
    const h = JSON.parse(line);
    h.cwd = newCwd;
    const head = encodeOne(JSON.stringify(h) + rest);
    const tail = frames.length > 1 ? buf.subarray(frames[1].offset) : Buffer.alloc(0);
    const out = Buffer.concat([head, tail]);
    return { buffer: out, header: readHeader(out), frames: frames.length };
  }

  const texts = decodeFrames(buf);

  if (newId && newId !== old.id) {
    for (let i = 0; i < texts.length; i++) texts[i] = texts[i].split(old.id).join(newId);
  }

  if (newCwd && newCwd !== old.cwd) {
    const t = texts[0];
    const nl = t.indexOf('\n');
    const line = nl === -1 ? t : t.slice(0, nl);
    const rest = nl === -1 ? '' : t.slice(nl);
    const h = JSON.parse(line);
    h.cwd = newCwd;
    texts[0] = JSON.stringify(h) + rest;
  }

  if (titleSuffix) {
    outer: for (let i = texts.length - 1; i >= 0; i--) {
      if (!texts[i].includes('"type":"session/title"')) continue;
      const lines = texts[i].split('\n');
      for (let j = lines.length - 1; j >= 0; j--) {
        if (!lines[j].includes('"type":"session/title"')) continue;
        try {
          const o = JSON.parse(lines[j]);
          if (typeof o?.data?.title === 'string') {
            o.data.title = o.data.title + titleSuffix;
            lines[j] = JSON.stringify(o);
            texts[i] = lines.join('\n');
            break outer;
          }
        } catch { /* 忽略 */ }
      }
    }
  }

  const out = encodeFrames(texts);
  const header = readHeader(out);
  if (header.version !== SUPPORTED_VERSION) {
    throw new Error(`不支持的会话版本：${header.version}（只处理 v${SUPPORTED_VERSION}）`);
  }
  return { buffer: out, header, frames: frames.length };
}

/** 会话 body = 头帧之后的全部字节。头帧里是 cwd，跨机必然不同，所以比对只比 body。 */
export function sessionBody(buf) {
  const frames = walkFrames(buf);
  return frames.length > 1 ? buf.subarray(frames[1].offset) : Buffer.alloc(0);
}

/** body 的 sha256：同步状态与冲突判定的唯一依据 */
export function bodySha256(buf) {
  return sha256(sessionBody(buf));
}

/**
 * 差量检查：判断两份会话的先后关系（冲突合并的核心）。
 * 只比 body：头帧的 cwd 跨机不同，比整份文件会让每台机器永远"分叉"。
 * body 是 append-only，所以"一方是另一方的前缀"就意味着只是多追加了几帧。
 * @returns {'equal'|'local-ahead'|'remote-ahead'|'diverged'}
 */
export function compareSessions(localBytes, remoteBytes) {
  const a = sessionBody(localBytes);
  const b = sessionBody(remoteBytes);
  if (a.equals(b)) return 'equal';
  const aShort = a.length <= b.length;
  const short = aShort ? a : b;
  const long = aShort ? b : a;
  if (long.subarray(0, short.length).equals(short)) return aShort ? 'remote-ahead' : 'local-ahead';
  return 'diverged';
}

/** 校验一个字节序列能否被安全地当作会话文件解析 */
export function validateSession(buf) {
  const header = readHeader(buf);
  const frames = walkFrames(buf);
  let bad = 0;
  for (const f of frames) {
    const text = decodeFrame(buf, f).toString('utf8');
    for (const line of text.split('\n')) {
      if (!line) continue;
      try { JSON.parse(line); } catch { bad++; }
    }
  }
  return { ok: bad === 0 && header.version === SUPPORTED_VERSION, header, frames: frames.length, badLines: bad };
}