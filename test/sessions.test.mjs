// One Pack · sessions 分区测试（node:test，完全离线）
//
// 覆盖：
// 1) 多帧 zstd 会话切分：readHeader 读头帧
// 2) rewriteSessionCwd 只重压头帧、尾部字节原样保留
// 3) compareSessions 四种关系（equal / local-ahead / remote-ahead / diverged）
// 4) planPull 四个分支 + 附件计划 + 只读（不写本地）
// 5) applyPull：改 cwd 落盘、备份、fork 另存、附件还原、工作区注册与 attach
// 6) export → applyPull 往返（模拟跨机：originalCwd 指向另一台机器的路径）
// 7) registry 缺失时 export 回退扫描 + warning
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

import sessions, {
  INDEX_PATH,
  applyPull,
  compareSessions,
  exportSessions,
  planPull,
  readSessionHeader,
  rewriteSessionCwd,
  sessionBody,
} from '../lib/sessions.mjs';
import { walkFrames } from '../lib/vendor/zstdframe.mjs';
import { projectKey } from '../lib/vendor/projectkey.mjs';
import { resetProjectDirCache } from '../lib/vendor/sessiondir.mjs';
import { readHeader } from '../lib/vendor/sessionlog.mjs';
import { sha256 } from '../lib/util.mjs';

// ---------------------------------------------------------------------------
// fixture 工具
// ---------------------------------------------------------------------------

const SESSION_FILE = 'session.v4.jsonl.zstd';

function frame(text) {
  return zstdCompressSync(Buffer.from(text, 'utf8'));
}

/** 一条 JSONL 事件行（不带换行） */
function line(type, data) {
  return JSON.stringify({ type, at: '2026-01-01T00:00:01.000Z', data });
}

/** 造一个多帧会话文件：头帧一行 header，其余每个元素各自一帧 */
function makeSession({ id, cwd, frames = [] }) {
  const header = JSON.stringify({
    type: 'session',
    id,
    version: 4,
    cwd,
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  return Buffer.concat([frame(`${header}\n`), ...frames.map((text) => frame(`${text}\n`))]);
}

/** 追加一帧（模拟 append-only 继续写） */
function appendFrame(buf, text) {
  return Buffer.concat([buf, frame(`${text}\n`)]);
}

/** 本地会话落盘位置：$DSH_HOME/sessions/<projectKey(cwd)>/<id>/session.v4.jsonl.zstd */
function writeLocalSession(dsh, cwd, id, buf) {
  const dir = join(dsh, 'sessions', projectKey(cwd), id);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, SESSION_FILE);
  writeFileSync(file, buf);
  return file;
}

/** 附件对象落盘位置：$DSH_HOME/attachments/v1/objects/<sha前2>/<sha> */
function writeLocalAttachment(dsh, sha, data) {
  const file = join(dsh, 'attachments', 'v1', 'objects', sha.slice(0, 2), sha);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
  return file;
}

/** 临时 DSH_HOME：测试期间切环境变量，结束后还原并清缓存 */
function withDshHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'one-pack-sessions-'));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  resetProjectDirCache();
  const cleanup = () => {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    resetProjectDirCache();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 忽略清理失败（Windows 文件占用）
    }
  };
  return Promise.resolve()
    .then(() => fn(dir))
    .then((value) => {
      cleanup();
      return value;
    }, (err) => {
      cleanup();
      throw err;
    });
}

/** mock 远端：只读内存 map，接口与 DESIGN §5 的 remote 一致 */
function mockRemote(fileList) {
  const map = new Map();
  for (const f of fileList) {
    map.set(f.path, Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content, 'utf8'));
  }
  return {
    snapshot: null,
    map,
    async readJson(path) {
      const buf = map.get(path);
      return buf ? JSON.parse(buf.toString('utf8')) : null;
    },
    async readText(path) {
      const buf = map.get(path);
      return buf ? buf.toString('utf8') : null;
    },
    async readFile(path) {
      return map.get(path) ?? null;
    },
  };
}

