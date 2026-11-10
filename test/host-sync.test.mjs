// host-sync 内核单测：不联网、不写 profile 配置。
// 覆盖 vendor（guard/folders/projectkey）、cloud（parseRepo/CloudRepo）、
// 四个 section 适配器的 export / planPull / applyPull（mock ctx/svc/remote + 临时 DSH_HOME）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CloudRepo, GitHubError, parseRepo } from '../lib/cloud.mjs';
import { sha256 } from '../lib/util.mjs';
import { isHex64, isInsideRoot, isSafeSegment, assertInsideRoot } from '../lib/vendor/guard.mjs';
import { HARD_BLOCK, isHardBlocked, scanFolder } from '../lib/vendor/folders.mjs';
import { projectKey, samePath } from '../lib/vendor/projectkey.mjs';
import pluginsSection from '../lib/sections/plugins.mjs';
import settingsSection from '../lib/sections/settings.mjs';
import skillsSection from '../lib/sections/skills.mjs';
import filesSection from '../lib/sections/files.mjs';

// ---------- 工具 ----------

function withDshHome(t) {
  const dir = mkdtempSync(join(tmpdir(), 'one-pack-dsh-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function tempDir(t, prefix = 'one-pack-src-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function gitBlobSha(buf) {
  const hash = createHash('sha1');
  hash.update(`blob ${buf.length}\0`);
  hash.update(buf);
  return hash.digest('hex');
}

function makeRemote({ json = {}, files = {} } = {}) {
  const jsonPaths = new Map(Object.entries(json));
  const fileMap = new Map(Object.entries(files).map(([key, value]) => [
    key,
    Buffer.isBuffer(value) ? value : Buffer.from(String(value)),
  ]));
  return {
    snapshot: { empty: false, commitSha: 'remote-commit', treeSha: 'remote-tree', files: new Map() },
    async readJson(relPath) {
      if (!jsonPaths.has(relPath)) return null;
      const value = jsonPaths.get(relPath);
      return typeof value === 'string' ? JSON.parse(value) : value;
    },
    async readText(relPath) {
      const buf = fileMap.get(relPath);
      return buf ? buf.toString('utf8') : null;
    },
    async readFile(relPath) {
      return fileMap.get(relPath) ?? null;
    },
  };
}

function makeGitHubClient(options = {}) {
  const files = options.files ?? new Map();
  const blobs = options.blobs ?? new Map();
  const calls = { commitBatch: [], getBlob: 0, tree: null, commit: null, ref: null };
  const client = {
    calls,
    async repoInfo() { return { private: false, default_branch: 'main' }; },
    async listFiles() {
      return { empty: files.size === 0, commitSha: 'base-commit', treeSha: 'base-tree', map: files };
    },
    async getBlob(sha) {
      calls.getBlob += 1;
      const buf = blobs.get(sha);
      return buf
        ? { content: buf.toString('base64'), encoding: 'base64' }
        : { content: '', encoding: 'base64' };
    },
    async getRefOrNull() {
      return options.ref ? { object: { sha: options.ref } } : null;
    },
    async getCommit(sha) { return { sha, tree: { sha: 'base-tree' } }; },
    async createTree(baseTree, entries) {
      calls.tree = { baseTree, entries };
      return { sha: 'new-tree' };
    },
    async createCommit(payload) {
      calls.commit = payload;
      return { sha: 'new-commit' };
    },
    async updateRef(sha) {
      calls.ref = sha;
      return { object: { sha } };
    },
    async commitBatch(payload) {
      calls.commitBatch.push(payload);
      return { commitSha: 'batch-commit', treeSha: 'batch-tree', files: payload.files.length, firstCommit: false };
    },
  };
  return client;
}

function makeRepo(options = {}) {
  const client = makeGitHubClient(options);
  const repo = new CloudRepo({ repo: 'owner/repo', client });
  return { repo, client };
}

const device = { id: 'device-test', name: 'test-device', platform: 'win32' };

// ---------- cloud / vendor ----------

test('parseRepo 接受多种写法并返回 {owner, repo, name}', () => {
  assert.deepEqual(parseRepo('owner/repo'), { owner: 'owner', repo: 'repo', name: 'repo' });
  assert.deepEqual(parseRepo('https://github.com/owner/repo.git'), { owner: 'owner', repo: 'repo', name: 'repo' });
  assert.deepEqual(parseRepo('git@github.com:owner/repo.git'), { owner: 'owner', repo: 'repo', name: 'repo' });
  assert.throws(() => parseRepo('only-one-segment'));
  assert.throws(() => parseRepo(''));
});

test('CloudRepo.state 把远端树整理成 Map，readFile 按 blob sha 缓存读取', async (t) => {
  const content = Buffer.from('hello 世界');
  const sha = gitBlobSha(content);
  const files = new Map([['a.txt', { sha, size: content.length }]]);
  const blobs = new Map([[sha, content]]);
  const { repo } = makeRepo({ files, blobs });

  const snapshot = await repo.state();
  assert.equal(snapshot.empty, false);
  assert.equal(snapshot.commitSha, 'base-commit');
  assert.equal(snapshot.files.get('a.txt').size, content.length);

  const first = await repo.readFile('a.txt', snapshot);
  const second = await repo.readFile('a.txt', snapshot);
  assert.equal(first.toString('utf8'), 'hello 世界');
  assert.equal(second.toString('utf8'), 'hello 世界');
  assert.equal(repo.blobCache.size, 1);

  assert.equal(await repo.readText('missing.txt', snapshot), null);
  assert.equal(await repo.readJson('missing.txt', snapshot), null);
});

test('CloudRepo.commit 跳过内容未变化的文件；有新内容时走一次 commitBatch', async () => {
  const same = Buffer.from('same content');
  const sha = gitBlobSha(same);
  const files = new Map([['a.txt', { sha, size: same.length }]]);
  const { repo, client } = makeRepo({ files, blobs: new Map([[sha, same]]) });
  const snapshot = await repo.state();

  const skipped = await repo.commit({ writes: [{ path: 'a.txt', content: same }], message: 'noop', snapshot });
  assert.equal(skipped.unchanged, true);
  assert.equal(skipped.files, 0);
  assert.equal(client.calls.commitBatch.length, 0);

  const changed = await repo.commit({
    writes: [
      { path: 'a.txt', content: Buffer.from('new content') },
      { path: 'b.txt', content: 'other' },
    ],
    deletes: ['old.txt'],
    message: 'push',
    snapshot,
  });
  assert.equal(changed.commitSha, 'batch-commit');
  assert.equal(changed.files, 2);
  assert.equal(client.calls.commitBatch.length, 1);
  const batch = client.calls.commitBatch[0];
  assert.equal(batch.files.length, 2);
  assert.deepEqual(batch.deletions, ['old.txt']);
  assert.equal(batch.message, 'push');
});

test('CloudRepo.commit 只有删除时单独走 Git Data API', async () => {
  const { repo, client } = makeRepo({ ref: 'base-commit' });
  const result = await repo.commit({ writes: [], deletes: ['old.txt'], message: 'remove' });
  assert.equal(result.commitSha, 'new-commit');
  assert.equal(result.files, 0);
  assert.equal(client.calls.ref, 'new-commit');
  assert.deepEqual(client.calls.tree.entries, [{ path: 'old.txt', mode: '100644', type: 'blob', sha: null }]);
  assert.deepEqual(client.calls.commit.parents, ['base-commit']);
});

test('CloudRepo 读取损坏 JSON 时报错而不是静默返回 null', async () => {
  const content = Buffer.from('{ not json');
  const sha = gitBlobSha(content);
  const files = new Map([['bad.json', { sha, size: content.length }]]);
  const { repo } = makeRepo({ files, blobs: new Map([[sha, content]]) });
  const snapshot = await repo.state();
  await assert.rejects(() => repo.readJson('bad.json', snapshot), /不是合法 JSON/);
  assert.ok(GitHubError instanceof Function);
});

test('vendor guard：路径段与 root 约束', () => {
  assert.equal(isSafeSegment('ok-name.txt'), true);
  assert.equal(isSafeSegment('..'), false);
  assert.equal(isSafeSegment('a/b'), false);
  assert.equal(isSafeSegment(''), false);
  assert.equal(isHex64('a'.repeat(64)), true);
  assert.equal(isHex64('a'.repeat(63)), false);

  const root = join(tmpdir(), 'one-pack-guard-root');
  assert.equal(isInsideRoot(root, join(root, 'a', 'b.txt')), true);
  assert.equal(isInsideRoot(root, join(root, '..', 'escape.txt')), false);
  assert.equal(assertInsideRoot(root, join(root, 'a.txt')), join(root, 'a.txt'));
  assert.throws(() => assertInsideRoot(root, join(root, '..', 'escape.txt')));
});

test('vendor folders：硬排除密钥文件 + 体积/深度扫描', (t) => {
  const root = tempDir(t);
  mkdirSync(join(root, 'sub'), { recursive: true });
  writeFileSync(join(root, 'a.txt'), 'a');
  writeFileSync(join(root, 'sub', 'b.js'), 'b');
  writeFileSync(join(root, '.env'), 'SECRET=1');
  writeFileSync(join(root, 'id_rsa'), 'key');
  writeFileSync(join(root, '.npmrc'), 'token');
  writeFileSync(join(root, 'skip.log'), 'log');

  assert.ok(HARD_BLOCK.length >= 3);
  assert.equal(isHardBlocked('.env'), true);
  assert.equal(isHardBlocked('id_rsa'), true);
  assert.equal(isHardBlocked('.npmrc'), true);
  assert.equal(isHardBlocked('a.txt'), false);

  const scanned = scanFolder(root, { patterns: ['*.log'], limits: { maxFileBytes: 1024, maxFiles: 100, maxTotalBytes: 4096, maxDepth: 5 } });
  const rels = scanned.files.map((file) => file.rel).sort();
  assert.deepEqual(rels, ['a.txt', 'sub/b.js']);
  const blockedRels = scanned.blocked.map((item) => item.rel).sort();
  assert.deepEqual(blockedRels, ['.env', '.npmrc', 'id_rsa']);
  assert.ok(scanned.totalBytes > 0);
});

test('vendor projectkey：稳定 key 与 samePath', () => {
  const key = projectKey('D:/Documents/deepseek-harness/default-workspace');
  assert.match(key, /^--[A-Za-z0-9._~-]+--$/);
  assert.ok(key.length <= 251);
  assert.equal(projectKey('D:/Documents/deepseek-harness/default-workspace'), key);
  assert.ok(!key.includes('/'));
  assert.equal(samePath('C:/Users/A', 'c:\\users\\a'), true);
});

// ---------- plugins ----------

test('plugins section：export 只带已安装 bundle，planPull 产出差异动作', async (t) => {
  const installedBundles = [
    {
      name: 'pkg-a', version: '1.0.0', installed: true, availability: 'installation', enabled: true, installTarget: { spec: 'pkg-a@1.0.0', version: '1.0.0' },
    },
    {
      name: 'pkg-missing', version: '9.9.9', installed: false, availability: 'missing', enabled: false,
    },
  ];
  const localPlugins = [{ entryId: 'x/plugin', enabled: true }];
  const calls = [];
  const pm = {
    async listBundles() { return installedBundles; },
    async listPlugins() { return localPlugins; },
    async installBundle(spec, opts) { calls.push(['installBundle', spec, opts]); return { application: 'applied' }; },
    async setBundleEnabled(name, enabled) { calls.push(['setBundleEnabled', name, enabled]); return { application: 'applied' }; },
    async setPluginEnabled(id, enabled) { calls.push(['setPluginEnabled', id, enabled]); return { application: 'restart-required', restartReason: 'no-hmr' }; },
  };
  const ctx = { state: { device }, svc: { pluginManager: pm }, warn() {} };

  const exported = await pluginsSection.export(ctx);
  assert.equal(pluginsSection.name, 'plugins');
  assert.equal(pluginsSection.defaultEnabled, true);
  assert.equal(exported.files.length, 1);
  assert.equal(exported.files[0].path, 'plugins/bundles.json');
  const payload = JSON.parse(exported.files[0].content);
  assert.equal(payload.schema, 1);
  assert.deepEqual(payload.bundles.map((bundle) => bundle.name), ['pkg-a']);
  assert.equal(payload.bundles[0].spec, 'pkg-a@1.0.0');
  assert.deepEqual(payload.plugins, [{ id: 'x/plugin', enabled: true }]);

  const remote = makeRemote({
    json: {
      'plugins/bundles.json': {
        bundles: [
          { name: 'pkg-a', version: '2.0.0', spec: 'pkg-a@2.0.0', enabled: true, saveExact: true },
          { name: 'pkg-b', version: '1.0.0', spec: 'pkg-b@1.0.0', enabled: true, saveExact: true },
        ],
        plugins: [{ id: 'x/plugin', enabled: false }],
      },
    },
  });
  const plan = await pluginsSection.planPull(ctx, remote);
  const kinds = plan.actions.map((action) => `${action.kind}:${action.title}`).sort();
  assert.deepEqual(kinds, ['disable:x/plugin', 'install:pkg-b', 'update:pkg-a']);

  const applied = await pluginsSection.applyPull(ctx, remote, plan);
  assert.equal(applied.restartRequired, true);
  assert.ok(calls.some((call) => call[0] === 'installBundle' && call[1] === 'pkg-b@1.0.0'));
  assert.ok(calls.some((call) => call[0] === 'installBundle' && call[1] === 'pkg-a@2.0.0'));
  assert.ok(calls.some((call) => call[0] === 'setPluginEnabled' && call[1] === 'x/plugin' && call[2] === false));
});

test('plugins section：服务缺失时 export 降级、planPull 抛出结构化错误', async () => {
  const ctx = { state: { device }, svc: {}, warn() {} };
  const exported = await pluginsSection.export(ctx);
  assert.deepEqual(exported.files, []);
  assert.equal(exported.warnings.length, 1);

  await assert.rejects(
    () => pluginsSection.planPull(ctx, makeRemote()),
    (err) => err.code === 'PLUGINS_UNAVAILABLE',
  );
});

// ---------- settings ----------

test('settings section：只导出显式 override 且敏感字段脱敏，pull 保留本机敏感值', async (t) => {
  const entryA = { id: 'entry-a', name: 'Plugin A' };
  const entryB = { id: 'entry-b', name: 'Plugin B' };
  const rows = [
    { entry: entryA, inherited: {}, override: { apiKey: 'local-secret', size: 10 } },
    { entry: entryB, inherited: {}, override: {} },
  ];
  let edited = null;
  const cfg = {
    async configuration() { return rows; },
    async edit(entry, change) {
      const next = change({ apiKey: 'local-secret', size: 10 }, {});
      edited = { entryId: entry.id, next };
    },
  };
  const ctx = { state: { device }, svc: { configEditor: cfg }, warn() {} };

  const exported = await settingsSection.export(ctx);
  assert.equal(settingsSection.name, 'settings');
  assert.equal(settingsSection.defaultEnabled, true);
  const payload = JSON.parse(exported.files[0].content);
  assert.deepEqual(Object.keys(payload.entries), ['entry-a']);
  assert.equal(payload.entries['entry-a'].override.apiKey, '***');
  assert.equal(payload.entries['entry-a'].override.size, 10);
  assert.ok(payload.redacted.length >= 1);

  const remote = makeRemote({
    json: {
      'settings/config.json': {
        entries: {
          'entry-a': { name: 'Plugin A', override: { apiKey: '***', size: 20 } },
          ghost: { name: 'Ghost', override: { size: 1 } },
        },
        redacted: [['apiKey']],
      },
    },
  });
  const plan = await settingsSection.planPull(ctx, remote);
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].title, 'entry-a');
  assert.ok(plan.warnings.some((message) => message.includes('ghost')));

  const applied = await settingsSection.applyPull(ctx, remote, plan);
  assert.equal(applied.applied.entries, 1);
  assert.deepEqual(edited, { entryId: 'entry-a', next: { apiKey: 'local-secret', size: 20 } });
});

test('settings section：configEditor 缺失时 planPull 抛出结构化错误', async () => {
  await assert.rejects(
    () => settingsSection.planPull({ state: { device }, svc: {} }, makeRemote()),
    (err) => err.code === 'SETTINGS_UNAVAILABLE',
  );
});

// ---------- skills ----------

test('skills section：导出技能文件，pull 覆盖前备份且不删本地多余文件', async (t) => {
  const home = withDshHome(t);
  const skillsRoot = join(home, 'skills');
  mkdirSync(join(skillsRoot, 'demo'), { recursive: true });
  mkdirSync(join(skillsRoot, 'keep'), { recursive: true });
  writeFileSync(join(skillsRoot, 'demo', 'SKILL.md'), 'old content');
  writeFileSync(join(skillsRoot, 'keep', 'extra.md'), 'keep me');
  writeFileSync(join(skillsRoot, 'demo', '.env'), 'SECRET=1');

  const ctx = { state: { device }, svc: {}, warn() {}, backupDir: null };

  const exported = await skillsSection.export(ctx);
  assert.equal(skillsSection.name, 'skills');
  assert.equal(skillsSection.defaultEnabled, false);
  const paths = exported.files.map((file) => file.path).sort();
  assert.deepEqual(paths, ['skills/_index.json', 'skills/demo/SKILL.md', 'skills/keep/extra.md']);
  const index = JSON.parse(exported.files.find((file) => file.path === 'skills/_index.json').content);
  assert.equal(index.files['demo/SKILL.md'].sha256, sha256(Buffer.from('old content')));
  assert.equal(index.files['keep/extra.md'].sha256, sha256(Buffer.from('keep me')));
  assert.ok(exported.warnings.some((message) => message.includes('.env')));

  const remote = makeRemote({
    json: {
      'skills/_index.json': {
        schema: 1,
        files: { 'demo/SKILL.md': { sha256: sha256(Buffer.from('new content')), size: 11 } },
      },
    },
    files: { 'skills/demo/SKILL.md': 'new content' },
  });
  const plan = await skillsSection.planPull(ctx, remote);
  assert.deepEqual(plan.actions.map((action) => `${action.kind}:${action.title}`), ['update:demo/SKILL.md']);

  const backupDir = join(home, 'one-pack', 'backups', '20260101000000');
  const applied = await skillsSection.applyPull({ ...ctx, backupDir }, remote, plan);
  assert.equal(applied.applied.written, 1);
  assert.equal(readFileSync(join(skillsRoot, 'demo', 'SKILL.md'), 'utf8'), 'new content');
  assert.equal(readFileSync(join(backupDir, 'skills', 'demo', 'SKILL.md'), 'utf8'), 'old content');
  assert.equal(readFileSync(join(skillsRoot, 'keep', 'extra.md'), 'utf8'), 'keep me');
});

test('skills section：远端索引缺失时返回 warning 而不是报错', async (t) => {
  withDshHome(t);
  const plan = await skillsSection.planPull({ state: { device }, svc: {} }, makeRemote());
  assert.deepEqual(plan.actions, []);
  assert.equal(plan.warnings.length, 1);
});

// ---------- files ----------

test('files section：导出登记目录，pull 新增与冲突另存', async (t) => {
  const home = withDshHome(t);
  const source = tempDir(t, 'one-pack-workspace-');
  writeFileSync(join(source, 'doc.txt'), 'hello');
  writeFileSync(join(source, 'conflict.txt'), 'local version');
  mkdirSync(join(source, 'sub'), { recursive: true });
  writeFileSync(join(source, 'sub', 'b.txt'), 'bee');
  writeFileSync(join(source, '.env'), 'SECRET=1');

  const key = projectKey(source);
  const ctx = {
    state: { device, files: { paths: [source], patterns: [] } },
    svc: {},
    warn() {},
    backupDir: null,
  };

  const exported = await filesSection.export(ctx);
  assert.equal(filesSection.name, 'files');
  assert.equal(filesSection.defaultEnabled, false);
  const paths = exported.files.map((file) => file.path).sort();
  assert.deepEqual(paths, [`files/${key}/conflict.txt`, `files/${key}/doc.txt`, `files/${key}/sub/b.txt`, 'files/_index.json'].sort());
  const index = JSON.parse(exported.files.find((file) => file.path === 'files/_index.json').content);
  assert.equal(index.projects[key].originalCwd, source);
  assert.equal(index.files[`${key}/doc.txt`].sha256, sha256(Buffer.from('hello')));

  const remote = makeRemote({
    json: {
      'files/_index.json': {
        schema: 1,
        projects: { [key]: { originalCwd: source, title: 'workspace' } },
        files: {
          [`${key}/doc.txt`]: { sha256: sha256(Buffer.from('hello')), size: 5 },
          [`${key}/new.txt`]: { sha256: sha256(Buffer.from('fresh')), size: 5 },
          [`${key}/conflict.txt`]: { sha256: sha256(Buffer.from('remote version')), size: 14 },
        },
      },
    },
    files: {
      [`files/${key}/new.txt`]: 'fresh',
      [`files/${key}/conflict.txt`]: 'remote version',
    },
  });

  const plan = await filesSection.planPull(ctx, remote);
  const kinds = plan.actions.map((action) => `${action.kind}:${action.title}`).sort();
  assert.deepEqual(kinds, [`add:${key}/new.txt`, `conflict:${key}/conflict.txt`]);

  const backupDir = join(home, 'one-pack', 'backups', '20260101000000');
  const applied = await filesSection.applyPull({ ...ctx, backupDir }, remote, plan);
  assert.equal(applied.applied.written, 1);
  assert.equal(applied.applied.conflicts, 1);
  assert.equal(readFileSync(join(source, 'new.txt'), 'utf8'), 'fresh');
  assert.equal(readFileSync(join(source, 'conflict.txt'), 'utf8'), 'local version');
  assert.equal(readFileSync(join(backupDir, 'files', key, 'conflict.txt'), 'utf8'), 'local version');

  const stampSuffix = plan.context.stamp;
  assert.ok(existsSync(join(source, `conflict.remote-${stampSuffix}.txt`)));
  assert.equal(readFileSync(join(source, `conflict.remote-${stampSuffix}.txt`), 'utf8'), 'remote version');
});

test('files section：未登记目录时导出为空并给出 warning', async (t) => {
  withDshHome(t);
  const exported = await filesSection.export({ state: { device, files: { paths: [] } }, svc: {} });
  assert.deepEqual(exported.files, []);
  assert.equal(exported.warnings.length, 1);
});