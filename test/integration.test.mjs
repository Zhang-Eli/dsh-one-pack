// End-to-end round trip: push from HOME A into an in-memory fake GitHub repo,
// then pull into HOME B and verify every partition landed.
// No network, no real profile, no writes outside the temp directory.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import { SyncEngine } from '../lib/orchestrator.mjs'
import { StateStore } from '../lib/state.mjs'
import { createHash } from 'node:crypto'
import { sha256 } from '../lib/util.mjs'
import { projectKey } from '../lib/vendor/projectkey.mjs'

function put(file, content) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

function makeFakeCloud() {
  const files = new Map() // path -> Buffer
  const commits = []
  let commitSha = null
  let seq = 0
  const snapshot = () => {
    const map = new Map()
    // GitHub 树里的 blob sha 是 SHA-1，真实 CloudRepo 就返回这个；用 sha256 会造成
    // 「与真实实现不一致」的假绿。
    for (const [path, buf] of files) {
      map.set(path, { path, sha: createHash('sha1').update(buf).digest('hex'), size: buf.length })
    }
    return { empty: files.size === 0, commitSha, treeSha: commitSha, files: map, map }
  }
  return {
    files,
    commits,
    async state() {
      return snapshot()
    },
    async readJson(path) {
      const buf = files.get(path)
      if (!buf) return null
      try {
        return JSON.parse(buf.toString('utf8'))
      } catch {
        return null
      }
    },
    async readText(path) {
      const buf = files.get(path)
      return buf ? buf.toString('utf8') : null
    },
    async readFile(pathOrEntry) {
      const path = typeof pathOrEntry === 'string' ? pathOrEntry : pathOrEntry?.path
      const buf = files.get(path)
      if (!buf) throw new Error(`fake cloud: missing ${path}`)
      return buf
    },
    async commit({ writes = [], deletes = [], message }) {
      for (const item of writes) {
        const buf = Buffer.isBuffer(item.content) ? item.content : Buffer.from(String(item.content ?? ''), 'utf8')
        files.set(item.path, buf)
      }
      for (const path of deletes) files.delete(path)
      seq += 1
      commitSha = sha256(Buffer.from(`commit-${seq}`)).slice(0, 40)
      commits.push({ sha: commitSha, message, writes: writes.length, deletes: deletes.length })
      return { commitSha, firstCommit: commits.length === 1, files: writes.length }
    },
  }
}

function makePluginManager({ bundles = [], plugins = [], calls = [] } = {}) {
  let bundleList = [...bundles]
  let pluginList = [...plugins]
  return {
    calls,
    async listBundles() {
      return bundleList
    },
    async listPlugins() {
      return pluginList
    },
    async installBundle(spec, options) {
      calls.push({ method: 'installBundle', spec, options })
      bundleList = [...bundleList, { name: spec.split('@')[0], version: spec.split('@')[1] ?? '', enabled: options?.enabled !== false, installed: true, installTarget: { spec } }]
      return { changed: true, application: 'applied' }
    },
    async setBundleEnabled(name, enabled) {
      calls.push({ method: 'setBundleEnabled', name, enabled })
      bundleList = bundleList.map((b) => (b.name === name ? { ...b, enabled } : b))
      return { changed: true, application: 'applied' }
    },
    async setPluginEnabled(id, enabled) {
      calls.push({ method: 'setPluginEnabled', id, enabled })
      pluginList = pluginList.map((p) => (p.entryId === id ? { ...p, enabled } : p))
      return { changed: true, application: 'applied' }
    },
  }
}

function makeConfigEditor({ rows = [], calls = [] } = {}) {
  return {
    calls,
    async configuration() {
      return rows
    },
    async entries() {
      return rows.map((row) => row.entry)
    },
    async edit(entry, change) {
      const row = rows.find((candidate) => candidate.entry?.id === entry?.id)
      const next = change(row?.override ?? {}, row?.inherited ?? {})
      calls.push({ entryId: entry?.id, next })
      if (row) row.override = next
      return undefined
    },
  }
}

function makeSvc({ pluginManager, configEditor, workspaces = [] } = {}) {
  return {
    credentials: { resolve: async () => ({ value: 'fake-token' }) },
    pluginManager,
    configEditor,
    workspaceRegistry: { list: () => workspaces },
  }
}