/** mock workspaceRegistry：list 同步，resolveByPath/create/attachSession 异步 */
function makeRegistry(initial = []) {
  const calls = { resolve: [], create: [], attach: [] };
  const workspaces = initial.map((w) => ({
    id: `ws-${w.path}`,
    path: w.path,
    title: w.title ?? null,
    async attachSession(id) {
      calls.attach.push(id);
    },
  }));
  return {
    calls,
    workspaces,
    list() {
      return workspaces.map(({ id, path, title }) => ({ id, path, title }));
    },
    async resolveByPath(path) {
      calls.resolve.push(path);
      return workspaces.find((w) => w.path.toLowerCase() === String(path).toLowerCase()) ?? null;
    },
    async create(path, title) {
      calls.create.push({ path, title });
      const ws = {
        id: `ws-${path}-${workspaces.length}`,
        path,
        title,
        async attachSession(id) {
          calls.attach.push(id);
        },
      };
      workspaces.push(ws);
      return ws;
    },
  };
}

function makeCtx(registry = makeRegistry()) {
  return {
    state: {
      schema: 1,
      device: { id: 'dev-test', name: 'test-host', platform: 'win32' },
      files: { paths: [] },
      sections: { sessions: true },
    },
    svc: { workspaceRegistry: registry },
  };
}

// ---------------------------------------------------------------------------
// 1) 头帧读取 + 只重压头帧改 cwd
// ---------------------------------------------------------------------------

test('readSessionHeader / rewriteSessionCwd：只改头帧，其余帧字节原样', () => {
  const cwdA = 'D:/work/one-pack-alpha';
  const cwdB = 'D:/work/one-pack-beta';
  const buf = makeSession({
    id: 'sess-1',
    cwd: cwdA,
    frames: [line('session/title', { title: 'Alpha' }), line('user/message', { text: 'hi' })],
  });

  const header = readSessionHeader(buf);
  assert.equal(header.type, 'session');
  assert.equal(header.id, 'sess-1');
  assert.equal(header.version, 4);
  assert.equal(header.cwd, cwdA);

  const before = walkFrames(buf);
  assert.equal(before.length, 3, 'fixture 应该是 3 帧');

  const result = rewriteSessionCwd(buf, { newCwd: cwdB });
  const after = walkFrames(result.buffer);
  assert.equal(after.length, before.length, '帧数不能变');
  assert.equal(result.frames, before.length);
  assert.equal(result.header.cwd, cwdB);
  assert.equal(result.header.id, 'sess-1');
  assert.ok(
    result.buffer.subarray(after[1].offset).equals(buf.subarray(before[1].offset)),
    '头帧之后的所有字节必须原样保留',
  );
  assert.ok(sessionBody(result.buffer).equals(sessionBody(buf)), 'body 必须逐字节相同');
  assert.equal(compareSessions(buf, result.buffer), 'equal', '只有 cwd 不同 → equal');

  // cwd 没变 → 原样返回同一个 Buffer，不重压
  const same = rewriteSessionCwd(buf, { newCwd: cwdA });
  assert.equal(same.buffer, buf);
});

// ---------------------------------------------------------------------------
// 2) compareSessions 四种关系
// ---------------------------------------------------------------------------

test('compareSessions：equal / local-ahead / remote-ahead / diverged', () => {
  const base = makeSession({ id: 'sess-2', cwd: '/machine/a', frames: [line('user/message', { n: 1 })] });
  const localAhead = appendFrame(base, line('assistant/message', { n: 2 }));
  const remoteAheadBuf = appendFrame(base, line('assistant/message', { n: 3 }));
  const bird = appendFrame(base, line('assistant/message', { n: 9 }));

  assert.equal(compareSessions(base, Buffer.from(base)), 'equal');
  assert.equal(compareSessions(localAhead, base), 'local-ahead');
  assert.equal(compareSessions(base, remoteAheadBuf), 'remote-ahead');
  assert.equal(compareSessions(localAhead, remoteAheadBuf), 'diverged');
  assert.equal(compareSessions(localAhead, bird), 'diverged');

  // 头帧 cwd 不同、body 相同 → 仍然是 equal（跨机场景）
  const baseOtherCwd = makeSession({ id: 'sess-2', cwd: '/machine/b', frames: [line('user/message', { n: 1 })] });
  assert.equal(compareSessions(base, baseOtherCwd), 'equal');
});

