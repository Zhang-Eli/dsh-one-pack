// plugins 分区：把本机插件/包管理器状态（bundle 安装 + 启停）同步到远端。
// 契约见 DESIGN.md §1/§3/§5：export 返回带 plugins/ 前缀的文件；planPull 只读；applyPull 只落本分区。
import { nowIso } from '../util.mjs';

export const SECTION_NAME = 'plugins';

const FILE_PATH = 'plugins/bundles.json';

function sectionError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function getPluginManager(ctx) {
  const pm = ctx?.svc?.pluginManager;
  if (!pm || typeof pm.listBundles !== 'function') {
    throw sectionError(
      'PLUGINS_UNAVAILABLE',
      '插件管理服务不可用（pluginManager 缺失），无法同步 plugins 分区。',
    );
  }
  return pm;
}

/** 远端条目 → 用于比较/安装的规范形状 */
function normalizeBundle(bundle) {
  const name = String(bundle?.name ?? '');
  const version = String(bundle?.version ?? bundle?.installTarget?.version ?? '');
  const spec = String(bundle?.installTarget?.spec ?? (version ? `${name}@${version}` : name));
  return {
    name,
    version,
    spec,
    enabled: Boolean(bundle?.enabled),
    saveExact: true,
  };
}

function jsonFile(payload) {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

async function readRemoteFile(remote) {
  const payload = await remote.readJson(FILE_PATH);
  if (payload === null || typeof payload !== 'object') return null;
  return {
    bundles: Array.isArray(payload.bundles) ? payload.bundles : [],
    plugins: Array.isArray(payload.plugins) ? payload.plugins : [],
  };
}

const pluginSection = {
  name: SECTION_NAME,
  defaultEnabled: true,

  async export(ctx) {
    const warnings = [];
    const pm = ctx?.svc?.pluginManager;
    if (!pm || typeof pm.listBundles !== 'function') {
      ctx?.warn?.('pluginManager 不可用，跳过 plugins 分区');
      return {
        files: [],
        summary: { available: false, bundles: 0, plugins: 0 },
        warnings: ['pluginManager 不可用，plugins 分区未导出'],
      };
    }

    const rawBundles = await pm.listBundles();
    const rawPlugins = typeof pm.listPlugins === 'function' ? await pm.listPlugins() : [];
    // 只导出"本机确实装过/可复现"的 bundle；官方目录里没装的不带出去
    const bundles = (rawBundles ?? [])
      .filter((bundle) => bundle && (bundle.installed === true || bundle.availability === 'profile'))
      .map(normalizeBundle)
      .filter((bundle) => bundle.name);
    const plugins = (rawPlugins ?? [])
      .filter((plugin) => plugin && plugin.entryId)
      .map((plugin) => ({ id: String(plugin.entryId), enabled: Boolean(plugin.enabled) }));

    const payload = {
      schema: 1,
      updatedAt: nowIso(),
      device: ctx?.state?.device ?? null,
      bundles,
      plugins,
    };
    return {
      files: [{ path: FILE_PATH, content: jsonFile(payload) }],
      summary: {
        bundles: bundles.length,
        plugins: plugins.length,
        enabledBundles: bundles.filter((bundle) => bundle.enabled).length,
      },
      warnings,
    };
  },

  async planPull(ctx, remote) {
    const pm = getPluginManager(ctx);
    const remoteData = await readRemoteFile(remote);
    if (!remoteData) {
      return {
        actions: [],
        summary: { bundles: 0, plugins: 0, install: 0, update: 0, enable: 0 },
        warnings: ['远端没有 plugins/bundles.json，跳过 plugins 分区'],
        context: { remote: null },
      };
    }

    const localBundles = await pm.listBundles();
    const localPlugins = typeof pm.listPlugins === 'function' ? await pm.listPlugins() : [];
    const byName = new Map((localBundles ?? []).map((bundle) => [String(bundle?.name ?? ''), bundle]));
    const byEntry = new Map((localPlugins ?? []).map((plugin) => [String(plugin?.entryId ?? ''), plugin]));

    const actions = [];
    const warnings = [];
    let install = 0;
    let update = 0;
    let enable = 0;

    for (const raw of remoteData.bundles) {
      if (!raw || typeof raw.name !== 'string' || !raw.name) continue;
      const wanted = normalizeBundle(raw);
      const local = byName.get(wanted.name);
      if (!local) {
        actions.push({
          kind: 'install',
          title: wanted.name,
          detail: `安装 ${wanted.spec}${wanted.enabled ? '' : '（保持停用）'}`,
        });
        install += 1;
        continue;
      }
      const localSpec = String(local.installTarget?.spec ?? '');
      const localVersion = String(local.version ?? local.installTarget?.version ?? '');
      if (wanted.version && localVersion && wanted.version !== localVersion) {
        actions.push({
          kind: 'update',
          title: wanted.name,
          detail: `${localVersion} → ${wanted.version}`,
        });
        update += 1;
      } else if (localSpec && wanted.spec && localSpec !== wanted.spec) {
        actions.push({
          kind: 'update',
          title: wanted.name,
          detail: `安装源 ${localSpec} → ${wanted.spec}`,
        });
        update += 1;
      }
      if (Boolean(local.enabled) !== wanted.enabled) {
        actions.push({
          kind: wanted.enabled ? 'enable' : 'disable',
          title: wanted.name,
          detail: wanted.enabled ? '启用 bundle' : '停用 bundle',
        });
        enable += 1;
      }
    }

    for (const raw of remoteData.plugins) {
      if (!raw || typeof raw.id !== 'string' || !raw.id) continue;
      const local = byEntry.get(raw.id);
      if (!local) {
        warnings.push(`本地没有插件条目 ${raw.id}（可能在安装/重启后出现）`);
        continue;
      }
      if (Boolean(local.enabled) !== Boolean(raw.enabled)) {
        actions.push({
          kind: raw.enabled ? 'enable' : 'disable',
          title: raw.id,
          detail: raw.enabled ? '启用插件' : '停用插件',
        });
        enable += 1;
      }
    }

    return {
      actions,
      summary: {
        bundles: remoteData.bundles.length,
        plugins: remoteData.plugins.length,
        install,
        update,
        enable,
      },
      warnings,
      context: { remote: remoteData },
    };
  },

  async applyPull(ctx, remote, plan) {
    const pm = getPluginManager(ctx);
    const remoteData = plan?.context?.remote ?? (await readRemoteFile(remote));
    if (!remoteData) {
      return { warnings: ['远端没有 plugins/bundles.json，跳过'], applied: {}, restartRequired: false };
    }

    const warnings = [];
    const applied = { installed: 0, updated: 0, toggled: 0 };
    let restartRequired = false;

    const noteResult = (label, result) => {
      if (!result || typeof result !== 'object') return;
      if (result.application === 'restart-required') {
        restartRequired = true;
        warnings.push(`${label}：已保存，需要重启 DSH 后生效${result.restartReason ? `（${result.restartReason}）` : ''}`);
      } else if (result.application === 'failed' || result.application === 'cancelled') {
        warnings.push(`${label}：未应用（${result.error?.code ?? result.application}）`);
      } else if (result.application === 'overridden') {
        warnings.push(`${label}：已被更高优先级配置覆盖`);
      }
      for (const item of Array.isArray(result.warnings) ? result.warnings : []) warnings.push(`${label}：${item}`);
    };

    const localBundles = await pm.listBundles();
    const byName = new Map((localBundles ?? []).map((bundle) => [String(bundle?.name ?? ''), bundle]));

    for (const raw of remoteData.bundles) {
      if (!raw || typeof raw.name !== 'string' || !raw.name) continue;
      const wanted = normalizeBundle(raw);
      const local = byName.get(wanted.name);
      const localVersion = String(local?.version ?? local?.installTarget?.version ?? '');
      const localSpec = String(local?.installTarget?.spec ?? '');
      const needsInstall = !local
        || (wanted.version && localVersion && wanted.version !== localVersion)
        || (localSpec && wanted.spec && localSpec !== wanted.spec);
      try {
        if (needsInstall) {
          const result = await pm.installBundle(wanted.spec, {
            enabled: wanted.enabled,
            saveExact: true,
          });
          noteResult(`安装 ${wanted.name}`, result);
          if (!local) applied.installed += 1;
          else applied.updated += 1;
        } else if (Boolean(local.enabled) !== wanted.enabled) {
          const result = await pm.setBundleEnabled(wanted.name, wanted.enabled);
          noteResult(`${wanted.enabled ? '启用' : '停用'} ${wanted.name}`, result);
          applied.toggled += 1;
        }
      } catch (err) {
        warnings.push(`安装/启用 ${wanted.name} 失败：${err?.message ?? err}`);
      }
    }

    const localPlugins = typeof pm.listPlugins === 'function' ? await pm.listPlugins() : [];
    const byEntry = new Map((localPlugins ?? []).map((plugin) => [String(plugin?.entryId ?? ''), plugin]));
    for (const raw of remoteData.plugins) {
      if (!raw || typeof raw.id !== 'string' || !raw.id) continue;
      const local = byEntry.get(raw.id);
      if (!local) {
        warnings.push(`本地没有插件条目 ${raw.id}，跳过启停`);
        continue;
      }
      if (Boolean(local.enabled) === Boolean(raw.enabled)) continue;
      try {
        const result = await pm.setPluginEnabled(raw.id, Boolean(raw.enabled));
        noteResult(`${raw.enabled ? '启用' : '停用'} ${raw.id}`, result);
        applied.toggled += 1;
      } catch (err) {
        warnings.push(`切换插件 ${raw.id} 失败：${err?.message ?? err}`);
      }
    }

    return { warnings, applied, restartRequired };
  },
};

export default pluginSection;