test('push from home A, pull into home B, every partition round-trips', async () => {
  const root = mkdtempSync(join(tmpdir(), 'one-pack-it-'))
  const homeA = join(root, 'homeA')
  const homeB = join(root, 'homeB')
  const wsA = join(homeA, 'work', 'first')
  const previousHome = process.env.DSH_HOME
  const previousProfile = process.env.DSH_PROFILE
  try {
    process.env.DSH_HOME = homeA
    process.env.DSH_PROFILE = 'it'
    mkdirSync(join(homeA, 'one-pack'), { recursive: true })
    put(join(homeA, 'skills', 'demo', 'SKILL.md'), '# demo skill\n')
    put(join(homeA, 'skills', 'demo', 'notes.md'), 'skill notes\n')
    put(join(wsA, 'notes', 'readme.md'), 'workspace note\n')
    put(join(wsA, '.env'), 'SECRET=1\n') // must never be uploaded
    const keyA = projectKey(wsA)

    const storeA = new StateStore()
    storeA.update((current) => ({
      ...current,
      repo: 'octo/one-pack-test',
      branch: 'main',
      sections: { plugins: true, settings: true, skills: true, sessions: false, files: true },
      files: { paths: [wsA], patterns: [] },
    }))

    const devA = storeA.read().device.id
    const dirA = `devices/${devA}/`
    const settingsEntry = { id: 'ui-settings', name: 'ui-settings' }
    const configA = makeConfigEditor({
      rows: [{ entry: settingsEntry, inherited: { theme: 'light' }, override: { theme: 'dark', apiKey: 'plain-secret' } }],
    })
    const pluginsA = makePluginManager({
      bundles: [
        { name: 'dsh-ops', version: '0.5.2', enabled: true, installed: true, installTarget: { spec: 'dsh-ops@0.5.2', version: '0.5.2' } },
        // Neither of these can be installed on another machine: One Pack is not
        // published yet, and link installs point at a local directory.
        { name: 'dsh-one-pack', version: '0.2.2', enabled: true, installed: true, source: 'link:D:/work/one-pack', installTarget: { spec: 'link:D:/work/one-pack', version: '0.2.2' } },
        { name: '@local/demo', version: '0.0.0', enabled: true, installed: true, source: 'link:D:/work/demo', installTarget: { spec: 'link:D:/work/demo' } },
      ],
      plugins: [{ entryId: 'include:settings', enabled: true }],
    })
    const cloud = makeFakeCloud()
    const engineA = new SyncEngine({ store: storeA, svc: makeSvc({ pluginManager: pluginsA, configEditor: configA }), cloudFactory: () => cloud })

    const previewPush = await engineA.preview('push')
    assert.ok(previewPush.token, 'preview must return a token')
    const pushPaths = previewPush.items.map((item) => item.path)
    assert.ok(pushPaths.includes(dirA + 'skills/demo/SKILL.md'), 'push items must be namespaced under devices/<id>/')
    assert.ok(pushPaths.includes(dirA + 'settings/config.json'))
    assert.ok(pushPaths.some((path) => path.startsWith(dirA + 'files/') && path.endsWith('/notes/readme.md')))
    assert.ok(!pushPaths.some((path) => path.includes('.env')), '.env must be blocked')

    const pushed = await engineA.execute('push', { token: previewPush.token })
    assert.equal(pushed.direction, 'push')
    assert.ok(pushed.commitSha)

    // remote layout: section data lives in devices/<id>/ namespaces; index + README stay at root
    for (const expected of ['one-pack.json', 'README.md']) {
      assert.ok(cloud.files.has(expected), `remote must contain ${expected}`)
    }
    for (const expected of ['plugins/bundles.json', 'settings/config.json', 'skills/_index.json', 'files/_index.json']) {
      assert.ok(cloud.files.has(dirA + expected), `remote must contain ${dirA}${expected}`)
    }
    assert.ok(cloud.files.has(dirA + `files/${keyA}/notes/readme.md`))
    assert.ok(![...cloud.files.keys()].some((path) => path.includes('.env')), '.env must not be uploaded')

    // Unreproducible bundles (link installs, One Pack itself) must not be asked
    // for on another machine; they are reported as a warning instead.
    const remoteBundles = await cloud.readJson(dirA + 'plugins/bundles.json')
    assert.deepEqual(remoteBundles.bundles.map((bundle) => bundle.name), ['dsh-ops'])

    // A second push with no local change is a no-op: section payloads carry no
    // volatile timestamps, so unchanged files stay unchanged and execute
    // refuses to create an empty commit.
    const previewAgain = await engineA.preview('push')
    assert.equal(previewAgain.summary.totals.added, 0)
    assert.equal(previewAgain.summary.totals.changed, 0)
    assert.ok(previewAgain.summary.totals.unchanged >= 2, 'unchanged files must be counted')
    await assert.rejects(
      () => engineA.execute('push', { token: previewAgain.token }),
      (err) => err && err.code === 'NOTHING_TO_SYNC',
      'a no-op push must not create a commit',
    )

    const index = await cloud.readJson('one-pack.json')
    assert.equal(index.schema, 2)
    assert.equal(index.devices[devA].manifest, dirA + 'one-pack.json')
    const manifest = await cloud.readJson(dirA + 'one-pack.json')
    assert.equal(manifest.schema, 2)
    assert.equal(manifest.device.id, devA)
    assert.ok(Object.keys(manifest.files).includes(dirA + 'skills/demo/SKILL.md'))
    assert.equal(manifest.files[dirA + 'skills/demo/SKILL.md'], sha256(Buffer.from('# demo skill\n')))

    const remoteSettings = await cloud.readJson(dirA + 'settings/config.json')
    assert.equal(remoteSettings.entries['ui-settings'].override.theme, 'dark')
    assert.equal(remoteSettings.entries['ui-settings'].override.apiKey, '***', 'apiKey must be masked on the remote')
    assert.deepEqual(remoteSettings.redacted, [['apiKey']])

    // ---- pull side ----
    delete process.env.DSH_HOME
    process.env.DSH_HOME = homeB
    mkdirSync(join(homeB, 'one-pack'), { recursive: true })
    rmSync(wsA, { recursive: true, force: true }) // original cwd is gone: files must be remapped

    const storeB = new StateStore()
    storeB.update((current) => ({
      ...current,
      repo: 'octo/one-pack-test',
      branch: 'main',
      sections: { plugins: true, settings: true, skills: true, sessions: false, files: true },
    }))

    const pluginCalls = []
    const pluginsB = makePluginManager({ bundles: [], plugins: [{ entryId: 'include:settings', enabled: false }], calls: pluginCalls })
    const configCalls = []
    const configB = makeConfigEditor({
      rows: [{ entry: settingsEntry, inherited: { theme: 'light' }, override: { theme: 'light', apiKey: 'plain-secret' } }],
      calls: configCalls,
    })
    const engineB = new SyncEngine({ store: storeB, svc: makeSvc({ pluginManager: pluginsB, configEditor: configB }), cloudFactory: () => cloud })

    const devB = storeB.read().device.id
    assert.notEqual(devB, devA, 'each DSH_HOME must get its own device id')
    // default 'self' must not silently pull another device's backup
    const previewSelf = await engineB.preview('pull')
    assert.equal(previewSelf.summary.noData, true, 'pull with no own backup must preview as no-data')
    const previewPull = await engineB.preview('pull', { sourceDevice: 'latest' })
    assert.equal(previewPull.sourceDeviceId, devA)
    const kinds = previewPull.items.map((item) => item.kind)
    assert.ok(kinds.includes('install'), 'pull must plan bundle installs')
    assert.ok(kinds.includes('update'), 'pull must plan settings updates')
    const pullWarnings = previewPull.warnings.map((item) => item.code)
    assert.ok(!pullWarnings.includes('SECTION_FAILED'), `unexpected section failures: ${JSON.stringify(previewPull.warnings)}`)

    const pulled = await engineB.execute('pull', { token: previewPull.token })
    assert.equal(pulled.direction, 'pull')
    assert.deepEqual(pulled.summary.failed, [])
    assert.equal(readFileSync(join(homeB, 'skills', 'demo', 'SKILL.md'), 'utf8'), '# demo skill\n')
    assert.equal(readFileSync(join(homeB, 'skills', 'demo', 'notes.md'), 'utf8'), 'skill notes\n')
    const restored = join(homeB, 'one-pack', 'restore', keyA, 'notes', 'readme.md')
    assert.ok(existsSync(restored), `files must be restored under one-pack/restore (${restored})`)
    assert.equal(readFileSync(restored, 'utf8'), 'workspace note\n')

    // plugins applied through pluginManager, not by editing profile files
    const install = pluginCalls.find((call) => call.method === 'installBundle')
    assert.ok(install, 'installBundle must be called')
    assert.equal(install.spec, 'dsh-ops@0.5.2')
    assert.equal(install.options.saveExact, true)
    assert.ok(pluginCalls.some((call) => call.method === 'setPluginEnabled' && call.id === 'include:settings' && call.enabled === true))

    // Device B pushes its own backup: A's namespace must survive untouched.
    const dirB = `devices/${devB}/`
    const skillAContent = cloud.files.get(dirA + 'skills/demo/SKILL.md').toString('utf8')
    const previewPushB = await engineB.preview('push')
    const pushedB = await engineB.execute('push', { token: previewPushB.token })
    assert.equal(pushedB.device.id, devB)
    assert.ok(cloud.files.has(dirB + 'settings/config.json'), 'B namespace must exist')
    assert.equal(cloud.files.get(dirA + 'skills/demo/SKILL.md').toString('utf8'), skillAContent, "A's files must not be overwritten by B's push")
    const indexAfterB = await cloud.readJson('one-pack.json')
    assert.ok(indexAfterB.devices[devA] && indexAfterB.devices[devB], 'root index must list both devices')

    // settings applied exactly once, masked secret kept local
    assert.equal(configCalls.length, 1)
    assert.equal(configCalls[0].entryId, 'ui-settings')
    assert.equal(configCalls[0].next.theme, 'dark')
    assert.equal(configCalls[0].next.apiKey, 'plain-secret')

    // backup exists before overwrite
    const backupRoots = readdirSync(join(homeB, 'one-pack', 'backups'))
    assert.ok(backupRoots.length >= 1)

    // pull recorded in history + state
    const stateAfter = storeB.read()
    assert.equal(stateAfter.lastSync.direction, 'push')
    assert.equal(stateAfter.lastSync.device.id, devB)
    const history = storeB.history(5)
    assert.equal(history[0].direction, 'push')
    assert.equal(history[0].device.id, devB)
    assert.equal(history[1].direction, 'pull')
    assert.equal(history[1].ok, true)
    assert.equal(history[1].sourceDevice.id, devA, 'pull history row must record the source device')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousProfile === undefined) delete process.env.DSH_PROFILE
    else process.env.DSH_PROFILE = previousProfile
    rmSync(root, { recursive: true, force: true })
  }
})

