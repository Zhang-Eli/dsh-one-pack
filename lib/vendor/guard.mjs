// Vendored from dsh-github-sync (MIT, Copyright (c) dsh-github-sync contributors).
// See ../../NOTICE. Adapted for One Pack: no behavioural change.
//
// 路径与标识符守卫：所有"远端数据拼进本地路径"的地方都必须先过这里。
// 背景：远端 manifest 与文件内容都来自 GitHub 仓库，一旦仓库被改或被投毒，
// id / sha 里可以塞 `../../` 把写入引到 $DSH_HOME 之外。这类写入必须硬拒绝。
import { resolve, sep } from 'node:path';

/** 单段标识符：字母数字点下划线短横，非 . / ..，长度受限 */
export function isSafeSegment(s, max = 128) {
  return typeof s === 'string'
    && s.length > 0
    && s.length <= max
    && s !== '.'
    && s !== '..'
    && /^[A-Za-z0-9._-]+$/.test(s);
}

/** 内容寻址附件用的 sha256 十六进制 */
export function isHex64(s) {
  return typeof s === 'string' && /^[0-9a-f]{64}$/i.test(s);
}

/** target 是否落在 root 之内（都先规范化，避免 .. 与大小写差异） */
export function isInsideRoot(root, target) {
  const r = resolve(root);
  const t = resolve(target);
  if (t === r) return true;
  return t.startsWith(r.endsWith(sep) ? r : r + sep);
}

/** 越界直接抛错：宁可失败，也不能写到工作区/数据目录之外 */
export function assertInsideRoot(root, target, label = '路径') {
  if (!isInsideRoot(root, target)) {
    throw new Error(`${label}越界，已拒绝写入：${target}`);
  }
  return target;
}

/** 会话 id 守卫 */
export function assertSessionId(id) {
  if (!isSafeSegment(id)) throw new Error(`会话 id 不合法：${JSON.stringify(String(id).slice(0, 40))}`);
  return id;
}

/** 附件 sha 守卫 */
export function assertSha256(sha) {
  if (!isHex64(sha)) throw new Error(`附件标识不合法：${JSON.stringify(String(sha).slice(0, 40))}`);
  return sha;
}