// ---------------------------------------------------------------------------
// 3) planPull 四个分支 + 附件计划；plan 只读
// ---------------------------------------------------------------------------

test('planPull：write / skip / fork 分支与附件计划（不写本地）', async () => {
  await withDshHome(async (dsh) => {
    const cwd = join(dsh, 'ws-alpha');
    mkdirSync(cwd, { recursive: true });
    const project = projectKey(cwd);
    const attachment = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const attSha = sha256(attachment);

    const e1 = line('user/message', { text: 'first' });
    const e2 = line('user/message', {
      content: [{
        attachmentId: `sha256:${attSha}`,
        mediaType: 'image/png',
        name: 'shot.png',
        bytes: attachment.length,
      }],
    });
    const e9 = line('user/message', { text: 'local-only' });
    const e2b = line('assistant/message', { text: 'remote-only' }); // 不带附件，避免 plan 重复计附件

    // 本地现状：
    // - sess-ahead：本地 [e1]，远端 [e1,e2] → remote-ahead → write
    // - sess-equal：body 与远端一致（头帧 cwd 不同）→ equal → skip
    // - sess-local：本地 [e1,e9]，远端 [e1] → local-ahead → skip + warning
    // - sess-fork：本地 [e1,e9]，远端 [e1,e2] → diverged → fork
    const localAheadFile = writeLocalSession(dsh, cwd, 'sess-ahead',
      makeSession({ id: 'sess-ahead', cwd, frames: [e1] }));
    const localEqualFile = writeLocalSession(dsh, cwd, 'sess-equal',
      makeSession({ id: 'sess-equal', cwd, frames: [e1] }));
    writeLocalSession(dsh, cwd, 'sess-local',
      makeSession({ id: 'sess-local', cwd, frames: [e1, e9] }));
    const localForkFile = writeLocalSession(dsh, cwd, 'sess-fork',
      makeSession({ id: 'sess-fork', cwd, frames: [e1, e9] }));

    const remoteAhead = makeSession({ id: 'sess-ahead', cwd: 'D:/remote/machine', frames: [e1, e2] });
    const remoteEqual = makeSession({ id: 'sess-equal', cwd: 'D:/remote/machine', frames: [e1] });
    const remoteLocal = makeSession({ id: 'sess-local', cwd: 'D:/remote/machine', frames: [e1] });
    const remoteFork = makeSession({ id: 'sess-fork', cwd: 'D:/remote/machine', frames: [e1, e2b] });

    const index = {
      schema: 1,
      updatedAt: '2026-01-02T00:00:00.000Z',
      device: { id: 'dev-remote', name: 'remote-host', platform: 'darwin' },
      projects: { [project]: { originalCwd: cwd, title: 'Alpha' } },
      sessions: {
        'sess-ahead': { project, title: 'Ahead', bodySha: sha256(sessionBody(remoteAhead)), bytes: remoteAhead.length, updatedAt: '2026-01-02T00:00:00.000Z' },
        'sess-equal': { project, title: 'Equal', bodySha: sha256(sessionBody(remoteEqual)), bytes: remoteEqual.length, updatedAt: '2026-01-02T00:00:00.000Z' },
        'sess-local': { project, title: 'Local', bodySha: sha256(sessionBody(remoteLocal)), bytes: remoteLocal.length, updatedAt: '2026-01-02T00:00:00.000Z' },
        'sess-fork': { project, title: 'Fork', bodySha: sha256(sessionBody(remoteFork)), bytes: remoteFork.length, updatedAt: '2026-01-02T00:00:00.000Z' },
      },
      attachments: {
        [attSha]: { bytes: attachment.length, mediaType: 'image/png', name: 'shot.png', ext: 'png' },
      },
    };
    const remote = mockRemote([
      { path: INDEX_PATH, content: `${JSON.stringify(index, null, 2)}\n` },
      { path: `sessions/${project}/sess-ahead.jsonl.zstd`, content: remoteAhead },
      { path: `sessions/${project}/sess-equal.jsonl.zstd`, content: remoteEqual },
      { path: `sessions/${project}/sess-local.jsonl.zstd`, content: remoteLocal },
      { path: `sessions/${project}/sess-fork.jsonl.zstd`, content: remoteFork },
      { path: `sessions/attachments/${attSha}.png`, content: attachment },
    ]);

    const registry = makeRegistry([{ path: cwd, title: 'Alpha' }]);
    const ctx = makeCtx(registry);
    const plan = await planPull(ctx, remote);

    assert.equal(plan.summary.write, 1, '只有 remote-ahead 需要写');
    assert.equal(plan.summary.skip, 2, 'equal 与 local-ahead 都跳过');
    assert.equal(plan.summary.fork, 1, '分叉要另存');
    assert.equal(plan.summary.blocked, 0);
    assert.equal(plan.summary.attachments, 1, '本地缺失的附件要还原');
    assert.equal(plan.summary.items, 4);

    const byId = new Map(plan.context.items.map((item) => [item.id, item]));
    assert.equal(byId.get('sess-ahead').action, 'write');
    assert.equal(byId.get('sess-equal').action, 'skip');
    assert.equal(byId.get('sess-local').action, 'skip');
    assert.equal(byId.get('sess-fork').action, 'fork');
    assert.match(
      byId.get('sess-fork').forkFile,
      new RegExp(`sess-fork-remote-${plan.context.stamp}\\.jsonl\\.zstd$`),
      'fork 分支的 item 要带计划中的另存路径',
    );

    const forkItem = plan.context.items.find((item) => item.id === 'sess-fork');
    assert.equal(forkItem.title, 'Fork');
    const forkAction = plan.actions.find((a) => a.kind === 'fork');
    assert.ok(forkAction);
    assert.match(forkAction.detail, /-remote-<stamp>\.jsonl\.zstd/);
    assert.match(
      plan.warnings.join('\n'),
      /sess-fork 两端分叉/,
      '分叉要给出 warning',
    );
    assert.match(plan.warnings.join('\n'), /sess-local 本地领先远端/, 'local-ahead 要给出 warning');
    assert.ok(plan.context.stamp && /^\d{14}$/.test(plan.context.stamp), 'stamp 必须是 yyyyMMddHHmmss');
    assert.ok(plan.actions.some((a) => a.kind === 'attachment'), '附件计划要出现在 actions 里');

    // planPull 只读：本地文件一个字节都不能变
    assert.ok(readFileSync(localAheadFile).equals(makeSession({ id: 'sess-ahead', cwd, frames: [e1] })));
    assert.ok(readFileSync(localEqualFile).equals(makeSession({ id: 'sess-equal', cwd, frames: [e1] })));
    assert.ok(readFileSync(localForkFile).equals(makeSession({ id: 'sess-fork', cwd, frames: [e1, e9] })));
    assert.equal(existsSync(join(dsh, 'attachments')), false, 'plan 阶段不能写附件');
  });
});