test('legacy single-device remote is migrated into devices/ namespaces on first multi-device push', async () => {
  const root = mkdtempSync(join(tmpdir(), 'one-pack-legacy-'))
  const homeA = join(root, 'homeA')
  const previousHome = process.env.DSH_HOME
  const previousProfile = process.env.DSH_PROFILE
  try {
    process.env.DSH_HOME = homeA
    process.env.DSH_PROFILE = 'it'
    mkdirSync(join(homeA, 'one-pack'), { recursive: true })
    put(join(homeA, 'skills', 'demo', 'SKILL.md'), '# new machine skill\n')

    const legacyId = 'aaaaaaaa-1111-2222-3333-444444444444'
    const legacySkill = '# old machine skill\n'
    const legacyIndexFile = JSON.stringify({
      schema: 1,
      device: null,
      files: { 'demo/SKILL.md': { sha256: sha256(Buffer.from(legacySkill)), size: Buffer.byteLength(legacySkill) } },
    })
    const cloud = makeFakeCloud()
    const legacyManifest = {
      schema: 1,
      updatedAt: '2026-01-01T00:00:00.000Z',
      device: { id: legacyId, name: 'OldBox', platform: 'win32' },
      sections: { skills: {} },
      files: {
        'one-pack.json': 'x',
        'README.md': 'x',
        'skills/_index.json': sha256(Buffer.from(legacyIndexFile)),
        'skills/demo/SKILL.md': sha256(Buffer.from(legacySkill)),
      },
    }
    cloud.files.set('one-pack.json', Buffer.from(JSON.stringify(legacyManifest), 'utf8'))
    cloud.files.set('README.md', Buffer.from('# old readme\n', 'utf8'))
    cloud.files.set('skills/_index.json', Buffer.from(legacyIndexFile, 'utf8'))
    cloud.files.set('skills/demo/SKILL.md', Buffer.from(legacySkill, 'utf8'))

    const storeA = new StateStore()
    storeA.update((current) => ({
      ...current,
      repo: 'octo/one-pack-test',
      branch: 'main',
      sections: { plugins: false, settings: false, skills: true, sessions: false, files: false },
    }))
    const engineA = new SyncEngine({ store: storeA, svc: makeSvc({}), cloudFactory: () => cloud })
    const devA = storeA.read().device.id

    const preview = await engineA.preview('push')
    assert.ok(preview.warnings.some((item) => item.code === 'LEGACY_LAYOUT'), 'legacy layout must be warned')

    const pushed = await engineA.execute('push', { token: preview.token })
    assert.equal(pushed.summary.migrated, 'OldBox')
    assert.ok(cloud.files.has(`devices/${legacyId}/skills/demo/SKILL.md`), 'old device data must be copied into its own namespace')
    assert.ok(cloud.files.has(`devices/${legacyId}/one-pack.json`))
    assert.ok(!cloud.files.has('skills/demo/SKILL.md'), 'root-level legacy section files must be deleted')
    const index = await cloud.readJson('one-pack.json')
    assert.equal(index.schema, 2)
    assert.equal(index.devices[legacyId].name, 'OldBox')
    assert.ok(index.devices[devA], 'own namespace entry must exist')

    // pull from the migrated legacy device
    const previewPull = await engineA.preview('pull', { sourceDevice: legacyId })
    assert.equal(previewPull.sourceDeviceId, legacyId)
    const pulled = await engineA.execute('pull', { token: previewPull.token })
    assert.equal(pulled.source.id, legacyId)
    assert.equal(readFileSync(join(homeA, 'skills', 'demo', 'SKILL.md'), 'utf8'), legacySkill, 'pull from the legacy device restores its content')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousProfile === undefined) delete process.env.DSH_PROFILE
    else process.env.DSH_PROFILE = previousProfile
    rmSync(root, { recursive: true, force: true })
  }
})

