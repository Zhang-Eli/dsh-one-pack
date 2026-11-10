// files 分区：把用户登记的工作目录（state.files.paths）镜像到远端，pull 时还原到原位置。
// 契约见 DESIGN.md §1/§3/§5：files/_index.json + files/<projectKey>/<rel>；
// 同名不同内容不覆盖，另存 .remote-<stamp><ext>；写前备份；硬排除 + 体积上限。
import { copyFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';
import { stateDir } from '../paths.mjs';
import {
  DEFAULT_EXCLUDES, ensureDir, nowIso, readBuffer, safeRelPath, sha256, stamp,
} from '../util.mjs';
import { isHardBlocked, scanFolder } from '../vendor/folders.mjs';
import { assertInsideRoot, isInsideRoot } from '../vendor/guard.mjs';
import { projectKey } from '../vendor/projectkey.mjs';

export const SECTION_NAME = 'files';

/** projectKey 里允许 ~ 转义，因此不能用 guard 的 isSafeSegment（只允许 [A-Za-z0-9._-]） */
const PROJECT_KEY = /^--[A-Za-z0-9._~-]+$/;

function isSafeProjectKey(key) {
  return typeof key === 'string'
    && key.length > 2
    && key.length <= 251
    && !key.includes('..')
    && PROJECT_KEY.test(key);
}

const INDEX_PATH = 'files/_index.json';
const LIMITS = {
  maxFiles: 2000,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
  maxDepth: 12,
};

function jsonFile(payload) {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function isDirectory(dir) {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** 登记的目录按字面去重，并跳过被更上层登记目录包住的嵌套目录，避免同一文件两边重复 */
function resolveSources(ctx) {
  const raw = Array.isArray(ctx?.state?.files?.paths) ? ctx.state.files.paths : [];
  const warnings = [];
  const seen = new Set();
  const accepted = [];
  for (const item of raw) {
    const dir = typeof item === 'string' ? item : String(item?.path ?? '');
    if (!dir || !isAbsolute(dir)) {
      warnings.push(`忽略非绝对路径：${dir || '(空)'}`);
      continue;
    }
    const key = projectKey(dir);
    if (seen.has(key)) continue;
    if (accepted.some((kept) => isInsideRoot(kept, dir))) {
      warnings.push(`跳过嵌套登记目录：${dir}`);
      continue;
    }
    seen.add(key);
    accepted.push(dir);
  }
  return { dirs: accepted, warnings };
}

function scanSources(ctx) {
  const warnings = [];
  const { dirs } = resolveSources(ctx);
  const patterns = [
    ...DEFAULT_EXCLUDES,
    ...(Array.isArray(ctx?.state?.files?.patterns) ? ctx.state.files.patterns : []),
  ];
  const projects = {};
  const out = [];
  let blocked = 0;
  let bytes = 0;

  for (const dir of dirs) {
    const key = projectKey(dir);
    if (!isSafeProjectKey(key)) {
      warnings.push(`目录键不合法，已跳过：${dir}`);
      continue;
    }
    if (!isDirectory(dir)) {
      warnings.push(`登记的目录不存在，已跳过：${dir}`);
      continue;
    }
    let scanned;
    try {
      scanned = scanFolder(dir, { patterns, limits: LIMITS });
    } catch (err) {
      warnings.push(`扫描 ${dir} 失败：${err?.message ?? err}`);
      continue;
    }
    blocked += scanned.blocked.length;
    for (const item of scanned.blocked) {
      warnings.push(`跳过 ${item.rel}（${dir}）：${item.reason}`);
    }
    projects[key] = { originalCwd: dir, title: basename(dir) };
    for (const file of scanned.files) {
      const buf = readBuffer(file.abs);
      if (!buf) {
        warnings.push(`无法读取 ${file.abs}`);
        continue;
      }
      bytes += buf.length;
      out.push({
        rel: `${key}/${file.rel}`,
        content: buf,
        sha256: sha256(buf),
        size: buf.length,
      });
    }
  }
  return { projects, files: out, blocked, bytes, warnings };
}

async function readRemoteIndex(remote) {
  const payload = await remote.readJson(INDEX_PATH);
  if (payload === null || typeof payload !== 'object') return null;
  const projects = payload.projects && typeof payload.projects === 'object' && !Array.isArray(payload.projects)
    ? payload.projects
    : {};
  const files = payload.files && typeof payload.files === 'object' && !Array.isArray(payload.files)
    ? payload.files
    : {};
  return { projects, files };
}

/** 'files/<project>/<rel>' 形式的远端键 → {project, rel}；不合法返回 null */
function splitRemotePath(relPath) {
  const safe = safeRelPath(relPath);
  if (!safe) return null;
  const slash = safe.indexOf('/');
  if (slash <= 0) return null;
  const project = safe.slice(0, slash);
  const rel = safe.slice(slash + 1);
  if (!isSafeProjectKey(project) || !rel) return null;
  const inner = safeRelPath(rel);
  if (!inner || isHardBlocked(inner)) return null;
  return { project, rel: inner };
}

function restoreRoot(state, project) {
  const configured = Array.isArray(state?.files?.paths) ? state.files.paths : [];
  for (const item of configured) {
    const dir = typeof item === 'string' ? item : item?.path;
    if (typeof dir === 'string' && dir && projectKey(dir) === project && isAbsolute(dir)) {
      if (isDirectory(dir)) return { dir, mapped: false };
      // 原目录不在本机：落到状态目录下的 restore/<project>
      return { dir: join(stateDir(), 'restore', project), mapped: true };
    }
  }
  const original = null;
  return { dir: join(stateDir(), 'restore', project), mapped: true, original };
}

/**
 * 计算每个远端文件要落到哪里、本地是否已有同名不同内容。
 * 只读：planPull 与 applyPull 共用（apply 可直接使用 plan.context）。
 */
function buildTargets(ctx, remoteData) {
  const warnings = [];
  const targets = [];
  const stampValue = stamp();
  for (const [remotePath, meta] of Object.entries(remoteData.files)) {
    const parsed = splitRemotePath(remotePath);
    if (!parsed) {
      warnings.push(`远端文件路径不安全，已忽略：${remotePath}`);
      continue;
    }
    const projectMeta = remoteData.projects[parsed.project];
    const project = projectMeta?.originalCwd
      ? projectKey(String(projectMeta.originalCwd))
      : parsed.project;
    const base = restoreRoot(ctx?.state, project);
    const abs = join(base.dir, parsed.rel);
    assertInsideRoot(base.dir, abs, '工作区文件');
    const current = readBuffer(abs);
    const localSha = current ? sha256(current) : null;
    const remoteSha = typeof meta?.sha256 === 'string' ? meta.sha256 : null;
    let kind = 'add';
    if (localSha) kind = remoteSha && localSha === remoteSha ? 'same' : 'conflict';
    targets.push({
      remotePath,
      remoteFile: `files/${remotePath}`,
      project,
      rel: parsed.rel,
      baseDir: base.dir,
      abs,
      mapped: base.mapped,
      kind,
      remoteSha,
    });
    if (base.mapped) warnings.push(`原目录不在本机，${parsed.project} 将还原到 ${base.dir}`);
  }
  return { targets, warnings, stampValue };
}

function conflictPath(abs, stampValue) {
  const ext = extname(abs);
  const stem = abs.slice(0, abs.length - ext.length);
  return `${stem}.remote-${stampValue}${ext}`;
}

function backupFile(ctx, project, rel, abs) {
  const backupDir = ctx?.backupDir;
  if (!backupDir) return false;
  const target = join(backupDir, 'files', project, rel);
  ensureDir(dirname(target));
  copyFileSync(abs, target);
  return true;
}

function writeAtomic(abs, buf) {
  ensureDir(dirname(abs));
  const tmp = `${abs}.tmp-${process.pid}`;
  writeFileSync(tmp, buf);
  renameSync(tmp, abs);
}

const filesSection = {
  name: SECTION_NAME,
  defaultEnabled: false,

  async export(ctx) {
    const warnings = [];
    const scanned = scanSources(ctx);
    warnings.push(...scanned.warnings);
    const known = Object.keys(scanned.projects).length;
    if (known === 0) {
      return {
        files: [],
        summary: { projects: 0, files: 0, blocked: scanned.blocked },
        warnings: warnings.length ? warnings : ['没有登记可同步的工作目录，files 分区没有内容'],
      };
    }

    const index = {};
    const files = [];
    for (const item of scanned.files) {
      index[item.rel] = { sha256: item.sha256, size: item.size };
      files.push({ path: `files/${item.rel}`, content: item.content });
    }
    files.push({
      path: INDEX_PATH,
      content: jsonFile({
        schema: 1,
        updatedAt: nowIso(),
        device: ctx?.state?.device ?? null,
        projects: scanned.projects,
        files: index,
      }),
    });

    return {
      files,
      summary: {
        projects: known,
        files: scanned.files.length,
        bytes: scanned.bytes,
        blocked: scanned.blocked,
      },
      warnings,
    };
  },

  async planPull(ctx, remote) {
    const remoteIndex = await readRemoteIndex(remote);
    if (!remoteIndex) {
      return {
        actions: [],
        summary: { files: 0, add: 0, conflict: 0 },
        warnings: ['远端没有 files/_index.json，跳过 files 分区'],
        context: { remote: null, targets: [] },
      };
    }

    const { targets, warnings, stampValue } = buildTargets(ctx, remoteIndex);
    const actions = [];
    let add = 0;
    let conflict = 0;
    for (const target of targets) {
      if (target.kind === 'same') continue;
      if (target.kind === 'conflict') {
        actions.push({
          kind: 'conflict',
          title: target.remotePath,
          detail: `本地已有不同内容，将另存为 ${basename(conflictPath(target.abs, stampValue))}`,
        });
        conflict += 1;
      } else {
        actions.push({
          kind: 'add',
          title: target.remotePath,
          detail: target.mapped ? `还原到映射目录 ${target.baseDir}` : '新增文件',
        });
        add += 1;
      }
    }

    return {
      actions,
      summary: { files: targets.length, add, conflict },
      warnings,
      context: { remote: remoteIndex, targets, stamp: stampValue },
    };
  },

  async applyPull(ctx, remote, plan) {
    const remoteIndex = plan?.context?.remote ?? (await readRemoteIndex(remote));
    if (!remoteIndex) return { warnings: ['远端没有 files/_index.json，跳过'], applied: {}, restartRequired: false };
    const built = plan?.context?.targets?.length
      ? { targets: plan.context.targets, warnings: [], stampValue: plan.context.stamp ?? stamp() }
      : buildTargets(ctx, remoteIndex);

    const warnings = [...built.warnings];
    const applied = { written: 0, conflicts: 0, unchanged: 0, mapped: 0 };
    if (!ctx?.backupDir) warnings.push('未提供备份目录，覆盖的文件无法先备份');

    for (const target of built.targets) {
      if (target.kind === 'same') {
        applied.unchanged += 1;
        continue;
      }
      const buf = await remote.readFile(target.remoteFile ?? `files/${target.remotePath}`);
      if (!buf) {
        warnings.push(`远端缺少文件内容：${target.remotePath}`);
        continue;
      }
      if (target.remoteSha && sha256(buf) !== target.remoteSha) {
        warnings.push(`文件校验和不一致（仍以远端内容为准）：${target.remotePath}`);
      }
      try {
        ensureDir(target.baseDir);
        if (target.kind === 'conflict') {
          const current = readBuffer(target.abs);
          if (current) {
            if (backupFile(ctx, target.project, target.rel, target.abs)) {
              // 备份成功
            } else {
              warnings.push(`覆盖 ${target.abs} 前未备份`);
            }
            const alt = conflictPath(target.abs, built.stampValue);
            assertInsideRoot(target.baseDir, alt, '冲突另存文件');
            writeAtomic(alt, buf);
            applied.conflicts += 1;
            warnings.push(`保留本地文件，远端版本另存为 ${alt}`);
          } else {
            writeAtomic(target.abs, buf);
            applied.written += 1;
          }
        } else {
          writeAtomic(target.abs, buf);
          applied.written += 1;
        }
        if (target.mapped) applied.mapped += 1;
      } catch (err) {
        warnings.push(`写入 ${target.abs} 失败：${err?.message ?? err}`);
      }
    }

    return { warnings, applied, restartRequired: false };
  },
};

export default filesSection;