test('planPull：远端没有 _index.json 时返回空计划 + warning', async () => {
  const plan = await planPull(makeCtx(), mockRemote([]));
  assert.deepEqual(plan.actions, []);
  assert.equal(plan.summary.write, 0);
  assert.equal(plan.summary.items, 0);
  assert.ok(plan.warnings.some((w) => w.includes('sessions/_index.json')));
});

// ---------------------------------------------------------------------------
// 4) applyPull：改 cwd 落盘、备份、fork、附件、工作区注册
// ---------------------------------------------------------------------------

test('applyPull：写会话（备份 + attach）、fork 另存、附件内容寻址还原', async () => {
  await withDshHome(async (dsh) => {
    const cwd = join(dsh, 'ws-beta');
    mkdirSync(cwd, { recursive: true });
    const project = projectKey(cwd);
    const attachment = Buffer.from('attachment-bytes');
    const attSha = sha256(attachment);
    const e1 = line('user/message', { text: 'first' });
    const e2 = line('user/message', {
      content: [{ attachmentId: `sha256:${attSha}`, mediaType: 'image/png', name: 'shot.png', bytes: attachment.length }],
    });
    const e9 = line('user/message', { text: 'local-only' });

    // 本地已有 sess-ahead（远端更新）与 sess-fork（分叉）
    const localAheadBuf = makeSession({ id: 'sess-ahead', cwd, frames: [e1] });
    writeLocalSession(dsh, cwd, 'sess-ahead', localAheadBuf);
    const localForkBuf = makeSession({ id: 'sess-fork', cwd, frames: [e1, e9] });
    writeLocalSession(dsh, cwd, 'sess-fork', localForkBuf);

    const remoteAhead = makeSession({ id: 'sess-ahead', cwd: 'D:/remote/machine', frames: [e1, e2] });
    const remoteFork = makeSession({ id: 'sess-fork', cwd: 'D:/remote/machine', frames: [e1, e2] });
    const index = {
      schema: 1,
      updatedAt: '2026-01-02T00:00:00.000Z',
      device: { id: 'dev-remote', name: 'remote-host', platform: 'darwin' },
      projects: { [project]: { originalCwd: cwd, title: 'Beta' } },
      sessions: {
        'sess-ahead': { project, title: 'Ahead', bodySha: sha256(sessionBody(remoteAhead)), bytes: remoteAhead.length, updatedAt: '2026-01-02T00:00:00.000Z' },
        'sess-fork': { project, title: 'Fork', bodySha: sha256(sessionBody(remoteFork)), bytes: remoteFork.length, updatedAt: '2026-01-02T00:00:00.000Z' },
      },
      attachments: { [attSha]: { bytes: attachment.length, mediaType: 'image/png', name: 'shot.png', ext: 'png' } },
    };
    const remote = mockRemote([
      { path: INDEX_PATH, content: JSON.stringify(index) },
      { path: `sessions/${project}/sess-ahead.jsonl.zstd`, content: remoteAhead },
      { path: `sessions/${project}/sess-fork.jsonl.zstd`, content: remoteFork },
      { path: `sessions/attachments/${attSha}.png`, content: attachment },
    ]);

    const registry = makeRegistry([{ path: cwd, title: 'Beta' }]);
    const ctx = makeCtx(registry);
    const plan = await planPull(ctx, remote);
    const result = await applyPull(ctx, remote, plan);

    assert.equal(result.restartRequired, false);
    assert.equal(result.applied.sessions, 1);
    assert.equal(result.applied.forked, 1);
    assert.equal(result.applied.attachments, 1);
    assert.equal(result.applied.backups.length, 1, '覆盖本地前必须备份一次');
    assert.equal(result.applied.imported, 2, '写入/分叉的会话都要挂到工作区');

    // sess-ahead：头帧 cwd 换成目标 cwd，body 与远端一致
    const writtenFile = join(dsh, 'sessions', project, 'sess-ahead', SESSION_FILE);
    assert.ok(existsSync(writtenFile));
    const written = readFileSync(writtenFile);
    const writtenHeader = readHeader(written);
    assert.equal(writtenHeader.cwd, cwd);
    assert.equal(writtenHeader.id, 'sess-ahead');
    assert.ok(sessionBody(written).equals(sessionBody(remoteAhead)), 'body 必须与远端完全一致');
    assert.equal(compareSessions(written, remoteAhead), 'equal');

    // 备份内容 == 覆盖前的本地字节
    const backupFile = result.applied.backups[0];
    assert.ok(existsSync(backupFile));
    assert.ok(readFileSync(backupFile).equals(localAheadBuf), '备份必须是覆盖前的原文件');

    // sess-fork：本地保持原样，远端版本另存为扁平文件
    assert.ok(readFileSync(join(dsh, 'sessions', project, 'sess-fork', SESSION_FILE)).equals(localForkBuf));
    const appended = plan.context.items.find((item) => item.id === 'sess-fork');
    assert.ok(appended.forkFile, 'fork 必须给出另存路径');
    assert.ok(existsSync(appended.forkFile));
    assert.match(appended.forkFile, new RegExp(`sess-fork-remote-${plan.context.stamp}\\.jsonl\\.zstd$`));
    assert.equal(readHeader(readFileSync(appended.forkFile)).cwd, cwd);

    // 附件按内容寻址还原
    const storedAttachment = join(dsh, 'attachments', 'v1', 'objects', attSha.slice(0, 2), attSha);
    assert.ok(existsSync(storedAttachment));
    assert.ok(readFileSync(storedAttachment).equals(attachment));

    // 工作区注册：resolveByPath 命中已有工作区后 attachSession
    assert.deepEqual(registry.calls.resolve, [cwd]);
    assert.equal(registry.calls.create.length, 0);
    assert.deepEqual(registry.calls.attach.slice().sort(), ['sess-ahead', 'sess-fork'], '写入与分叉会话都要挂载');
    assert.ok(result.warnings.some((w) => w.includes('分叉')));
  });
});

