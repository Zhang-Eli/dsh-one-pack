// One Pack · 通用工具
// 只依赖 Node 内置模块。
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

/** sha256 hex（string 按 utf8，Buffer 按原样） */
export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/** 递归创建目录 */
export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 读 JSON，失败返回 fallback */
export function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 原子写 JSON（先写 .tmp 再 rename） */
export function writeJson(file, value) {
  ensureDir(dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
  return value;
}

/** yyyyMMddHHmmss（本地时区） */
export function stamp(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function deepClone(value) {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value));
}

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const SECRET_KEY_RE =
  /(api[-_]?key|token|secret|password|passwd|credential|private[-_]?key|authorization|cookie)/i;

/** 路径段是否像密钥字段 */
export function isSecretPath(segments) {
  return segments.some((seg) => SECRET_KEY_RE.test(String(seg)));
}

/**
 * 递归把敏感字段替换为 '***'，返回 {value, paths}。
 * paths 是被脱敏字段的字段路径（string[][]），发布到远端用于提示，不含明文。
 */
export function redactSecrets(value) {
  const paths = [];
  const walk = (node, trail) => {
    if (Array.isArray(node)) {
      return node.map((item, index) => walk(item, [...trail, String(index)]));
    }
    if (!isPlainObject(node)) return node;
    const out = {};
    for (const [key, child] of Object.entries(node)) {
      const nextTrail = [...trail, key];
      if (isSecretPath([key]) && child !== null && child !== undefined && child !== '') {
        paths.push(nextTrail);
        out[key] = '***';
        continue;
      }
      out[key] = walk(child, nextTrail);
    }
    return out;
  };
  return { value: walk(value ?? null, []), paths };
}

/** 跨平台相对路径校验：拒绝绝对路径 / 盘符 / .. / 空段 / 控制字符；返回 posix 相对路径或 null */
export function safeRelPath(input) {
  if (typeof input !== 'string') return null;
  const norm = input.replace(/\\/g, '/').trim();
  if (!norm) return null;
  if (norm.startsWith('/')) return null;
  if (/^[A-Za-z]:/.test(norm)) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(norm)) return null;
  const parts = norm.split('/').filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.some((part) => part === '.' || part === '..')) return null;
  if (parts.some((part) => part.length > 200)) return null;
  return parts.join('/');
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 文件体积（不存在返回 0） */
export function fileSize(file) {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

export function fileExists(file) {
  try {
    return existsSync(file);
  } catch {
    return false;
  }
}

/** 读取文件为 Buffer，失败返回 null */
export function readBuffer(file) {
  try {
    return readFileSync(file);
  } catch {
    return null;
  }
}

/** 读取文件为 utf8 文本，失败返回 null */
export function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** 默认排除（files 分区的基础规则，仍叠加 vendor/folders.mjs 的 HARD_BLOCK） */
export const DEFAULT_EXCLUDES = [
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '.idea',
  '.vscode',
  '__pycache__',
  '.DS_Store',
  'Thumbs.db',
  '*.log',
  '*.tmp',
  '*.bak',
  '*.swp',
  '.env',
  '.env.*',
  '*.key',
  '*.pem',
  '*.pfx',
  '*.p12',
  '.npmrc',
  '.netrc',
];