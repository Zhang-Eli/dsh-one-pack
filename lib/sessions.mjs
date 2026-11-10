// One Pack · sessions 分区适配器
// 只依赖 Node 内置模块。会话/附件算法在 lib/vendor/*（改造自 dsh-github-sync，MIT）。
//
// 职责：把本机各工作区的会话文件（多帧 zstd）与被引用附件导出到远端 sessions/；
// 拉取时只重压头帧把 cwd 重映射到本机，再按 body 前缀比较决定 skip / write / fork。
//
// 核心算法（不许改）：
// - 会话文件是多帧 zstd 顺序拼接，头帧一行 header；body = 头帧之后的全部字节。
// - 改 cwd 只重压头帧，尾部帧字节原样保留，保证跨机后两边 body 仍是同一条 append-only 字节链。
// - 冲突判定只比较 body（头帧 cwd 跨机必然不同）。
import { copyFileSync, existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { backupsDir, sessionsRoot } from './paths.mjs';
import { ensureDir, formatBytes, nowIso, sha256, stamp as makeStamp } from './util.mjs';
import {
  SESSION_FILE,
  SUPPORTED_VERSION,
  compareSessions,
  readHeader,
  rewriteSession,
  sessionBody,
  validateSession,
} from './vendor/sessionlog.mjs';
import {
  attachmentObjectPath,
  collectAttachmentRefs,
  extFor,
  readAttachment,
  restoreAttachment,
} from './vendor/attachments.mjs';
import { listSessionsForCwd, readTitleFast } from './vendor/localsessions.mjs';
import { projectDir } from './vendor/sessiondir.mjs';
import { projectKey, samePath } from './vendor/projectkey.mjs';
import { isHex64, isSafeSegment } from './vendor/guard.mjs';

export const NAME = 'sessions';
export const DEFAULT_ENABLED = false;
export const INDEX_PATH = 'sessions/_index.json';

/** 单个附件的大小上限：GitHub blob API 在几十 MB 以上很吃时间，超出只给 warning */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

// 远端项目目录名来自 projectKey()：只含 [A-Za-z0-9._-] 与 `~XXXX` 转义，额外允许 `~`
const SAFE_REMOTE_SEGMENT = /^[A-Za-z0-9._~-]+$/;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function isDirectory(p) {
  try {
    return Boolean(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 远端数据拼进本地/远端路径前的守卫 */
function isSafeRemoteSegment(seg, max = 251) {
  return typeof seg === 'string'
    && seg.length > 0
    && seg.length <= max
    && seg !== '.'
    && seg !== '..'
    && SAFE_REMOTE_SEGMENT.test(seg);
}

function isSafeRemoteSessionPath(rel) {
  return typeof rel === 'string'
    && /^sessions\/[A-Za-z0-9._~-]+\/[A-Za-z0-9._-]+\.jsonl\.zstd$/.test(rel);
}

function sessionRemotePath(project, id) {
  return `sessions/${project}/${id}.jsonl.zstd`;
}

function attachmentRemotePath(sha, ext) {
  return `sessions/attachments/${sha}.${ext}`;
}

/** 本地附件对象路径（sha 非法返回 null，不抛） */
function localAttachmentPath(sha) {
  if (!isHex64(sha)) return null;
  try {
    return attachmentObjectPath(sha);
  } catch {
    return null;
  }
}

async function tryReadFile(remote, relPath) {
  try {
    const data = await remote.readFile(relPath, remote.snapshot);
    return data ?? null;
  } catch {
    return null;
  }
}

async function tryReadJson(remote, relPath) {
  try {
    return (await remote.readJson(relPath, remote.snapshot)) ?? null;
  } catch {
    return null;
  }
}

/** 原子写：先写 .tmp 再 rename，避免半新半旧 */
function writeFileAtomic(file, data) {
  ensureDir(dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

/** 备份一个将被覆盖的会话文件到 <backupRoot>/sessions/<projectKey>/<id>/ */
function backupSessionFile(file, cwd, backupRoot, applied, warnings) {
  try {
    const dest = join(backupRoot, 'sessions', projectKey(cwd), basename(dirname(file)), SESSION_FILE);
    ensureDir(dirname(dest));
    copyFileSync(file, dest);
    applied.backups.push(dest);
    return dest;
  } catch (err) {
    warnings.push(`备份会话失败（${file}）：${err.message}`);
    return null;
  }
}

/**
 * 编排器执行 pull 时会传 ctx.backupDir = backups/<yyyyMMddHHmmss>；
 * 优先复用它，保证一次同步只产生一个备份目录，也保证 plan 与 apply 的 fork 文件名一致。
 */
function stampFromBackupDir(backupDir) {
  if (typeof backupDir !== 'string' || !backupDir) return null;
  const base = basename(backupDir);
  return /^\d{14}$/.test(base) ? base : null;
}

// ---------------------------------------------------------------------------
// 工作区枚举（导出用）
// ---------------------------------------------------------------------------

/** svc.workspaceRegistry.list()；不可用返回 null（由调用方回退并 warning） */
function registryList(ctx) {
  const registry = ctx?.svc?.workspaceRegistry;
  if (!registry || typeof registry.list !== 'function') return null;
  try {
    const list = registry.list();
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
}

function workspacesFromRegistry(ctx, warnings) {
  const list = registryList(ctx);
  if (list === null) {
    warnings.push('workspaceRegistry 不可用：已回退为扫描本机 sessions 目录');
    return null;
  }
  if (list.length === 0) {
    warnings.push('workspaceRegistry 为空：已回退为扫描本机 sessions 目录');
    return null;
  }
  const seen = new Set();
  const out = [];
  for (const ws of list) {
    const p = typeof ws === 'string' ? ws : ws?.path;
    if (typeof p !== 'string' || !p.trim()) continue;
    const key = p.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path: p.trim(), title: typeof ws?.title === 'string' ? ws.title : null });
  }
  return out;
}

/** 没有注册表时的兜底：扫 $DSH_HOME/sessions/*，用会话头帧的绝对 cwd 反推工作区列表 */
function workspacesFromDisk() {
  const root = sessionsRoot();
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  const seen = new Set();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    let subs;
    try {
      subs = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sub of subs) {
      if (!sub.isDirectory()) continue;
      try {
        const buf = readFileSync(join(dir, sub.name, SESSION_FILE));
        const cwd = readHeader(buf)?.cwd;
        if (typeof cwd !== 'string' || !cwd.trim()) continue;
        const key = cwd.trim().toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ path: cwd.trim(), title: null });
        break; // 一个项目目录只需取一次 cwd
      } catch {
        // 坏会话/非会话目录：继续找下一个
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 目标工作区解析（拉取用）
// ---------------------------------------------------------------------------

/** ctx.state 里可能记录的本机工作区候选（v1 的 state schema 没有 workspaces 字段，做宽松读取） */
function stateCwdCandidates(state) {
  const out = [];
  const push = (v) => {
    if (typeof v === 'string' && v.trim()) out.push(v.trim());
  };
  push(state?.workspace?.path);
  push(state?.cwd);
  if (Array.isArray(state?.workspaces)) {
    for (const w of state.workspaces) push(typeof w === 'string' ? w : w?.path);
  }
  if (Array.isArray(state?.files?.paths)) {
    for (const p of state.files.paths) push(p);
  }
  return out;
}

function firstAvailableWorkspace(ctx) {
  const list = registryList(ctx);
  if (!list) return null;
  for (const ws of list) {
    const p = typeof ws === 'string' ? ws : ws?.path;
    if (typeof p === 'string' && isDirectory(p)) return p;
  }
  return null;
}

/**
 * 远端项目 → 本机落点 cwd。
 * 优先用 _index.projects[project].originalCwd；本机不存在时依次尝试 ctx.state、第一个可用工作区。
 */
function resolveTargetCwd(project, meta, ctx, fallbackCwd, warnings) {
  const original = typeof meta?.originalCwd === 'string' ? meta.originalCwd.trim() : '';
  if (original && isDirectory(original)) return original;
  if (original) warnings.push(`原工作区不存在：${original}（项目 ${project}）`);

  for (const candidate of stateCwdCandidates(ctx?.state)) {
    if (isDirectory(candidate)) {
      warnings.push(`项目 ${project} 改用本机登记的工作区：${candidate}`);
      return candidate;
    }
  }
  if (fallbackCwd) {
    warnings.push(`项目 ${project} 改用第一个可用工作区：${fallbackCwd}`);
    return fallbackCwd;
  }
  warnings.push(`项目 ${project} 没有可用工作区，相关会话已跳过`);
  return null;
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

/**
 * 导出所有工作区的会话 + 被引用附件。
 * @returns {{files:{path:string,content:string|Buffer}[], summary:object, warnings:string[]}}
 */
export async function exportSessions(ctx = {}) {
  const warnings = [];
  const state = ctx.state ?? {};
  const device = state.device ?? {};
  const workspaces = workspacesFromRegistry(ctx, warnings) ?? workspacesFromDisk();

  const files = [];
  const projects = {};
  const sessions = {};
  const attachments = {};
  let sessionBytes = 0;
  let attachmentBytes = 0;

  for (const ws of workspaces) {
    const cwd = ws.path;
    let project;
    try {
      project = projectKey(cwd);
    } catch {
      warnings.push(`无法计算项目键，已跳过工作区：${cwd}`);
      continue;
    }
    if (!isSafeRemoteSegment(project)) {
      warnings.push(`项目键不含安全字符，已跳过工作区：${cwd}`);
      continue;
    }

    const rows = listSessionsForCwd(cwd);
    if (!rows.length) continue;
    projects[project] = { originalCwd: cwd, title: ws.title || basename(cwd) || project };

    for (const row of rows) {
      if (row.error) {
        warnings.push(`会话 ${row.dirName} 无法解析，已跳过：${row.error}`);
        continue;
      }
      if (!isSafeSegment(row.id)) {
        warnings.push(`会话 id 不合法，已跳过：${JSON.stringify(String(row.id ?? row.dirName).slice(0, 40))}`);
        continue;
      }
      const id = row.id;
      if (sessions[id]) {
        warnings.push(`会话 id 重复，已跳过：${row.file}`);
        continue;
      }

      let buf;
      try {
        buf = readFileSync(row.file);
      } catch (err) {
        warnings.push(`读取会话失败（${row.file}）：${err.message}`);
        continue;
      }
      let header;
      try {
        header = readHeader(buf);
      } catch (err) {
        warnings.push(`会话 ${id} 头帧无法解析，已跳过：${err.message}`);
        continue;
      }
      if (header.version !== SUPPORTED_VERSION) {
        warnings.push(`会话 ${id} 版本 v${header.version} 不是 v${SUPPORTED_VERSION}，已跳过`);
        continue;
      }
      if (typeof header.cwd === 'string' && header.cwd && !samePath(header.cwd, cwd)) {
        warnings.push(`会话 ${id} 记录的 cwd 与所在工作区不一致（${header.cwd}），按所在工作区导出`);
      }

      const bodySha = row.bodySha256 ?? sha256(sessionBody(buf));
      sessions[id] = {
        project,
        title: row.title ?? readTitleFast(buf) ?? null,
        bodySha,
        bytes: buf.length,
        updatedAt: new Date(row.mtimeMs || Date.now()).toISOString(),
      };
      files.push({ path: sessionRemotePath(project, id), content: buf });
      sessionBytes += buf.length;

      // 附件按会话 body 里的 attachment 引用收集（内容寻址读本地对象）
      let refs = [];
      try {
        refs = collectAttachmentRefs(buf);
      } catch (err) {
        warnings.push(`会话 ${id} 附件引用解析失败：${err.message}`);
      }
      for (const ref of refs) {
        if (attachments[ref.sha]) continue;
        const label = ref.name || ref.sha.slice(0, 12);
        let data;
        try {
          data = readAttachment(ref.sha);
        } catch {
          data = null;
        }
        if (!data) {
          warnings.push(`附件在本机缺失，已跳过：${label}`);
          continue;
        }
        if (data.length > MAX_ATTACHMENT_BYTES) {
          warnings.push(`附件超过 ${Math.round(MAX_ATTACHMENT_BYTES / 1048576)}MB，已跳过：${label}`);
          continue;
        }
        const ext = extFor(ref.mediaType, ref.name);
        attachments[ref.sha] = {
          bytes: data.length,
          mediaType: ref.mediaType || '',
          name: ref.name ?? null,
          ext,
        };
        files.push({ path: attachmentRemotePath(ref.sha, ext), content: data });
        attachmentBytes += data.length;
      }
    }
  }

  const index = {
    schema: 1,
    updatedAt: nowIso(),
    device: {
      id: typeof device.id === 'string' && device.id ? device.id : 'unknown',
      name: typeof device.name === 'string' && device.name ? device.name : 'unknown',
      platform: typeof device.platform === 'string' && device.platform ? device.platform : process.platform,
    },
    projects,
    sessions,
    attachments,
  };
  // _index.json 放在最前面，方便人读
  files.unshift({ path: INDEX_PATH, content: `${JSON.stringify(index, null, 2)}\n` });

  return {
    files,
    summary: {
      projects: Object.keys(projects).length,
      sessions: Object.keys(sessions).length,
      attachments: Object.keys(attachments).length,
      sessionBytes,
      attachmentBytes,
      bytes: sessionBytes + attachmentBytes,
      files: files.length,
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// planPull（只读，不写本地）
// ---------------------------------------------------------------------------

/**
 * @param {{state?:object, store?:object, svc?:object, warn?:Function}} ctx
 * @param {{snapshot?:any, readJson:Function, readText:Function, readFile:Function}} remote
 * @returns {{actions:{kind:string,title?:string,detail?:string}[], summary:object, warnings:string[], context:object}}
 */
export async function planPull(ctx = {}, remote) {
  const warnings = [];
  const actions = [];
  const counts = { write: 0, skip: 0, fork: 0, blocked: 0, attachments: 0 };
  let bytes = 0;
  const empty = () => ({
    actions,
    summary: { ...counts, items: 0, bytes: 0 },
    warnings,
    context: { index: null, stamp: null, items: [] },
  });

  if (!remote || typeof remote.readJson !== 'function' || typeof remote.readFile !== 'function') {
    warnings.push('远端读取接口不可用，无法规划 sessions 拉取');
    return empty();
  }

  const index = await tryReadJson(remote, INDEX_PATH);
  if (!index || typeof index !== 'object' || !index.sessions || typeof index.sessions !== 'object') {
    warnings.push('远端没有可用的 sessions/_index.json，sessions 分区无可拉取内容');
    return empty();
  }
  if (index.schema !== 1) warnings.push(`sessions/_index.json schema=${index.schema}，按 v1 兼容处理`);

  const projects = index.projects && typeof index.projects === 'object' ? index.projects : {};
  const sessionsIndex = index.sessions;
  const attachmentsIndex = index.attachments && typeof index.attachments === 'object' ? index.attachments : {};
  const stamp = stampFromBackupDir(ctx?.backupDir) ?? makeStamp();
  const fallbackCwd = firstAvailableWorkspace(ctx);
  const cwdCache = new Map();
  const cwdForProject = (project) => {
    if (cwdCache.has(project)) return cwdCache.get(project);
    const cwd = resolveTargetCwd(project, projects[project], ctx, fallbackCwd, warnings);
    cwdCache.set(project, cwd);
    return cwd;
  };

  const items = [];

  for (const [id, entry] of Object.entries(sessionsIndex)) {
    if (!isSafeSegment(id)) {
      warnings.push(`远端会话 id 不合法，已跳过：${JSON.stringify(String(id).slice(0, 40))}`);
      continue;
    }
    const title = typeof entry?.title === 'string' && entry.title.trim() ? entry.title.trim() : null;
    const project = typeof entry?.project === 'string' ? entry.project : '';
    const label = title || id;

    if (!isSafeRemoteSegment(project)) {
      warnings.push(`远端会话 ${id} 的 project 字段不合法，已跳过`);
      counts.blocked += 1;
      actions.push({ kind: 'blocked', title: label, detail: 'project 字段不合法，拒绝写入' });
      continue;
    }

    const targetCwd = cwdForProject(project);
    if (!targetCwd) {
      counts.blocked += 1;
      actions.push({ kind: 'blocked', title: label, detail: '本机没有可用工作区' });
      continue;
    }

    const remotePath = sessionRemotePath(project, id);
    const remoteBuf = await tryReadFile(remote, remotePath);
    if (!remoteBuf) {
      warnings.push(`远端会话读取失败：${remotePath}`);
      counts.blocked += 1;
      actions.push({ kind: 'blocked', title: label, detail: `远端文件读取失败：${remotePath}` });
      continue;
    }

    let check;
    try {
      check = validateSession(remoteBuf);
    } catch (err) {
      warnings.push(`远端会话 ${id} 无法解析：${err.message}`);
      counts.blocked += 1;
      actions.push({ kind: 'blocked', title: label, detail: `会话校验失败：${err.message}` });
      continue;
    }
    if (!check.ok) {
      warnings.push(`远端会话 ${id} 校验失败（坏行 ${check.badLines}），已跳过`);
      counts.blocked += 1;
      actions.push({ kind: 'blocked', title: label, detail: `会话校验失败（坏行 ${check.badLines}）` });
      continue;
    }

    let rewritten;
    try {
      rewritten = rewriteSession(remoteBuf, { newCwd: targetCwd }).buffer;
    } catch (err) {
      warnings.push(`会话 ${id} cwd 重映射失败：${err.message}`);
      counts.blocked += 1;
      actions.push({ kind: 'blocked', title: label, detail: `cwd 重映射失败：${err.message}` });
      continue;
    }

    const dir = projectDir(targetCwd);
    const localFile = join(dir, id, SESSION_FILE);
    let action = 'write';
    let reason = '本地不存在，写入';
    let forkFile = null;

    if (existsSync(localFile)) {
      let localBuf = null;
      try {
        localBuf = readFileSync(localFile);
      } catch (err) {
        warnings.push(`本地会话 ${id} 不可读，将覆盖写入：${err.message}`);
      }
      if (!localBuf) {
        action = 'write';
        reason = '本地文件不可读，覆盖写入';
      } else if (localBuf.equals(rewritten)) {
        action = 'skip';
        reason = '内容一致';
      } else {
        let cmp;
        try {
          cmp = compareSessions(localBuf, rewritten);
        } catch {
          cmp = 'diverged';
        }
        if (cmp === 'equal') {
          action = 'skip';
          reason = 'body 一致（仅 cwd 不同）';
        } else if (cmp === 'local-ahead') {
          action = 'skip';
          reason = '本地更新（本地 body 是远端的前缀扩展），保留本地';
          warnings.push(`会话 ${id} 本地领先远端，已跳过（保留本地）`);
        } else if (cmp === 'remote-ahead') {
          action = 'write';
          reason = '远端更新（远端 body 是本地的前缀扩展），覆盖本地';
        } else {
          action = 'fork';
          reason = `两端分叉：保留本地，远端版本另存为 ${id}-remote-<stamp>.jsonl.zstd`;
          warnings.push(`会话 ${id} 两端分叉：本地保留，远端版本另存为 ${id}-remote-${stamp}.jsonl.zstd`);
        }
      }
    }

    // 附件计划：只还原本地缺失的对象；applyPull 时再真正取字节（plan 不缓存大 Buffer）
    const attachmentPlan = [];
    for (const ref of collectAttachmentRefs(remoteBuf)) {
      const local = localAttachmentPath(ref.sha);
      if (!local || existsSync(local)) continue;
      const meta = attachmentsIndex[ref.sha] && typeof attachmentsIndex[ref.sha] === 'object'
        ? attachmentsIndex[ref.sha]
        : {};
      const rawExt = typeof meta.ext === 'string' ? meta.ext.toLowerCase() : '';
      const ext = /^[a-z0-9]{1,8}$/.test(rawExt) ? rawExt : extFor(ref.mediaType, ref.name);
      attachmentPlan.push({ sha: ref.sha, ext, name: meta.name ?? ref.name ?? null });
    }
    for (const att of attachmentPlan) {
      counts.attachments += 1;
      actions.push({
        kind: 'attachment',
        title: att.name || att.sha.slice(0, 12),
        detail: `还原附件 ${attachmentRemotePath(att.sha, att.ext)}`,
      });
    }

    if (action === 'fork') {
      forkFile = join(dir, `${id}-remote-${stamp}.jsonl.zstd`);
    }
    counts[action] += 1;
    if (action === 'write' || action === 'fork') bytes += rewritten.length;

    const detailParts = [reason, `→ ${targetCwd}`];
    if (action !== 'skip' || attachmentPlan.length) {
      detailParts.push(formatBytes(rewritten.length));
    }
    actions.push({ kind: action, title: label, detail: detailParts.join(' · ') });

    items.push({
      id,
      project,
      title,
      targetCwd,
      action,
      remotePath,
      localFile,
      forkFile,
      bytes: rewritten.length,
      bodySha: sha256(sessionBody(rewritten)),
      // applyPull 重新读远端再重映射；这里只带引用，避免 plan 里塞大 Buffer
      attachments: attachmentPlan,
    });
  }

  return {
    actions,
    summary: {
      write: counts.write,
      skip: counts.skip,
      fork: counts.fork,
      blocked: counts.blocked,
      attachments: counts.attachments,
      items: items.length,
      bytes,
    },
    warnings,
    context: { index, stamp, items },
  };
}

// ---------------------------------------------------------------------------
// applyPull（只落地 sessions / attachments / workspaceRegistry）
// ---------------------------------------------------------------------------

/** 把会话挂到工作区：resolveByPath → create（目录必须存在）→ attachSession */
async function attachToWorkspace(ctx, cwd, title, sessionId, stampState, warnings) {
  const registry = ctx?.svc?.workspaceRegistry;
  if (!registry) {
    warnings.push('workspaceRegistry 不可用：会话已写入磁盘，但无法挂载到工作区');
    return;
  }
  const key = cwd.toLowerCase();
  let ws = stampState.wsCache.get(key);
  if (!ws) {
    try {
      ws = typeof registry.resolveByPath === 'function' ? await registry.resolveByPath(cwd) : null;
    } catch (err) {
      warnings.push(`解析工作区失败（${cwd}）：${err.message}`);
      ws = null;
    }
    if (!ws && typeof registry.create === 'function') {
      try {
        ws = await registry.create(cwd, title || basename(cwd));
        stampState.applied.workspacesCreated += 1;
      } catch (err) {
        warnings.push(`创建工作区失败（${cwd}）：${err.message}`);
        return;
      }
    }
    if (ws) stampState.wsCache.set(key, ws);
  }
  if (!ws) {
    warnings.push(`工作区不可用，会话无法挂载：${cwd}`);
    return;
  }
  if (typeof ws.attachSession !== 'function') {
    warnings.push(`工作区对象没有 attachSession，会话未挂载：${sessionId}`);
    return;
  }
  try {
    await ws.attachSession(sessionId);
  } catch (err) {
    warnings.push(`挂载会话失败（${sessionId}）：${err.message}`);
  }
}

/**
 * @param {{state?:object, store?:object, svc?:object, warn?:Function}} ctx
 * @param {{snapshot?:any, readJson:Function, readText:Function, readFile:Function}} remote
 * @param {object} plan planPull() 的返回值
 * @returns {{warnings:string[], applied:object, restartRequired?:boolean}}
 */
export async function applyPull(ctx = {}, remote, plan) {
  const warnings = [];
  const applied = {
    sessions: 0,
    forked: 0,
    attachments: 0,
    workspacesCreated: 0,
    backups: [],
  };
  const context = plan?.context && typeof plan.context === 'object' ? plan.context : {};
  const items = Array.isArray(context.items) ? context.items : [];
  if (!items.length) return { warnings, applied };
  if (!remote || typeof remote.readFile !== 'function') {
    warnings.push('远端读取接口不可用，sessions 拉取未落地');
    return { warnings, applied };
  }

  const stamp = typeof context.stamp === 'string' && context.stamp ? context.stamp : makeStamp();
  const backupRoot = typeof ctx?.backupDir === 'string' && ctx.backupDir
    ? ctx.backupDir
    : join(backupsDir(), stamp);
  const stampState = { applied, wsCache: new Map() };

  // 1) 附件先就位：会话文件里引用的附件在打开会话前就应该存在
  const seenAttachments = new Set();
  for (const item of items) {
    for (const att of Array.isArray(item?.attachments) ? item.attachments : []) {
      if (!att || typeof att.sha !== 'string' || seenAttachments.has(att.sha)) continue;
      seenAttachments.add(att.sha);
      const local = localAttachmentPath(att.sha);
      if (!local) {
        warnings.push(`附件 sha 不合法，拒绝写入：${JSON.stringify(String(att.sha).slice(0, 40))}`);
        continue;
      }
      if (existsSync(local)) continue;
      const ext = typeof att.ext === 'string' && /^[a-z0-9]{1,8}$/.test(att.ext) ? att.ext : 'bin';
      const remotePath = attachmentRemotePath(att.sha, ext);
      const data = await tryReadFile(remote, remotePath);
      if (!data) {
        warnings.push(`远端附件读取失败：${remotePath}`);
        continue;
      }
      if (sha256(data) !== att.sha.toLowerCase()) {
        warnings.push(`附件内容与 sha 不符，拒绝写入：${remotePath}`);
        continue;
      }
      try {
        const res = restoreAttachment(att.sha, data);
        if (res?.written) applied.attachments += 1;
      } catch (err) {
        warnings.push(`附件写入失败（${remotePath}）：${err.message}`);
      }
    }
  }

  // 2) 会话：重压头帧改 cwd → 备份 → 写入 → 注册工作区
  for (const item of items) {
    if (!item || (item.action !== 'write' && item.action !== 'fork')) continue;
    if (!isSafeSegment(item.id)) {
      warnings.push(`会话 id 不合法，拒绝写入：${JSON.stringify(String(item.id).slice(0, 40))}`);
      continue;
    }
    const targetCwd = typeof item.targetCwd === 'string' ? item.targetCwd : '';
    if (!isDirectory(targetCwd)) {
      warnings.push(`工作区目录不存在，跳过会话 ${item.id}：${targetCwd || '(空)'}`);
      continue;
    }
    const remotePath = item.remotePath;
    if (!isSafeRemoteSessionPath(remotePath)) {
      warnings.push(`远端会话路径不合法，拒绝读取：${JSON.stringify(String(remotePath).slice(0, 80))}`);
      continue;
    }

    let rewritten;
    try {
      const remoteBuf = await tryReadFile(remote, remotePath);
      if (!remoteBuf) {
        warnings.push(`远端会话读取失败：${remotePath}`);
        continue;
      }
      const check = validateSession(remoteBuf);
      if (!check.ok) {
        warnings.push(`远端会话校验失败（坏行 ${check.badLines}），跳过：${item.id}`);
        continue;
      }
      rewritten = rewriteSession(remoteBuf, { newCwd: targetCwd });
    } catch (err) {
      warnings.push(`会话 ${item.id} 重映射失败：${err.message}`);
      continue;
    }

    const dir = projectDir(targetCwd);
    ensureDir(dir);

    if (item.action === 'fork') {
      // 分叉：本地文件保持原样，远端版本另存为同项目目录下的扁平文件（人工合并素材）
      const forkFile = join(dir, `${item.id}-remote-${stamp}.jsonl.zstd`);
      try {
        writeFileAtomic(forkFile, rewritten.buffer);
        applied.forked += 1;
        warnings.push(`会话 ${item.id} 分叉：远端版本已另存为 ${forkFile}`);
      } catch (err) {
        warnings.push(`会话 ${item.id} 分叉副本写入失败：${err.message}`);
      }
      continue;
    }

    const localFile = join(dir, item.id, SESSION_FILE);
    if (existsSync(localFile)) backupSessionFile(localFile, targetCwd, backupRoot, applied, warnings);
    try {
      writeFileAtomic(localFile, rewritten.buffer);
      applied.sessions += 1;
    } catch (err) {
      warnings.push(`会话 ${item.id} 写入失败：${err.message}`);
      continue;
    }
    await attachToWorkspace(ctx, targetCwd, item.title, item.id, stampState, warnings);
  }

  return { warnings, applied, restartRequired: false };
}

export default {
  name: NAME,
  defaultEnabled: DEFAULT_ENABLED,
  export: exportSessions,
  planPull,
  applyPull,
};

// DESIGN.md §5 要求 re-export 的会话算法入口（名字按契约固定）
export {
  readHeader as readSessionHeader,
  rewriteSession as rewriteSessionCwd,
  sessionBody,
  compareSessions,
} from './vendor/sessionlog.mjs';