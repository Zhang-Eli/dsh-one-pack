// One Pack · 本地状态与历史（$DSH_HOME/one-pack/state.json）
// 只依赖 Node 内置模块。
import { appendFileSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { historyPath, statePath } from './paths.mjs';
import { normalizeSchedule } from './schedule.mjs';
import { ensureDir, nowIso, readJson, writeJson } from './util.mjs';

export const SECTIONS = ['plugins', 'settings', 'skills', 'sessions', 'files'];
export const SECTION_DEFAULTS = {
  plugins: true,
  settings: true,
  skills: false,
  sessions: false,
  files: false,
};

function deviceName() {
  try {
    return hostname() || 'unknown-device';
  } catch {
    return 'unknown-device';
  }
}

function normalizeState(raw) {
  const base = raw && typeof raw === 'object' ? raw : {};
  const sections = {};
  for (const name of SECTIONS) {
    const value = base.sections && typeof base.sections[name] === 'boolean'
      ? base.sections[name]
      : SECTION_DEFAULTS[name];
    sections[name] = value;
  }
  const filesRaw = base.files && typeof base.files === 'object' ? base.files : {};
  const paths = Array.isArray(filesRaw.paths)
    ? filesRaw.paths.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
    : [];
  const patterns = Array.isArray(filesRaw.patterns)
    ? filesRaw.patterns.filter((item) => typeof item === 'string' && item.trim())
    : [];
  const device = base.device && typeof base.device === 'object' ? base.device : {};
  return {
    schema: 1,
    device: {
      id: typeof device.id === 'string' && device.id ? device.id : randomUUID(),
      name: typeof device.name === 'string' && device.name ? device.name : deviceName(),
      platform: typeof device.platform === 'string' && device.platform ? device.platform : process.platform,
    },
    repo: typeof base.repo === 'string' ? base.repo.trim() : '',
    branch: typeof base.branch === 'string' && base.branch.trim() ? base.branch.trim() : 'main',
    sections,
    files: { paths, patterns },
    schedule: normalizeSchedule(base.schedule),
    lastSync: base.lastSync && typeof base.lastSync === 'object' ? base.lastSync : null,
    remote: base.remote && typeof base.remote === 'object' ? base.remote : null,
  };
}

export class StateStore {
  constructor({ file = statePath() } = {}) {
    this.file = file;
  }

  /** 读取并规范化；首次使用或缺 device id 时落盘 */
  read() {
    const raw = readJson(this.file, null);
    const state = normalizeState(raw);
    const needsPersist =
      !raw ||
      !raw.device ||
      raw.device.id !== state.device.id ||
      raw.device.name !== state.device.name ||
      raw.schema !== 1;
    if (needsPersist) {
      try {
        writeJson(this.file, state);
      } catch {
        // 只读环境（测试）下忽略落盘失败
      }
    }
    return state;
  }

  write(state) {
    const next = normalizeState(state);
    writeJson(this.file, next);
    return next;
  }

  update(mutator) {
    const current = this.read();
    const next = mutator(current);
    return this.write(next ?? current);
  }

  /** 最近优先的历史记录 */
  history(limit = 50) {
    const size = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 50;
    let text = '';
    try {
      text = readFileSync(historyPath(), 'utf8');
    } catch {
      return [];
    }
    const rows = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        // 跳过坏行
      }
    }
    return rows.slice(-size).reverse();
  }

  addHistory(entry) {
    ensureDir(statePath().replace(/[\\/][^\\/]+$/, ''));
    const row = { at: nowIso(), ...entry };
    try {
      appendFileSync(historyPath(), `${JSON.stringify(row)}\n`, 'utf8');
    } catch {
      // 忽略写入失败
    }
    return row;
  }
}