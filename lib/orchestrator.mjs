// One Pack · 同步编排器（preview → execute）
// 只依赖 Node 内置模块。分区实现见 lib/sections/*.mjs 与 lib/sessions.mjs。
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { CloudRepo, DEFAULT_REPO_NAME, ensureSyncRepo, parseRepo } from './cloud.mjs';
import { backupsDir } from './paths.mjs';
import { isScheduleDue, isValidTime, normalizeSchedule } from './schedule.mjs';
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

// 多设备总览 README：根 one-pack.json 是全局索引（schema 2），每台设备的数据
// 位于 devices/<设备ID>/ 命名空间下，互不覆盖；Pull 时可以选择任意设备的备份。
function renderReadme(index) {
  const entries = Object.entries(index.devices || {}).sort(
    (a, b) => String(b[1]?.updatedAt || '').localeCompare(String(a[1]?.updatedAt || '')),
  );
  const lines = [];
  lines.push('# One Pack');
  lines.push('');
  lines.push('由 [dsh-one-pack](https://www.npmjs.com/package/dsh-one-pack) 自动维护的 DSH 环境快照（多设备）。');
  lines.push('在目标机器安装插件后选择 Pull（可选来源设备）即可还原；每个分区都可单独关闭。');
  lines.push('');
  lines.push(`- 最近更新：${index.updatedAt}`);
  lines.push(`- 设备数：${entries.length}`);
  lines.push('');
  lines.push('## 设备');
  lines.push('');
  lines.push('| 设备 | 平台 | 最近更新 | 分区 |');
  lines.push('| --- | --- | --- | --- |');
  for (const [id, device] of entries) {
    const sections = device?.sections || {};
    const included = SECTIONS.filter((name) => sections[name] && !sections[name].error).join('、') || '—';
    lines.push(
      `| ${device?.name || id.slice(0, 8)} (\`${id.slice(0, 8)}\`) | ${device?.platform || 'unknown'} | ${device?.updatedAt || '—'} | ${included} |,`
    );
  }
  lines.push('');
  lines.push('每台设备的完整备份在 devices/<设备ID>/ 下，Push 只更新本设备的命名空间。');
  lines.push('请勿手工编辑本仓库文件，否则下次 Push 会覆盖。');
  lines.push('');
  return lines.join('\n');
}

function sectionPrefixes(sections) {
  return sections.map((name) => `${name}/`);
}

// ---------- 多设备命名空间 ----------
// 根 one-pack.json 是全局索引（schema 2）；每台设备的 manifest 与各分区文件都在
// devices/<deviceId>/ 下。旧版（schema 1）单设备布局在首次 Push 时自动迁移。
const DEVICE_ROOT = 'devices/';
function deviceDir(deviceId) {
  return `${DEVICE_ROOT}${deviceId}/`;
}
function deviceManifestPath(deviceId) {
  return `${deviceDir(deviceId)}${MANIFEST_PATH}`;
}
function shortId(id) {
  return String(id ?? '').slice(0, 8);
}

/** 解析根 one-pack.json：新版索引 / 旧版单设备 manifest / 空 */
function parseRemoteIndex(raw) {
  const empty = { mode: 'empty', devices: [], legacyManifest: null };
  if (!raw || typeof raw !== 'object') return empty;
  if (Number(raw.schema) >= 2 && raw.devices && typeof raw.devices === 'object') {
    const devices = Object.entries(raw.devices).map(([id, d]) => ({
      id,
      name: d?.name || String(id).slice(0, 8),
      platform: d?.platform || 'unknown',
      updatedAt: d?.updatedAt || '',
      sections: d?.sections || null,
      manifest: typeof d?.manifest === 'string' ? d.manifest : deviceManifestPath(id),
      namespace: deviceDir(id),
      legacy: false,
    }));
    return { mode: 'index', devices, legacyManifest: null };
  }
  if (raw.device && raw.files && typeof raw.files === 'object') {
    const id = raw.device.id;
    const devices = id
      ? [{
          id,
          name: raw.device.name || shortId(id),
          platform: raw.device.platform || 'unknown',
          updatedAt: raw.updatedAt || '',
          sections: raw.sections || null,
          manifest: MANIFEST_PATH,
          namespace: '',
          legacy: true,
        }]
      : [];
    return { mode: 'legacy', devices, legacyManifest: raw };
  }
  return empty;
}

