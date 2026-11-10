// skills 分区：同步 $DSH_HOME/skills 下的技能文件（默认关闭）。
// 契约见 DESIGN.md §1/§3/§5：export 返回 skills/_index.json + skills/<rel>；
// pull 以远端为准、覆盖前先备份、不删除本地多余文件。
import { copyFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { skillsRoot } from '../paths.mjs';
import {
  DEFAULT_EXCLUDES, ensureDir, nowIso, readBuffer, safeRelPath, sha256,
} from '../util.mjs';
import { isHardBlocked, scanFolder } from '../vendor/folders.mjs';
import { assertInsideRoot } from '../vendor/guard.mjs';

export const SECTION_NAME = 'skills';

const INDEX_PATH = 'skills/_index.json';
const LIMITS = {
  maxFiles: 2000,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
  maxDepth: 12,
};

function jsonFile(payload) {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function scanLocalSkills() {
  const root = skillsRoot();
  const scanned = scanFolder(root, { patterns: DEFAULT_EXCLUDES, limits: LIMITS });
  return { root, ...scanned };
}

function localIndex(scanned) {
  const index = new Map();
  for (const file of scanned.files) {
    const buf = readBuffer(file.abs);
    if (!buf) continue;
    index.set(file.rel, { sha256: sha256(buf), size: buf.length });
  }
  return index;
}

async function readRemoteIndex(remote) {
  const payload = await remote.readJson(INDEX_PATH);
  if (payload === null || typeof payload !== 'object') return null;
  const files = payload.files && typeof payload.files === 'object' && !Array.isArray(payload.files)
    ? payload.files
    : {};
  return { files };
}

/** 校验远端相对路径：必须是安全相对路径，且不能是硬阻断的密钥类文件 */
function validateRel(relPath) {
  const safe = safeRelPath(relPath);
  if (!safe) return null;
  if (isHardBlocked(safe)) return null;
  return safe;
}

function backupFile(ctx, relPath, abs) {
  const backupDir = ctx?.backupDir;
  if (!backupDir) return false;
  const target = join(backupDir, 'skills', relPath);
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

const skillsSection = {
  name: SECTION_NAME,
  defaultEnabled: false,

  async export(ctx) {
    const warnings = [];
    let scanned;
    try {
      scanned = scanLocalSkills();
    } catch (err) {
      warnings.push(`读取技能目录失败：${err?.message ?? err}`);
      return { files: [], summary: { available: false, files: 0 }, warnings };
    }

    for (const item of scanned.blocked) {
      warnings.push(`跳过技能文件 ${item.rel}：${item.reason}`);
    }
    if (scanned.files.length === 0 && scanned.blocked.length === 0) {
      return {
        files: [],
        summary: { files: 0, bytes: 0 },
        warnings: ['技能目录为空，skills 分区没有可导出的内容'],
      };
    }

    const index = {};
    const files = [];
    for (const file of scanned.files) {
      const buf = readBuffer(file.abs);
      if (!buf) {
        warnings.push(`无法读取技能文件 ${file.rel}`);
        continue;
      }
      index[file.rel] = { sha256: sha256(buf), size: buf.length };
      files.push({ path: `skills/${file.rel}`, content: buf });
    }
    files.push({
      path: INDEX_PATH,
      content: jsonFile({
        schema: 1,
        updatedAt: nowIso(),
        device: ctx?.state?.device ?? null,
        files: index,
      }),
    });

    return {
      files,
      summary: {
        files: Object.keys(index).length,
        bytes: scanned.totalBytes,
        blocked: scanned.blocked.length,
      },
      warnings,
    };
  },

  async planPull(ctx, remote) {
    const remoteIndex = await readRemoteIndex(remote);
    if (!remoteIndex) {
      return {
        actions: [],
        summary: { files: 0, add: 0, update: 0 },
        warnings: ['远端没有 skills/_index.json，跳过 skills 分区'],
        context: { remote: null },
      };
    }

    const warnings = [];
    let local;
    try {
      local = localIndex(scanLocalSkills());
    } catch {
      local = new Map();
    }

    const actions = [];
    let add = 0;
    let update = 0;
    for (const [relPath, meta] of Object.entries(remoteIndex.files)) {
      const safe = validateRel(relPath);
      if (!safe) {
        warnings.push(`远端技能路径不安全，已忽略：${relPath}`);
        continue;
      }
      const hit = local.get(safe);
      if (!hit) {
        actions.push({ kind: 'add', title: safe, detail: `新增技能文件（${meta?.size ?? 0} B）` });
        add += 1;
      } else if (meta?.sha256 && hit.sha256 !== meta.sha256) {
        actions.push({ kind: 'update', title: safe, detail: '覆盖本地技能文件' });
        update += 1;
      }
    }

    return {
      actions,
      summary: { files: Object.keys(remoteIndex.files).length, add, update },
      warnings,
      context: { remote: remoteIndex },
    };
  },

  async applyPull(ctx, remote, plan) {
    const remoteIndex = plan?.context?.remote ?? (await readRemoteIndex(remote));
    if (!remoteIndex) return { warnings: ['远端没有 skills/_index.json，跳过'], applied: {}, restartRequired: false };

    const root = skillsRoot();
    ensureDir(root);
    const warnings = [];
    const applied = { written: 0, unchanged: 0, backedUp: 0 };
    if (!ctx?.backupDir) warnings.push('未提供备份目录，覆盖的文件无法先备份');

    for (const [relPath, meta] of Object.entries(remoteIndex.files)) {
      const safe = validateRel(relPath);
      if (!safe) {
        warnings.push(`远端技能路径不安全，已忽略：${relPath}`);
        continue;
      }
      const abs = assertInsideRoot(root, join(root, safe), '技能文件');
      const buf = await remote.readFile(`skills/${safe}`);
      if (!buf) {
        warnings.push(`远端缺少技能文件内容：${safe}`);
        continue;
      }
      if (meta?.sha256 && sha256(buf) !== meta.sha256) {
        warnings.push(`技能文件校验和不一致（仍以远端内容为准）：${safe}`);
      }
      const current = readBuffer(abs);
      if (current && sha256(current) === sha256(buf)) {
        applied.unchanged += 1;
        continue;
      }
      try {
        if (current) {
          if (backupFile(ctx, safe, abs)) applied.backedUp += 1;
          else warnings.push(`覆盖 ${safe} 前未备份`);
        }
        writeAtomic(abs, buf);
        applied.written += 1;
      } catch (err) {
        warnings.push(`写入技能文件 ${safe} 失败：${err?.message ?? err}`);
      }
    }

    return { warnings, applied, restartRequired: false };
  },
};

export default skillsSection;