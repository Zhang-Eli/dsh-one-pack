// One Pack · 宿主半边
// 只依赖 Node 内置模块。配置存在 $DSH_HOME/one-pack/state.json，
// token 存在 credentials（ONE_PACK_GITHUB_TOKEN，回退 GITHUB_TOKEN）。
// 不声明 Config，不读写 profile 的 package.json / cordis.patch.yml。
import { readFileSync } from 'node:fs';
import { parseRepo } from './lib/cloud.mjs';
import { OnePackError, SyncEngine } from './lib/orchestrator.mjs';
import { SECTIONS, StateStore } from './lib/state.mjs';
import { formatBytes, nowIso } from './lib/util.mjs';

export const name = 'dsh-one-pack';

export const inject = ['webServer', 'credentials', 'workspaceRegistry', 'tools'];

const PREFIX = '/one-pack/api';
const TOKEN_REF = 'ONE_PACK_GITHUB_TOKEN';
const BODY_LIMIT = 2 * 1024 * 1024;
const TOOL_ERROR_CODES = new Set([
  'CONFIG',
  'NO_TOKEN',
  'INVALID_DIRECTION',
  'INVALID_SECTIONS',
  'INVALID_REPO',
  'INVALID_REPO_NAME',
  'INVALID_BRANCH',
  'INVALID_FILES',
  'INVALID_TOKEN',
  'INVALID_SCHEDULE',
  'INVALID_PHASE',
  'REPO_CREATE_FAILED',
  'GITHUB_UNAUTHORIZED',
  'GITHUB_FORBIDDEN',
  'NO_SECTIONS',
  'NO_PREVIEW',
  'PREVIEW_EXPIRED',
  'PREVIEW_MISMATCH',
  'REMOTE_AHEAD',
  'NOTHING_TO_SYNC',
  'EMPTY_REMOTE',
  'BAD_JSON',
  'BODY_TOO_LARGE',
]);

function pluginVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function sanitizeToken(raw) {
  if (typeof raw !== 'string') return null;
  const clean = raw.trim();
  if (!clean || /\s/.test(clean) || clean.length > 500) return null;
  return clean;
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new OnePackError('BODY_TOO_LARGE', '请求体过大（上限 2MB）');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new OnePackError('BAD_JSON', '请求体不是合法 JSON');
  }
}

function statusOf(err) {
  if (err instanceof OnePackError && TOOL_ERROR_CODES.has(err.code)) return 400;
  if (err?.code === 'NO_TOKEN' || err?.code === 'CONFIG') return 400;
  return 500;
}

function requestRejection(ctx, req) {
  const connection = (() => {
    try {
      return typeof ctx.get === 'function' ? ctx.get('connection') : undefined;
    } catch {
      return undefined;
    }
  })();
  if (connection && typeof connection.requestRejection === 'function') {
    try {
      const rejected = connection.requestRejection(req);
      if (rejected !== undefined) return rejected;
    } catch {
      // 忽略鉴权服务异常，不阻塞本地调用
    }
  }
  return undefined;
}

// ---------- 文本渲染（agent 工具） ----------

function sectionsLine(state) {
  return SECTIONS.map((name) => `${name}=${state.sections[name] ? '开' : '关'}`).join(' ');
}