function deviceView(device) {
  if (!device) return null;
  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
    updatedAt: device.updatedAt,
    legacy: Boolean(device.legacy),
  };
}

/** 'self'（默认）/'latest'/设备 id → 匹配的设备条目；找不到返回 null */
function pickSource(devices, state, requested) {
  if (!Array.isArray(devices) || devices.length === 0) return null;
  const req = typeof requested === 'string' && requested.trim() ? requested.trim() : 'self';
  if (req === 'latest') {
    return [...devices].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0] ?? null;
  }
  if (req === 'self') return devices.find((d) => d.id === state.device?.id) ?? null;
  return devices.find((d) => d.id === req) ?? null;
}

function devicesText(devices) {
  return devices.map((d) => `${d.name} (${shortId(d.id)})`).join('、');
}

export class SyncEngine {
  constructor({ store, svc = {}, cloudFactory = null, repoCreator = null }) {
    this.store = store;
    this.svc = svc;
    /** 测试注入：() => 兼容 CloudRepo 接口的实例；生产环境为 null */
    this.cloudFactory = typeof cloudFactory === 'function' ? cloudFactory : null
    // 后台同步任务表（内存，随进程结束）：面板用轮询读取，避免长任务卡住界面。
    this.jobs = new Map()
    this.jobSeq = 0;
    /** 自动建仓实现；生产环境是 cloud.ensureSyncRepo，测试可注入假实现 */
    this.repoCreator = typeof repoCreator === 'function' ? repoCreator : ensureSyncRepo;
    /** @type {Map<string, {token:string,direction:string,sections:string[],force:boolean,createdAt:number,expiresAt:number}>} */
    this.pending = new Map();
    /** 定时同步执行中标记：避免同一分钟重复触发或与下一次 tick 叠加 */
    this.scheduleTickBusy = false;
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

  // 删除 token 时要清理所有别名，否则 resolveToken 会回退到旧引用（例如
  // 从 dsh-github-sync 迁移前留下的 GITHUB_TOKEN），面板仍显示已连接，
  // 但那个旧 token 往往没有私有同步仓库的权限，推送会得到 404。
  async clearToken() {
    const credentials = this.svc.credentials;
    if (!credentials || typeof credentials.unset !== 'function') return false;
    let cleared = false;
    for (const ref of TOKEN_REFS) {
      try {
        await credentials.unset(ref);
        cleared = true;
      } catch {
        // 忽略单个引用的清理失败，继续清理其余别名
      }
    }
    return cleared;
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

  /**
   * 自动创建（或复用）token 所属账号下的私有同步仓库，并写入 state.repo。
   * 用户只需保存 token，不需要再手工去 GitHub 建仓、填 owner/repo。
   * @param {{name?:string}} [options]
   * @returns {Promise<{repo:string,login:string,name:string,created:boolean,private:boolean}>}
   */
  async autoCreateRepo({ name } = {}) {
    const state = this.store.read();
    const auth = await this.resolveToken();
    if (!auth) {
      throw new OnePackError('NO_TOKEN', '还没有配置 GitHub token：请先保存 token，再自动创建同步仓库');
    }
    let result;
    try {
      result = await this.repoCreator({
        token: auth.token,
        name: (typeof name === 'string' && name.trim()) || DEFAULT_REPO_NAME,
      });
    } catch (err) {
      if (err?.code === 'NO_TOKEN') throw err;
      if (typeof err?.status === 'number' && err.status === 401) {
        throw new OnePackError('GITHUB_UNAUTHORIZED', err.message || 'GitHub token 无效或已过期');
      }
      if (typeof err?.status === 'number' && err.status === 403) {
        throw new OnePackError('GITHUB_FORBIDDEN', err.message || 'GitHub token 权限不足，无法创建私有仓库');
      }
      throw new OnePackError('REPO_CREATE_FAILED', `创建同步仓库失败：${err?.message ?? err}`);
    }
    const repo = typeof result?.repo === 'string' ? result.repo.trim() : '';
    if (!repo) throw new OnePackError('REPO_CREATE_FAILED', '创建同步仓库失败：GitHub 没有返回仓库地址');
    const branch = state.branch || 'main';
    this.store.update((current) => ({ ...current, repo, branch, remote: { ...(current.remote || {}) } }));
    return {
      repo,
      login: result.login || repo.split('/')[0],
      name: result.name || repo.split('/')[1],
      created: Boolean(result.created),
      private: result.private !== false,
    };
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

  /** prefix='' 读根布局；prefix='devices/<id>/' 读该设备命名空间（分区模块无感知）。 */
  remoteView(cloud, snapshot, prefix = '') {
    const full = (relPath) => (typeof relPath === 'string' && prefix && !relPath.startsWith(prefix) ? prefix + relPath : relPath);
    return {
      snapshot,
      prefix,
      async readJson(relPath) {
        return cloud.readJson(full(relPath), snapshot);
      },
      async readText(relPath) {
        return cloud.readText(full(relPath), snapshot);
      },
      async readFile(entryOrPath) {
        return cloud.readFile(typeof entryOrPath === 'string' ? full(entryOrPath) : entryOrPath, snapshot);
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
      schedule: state.schedule,
      hasToken,
      repoInfo,
      repoValid: Boolean(repoInfo?.valid),
      lastSync: state.lastSync,
      remote: state.remote,
      pending,
      // 后台同步任务：面板切换/重新打开后据此恢复「推送中/拉取中」提示与轮询。
      activeJob: this.listJobs().find((job) => job.status === 'running') ?? null,
    };
  }

  /**
   * 保存定时同步设置。只接受 enabled / time(HH:MM) / direction(push|pull)。
   * @param {{enabled?:boolean,time?:string,direction?:'push'|'pull'}} patch
   */
  async updateSchedule(patch = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new OnePackError('INVALID_SCHEDULE', 'schedule 必须是对象');
    }
    if ('enabled' in patch && typeof patch.enabled !== 'boolean') {
      throw new OnePackError('INVALID_SCHEDULE', 'schedule.enabled 必须是布尔值');
    }
    if ('time' in patch && !isValidTime(patch.time)) {
      throw new OnePackError('INVALID_SCHEDULE', 'schedule.time 必须是 HH:MM（24 小时制）');
    }
    if ('direction' in patch && patch.direction !== 'push' && patch.direction !== 'pull') {
      throw new OnePackError('INVALID_SCHEDULE', 'schedule.direction 必须是 push 或 pull');
    }
    const state = this.store.read();
    const next = normalizeSchedule({ ...state.schedule, ...patch });
    this.store.update((current) => ({ ...current, schedule: next }));
    return next;
  }

  /**
   * 由宿主定时器调用：到点则执行一次同步（默认 push）。
   * 没有 token / 仓库、未启用、当天已跑过、正在跑时都直接返回 null。
   * @param {Date} [now]
   */
  async tickSchedule(now = new Date()) {
    if (this.scheduleTickBusy) return null;
    const state = this.store.read();
    const schedule = state.schedule;
    if (!isScheduleDue(schedule, now, schedule.lastRunAt)) return null;
    this.scheduleTickBusy = true;
    try {
      const { state: fresh, cloud } = await this.openCloud();
      const sections = this.effectiveSections(fresh);
      if (sections.length === 0) throw new OnePackError('NO_SECTIONS', '没有启用任何同步分区');
      const result = schedule.direction === 'pull'
        ? await this.executePull({ state: fresh, cloud, sections, force: false })
        : await this.executePush({ state: fresh, cloud, sections, force: false });
      this.recordScheduledRun({ ok: true, error: '' });
      return result;
    } catch (err) {
      const code = err?.code || 'SCHEDULE_FAILED';
      // 没有变化不算失败，但仍记一次运行，避免当天反复重试。
      const message = code === 'NOTHING_TO_SYNC' ? '' : `${code}: ${err?.message ?? err}`;
      this.recordScheduledRun({ ok: code === 'NOTHING_TO_SYNC', error: message });
      return null;
    } finally {
      this.scheduleTickBusy = false;
    }
  }

  recordScheduledRun({ ok, error = '' }) {
    this.store.update((current) => ({
      ...current,
      schedule: { ...current.schedule, lastRunAt: nowIso(), lastOk: ok, lastError: error },
    }));
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
      : await this.previewPull({ state, cloud, sections, force, sourceDeviceId: opts.sourceDevice });
    result.sections = sections;
    result.direction = direction;
    return result;
  }

  async previewPush({ state, cloud, sections, force }) {
    const snapshot = await cloud.state();
    const rootRaw = await cloud.readJson(MANIFEST_PATH, snapshot);
    const parsed = parseRemoteIndex(rootRaw);
    const warnings = [];
    const myDir = deviceDir(state.device.id);
    const mine = parsed.devices.find((d) => d.id === state.device.id) ?? null;
    let deviceManifest = null;
    if (mine) {
      deviceManifest = await cloud.readJson(mine.manifest, snapshot);
      if (mine.updatedAt && state.lastSync?.at && String(mine.updatedAt) > String(state.lastSync.at)) {
        warnings.push(
          warning(
            'REMOTE_AHEAD',
            `本设备在远端的备份（${mine.updatedAt}）比本机上次同步（${state.lastSync.at}）新，可能来自本机的另一处安装；执行时需要 force 确认覆盖。`,
          ),
        );
      }
    }
    if (parsed.mode === 'legacy') {
      const legacy = parsed.legacyManifest;
      warnings.push(
        warning(
          'LEGACY_LAYOUT',
          legacy?.device?.id === state.device.id
            ? '远端还是旧版单设备布局；本次 Push 会把本设备数据迁移到 devices/<设备ID>/ 命名空间。'
            : `远端是设备 ${legacy?.device?.name || 'unknown'} 的旧版单设备布局；本次 Push 会先代为迁移到各自的 devices/ 命名空间（一次性复制）。`,
        ),
      );
    }
    const remoteFiles = deviceManifest && typeof deviceManifest.files === 'object' ? deviceManifest.files : {};

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
        writes.set(myDir + clean, file.content);
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
        devices: parsed.devices.map(deviceView),
        source: deviceView(mine ?? { id: state.device.id, name: state.device.name, platform: state.device.platform, updatedAt: '' }),
      },
      warnings: [...warnings, ...warningsAll],
      items,
    });
  }

