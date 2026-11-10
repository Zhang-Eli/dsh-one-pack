// settings 分区：只同步"显式覆盖"的插件配置，敏感字段递归脱敏。
// 契约见 DESIGN.md §1/§3/§5；远端格式 {entries:{<entryId>:{name,override}},redacted:[[...]]}。
import { deepClone, isPlainObject, nowIso, redactSecrets } from '../util.mjs';

export const SECTION_NAME = 'settings';

const FILE_PATH = 'settings/config.json';
/** 敏感字段在远端的占位符：pull 时保留本机现值，不写回 '***' */
const MASK = '***';

function sectionError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function getEditor(ctx) {
  const cfg = ctx?.svc?.configEditor;
  if (!cfg || typeof cfg.configuration !== 'function' || typeof cfg.edit !== 'function') {
    throw sectionError(
      'SETTINGS_UNAVAILABLE',
      '配置编辑器不可用（configEditor 缺失），无法同步 settings 分区。',
    );
  }
  return cfg;
}

function entryKey(entry, index) {
  return String(entry?.id ?? entry?.entryId ?? entry?.patchId ?? entry?.name ?? `entry-${index}`);
}

function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return deepClone(patch);
  const out = deepClone(base);
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? deepMerge(out[key], value) : deepClone(value);
  }
  return out;
}

/** 去掉 '***' 占位后的远端 override（脱敏字段保留本机值） */
function stripMask(node) {
  if (Array.isArray(node)) return node.map(stripMask);
  if (!isPlainObject(node)) return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (value === MASK) continue;
    out[key] = stripMask(value);
  }
  return out;
}

/** 由本机完整配置 + 远端 override（去掉脱敏占位）得到要持久化的完整配置 */
function buildNext(current, inherited, remoteOverride) {
  const base = isPlainObject(current) ? current : isPlainObject(inherited) ? inherited : {};
  return deepMerge(base, stripMask(remoteOverride));
}

/** 远端 override 与本机显式 override 是否等价（'***' 视作任意值） */
function overridesEqual(remote, local) {
  if (remote === MASK) return true;
  if (isPlainObject(remote)) {
    if (!isPlainObject(local)) return false;
    return Object.keys(remote).every((key) => overridesEqual(remote[key], local[key]));
  }
  if (Array.isArray(remote)) return JSON.stringify(remote) === JSON.stringify(local);
  return remote === local;
}

function jsonFile(payload) {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

async function readRemote(remote) {
  const payload = await remote.readJson(FILE_PATH);
  if (payload === null || typeof payload !== 'object') return null;
  const entries = isPlainObject(payload.entries) ? payload.entries : {};
  return {
    entries,
    redacted: Array.isArray(payload.redacted) ? payload.redacted : [],
  };
}

const settingsSection = {
  name: SECTION_NAME,
  defaultEnabled: true,

  async export(ctx) {
    const warnings = [];
    const cfg = ctx?.svc?.configEditor;
    if (!cfg || typeof cfg.configuration !== 'function') {
      ctx?.warn?.('configEditor 不可用，跳过 settings 分区');
      return {
        files: [],
        summary: { available: false, entries: 0 },
        warnings: ['configEditor 不可用，settings 分区未导出'],
      };
    }

    const rows = await cfg.configuration();
    const entries = {};
    const redacted = [];
    for (let index = 0; index < (rows ?? []).length; index++) {
      const row = rows[index];
      const override = row?.override;
      if (!isPlainObject(override) || Object.keys(override).length === 0) continue;
      const key = entryKey(row?.entry, index);
      const safe = redactSecrets(override);
      entries[key] = {
        name: String(row?.entry?.name ?? row?.entry?.meta?.title ?? key),
        override: safe.value,
      };
      for (const trail of safe.paths) redacted.push(trail);
    }

    const payload = {
      schema: 1,
      updatedAt: nowIso(),
      device: ctx?.state?.device ?? null,
      entries,
      redacted,
    };
    const count = Object.keys(entries).length;
    return {
      files: [{ path: FILE_PATH, content: jsonFile(payload) }],
      summary: { entries: count, redacted: redacted.length },
      warnings,
    };
  },

  async planPull(ctx, remote) {
    const cfg = getEditor(ctx);
    const remoteData = await readRemote(remote);
    if (!remoteData) {
      return {
        actions: [],
        summary: { entries: 0, actions: 0 },
        warnings: ['远端没有 settings/config.json，跳过 settings 分区'],
        context: { remote: null },
      };
    }

    const rows = await cfg.configuration();
    const local = new Map();
    for (let index = 0; index < (rows ?? []).length; index++) {
      const row = rows[index];
      local.set(entryKey(row?.entry, index), row);
    }

    const actions = [];
    const warnings = [];
    let missing = 0;
    for (const [key, entry] of Object.entries(remoteData.entries)) {
      const row = local.get(key);
      if (!row) {
        warnings.push(`本地没有配置条目 ${key}（可能对应已卸载的插件）`);
        missing += 1;
        continue;
      }
      const wanted = isPlainObject(entry?.override) ? entry.override : {};
      if (overridesEqual(wanted, row.override)) continue;
      actions.push({
        kind: 'update',
        title: key,
        detail: `覆盖 ${Object.keys(wanted).length} 个配置字段`,
      });
    }

    return {
      actions,
      summary: { entries: Object.keys(remoteData.entries).length, actions: actions.length, missing },
      warnings,
      context: { remote: remoteData },
    };
  },

  async applyPull(ctx, remote, plan) {
    const cfg = getEditor(ctx);
    const remoteData = plan?.context?.remote ?? (await readRemote(remote));
    if (!remoteData) return { warnings: ['远端没有 settings/config.json，跳过'], applied: {}, restartRequired: false };

    const warnings = [];
    const rows = await cfg.configuration();
    const local = new Map();
    for (let index = 0; index < (rows ?? []).length; index++) {
      const row = rows[index];
      local.set(entryKey(row?.entry, index), row);
    }

    let changed = 0;
    let fields = 0;
    for (const [key, entry] of Object.entries(remoteData.entries)) {
      const row = local.get(key);
      if (!row || !row.entry) {
        warnings.push(`本地没有配置条目 ${key}，跳过`);
        continue;
      }
      const wanted = isPlainObject(entry?.override) ? entry.override : {};
      if (overridesEqual(wanted, row.override)) continue;
      try {
        await cfg.edit(row.entry, (current, inherited) => buildNext(current, inherited, wanted));
        changed += 1;
        fields += Object.keys(wanted).length;
      } catch (err) {
        warnings.push(`应用 ${key} 失败：${err?.message ?? err}`);
      }
    }

    return {
      warnings,
      applied: { entries: changed, fields },
      restartRequired: false,
    };
  },
};

export default settingsSection;