function summaryLine(summary) {
  if (!summary || typeof summary !== 'object') return '—';
  const entries = Object.entries(summary)
    .filter(([key]) => key !== 'files' && key !== 'warnings')
    .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`);
  return entries.length ? entries.join(' · ') : '—';
}

function warningsText(warnings) {
  if (!Array.isArray(warnings) || warnings.length === 0) return '';
  return `\n警告：\n${warnings.map((item) => `- [${item.code}] ${item.message}`).join('\n')}`;
}

function previewText(preview) {
  const totals = preview.summary?.totals ?? {};
  const lines = [
    `One Pack 预览（${preview.direction}）`,
    `分区：${preview.sections.join(', ')}`,
    '',
    '分区摘要：',
  ];
  for (const name of preview.sections) {
    lines.push(`- ${name}：${summaryLine(preview.summary?.sections?.[name])}`);
  }
  if (preview.summary?.empty) lines.push('', '远端仓库为空（首次 Push 会创建快照）。');
  if (typeof totals.added === 'number') {
    lines.push(
      '',
      `合计：新增 ${totals.added} / 变更 ${totals.changed} / 不变 ${totals.unchanged}，约 ${formatBytes(totals.bytes || 0)}`,
    );
  }
  if (Array.isArray(preview.items) && preview.items.length) {
    lines.push('', `计划（前 ${Math.min(preview.items.length, 20)} 项）：`);
    for (const item of preview.items.slice(0, 20)) {
      lines.push(`- ${item.kind} ${item.title || item.path || ''}${item.detail ? `（${item.detail}）` : ''}`);
    }
  }
  lines.push(warningsText(preview.warnings));
  lines.push('', `previewToken：${preview.token}`, `有效期至：${preview.expiresAt}`);
  lines.push(
    '',
    `确认执行：one_pack_sync { direction: "${preview.direction}", phase: "execute", previewToken: "${preview.token}" }`,
  );
  return lines.join('\n');
}

function executeText(result) {
  const lines = [
    `One Pack ${result.direction === 'push' ? '推送' : '拉取'}完成`,
    `commit：${result.commitSha}${result.firstCommit ? '（首次提交）' : ''}`,
    `分区：${result.sections.join(', ')}`,
    '',
    '结果：',
  ];
  for (const name of result.sections) {
    lines.push(`- ${name}：${summaryLine(result.summary?.sections?.[name])}`);
  }
  if (result.summary?.failed?.length) lines.push(`失败分区：${result.summary.failed.join(', ')}`);
  if (result.direction === 'push' && typeof result.summary?.files === 'number') {
    lines.push(`文件：${result.summary.files} 个，删除 ${result.summary.deletes ?? 0} 个`);
  }
  lines.push(warningsText(result.warnings));
  return lines.join('\n');
}

function statusText(report) {
  const lines = [
    'One Pack 状态',
    `设备：${report.device.name}（${report.device.platform}）· ${report.device.id}`,
    `仓库：${report.repo || '（未配置）'} @ ${report.branch}`,
    `仓库格式：${report.repoInfo.valid ? '有效' : `无效（${report.repoInfo.reason}）`}`,
    `Token：${report.hasToken ? '已配置' : '未配置'}`,
    `分区：${report.sections.map((item) => `${item.name}=${item.enabled ? '开' : '关'}`).join(' ')}`,
  ];
  if (report.schedule?.enabled) {
    const direction = report.schedule.direction === 'pull' ? '拉取' : '推送';
    lines.push(`定时同步：每天 ${report.schedule.time} 自动${direction}`);
    if (report.schedule.lastRunAt) {
      lines.push(
        `定时结果：${report.schedule.lastOk === false ? '失败' : '正常'} · ${report.schedule.lastRunAt}` +
          (report.schedule.lastError ? ` · ${report.schedule.lastError}` : ''),
      );
    }
  } else {
    lines.push('定时同步：关闭');
  }
  if (report.lastSync) {
    lines.push(
      `最近同步：${report.lastSync.at} · ${report.lastSync.direction} · ${report.lastSync.commitSha || '—'}`,
    );
  } else {
    lines.push('最近同步：从未同步');
  }
  if (report.pending?.length) {
    lines.push(`待执行预览：${report.pending.map((item) => `${item.direction}（至 ${item.expiresAt}）`).join('；')}`);
  }
  if (report.files?.paths?.length) lines.push(`文件同步目录：${report.files.paths.join(', ')}`);
  return lines.join('\n');
}

// ---------- 参数校验 ----------

function validateSectionsPatch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new OnePackError('INVALID_SECTIONS', 'sections 必须是对象');
  }
  const patch = {};
  for (const name of SECTIONS) {
    if (!(name in input)) continue;
    if (typeof input[name] !== 'boolean') {
      throw new OnePackError('INVALID_SECTIONS', `sections.${name} 必须是布尔值`);
    }
    patch[name] = input[name];
  }
  return patch;
}

function validateFilesPatch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new OnePackError('INVALID_FILES', 'files 必须是对象');
  }
  const patch = {};
  if ('paths' in input) {
    if (!Array.isArray(input.paths) || input.paths.some((item) => typeof item !== 'string')) {
      throw new OnePackError('INVALID_FILES', 'files.paths 必须是字符串数组');
    }
    patch.paths = input.paths.map((item) => item.trim()).filter(Boolean);
  }
  if ('patterns' in input) {
    if (!Array.isArray(input.patterns) || input.patterns.some((item) => typeof item !== 'string')) {
      throw new OnePackError('INVALID_FILES', 'files.patterns 必须是字符串数组');
    }
    patch.patterns = input.patterns.map((item) => item.trim()).filter(Boolean);
  }
  return patch;
}

function validateRepo(repo) {
  const value = String(repo ?? '').trim();
  if (!value) return '';
  try {
    const parsed = parseRepo(value);
    return `${parsed.owner}/${parsed.repo}`;
  } catch (err) {
    throw new OnePackError('INVALID_REPO', `仓库格式不正确：${err?.message ?? err}`);
  }
}

function validateBranch(branch) {
  const value = String(branch ?? '').trim();
  if (!value) return 'main';
  if (!/^[A-Za-z0-9._/-]{1,120}$/.test(value) || value.includes('..')) {
    throw new OnePackError('INVALID_BRANCH', '分支名不合法');
  }
  return value;
}

// ---------- 工具 ----------

function toolOutput(extra = {}) {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: { text: { type: 'string' }, ...extra },
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  };
}

function makeTools(engine, store, ctx) {
  return [
    {
      name: 'one_pack_status',
      description:
        'One Pack 状态：GitHub 仓库配置、token 是否就绪、设备信息、各同步分区开关、最近一次同步与待执行预览。只读。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: toolOutput(),
      isConcurrencySafe: () => true,
      timeoutMs: 20000,
      async execute() {
        return { text: statusText(await engine.status()) };
      },
    },
    {
      name: 'one_pack_sync',
      description:
        '把 DSH 环境（已装插件、设置、技能、会话、工作区文件）推送/拉取到 GitHub。两段式：先 phase=preview 拿摘要与 previewToken，再 phase=execute 带同一个 token 真正执行；执行前会自动备份。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['direction', 'phase'],
        properties: {
          direction: { type: 'string', enum: ['push', 'pull'], description: 'push=本机→远端；pull=远端→本机' },
          phase: { type: 'string', enum: ['preview', 'execute'] },
          sections: {
            type: 'array',
            items: { type: 'string', enum: [...SECTIONS] },
            description: '只处理这些分区；默认使用已启用的分区',
          },
          force: { type: 'boolean', description: '覆盖远端已被其他设备更新/会话分叉时的保护，默认 false' },
          previewToken: { type: 'string', description: 'execute 阶段必须带上 preview 返回的 token' },
        },
      },
      output: toolOutput({ token: { type: 'string' } }),
      isConcurrencySafe: () => false,
      timeoutMs: 240000,
      async execute(args) {
        const direction = args.direction;
        if (args.phase === 'preview') {
          const preview = await engine.preview(direction, { sections: args.sections, force: Boolean(args.force) });
          return { text: `${previewText(preview)}\n\nTOKEN=${preview.token}`, token: preview.token };
        }
        if (args.phase !== 'execute') {
          throw new OnePackError('INVALID_PHASE', 'phase 必须是 preview 或 execute');
        }
        const result = await engine.execute(direction, {
          token: args.previewToken,
          force: Boolean(args.force),
        });
        return { text: executeText(result) };
      },
    },
    {
      name: 'one_pack_setup',
      description:
        '配置 One Pack：GitHub 仓库（owner/repo）、分支、token（写入 credentials，不回显）、分区开关；createRepo=true 时在保存 token 后自动创建（或复用）该账号下的私有同步仓库。只写本地配置，不触发同步。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          repo: { type: 'string', description: 'owner/repo 或 GitHub 仓库 URL；空字符串表示清除' },
          branch: { type: 'string', description: '分支名，默认 main' },
          token: { type: 'string', description: 'GitHub fine-grained/classic token（只写不读）' },
          createRepo: {
            type: 'boolean',
            description:
              '保存 token 后自动创建（或复用）私有同步仓库并写入 repo；需要 token 具备 repo（classic）或 Administration: write（fine-grained）权限',
          },
          sections: {
            type: 'object',
            additionalProperties: false,
            properties: Object.fromEntries(SECTIONS.map((name) => [name, { type: 'boolean' }])),
            description: '只覆盖给出的分区开关',
          },
        },
      },
      output: toolOutput(),
      isConcurrencySafe: () => false,
      timeoutMs: 20000,
      async execute(args) {
        const patch = {};
        if ('repo' in args) patch.repo = validateRepo(args.repo);
        if ('branch' in args) patch.branch = validateBranch(args.branch);
        if ('sections' in args) patch.sections = validateSectionsPatch(args.sections);
        if ('token' in args) {
          const token = sanitizeToken(args.token);
          if (!token) throw new OnePackError('INVALID_TOKEN', 'token 不合法（不能为空/含空白/超过 500 字符）');
          await ctx.credentials.set(TOKEN_REF, token);
        }
        const next = store.update((current) => ({
          ...current,
          ...patch,
          sections: { ...current.sections, ...(patch.sections ?? {}) },
        }));
        let autoCreated = null;
        if (args.createRepo === true) {
          autoCreated = await engine.autoCreateRepo({});
        }
        const current = autoCreated ? store.read() : next;
        const lines = [
          'One Pack 配置已更新',
          `仓库：${current.repo || '（未配置）'} @ ${current.branch}`,
          `分区：${sectionsLine(current)}`,
        ];
        if ('token' in args) lines.push('Token：已写入 credentials（不回显）');
        if (autoCreated) {
          lines.push(autoCreated.created ? `私有仓库：已创建 ${autoCreated.repo}` : `私有仓库：复用已有 ${autoCreated.repo}`);
        }
        return { text: lines.join('\n') };
      },
    },
  ];
}

// ---------- 主入口 ----------

// 可选服务在真正用到时才解析：apply() 执行时这些服务可能还没挂载，
// 用 getter 而不是一次性 ctx.get，避免永久拿到 undefined。
function optionalService(ctx, name) {
  return () => {
    try {
      return typeof ctx.get === 'function' ? ctx.get(name) : undefined;
    } catch {
      return undefined;
    }
  };
}

export function apply(ctx) {
  const store = new StateStore();
  const lookupPluginManager = optionalService(ctx, 'pluginManager');
  const lookupConfigEditor = optionalService(ctx, 'configEditor');
  const lookupSettings = optionalService(ctx, 'settings');
  const lookupConnection = optionalService(ctx, 'connection');
  const svc = {
    get pluginManager() {
      return lookupPluginManager();
    },
    get configEditor() {
      return lookupConfigEditor();
    },
    get settings() {
      return lookupSettings();
    },
    workspaceRegistry: ctx.workspaceRegistry,
    credentials: ctx.credentials,
    get connection() {
      return lookupConnection();
    },
  };
  const engine = new SyncEngine({ store, svc });

  // HTTP API
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: PREFIX,
        handler: async (req, res) => {
          const rejected = requestRejection(ctx, req);
          if (rejected !== undefined) {
            sendJson(res, rejected, { ok: false, error: { code: 'forbidden', message: 'forbidden' } });
            return;
          }
          const url = new URL(req.url ?? '/', 'http://dsh.internal');
          const sub = url.pathname.startsWith(PREFIX)
            ? url.pathname.slice(PREFIX.length).replace(/^\/+|\/+$/g, '')
            : '';
          const method = req.method ?? 'GET';
          try {
            if (method === 'GET' && sub === 'status') {
              sendJson(res, 200, { ok: true, result: await engine.status() });
              return;
            }
            if (method === 'GET' && sub === 'sections') {
              sendJson(res, 200, {
                ok: true,
                result: {
                  sections: engine.sectionsMeta(),
                  version: pluginVersion(),
                  state: store.read(),
                },
              });
              return;
            }
            if (method === 'GET' && sub === 'history') {
              const limit = Number(url.searchParams.get('limit') ?? 20);
              sendJson(res, 200, { ok: true, result: { entries: store.history(Number.isFinite(limit) ? limit : 20) } });
              return;
            }
            if (method === 'POST' && sub === 'state') {
              const body = await readBody(req);
              const patch = {};
              if ('repo' in body) patch.repo = validateRepo(body.repo);
              if ('branch' in body) patch.branch = validateBranch(body.branch);
              if ('sections' in body) patch.sections = validateSectionsPatch(body.sections);
              if ('files' in body) patch.files = validateFilesPatch(body.files);
              const next = store.update((current) => ({
                ...current,
                ...patch,
                sections: { ...current.sections, ...(patch.sections ?? {}) },
                files: { ...current.files, ...(patch.files ?? {}) },
              }));
              sendJson(res, 200, {
                ok: true,
                result: {
                  repo: next.repo,
                  branch: next.branch,
                  sections: next.sections,
                  files: next.files,
                  device: next.device,
                },
              });
              return;
            }
            if (method === 'POST' && sub === 'token') {
              const body = await readBody(req);
              const token = sanitizeToken(body.token);
              if (!token) throw new OnePackError('INVALID_TOKEN', 'token 不合法（不能为空/含空白/超过 500 字符）');
              await ctx.credentials.set(TOKEN_REF, token);
              sendJson(res, 200, { ok: true, result: { hasToken: true } });
              return;
            }
            if (method === 'DELETE' && sub === 'token') {
              try {
                await ctx.credentials.unset(TOKEN_REF);
              } catch {
                // 忽略
              }
              sendJson(res, 200, { ok: true, result: { hasToken: await engine.hasToken() } });
              return;
            }
            if (method === 'POST' && sub === 'repo/auto') {
              const body = await readBody(req);
              let name;
              if (body.name != null) {
                name = String(body.name).trim();
                if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) {
                  throw new OnePackError(
                    'INVALID_REPO_NAME',
                    '仓库名只能包含字母、数字、点、下划线、短横线，最长 100 个字符',
                  );
                }
              }
              const result = await engine.autoCreateRepo({ name });
              sendJson(res, 200, { ok: true, result });
              return;
            }
            if (method === 'POST' && sub === 'schedule') {
              const body = await readBody(req);
              const patch = {};
              if ('enabled' in body) patch.enabled = body.enabled;
              if ('time' in body) patch.time = body.time;
              if ('direction' in body) patch.direction = body.direction;
              const schedule = await engine.updateSchedule(patch);
              sendJson(res, 200, { ok: true, result: { schedule } });
              return;
            }
            if (method === 'POST' && sub === 'sync') {
              const body = await readBody(req);
              if (body.direction !== 'push' && body.direction !== 'pull') {
                throw new OnePackError('INVALID_DIRECTION', 'direction 必须是 push 或 pull');
              }
              if (body.phase === 'preview') {
                const preview = await engine.preview(body.direction, {
                  sections: body.sections,
                  force: Boolean(body.force),
                });
                sendJson(res, 200, { ok: true, result: preview });
                return;
              }
              if (body.phase === 'execute') {
                const result = await engine.execute(body.direction, {
                  token: body.previewToken ?? body.token,
                  force: Boolean(body.force),
                });
                sendJson(res, 200, { ok: true, result });
                return;
              }
              throw new OnePackError('INVALID_PHASE', 'phase 必须是 preview 或 execute');
            }
            sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `未知接口：${method} ${sub}` } });
          } catch (err) {
            sendJson(res, statusOf(err), {
              ok: false,
              error: { code: err?.code ?? 'INTERNAL', message: err?.message ?? String(err) },
            });
          }
        },
      }),
    'one-pack: http api',
  );

  // Register tools directly (the host validates each registration) and keep
  // only their disposal inside ctx.effect: isolated probes do not run effect
  // callbacks, so effect-wrapped registration reads as "no tools".
  for (const tool of makeTools(engine, store, ctx)) {
    const dispose = ctx.tools.register(tool);
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => dispose, `one-pack: tool ${tool.name}`);
    }
  }

  // 定时同步：宿主每 30 秒检查一次是否到点（本地时间，默认每天 18:00 推送）。
  // 放在 ctx.effect 里：隔离探针不执行 effect 回调，门禁子进程不会留下计时器；
  // 真实 Cordis 中 effect 立即执行，返回的清理函数在插件卸载时停掉计时器。
  ctx.effect(() => {
    let stopped = false
    const tick = () => {
      if (stopped) return
      void engine.tickSchedule().catch(() => {})
    }
    const interval = setInterval(tick, 30 * 1000)
    const warmup = setTimeout(tick, 8 * 1000)
    if (typeof interval.unref === 'function') interval.unref()
    if (typeof warmup.unref === 'function') warmup.unref()
    return () => {
      stopped = true
      clearInterval(interval)
      clearTimeout(warmup)
    }
  }, 'one-pack: schedule timer')

  // 首启时确保 state.json 存在（device 身份稳定）
  try {
    store.read();
  } catch {
    // 忽略
  }
}

export { nowIso };