  async previewPull({ state, cloud, sections, force, sourceDeviceId }) {
    const snapshot = await cloud.state();
    const warnings = [];
    if (snapshot?.empty) {
      return this.finishPreview('pull', {
        force,
        sections,
        summary: {
          empty: true,
          devices: [],
          source: null,
          noData: true,
          sections: {},
          totals: { files: 0, added: 0, changed: 0, unchanged: 0, bytes: 0 },
        },
        warnings: [warning('EMPTY_REMOTE', '远端仓库还没有 One Pack 快照，先在一台机器上 Push。')],
        items: [],
        sourceDeviceId: sourceDeviceId ?? 'self',
      });
    }
    const rootRaw = await cloud.readJson(MANIFEST_PATH, snapshot);
    const parsed = parseRemoteIndex(rootRaw);
    const source = pickSource(parsed.devices, state, sourceDeviceId);
    if (!source) {
      const requested =
        sourceDeviceId && sourceDeviceId !== 'self' && sourceDeviceId !== 'latest'
          ? `设备 ${shortId(sourceDeviceId)}`
          : '本设备';
      return this.finishPreview('pull', {
        force,
        sections,
        summary: {
          empty: false,
          devices: parsed.devices.map(deviceView),
          source: null,
          noData: true,
          sections: {},
          totals: { files: 0, added: 0, changed: 0, unchanged: 0, bytes: 0 },
        },
        warnings: [
          warning(
            'EMPTY_REMOTE',
            `${requested}在远端还没有备份。可用设备：${parsed.devices.length ? devicesText(parsed.devices) : '（无）'}；可用 sourceDevice 选择设备 id 或 'latest'。`,
          ),
        ],
        items: [],
        sourceDeviceId: sourceDeviceId ?? 'self',
      });
    }
    const remote = this.remoteView(cloud, snapshot, source.namespace);
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
    const prefix = source.namespace;
    const sourceFileCount =
      snapshot?.files instanceof Map
        ? [...snapshot.files.keys()].filter((p) => !prefix || p.startsWith(prefix)).length
        : 0;
    return this.finishPreview('pull', {
      force,
      sections,
      summary: {
        empty: false,
        commitSha: snapshot.commitSha,
        sections: summarySections,
        totals: { files: sourceFileCount },
        devices: parsed.devices.map(deviceView),
        source: deviceView(source),
      },
      warnings,
      items,
      sourceDeviceId: source.id,
    });
  }

