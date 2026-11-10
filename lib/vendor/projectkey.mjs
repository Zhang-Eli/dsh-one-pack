// Vendored from dsh-github-sync (MIT, Copyright (c) dsh-github-sync contributors).
// See ../../NOTICE. Adapted for One Pack: no behavioural change; Node built-ins only.
//
// DSH 会话目录键：cwd 绝对路径 → "--E-ruanjianxiazai-deepseek-work--"
// 规则（实测）：`/ \\ :` 的连续段折叠成单个 "-"；其余不在 [A-Za-z0-9._-] 的码元转 ~XXXX（4 位大写十六进制）；两端各加 "--"；最长 251。

const SAFE = /[A-Za-z0-9._-]/;
const SEPARATORS = /[/\\:]+/g;

function escapeCodeUnit(ch) {
  return '~' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0');
}

export function projectKey(cwd) {
  const collapsed = String(cwd).replace(SEPARATORS, '-');
  let encoded = '';
  for (const ch of collapsed) encoded += SAFE.test(ch) ? ch : escapeCodeUnit(ch);
  const key = '--' + encoded + '--';
  return key.length > 251 ? key.slice(0, 251) : key;
}

export function encodeSegment(segment) {
  let out = '';
  for (const ch of String(segment)) {
    // 注意：'~' 本身不安全，也要转义，否则无法逆解
    out += SAFE.test(ch) && ch !== '~' ? ch : escapeCodeUnit(ch);
  }
  return out;
}

export function decodeSegment(segment) {
  return String(segment).replace(/~([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/** 由 cwd 推会话日志的期望路径片段（不含 DSH_HOME） */
export function logPathParts(cwd, sessionId) {
  return ['sessions', projectKey(cwd), encodeSegment(sessionId), 'session.v4.jsonl.zstd'];
}

/** 两个路径是否"同一个"（Windows 大小写不敏感、分隔符归一） */
export function samePath(a, b) {
  const n = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return n(a) === n(b);
}