test('pull from an empty or unmatched remote previews no-data instead of crashing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'one-pack-empty-'))
  const homeC = join(root, 'homeC')
  const previousHome = process.env.DSH_HOME
  const previousProfile = process.env.DSH_PROFILE
  try {
    process.env.DSH_HOME = homeC
    process.env.DSH_PROFILE = 'it'
    mkdirSync(join(homeC, 'one-pack'), { recursive: true })
    const storeC = new StateStore()
    storeC.update((current) => ({
      ...current,
      repo: 'octo/one-pack-test',
      branch: 'main',
      sections: { plugins: false, settings: true, skills: false, sessions: false, files: false },
    }))
    const cloud = makeFakeCloud()
    const engineC = new SyncEngine({
      store: storeC,
      svc: makeSvc({ pluginManager: makePluginManager(), configEditor: makeConfigEditor({ rows: [] }) }),
      cloudFactory: () => cloud,
    })
    const devC = storeC.read().device.id

    const previewEmpty = await engineC.preview('pull')
    assert.equal(previewEmpty.summary.noData, true)
    assert.deepEqual(previewEmpty.summary.devices, [])
    assert.ok(previewEmpty.warnings.some((item) => item.code === 'EMPTY_REMOTE'))
    await assert.rejects(
      () => engineC.execute('pull', { token: previewEmpty.token }),
      (err) => err && err.code === 'EMPTY_REMOTE',
      'executing an empty pull must fail loudly',
    )

    // remote has another device's data only: 'self' stays no-data, 'latest' resolves
    const otherId = 'ffffffff-0000-0000-0000-000000000000'
    cloud.files.set(
      'one-pack.json',
      Buffer.from(
        JSON.stringify({
          schema: 2,
          updatedAt: '2026-01-02T00:00:00.000Z',
          devices: { [otherId]: { name: 'Other', platform: 'linux', updatedAt: '2026-01-02T00:00:00.000Z', manifest: `devices/${otherId}/one-pack.json` } },
        }),
        'utf8',
      ),
    )
    const previewNoMine = await engineC.preview('pull')
    assert.equal(previewNoMine.summary.noData, true)
    assert.equal(previewNoMine.summary.devices.length, 1)
    const previewLatest = await engineC.preview('pull', { sourceDevice: 'latest' })
    assert.equal(previewLatest.sourceDeviceId, otherId)
    assert.notEqual(devC, otherId)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousProfile === undefined) delete process.env.DSH_PROFILE
    else process.env.DSH_PROFILE = previousProfile
    rmSync(root, { recursive: true, force: true })
  }
})