  finishPreview(direction, { force, sections, summary, warnings, items, sourceDeviceId = null }) {
    const token = randomUUID();
    const createdAt = Date.now();
    const expiresAt = createdAt + PREVIEW_TTL_MS;
    this.pending.set(token, { token, direction, sections, force, sourceDeviceId, createdAt, expiresAt });
    // 清理过期 pending，避免内存泄漏
    for (const [key, value] of this.pending) {
      if (value.expiresAt <= createdAt) this.pending.delete(key);
    }
    return {
      token,
      direction,
      sections,
      force,
      sourceDeviceId,
      createdAt: new Date(createdAt).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      summary,
      warnings: normalizeWarnings(warnings),
      items,
    };
  }

  // ---------- 执行 ----------

  /** 丢弃未执行的预览计划（不触碰远端）。传入 token 只丢一条，否则清空。 */
  discardPreview(token) {
    if (typeof token === 'string' && token) {
      return this.pending.delete(token) ? 1 : 0;
    }
    const count = this.pending.size;
    this.pending.clear();
    return count;
  }

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
    return this.executePull({
      state,
      cloud,
      sections: entry.sections,
      force,
      sourceDeviceId: entry.sourceDeviceId,
    });
  }

  /** 启动一个后台同步任务，立即返回任务快照；执行结果由 getJob 轮询。 */
  startJob(direction, opts = {}) {
    if (direction !== 'push' && direction !== 'pull') {
      throw new OnePackError('INVALID_DIRECTION', 'direction 必须是 push 或 pull');
    }
    this.pruneJobs()
    const id = `job-${Date.now().toString(36)}-${(this.jobSeq += 1).toString(36)}`
    const job = {
      id,
      direction,
      status: 'running',
      startedAt: nowIso(),
      finishedAt: null,
      result: null,
      error: null,
    }
    this.jobs.set(id, job)
    void this.runJob(job, opts)
    return this.getJob(id)
  }

  async runJob(job, opts) {
    try {
      job.result = await this.execute(job.direction, opts)
      job.status = 'done'
    } catch (err) {
      job.status = 'failed'
      job.error = { code: err?.code ?? 'SYNC_FAILED', message: err?.message ?? String(err) }
    } finally {
      job.finishedAt = nowIso()
    }
  }

  getJob(id) {
    this.pruneJobs()
    const job = this.jobs.get(String(id ?? ''))
    if (!job) return null
    return {
      id: job.id,
      direction: job.direction,
      status: job.status,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      result: job.result,
      error: job.error,
    }
  }

  listJobs() {
    this.pruneJobs()
    return [...this.jobs.values()].map((job) => ({
      id: job.id,
      direction: job.direction,
      status: job.status,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    }))
  }

  /** 只保留最近 20 个任务；运行中的任务不清理。 */
  pruneJobs() {
    if (this.jobs.size <= 20) return
    for (const [id, job] of this.jobs) {
      if (this.jobs.size <= 20) break
      if (job.status !== 'running') this.jobs.delete(id)
    }
  }

  async executePush({ state, cloud, sections, force }) {
    const snapshot = await cloud.state();
    const rootRaw = await cloud.readJson(MANIFEST_PATH, snapshot);
    const parsed = parseRemoteIndex(rootRaw);
    const myId = state.device.id;
    const myDir = deviceDir(myId);
    const warnings = [];
    const mine = parsed.devices.find((d) => d.id === myId) ?? null;
    let deviceManifest = null;
    if (mine) {
      deviceManifest = await cloud.readJson(mine.manifest, snapshot);
      // 冲突只看本设备命名空间：其他设备的 Push 不再阻塞本机。
      if (mine.updatedAt && state.lastSync?.at && String(mine.updatedAt) > String(state.lastSync.at) && !force) {
        throw new OnePackError(
          'REMOTE_AHEAD',
          '本设备在远端的备份比上次同步新（可能来自本机的另一处安装）；确认覆盖请先以 force 重新预览，或在 execute 时传 force。',
        );
      }
    }
    const remoteFiles = deviceManifest && typeof deviceManifest.files === 'object' ? deviceManifest.files : {};

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

    // 本设备命名空间下的写入集
    const writes = new Map();
    for (const exported of exports.values()) {
      for (const file of exported?.files ?? []) {
        if (file && typeof file.path === 'string') writes.set(myDir + file.path, file.content);
      }
    }
    if (writes.size === 0) throw new OnePackError('NOTHING_TO_SYNC', '没有可推送的内容（请检查分区开关）。');

    const filesMap = {};
    for (const [relPath, content] of writes) filesMap[relPath] = sha256(toBuffer(content));
    // 只上传真正变化的文件；比较基准是本设备 manifest.files 的 sha256
    // （Git blob 是 SHA-1，不可比）。
    const changed = new Map();
    for (const [relPath, content] of writes) {
      const previous = remoteFiles[relPath];
      if (typeof previous === 'string' && previous === filesMap[relPath]) continue;
      changed.set(relPath, content);
    }

    // 旧版单设备布局迁移
    const extraWrites = new Map();
    const deletes = [];
    let migrated = null;
    if (parsed.mode === 'legacy') {
      const legacy = parsed.legacyManifest;
      const legacyId = legacy?.device?.id;
      for (const relPath of Object.keys(legacy?.files ?? {})) {
        if (relPath === MANIFEST_PATH || relPath === README_PATH) continue;
        deletes.push(relPath);
      }
      if (legacyId && legacyId !== myId) {
        // 代为迁移：把那台设备的数据一次性复制进它自己的命名空间
        const movedFiles = {};
        for (const relPath of Object.keys(legacy?.files ?? {})) {
          if (relPath === MANIFEST_PATH || relPath === README_PATH) continue;
          const buf = await cloud.readFile(relPath, snapshot);
          if (buf == null) continue;
          const target = deviceDir(legacyId) + relPath;
          extraWrites.set(target, buf);
          movedFiles[target] = legacy.files[relPath];
        }
        extraWrites.set(
          deviceManifestPath(legacyId),
          `${JSON.stringify(
            { schema: 2, updatedAt: legacy?.updatedAt || '', device: legacy.device, sections: legacy?.sections || {}, files: movedFiles },
            null,
            2,
          )}\n`,
        );
        migrated = legacy.device?.name || shortId(legacyId);
      } else if (legacyId === myId) {
        migrated = state.device.name;
      }
    } else {
      // 正常增量清理：本设备命名空间中不在本次写入里的旧路径
      const prefixes = sectionPrefixes(sections).map((prefix) => myDir + prefix);
      for (const relPath of Object.keys(remoteFiles)) {
        if (!prefixes.some((prefix) => relPath.startsWith(prefix))) continue;
        if (relPath === deviceManifestPath(myId) || relPath === README_PATH) continue;
        if (!writes.has(relPath)) deletes.push(relPath);
      }
    }

    if (changed.size === 0 && deletes.length === 0 && extraWrites.size === 0) {
      throw new OnePackError('NOTHING_TO_SYNC', '远端本设备命名空间已是最新，没有需要推送的变更。');
    }

    const now = nowIso();
    const myManifestPath = deviceManifestPath(myId);
    const myManifest = {
      schema: 2,
      updatedAt: now,
      device: state.device,
      sections: summarySections,
      files: filesMap,
    };
    const indexDevices = {};
    for (const d of parsed.devices) {
      if (d.id === myId) continue;
      indexDevices[d.id] = {
        name: d.name,
        platform: d.platform,
        updatedAt: d.updatedAt,
        sections: d.sections || undefined,
        manifest: d.legacy ? deviceManifestPath(d.id) : d.manifest,
      };
    }
    indexDevices[myId] = {
      name: state.device.name,
      platform: state.device.platform,
      updatedAt: now,
      sections: summarySections,
      manifest: myManifestPath,
    };
    const index = { schema: 2, updatedAt: now, devices: indexDevices };

    const uploads = new Map(changed);
    for (const [relPath, content] of extraWrites) {
      if (!uploads.has(relPath)) uploads.set(relPath, content);
    }
    uploads.set(myManifestPath, `${JSON.stringify(myManifest, null, 2)}\n`);
    uploads.set(MANIFEST_PATH, `${JSON.stringify(index, null, 2)}\n`);
    uploads.set(README_PATH, renderReadme(index));
    const message = `one-pack: push ${state.device.name}#${shortId(myId)} [${sections.join(',')}]`;
    const commit = await cloud.commit({
      writes: [...uploads.entries()].map(([relPath, content]) => ({ path: relPath, content })),
      deletes,
      message,
      snapshot,
    });

    const finishedAt = nowIso();
    const deviceViewMine = { id: myId, name: state.device.name };
    this.store.update((current) => ({
      ...current,
      lastSync: { at: finishedAt, commitSha: commit.commitSha, direction: 'push', sections, device: deviceViewMine },
      remote: { commitSha: commit.commitSha, at: finishedAt },
    }));
    const result = {
      direction: 'push',
      commitSha: commit.commitSha,
      firstCommit: Boolean(commit.firstCommit),
      sections,
      device: deviceViewMine,
      summary: {
        sections: summarySections,
        files: uploads.size,
        deletes: deletes.length,
        namespace: myDir,
        migrated: migrated || undefined,
      },
      warnings: normalizeWarnings(warnings),
    };
    this.store.addHistory({
      direction: 'push',
      device: deviceViewMine,
      sections,
      ok: true,
      commitSha: commit.commitSha,
      summary: result.summary,
      warnings: result.warnings,
    });
    return result;
  }

  async executePull({ state, cloud, sections, force, sourceDeviceId }) {
    const snapshot = await cloud.state();
    if (snapshot?.empty) throw new OnePackError('EMPTY_REMOTE', '远端仓库还没有 One Pack 快照。');
    const rootRaw = await cloud.readJson(MANIFEST_PATH, snapshot);
    const parsed = parseRemoteIndex(rootRaw);
    const source = pickSource(parsed.devices, state, sourceDeviceId);
    if (!source) {
      throw new OnePackError(
        'EMPTY_REMOTE',
        `远端没有匹配的来源备份。可用设备：${parsed.devices.length ? devicesText(parsed.devices) : '（无）'}`,
        { devices: parsed.devices.map(deviceView) },
      );
    }
    const remote = this.remoteView(cloud, snapshot, source.namespace);

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
    const sourceView = deviceView(source);
    const nextState = this.store.update((current) => ({
      ...current,
      lastSync: { at: finishedAt, commitSha: snapshot.commitSha, direction: 'pull', sections, source: sourceView },
      remote: { commitSha: snapshot.commitSha, at: finishedAt },
    }));
    const result = {
      direction: 'pull',
      commitSha: snapshot.commitSha,
      sections,
      source: sourceView,
      summary: { sections: summarySections, applied, failed, source: sourceView },
      warnings: normalizeWarnings(warnings),
      applied: { restartRequired },
      lastSync: nextState.lastSync,
      ok: failed.length === 0,
    };
    this.store.addHistory({
      direction: 'pull',
      device: { id: state.device.id, name: state.device.name },
      sourceDevice: sourceView,
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