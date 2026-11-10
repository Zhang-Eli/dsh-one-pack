// One Pack · 同步编排器（preview → execute）
// 只依赖 Node 内置模块。分区实现见 lib/sections/*.mjs 与 lib/sessions.mjs。
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { CloudRepo, parseRepo } from './cloud.mjs';
import { backupsDir } from './paths.mjs';
import { SECTIONS } from './state.mjs';
import { ensureDir, formatBytes, nowIso, sha256, stamp, writeJson } from './util.mjs';
import pluginsSection from './sections/plugins.mjs';
import settingsSection from './sections/settings.mjs';
import skillsSection from './sections/skills.mjs';
import filesSection from './sections/files.mjs';
import sessionsSection from './sessions.mjs';

const MANIFEST_PATH = 'one-pack.json';
const README_PATH = 'README.md';
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const PREVIEW_LIMIT = 200;
const TOKEN_REFS = ['ONE_PACK_GITHUB_TOKEN', 'GITHUB_TOKEN'];

/** 分区模块注册表（name → adapter） */
export const SECTION_MODULES = new Map([
  ['plugins', pluginsSection],
  ['settings', settingsSection],
  ['skills', skillsSection],
  ['sessions', sessionsSection],
  ['files', filesSection],
]);

// pull 落地顺序：先环境（插件/设置），再内容，最后会话（依赖 workspaceRegistry）
const APPLY_ORDER = ['plugins', 'settings', 'skills', 'files', 'sessions'];

export class OnePackError extends Error {
  constructor(code, message, detail = undefined) {
    super(message);
    this.name = 'OnePackError';
    this.code = code;
    this.detail = detail;
  }
}

function toBuffer(content) {
  return Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), 'utf8');
}

function warning(code, message) {
  return { code, message };
}

function normalizeWarnings(list) {
  if (!Array.isArray(list)) return [];
  return list.map((item) => {
    if (typeof item === 'string') return warning('WARNING', item);
    if (item && typeof item === 'object') return warning(item.code || 'WARNING', String(item.message ?? item.detail ?? ''));
    return warning('WARNING', String(item));
  });
}

function sanitizeToken(raw) {
  if (typeof raw !== 'string') return null;
  const clean = raw.trim();
  if (!clean || /\s/.test(clean) || clean.length > 500) return null;
  return clean;
}

function summarizeExport(name, exported, warnings) {
  const summary = exported?.summary && typeof exported.summary === 'object' ? { ...exported.summary } : {};
  summary.files = Array.isArray(exported?.files) ? exported.files.length : 0;
  if (warnings.length) summary.warnings = warnings.length;
  return summary;
}

function diffWrites(writes, snapshot, remoteFiles) {
  let added = 0;
  let changed = 0;
  let unchanged = 0;
  let bytes = 0;
  // CloudRepo.state() 返回 {empty, commitSha, treeSha, files: Map}；
  // 兼容直接传 Map 的测试替身。
  const remotePaths = snapshot instanceof Map ? snapshot : snapshot?.files instanceof Map ? snapshot.files : null;
  for (const [relPath, content] of writes) {
    const buf = toBuffer(content);
    bytes += buf.length;
    if (!remotePaths || !remotePaths.has(relPath)) {
      added += 1;
      continue;
    }
    const previous = remoteFiles && remoteFiles[relPath];
    if (typeof previous === 'string' && previous === sha256(buf)) unchanged += 1;
    else changed += 1;
  }
  return { added, changed, unchanged, bytes, files: writes.size };
}