// ---------------------------------------------------------------------------
// 5) export → applyPull 往返（模拟跨机：另一台机器的路径）
// ---------------------------------------------------------------------------

test('export → applyPull 往返：cwd 重映射 + 附件 + 新建工作区', async () => {
  const dsh1 = mkdtempSync(join(tmpdir(), 'one-pack-export-'));
  const dsh2 = mkdtempSync(join(tmpdir(), 'one-pack-import-'));
  const prev = process.env.DSH_HOME;
  try {
    // ---- 机器 1：导出 ----
    process.env.DSH_HOME = dsh1;
    resetProjectDirCache();
    const cwd1 = join(dsh1, 'ws-alpha');
    mkdirSync(cwd1, { recursive: true });
    const project = projectKey(cwd1);
    const id = 'sess-rt-1';
    const attachment = Buffer.from('roundtrip-image');
    const attSha = sha256(attachment);
    const sessionBuf = makeSession({
      id,
      cwd: cwd1,
      frames: [
        line('session/title', { title: 'Roundtrip' }),
        line('user/message', {
          content: [{ attachmentId: `sha256:${attSha}`, mediaType: 'image/png', name: 'image.png', bytes: attachment.length }],
        }),
      ],
    });
    writeLocalSession(dsh1, cwd1, id, sessionBuf);
    writeLocalAttachment(dsh1, attSha, attachment);

    const ctx1 = makeCtx(makeRegistry([{ path: cwd1, title: 'Alpha' }]));
    const exported = await exportSessions(ctx1);

    assert.equal(exported.files[0].path, INDEX_PATH, '_index.json 应排在最前');
    const index = JSON.parse(exported.files[0].content);
    assert.equal(index.schema, 1);
    assert.deepEqual(index.projects[project], { originalCwd: cwd1, title: 'Alpha' });
    assert.equal(index.sessions[id].project, project);
    assert.equal(index.sessions[id].title, 'Roundtrip');
    assert.equal(index.sessions[id].bodySha, sha256(sessionBody(sessionBuf)));
    assert.equal(index.sessions[id].bytes, sessionBuf.length);
    assert.equal(index.attachments[attSha].ext, 'png');
    assert.equal(index.attachments[attSha].bytes, attachment.length);
    assert.equal(exported.summary.projects, 1);
    assert.equal(exported.summary.sessions, 1);
    assert.equal(exported.summary.attachments, 1);

    const sessionFile = exported.files.find((f) => f.path === `sessions/${project}/${id}.jsonl.zstd`);
    assert.ok(sessionFile, '会话文件路径必须是 sessions/<project>/<id>.jsonl.zstd');
    assert.ok(Buffer.isBuffer(sessionFile.content));
    assert.ok(sessionFile.content.equals(sessionBuf), '导出的会话字节必须原样');
    const attachmentFile = exported.files.find((f) => f.path === `sessions/attachments/${attSha}.png`);
    assert.ok(attachmentFile, '附件路径必须是 sessions/attachments/<sha>.<ext>');
    assert.ok(attachmentFile.content.equals(attachment));

    // ---- 机器 2：拉取（把 index 的 originalCwd 改成机器 2 的路径）----
    process.env.DSH_HOME = dsh2;
    resetProjectDirCache();
    const cwd2 = join(dsh2, 'ws-beta');
    mkdirSync(cwd2, { recursive: true });
    const index2 = {
      ...index,
      projects: { ...index.projects, [project]: { originalCwd: cwd2, title: 'Alpha' } },
    };
    const remote = mockRemote(exported.files.map((f) => (
      f.path === INDEX_PATH ? { path: INDEX_PATH, content: `${JSON.stringify(index2, null, 2)}\n` } : f
    )));

    const registry2 = makeRegistry([]); // 机器 2 还没有任何工作区
    const ctx2 = makeCtx(registry2);
    const plan = await planPull(ctx2, remote);
    assert.equal(plan.summary.write, 1, '机器 2 本地没有该会话 → 直接写');
    assert.equal(plan.summary.attachments, 1);

    const result = await applyPull(ctx2, remote, plan);
    assert.equal(result.applied.sessions, 1);
    assert.equal(result.applied.attachments, 1);
    assert.equal(result.applied.workspacesCreated, 1);

    // 落盘位置按目标 cwd 的 projectKey 计算
    const writtenFile = join(dsh2, 'sessions', projectKey(cwd2), id, SESSION_FILE);
    assert.ok(existsSync(writtenFile), '会话应写入目标 cwd 对应的项目目录');
    const written = readFileSync(writtenFile);
    assert.equal(readHeader(written).cwd, cwd2, '头帧 cwd 必须重映射到机器 2 的路径');
    assert.ok(sessionBody(written).equals(sessionBody(sessionBuf)), 'body 必须逐字节保留');
    // 机器 1 的路径从不出现在 body 里
    assert.ok(!sessionBody(written).toString('utf8').includes(cwd1));

    // 附件还原到机器 2 的内容寻址根
    const storedAttachment = join(dsh2, 'attachments', 'v1', 'objects', attSha.slice(0, 2), attSha);
    assert.ok(existsSync(storedAttachment));
    assert.ok(readFileSync(storedAttachment).equals(attachment));

    // 工作区注册：create(cwd2, title) + attachSession(id)
    assert.equal(registry2.calls.create.length, 1);
    assert.equal(registry2.calls.create[0].path, cwd2);
    assert.deepEqual(registry2.calls.attach, [id]);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    resetProjectDirCache();
    for (const dir of [dsh1, dsh2]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // 忽略清理失败
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 6) registry 缺失时 export 回退扫描
// ---------------------------------------------------------------------------

test('export：workspaceRegistry 缺失时回退扫描 sessions 目录并 warning', async () => {
  await withDshHome(async (dsh) => {
    const cwd = join(dsh, 'ws-fallback');
    mkdirSync(cwd, { recursive: true });
    writeLocalSession(dsh, cwd, 'sess-fb', makeSession({ id: 'sess-fb', cwd, frames: [line('user/message', { text: 'x' })] }));

    const exported = await exportSessions({ state: { device: { id: 'd', name: 'n', platform: 'win32' } }, svc: {} });
    assert.ok(
      exported.warnings.some((w) => w.includes('workspaceRegistry 不可用')),
      '缺服务时要 warning，不能静默',
    );
    const index = JSON.parse(exported.files[0].content);
    const project = projectKey(cwd);
    assert.deepEqual(index.projects[project], { originalCwd: cwd, title: 'ws-fallback' });
    assert.equal(index.sessions['sess-fb'].project, project);
    assert.equal(exported.summary.sessions, 1);
  });
});

// ---------------------------------------------------------------------------
// 7) DESIGN §5 适配器契约
// ---------------------------------------------------------------------------

test('默认导出符合 sessions 适配器契约', () => {
  assert.equal(sessions.name, 'sessions');
  assert.equal(sessions.defaultEnabled, false);
  for (const key of ['export', 'planPull', 'applyPull']) {
    assert.equal(typeof sessions[key], 'function', `缺少 ${key}()`);
  }
  // §5 要求 re-export 的四个入口
  for (const fn of [readSessionHeader, rewriteSessionCwd, sessionBody, compareSessions]) {
    assert.equal(typeof fn, 'function');
  }
  assert.equal(typeof applyPull, 'function');
  assert.equal(typeof planPull, 'function');
  assert.equal(typeof exportSessions, 'function');
});

test('applyPull：内容相同的会话（skip）也会补挂到工作区', async () => {
  await withDshHome(async (dsh) => {
    const cwd = join(dsh, 'ws-gamma');
    mkdirSync(cwd, { recursive: true });
    const project = projectKey(cwd);
    const e1 = line('user/message', { text: 'same-body' });

    // 本地已有同 body（cwd 不同）的会话：plan 判 equal -> skip
    const localBuf = makeSession({ id: 'sess-same', cwd, frames: [e1] });
    writeLocalSession(dsh, cwd, 'sess-same', localBuf);
    const remoteBuf = makeSession({ id: 'sess-same', cwd: 'D:/remote/other', frames: [e1] });
    const index = {
      schema: 1,
      updatedAt: '2026-01-03T00:00:00.000Z',
      device: { id: 'dev-remote', name: 'remote-host', platform: 'darwin' },
      projects: { [project]: { originalCwd: cwd, title: 'Gamma' } },
      sessions: {
        'sess-same': { project, title: 'Same', bodySha: sha256(sessionBody(remoteBuf)), bytes: remoteBuf.length, updatedAt: '2026-01-03T00:00:00.000Z' },
      },
      attachments: {},
    };
    const remote = mockRemote([
      { path: INDEX_PATH, content: JSON.stringify(index) },
      { path: `sessions/${project}/sess-same.jsonl.zstd`, content: remoteBuf },
    ]);

    const registry = makeRegistry([{ path: cwd, title: 'Gamma' }]);
    const ctx = makeCtx(registry);
    const plan = await planPull(ctx, remote);
    assert.equal(plan.summary.import, 1, 'skip 的会话应计入待导入');

    const result = await applyPull(ctx, remote, plan);
    assert.equal(result.applied.sessions, 0);
    assert.equal(result.applied.imported, 1);
    assert.deepEqual(registry.calls.attach, ['sess-same']);
    assert.ok(readFileSync(join(dsh, 'sessions', project, 'sess-same', SESSION_FILE)).equals(localBuf), 'skip 不应改写本地文件');
  });
});

test('已归档会话不参与同步：export 跳过、planPull 跳过', async () => {
  await withDshHome(async (dsh) => {
    const cwd = join(dsh, 'ws-archived');
    mkdirSync(cwd, { recursive: true });
    const project = projectKey(cwd);
    const keep = makeSession({ id: 'sess-keep', cwd, frames: [line('user/message', { text: 'keep' })] });
    const gone = makeSession({ id: 'sess-archived', cwd, frames: [line('user/message', { text: 'archived' })] });
    writeLocalSession(dsh, cwd, 'sess-keep', keep);
    writeLocalSession(dsh, cwd, 'sess-archived', gone);

    // workspace.json 记录归档会话
    const wsj = join(dsh, 'storages', 'workspace.json');
    mkdirSync(dirname(wsj), { recursive: true });
    writeFileSync(wsj, JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { archivedSessionIds: ['sess-archived'], pinnedSessionIds: [], workspaceIds: [], initialized: true },
      tables: { workspaces: {} },
    }));

    const registry = makeRegistry([{ path: cwd, title: 'Archived' }]);
    const ctx = makeCtx(registry);
    const exported = await exportSessions(ctx);
    const index = JSON.parse(exported.files[0].content);
    assert.deepEqual(Object.keys(index.sessions), ['sess-keep']);
    assert.ok(!exported.files.some((f) => f.path.includes('sess-archived')), '归档会话不应导出文件');
    assert.ok(exported.warnings.some((w) => w.includes('已归档')));

    // pull：远端即使含有本地已归档的会话，也应跳过
    const remoteBuf = makeSession({ id: 'sess-remote-archived', cwd: 'D:/remote/x', frames: [line('user/message', { text: 'r' })] });
    const remote = mockRemote([
      { path: INDEX_PATH, content: JSON.stringify({
        schema: 1,
        device: { id: 'dev-remote', name: 'r', platform: 'darwin' },
        projects: { [project]: { originalCwd: cwd, title: 'Archived' } },
        sessions: { 'sess-remote-archived': { project, title: 'Remote archived', bodySha: sha256(sessionBody(remoteBuf)), bytes: remoteBuf.length, updatedAt: '2026-01-04T00:00:00.000Z' } },
        attachments: {},
      }) },
      { path: `sessions/${project}/sess-remote-archived.jsonl.zstd`, content: remoteBuf },
    ]);
    const wsj2 = JSON.parse(readFileSync(wsj, 'utf8'));
    wsj2.global.archivedSessionIds = ['sess-remote-archived'];
    writeFileSync(wsj, JSON.stringify(wsj2));

    const plan = await planPull(makeCtx(registry), remote);
    assert.equal(plan.summary.archived, 1);
    assert.equal(plan.summary.write, 0);
    assert.deepEqual(plan.actions, []);
  });
});