function renderReadme(state, manifest) {
  const sections = manifest.sections || {};
  const lines = [];
  lines.push('# One Pack');
  lines.push('');
  lines.push('由 [dsh-one-pack](https://www.npmjs.com/package/dsh-one-pack) 自动维护的 DSH 环境快照。');
  lines.push('在目标机器安装插件后选择 Pull 即可还原（每个分区都可单独关闭）。');
  lines.push('');
  lines.push(`- 最近更新：${manifest.updatedAt}`);
  lines.push(`- 来源设备：${manifest.device?.name || 'unknown'} (${manifest.device?.platform || 'unknown'})`);
  lines.push(`- 本地仓库配置：${state.repo || '—'} @ ${state.branch || 'main'}`);
  lines.push('');
  lines.push('## 分区');
  lines.push('');
  lines.push('| 分区 | 摘要 |');
  lines.push('| --- | --- |');
  for (const name of SECTIONS) {
    const summary = sections[name];
    if (!summary) {
      lines.push(`| ${name} | 未包含 |`);
      continue;
    }
    const detail = Object.entries(summary)
      .filter(([key]) => key !== 'files' && key !== 'warnings')
      .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`)
      .join(', ');
    lines.push(`| ${name} | ${detail || '—'} |`);
  }
  const total = Object.keys(manifest.files || {}).length;
  lines.push('');
  lines.push(`共 ${total} 个文件。请勿手工编辑此仓库文件，否则下次 Push 会覆盖。`);
  lines.push('');
  return lines.join('\n');
}

function sectionPrefixes(sections) {
  return sections.map((name) => `${name}/`);
}

export class SyncEngine {
  constructor({ store, svc = {}, cloudFactory = null }) {
    this.store = store;
    this.svc = svc;
    /** 测试注入：() => 兼容 CloudRepo 接口的实例；生产环境为 null */
    this.cloudFactory = typeof cloudFactory === 'function' ? cloudFactory : null;
    /** @type {Map<string, {token:string,direction:string,sections:string[],force:boolean,createdAt:number,expiresAt:number}>} */
    this.pending = new Map();
  }

  // ---------- 基础设施 ----------

  async resolveToken() {
    const credentials = this.svc.credentials;
    if (!credentials || typeof credentials.resolve !== 'function') return null;
    for (const ref of TOKEN_REFS) {
      let resolved;
      try {
        resolved = await credentials.resolve(ref);
      } catch {
        continue;
      }
      const clean = sanitizeToken(resolved?.value ?? resolved?.secret ?? resolved);
      if (clean) return { ref, token: clean };
    }
    return null;
  }

  async hasToken() {
    return (await this.resolveToken()) !== null;
  }

  repoInfo(state) {
    if (!state.repo) return { valid: false, reason: '未配置仓库' };
    try {
      const parsed = parseRepo(state.repo);
      return { valid: true, owner: parsed.owner, repo: parsed.repo };
    } catch (err) {
      return { valid: false, reason: String(err?.message ?? err) };
    }
  }

  sectionsMeta() {
    const state = this.store.read();
    return SECTIONS.map((name) => {
      const mod = SECTION_MODULES.get(name);
      return {
        name,
        enabled: Boolean(state.sections[name]),
        defaultEnabled: Boolean(mod?.defaultEnabled),
        available: Boolean(mod),
      };
    });
  }

  effectiveSections(state, requested) {
    if (Array.isArray(requested) && requested.length > 0) {
      const names = [...new Set(requested.filter((name) => SECTIONS.includes(name)))];
      if (names.length === 0) throw new OnePackError('INVALID_SECTIONS', '没有可用的同步分区');
      return names;
    }
    return SECTIONS.filter((name) => state.sections[name]);
  }

  sectionContext(state, backupDir = null, warnings = []) {
    return {
      state,
      store: this.store,
      svc: this.svc,
      backupDir,
      warn: (message) => warnings.push(warning('WARNING', String(message))),
    };
  }

  async openCloud() {
    const state = this.store.read();
    const info = this.repoInfo(state);
    if (!info.valid) throw new OnePackError('CONFIG', `仓库未配置或格式不正确：${state.repo || '空'}`);
    const auth = await this.resolveToken();
    if (!auth) {
      throw new OnePackError('NO_TOKEN', '还没有可用的 GitHub token，请先在 One Pack 面板或 one_pack_setup 工具中设置。');
    }
    const cloud = this.cloudFactory
      ? await this.cloudFactory({ state, info, token: auth.token })
      : new CloudRepo({
          token: auth.token,
          repo: `${info.owner}/${info.repo}`,
          branch: state.branch || 'main',
          userAgent: 'dsh-one-pack',
        });
    return { state, info, cloud, tokenRef: auth.ref };
  }

  remoteView(cloud, snapshot) {
    return {
      snapshot,
      async readJson(relPath) {
        return cloud.readJson(relPath, snapshot);
      },
      async readText(relPath) {
        return cloud.readText(relPath, snapshot);
      },
      async readFile(entryOrPath) {
        return cloud.readFile(entryOrPath, snapshot);
      },
    };
  }

  // ---------- 状态 ----------

  async status() {
    const state = this.store.read();
    const [hasToken, repoInfo] = await Promise.all([this.hasToken(), Promise.resolve(this.repoInfo(state))]);
    const pending = [...this.pending.values()]
      .filter((item) => item.expiresAt > Date.now())
      .map((item) => ({
        direction: item.direction,
        sections: item.sections,
        createdAt: new Date(item.createdAt).toISOString(),
        expiresAt: new Date(item.expiresAt).toISOString(),
      }));
    return {
      repo: state.repo,
      branch: state.branch,
      device: state.device,
      sections: this.sectionsMeta(),
      files: { paths: state.files.paths, patterns: state.files.patterns },
      hasToken,
      repoInfo,
      repoValid: Boolean(repoInfo?.valid),
      lastSync: state.lastSync,
      remote: state.remote,
      pending,
    };
  }

  // ---------- 预览 ----------

  async preview(direction, opts = {}) {
    if (direction !== 'push' && direction !== 'pull') {
      throw new OnePackError('INVALID_DIRECTION', 'direction 必须是 push 或 pull');
    }
    const { state, cloud } = await this.openCloud();
    const sections = this.effectiveSections(state, opts.sections);
    if (sections.length === 0) throw new OnePackError('NO_SECTIONS', '没有启用任何同步分区');
    const force = Boolean(opts.force);
    const result = direction === 'push'
      ? await this.previewPush({ state, cloud, sections, force })
      : await this.previewPull({ state, cloud, sections, force });
    result.sections = sections;
    result.direction = direction;
    return result;
  }

  async previewPush({ state, cloud, sections, force }) {
    const snapshot = await cloud.state();
    const remoteManifest = await cloud.readJson(MANIFEST_PATH, snapshot);
    const warnings = [];
    const remoteFiles = remoteManifest && typeof remoteManifest.files === 'object' ? remoteManifest.files : {};

    if (
      remoteManifest &&
      remoteManifest.device &&
      remoteManifest.device.id !== state.device.id &&
      state.lastSync?.at &&
      String(remoteManifest.updatedAt || '') > String(state.lastSync.at)
    ) {
      warnings.push(
        warning(
          'REMOTE_AHEAD',
          `远端在本机上次同步（${state.lastSync.at}）之后被其他设备（${remoteManifest.device.name || 'unknown'}）更新过；执行时需要 force 才能覆盖。`,
        ),
      );
    }

    const warningsAll = [];
    const exports = new Map();
    const summarySections = {};
    for (const name of sections) {
      const mod = SECTION_MODULES.get(name);
      if (!mod) {
        warningsAll.push(warning('SECTION_MISSING', `分区 ${name} 没有实现`));
        continue;
      }
      const sectionWarnings = [];
      try {
        const ctx = this.sectionContext(state, null, sectionWarnings);
        const exported = await mod.export(ctx);
        exports.set(name, exported);
        summarySections[name] = {
          ...summarizeExport(name, exported, sectionWarnings),
          itemCount: exported?.files?.length ?? 0,
        };
        warningsAll.push(...normalizeWarnings(exported?.warnings), ...sectionWarnings);
      } catch (err) {
        warningsAll.push(warning('SECTION_FAILED', `${name} 导出失败：${err?.message ?? err}`));
        summarySections[name] = { error: String(err?.message ?? err) };
      }
    }

    const writes = new Map();
    for (const exported of exports.values()) {
      for (const file of exported?.files ?? []) {
        const clean = typeof file?.path === 'string' ? file.path : null;
        if (!clean) continue;
        writes.set(clean, file.content);
      }
    }
    const totals = diffWrites(writes, snapshot, remoteFiles);
    const items = [...writes.keys()].slice(0, PREVIEW_LIMIT).map((relPath) => ({ kind: 'write', path: relPath }));

    return this.finishPreview('push', {
      force,
      sections,
      summary: {
        empty: Boolean(snapshot?.empty),
        sections: summarySections,
        totals,
      },
      warnings: [...warnings, ...warningsAll],
      items,
    });
  }

  async previewPull({ state, cloud, sections, force }) {
    const snapshot = await cloud.state();
    const warnings = [];
    if (snapshot?.empty) {
      return this.finishPreview('pull', {
        force,
        sections,
        summary: { empty: true, sections: {}, totals: { files: 0, added: 0, changed: 0, unchanged: 0, bytes: 0 } },
        warnings: [warning('EMPTY_REMOTE', '远端仓库还没有 One Pack 快照，先在一台机器上 Push。')],
        items: [],
      });
    }
    const remote = this.remoteView(cloud, snapshot);
    const plans = new Map();
    const summarySections = {};
    const items = [];
    for (const name of sections) {
      const mod = SECTION_MODULES.get(name);
      if (!mod) {
        warnings.push(warning('SECTION_MISSING', `分区 ${name} 没有实现`));
        continue;
      }
      const sectionWarnings = [];
      try {
        const plan = await mod.planPull(this.sectionContext(state, null, sectionWarnings), remote);
        plans.set(name, plan);
        const actions = Array.isArray(plan?.actions) ? plan.actions : [];
        summarySections[name] = {
          ...(plan?.summary && typeof plan.summary === 'object' ? plan.summary : {}),
          actionCount: actions.length,
        };
        for (const action of actions.slice(0, PREVIEW_LIMIT)) {
          items.push({
            kind: action?.kind ?? 'change',
            section: name,
            title: action?.title ?? action?.id ?? action?.path ?? '',
            detail: action?.detail ?? '',
          });
        }
        warnings.push(...normalizeWarnings(plan?.warnings), ...sectionWarnings);
      } catch (err) {
        warnings.push(warning('SECTION_FAILED', `${name} 计划失败：${err?.message ?? err}`));
        summarySections[name] = { error: String(err?.message ?? err) };
      }
    }
    return this.finishPreview('pull', {
      force,
      sections,
      plans,
      summary: {
        empty: false,
        commitSha: snapshot.commitSha,
        sections: summarySections,
        totals: { files: snapshot.files?.size ?? 0 },
      },
      warnings,
      items,
    });
  }

  finishPreview(direction, { force, sections, summary, warnings, items }) {
    const token = randomUUID();
    const createdAt = Date.now();
    const expiresAt = createdAt + PREVIEW_TTL_MS;
    this.pending.set(token, { token, direction, sections, force, createdAt, expiresAt });
    // 清理过期 pending，避免内存泄漏
    for (const [key, value] of this.pending) {
      if (value.expiresAt <= createdAt) this.pending.delete(key);
    }
    return {
      token,
      direction,
      sections,
      force,
      createdAt: new Date(createdAt).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      summary,
      warnings: normalizeWarnings(warnings),
      items,
    };
  }

  // ---------- 执行 ----------

  consumePending(direction, token) {
    if (typeof token !== 'string' || !token) {
      throw new OnePackError('NO_PREVIEW', '缺少 previewToken，请先调用 preview。');
    }
    const entry = this.pending.get(token);
    if (!entry) throw new OnePackError('PREVIEW_EXPIRED', '预览不存在或已执行/过期，请重新预览。');
    if (entry.expiresAt <= Date.now()) {
      this.pending.delete(token);
      throw new OnePackError('PREVIEW_EXPIRED', '预览已过期，请重新预览。');
    }
    if (entry.direction !== direction) {
      throw new OnePackError('PREVIEW_MISMATCH', `该预览是 ${entry.direction} 的，不能用于 ${direction}。`);
    }
    this.pending.delete(token);
    return entry;
  }

  async execute(direction, opts = {}) {
    if (direction !== 'push' && direction !== 'pull') {
      throw new OnePackError('INVALID_DIRECTION', 'direction 必须是 push 或 pull');
    }
    const entry = this.consumePending(direction, opts.token ?? opts.previewToken);
    const { state, cloud } = await this.openCloud();
    const force = Boolean(entry.force || opts.force);
    if (direction === 'push') return this.executePush({ state, cloud, sections: entry.sections, force });
    return this.executePull({ state, cloud, sections: entry.sections, force });
  }

  async executePush({ state, cloud, sections, force }) {
    const snapshot = await cloud.state();
    const remoteManifest = await cloud.readJson(MANIFEST_PATH, snapshot);
    const remoteFiles = remoteManifest && typeof remoteManifest.files === 'object' ? remoteManifest.files : {};
    const warnings = [];

    const remoteAhead =
      remoteManifest &&
      remoteManifest.device &&
      remoteManifest.device.id !== state.device.id &&
      state.lastSync?.at &&
      String(remoteManifest.updatedAt || '') > String(state.lastSync.at);
    if (remoteAhead && !force) {
      throw new OnePackError(
        'REMOTE_AHEAD',
        '远端已被其他设备更新；确认覆盖请先以 force 重新预览，或在 execute 时传 force。',
      );
    }

    const exports = new Map();
    const summarySections = {};
    const sectionWarnings = [];
    for (const name of sections) {
      const mod = SECTION_MODULES.get(name);
      if (!mod) {
        warnings.push(warning('SECTION_MISSING', `分区 ${name} 没有实现`));
        continue;
      }
      const perSection = [];
      try {
        const ctx = this.sectionContext(state, null, perSection);
        const exported = await mod.export(ctx);
        exports.set(name, exported);
        summarySections[name] = summarizeExport(name, exported, perSection);
        warnings.push(...normalizeWarnings(exported?.warnings), ...perSection);
      } catch (err) {
        warnings.push(warning('SECTION_FAILED', `${name} 导出失败：${err?.message ?? err}`));
        summarySections[name] = { error: String(err?.message ?? err) };
      }
    }

    const writes = new Map();
    for (const exported of exports.values()) {
      for (const file of exported?.files ?? []) {
        if (file && typeof file.path === 'string') writes.set(file.path, file.content);
      }
    }
    if (writes.size === 0) throw new OnePackError('NOTHING_TO_SYNC', '没有可推送的内容（请检查分区开关）。');

    const filesMap = {};
    for (const [relPath, content] of writes) filesMap[relPath] = sha256(toBuffer(content));
    const now = nowIso();
    const manifest = {
      schema: 1,
      updatedAt: now,
      device: state.device,
      sections: summarySections,
      files: filesMap,
    };
    writes.set(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
    writes.set(README_PATH, renderReadme(state, manifest));

    // 删除远端旧文件：仅限本次包含的分区、且不在本次写入中的路径
    const deletes = [];
    const prefixes = sectionPrefixes(sections);
    const previousFiles = remoteManifest && typeof remoteManifest.files === 'object' ? remoteManifest.files : {};
    for (const relPath of Object.keys(previousFiles)) {
      if (!prefixes.some((prefix) => relPath.startsWith(prefix))) continue;
      if (relPath === MANIFEST_PATH || relPath === README_PATH) continue;
      if (!writes.has(relPath)) deletes.push(relPath);
    }

    const message = `one-pack: push from ${state.device.name} [${sections.join(',')}]`;
    const commit = await cloud.commit({
      writes: [...writes.entries()].map(([relPath, content]) => ({ path: relPath, content })),
      deletes,
      message,
      snapshot,
    });

    const finishedAt = nowIso();
    const nextState = this.store.update((current) => ({
      ...current,
      lastSync: { at: finishedAt, commitSha: commit.commitSha, direction: 'push', sections },
      remote: { commitSha: commit.commitSha, at: finishedAt },
    }));
    const result = {
      direction: 'push',
      commitSha: commit.commitSha,
      firstCommit: Boolean(commit.firstCommit),
      sections,
      summary: { sections: summarySections, files: writes.size, deletes: deletes.length },
      warnings: normalizeWarnings(warnings),
      applied: { restartRequired: false },
      lastSync: nextState.lastSync,
    };
    this.store.addHistory({
      direction: 'push',
      sections,
      ok: true,
      commitSha: commit.commitSha,
      summary: result.summary,
      warnings: result.warnings,
    });
    return result;
  }

  async executePull({ state, cloud, sections, force }) {
    const snapshot = await cloud.state();
    if (snapshot?.empty) throw new OnePackError('EMPTY_REMOTE', '远端仓库还没有 One Pack 快照。');
    const remote = this.remoteView(cloud, snapshot);

    // 备份当前可迁移状态（sections 自己备份文件）
    const backupDir = join(backupsDir(), stamp());
    ensureDir(backupDir);
    try {
      writeJson(join(backupDir, 'state.json'), state);
      const cfg = this.svc.configEditor;
      if (cfg && typeof cfg.configuration === 'function') {
        writeJson(join(backupDir, 'settings.json'), await cfg.configuration());
      }
      const pm = this.svc.pluginManager;
      if (pm && typeof pm.listBundles === 'function') {
        writeJson(join(backupDir, 'plugins.json'), {
          bundles: await pm.listBundles(),
          plugins: typeof pm.listPlugins === 'function' ? await pm.listPlugins() : [],
        });
      }
    } catch {
      // 备份失败不阻塞，但要提示
    }

    const warnings = [];
    const summarySections = {};
    const applied = {};
    const failed = [];
    let restartRequired = false;
    for (const name of APPLY_ORDER) {
      if (!sections.includes(name)) continue;
      const mod = SECTION_MODULES.get(name);
      if (!mod) continue;
      const perSection = [];
      try {
        const plan = await mod.planPull(this.sectionContext(state, backupDir, perSection), remote);
        const applyResult = await mod.applyPull(
          this.sectionContext(state, backupDir, perSection),
          remote,
          plan,
        );
        summarySections[name] = {
          ...(plan?.summary && typeof plan.summary === 'object' ? plan.summary : {}),
          applied: true,
        };
        applied[name] = applyResult?.applied ?? true;
        warnings.push(...normalizeWarnings(plan?.warnings), ...normalizeWarnings(applyResult?.warnings), ...perSection);
        if (applyResult?.restartRequired) {
          restartRequired = true;
          warnings.push(warning('RESTART_REQUIRED', `${name} 已应用，部分改动需要重启插件/应用后生效。`));
        }
      } catch (err) {
        failed.push(name);
        warnings.push(warning('SECTION_FAILED', `${name} 应用失败：${err?.message ?? err}`));
        summarySections[name] = { error: String(err?.message ?? err) };
      }
    }

    const finishedAt = nowIso();
    const nextState = this.store.update((current) => ({
      ...current,
      lastSync: { at: finishedAt, commitSha: snapshot.commitSha, direction: 'pull', sections },
      remote: { commitSha: snapshot.commitSha, at: finishedAt },
    }));
    const result = {
      direction: 'pull',
      commitSha: snapshot.commitSha,
      sections,
      summary: { sections: summarySections, applied, failed },
      warnings: normalizeWarnings(warnings),
      applied: { restartRequired },
      lastSync: nextState.lastSync,
      ok: failed.length === 0,
    };
    this.store.addHistory({
      direction: 'pull',
      sections,
      ok: result.ok,
      commitSha: snapshot.commitSha,
      summary: result.summary,
      warnings: result.warnings,
    });
    return result;
  }
}

export { MANIFEST_PATH, README_PATH };