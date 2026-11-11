// 自动建仓离线单测：ensureSyncRepo（GitHub 账号/仓库编排）与
// SyncEngine.autoCreateRepo（写回 state）。不发网络请求。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_REPO_NAME, GitHubError, ensureSyncRepo } from '../lib/cloud.mjs'
import { SyncEngine } from '../lib/orchestrator.mjs'
import { StateStore } from '../lib/state.mjs'

/** 假 GitHub 账号客户端：只实现 ensureSyncRepo 用到的三个方法 */
function makeAccountClient({ login = 'octo', repos = new Map(), failCreate = null } = {}) {
  const calls = []
  return {
    calls,
    repos,
    async userInfo() {
      calls.push({ method: 'userInfo' })
      return { login }
    },
    async repoMetaOrNull(owner, name) {
      calls.push({ method: 'repoMetaOrNull', owner, name })
      return repos.get(`${owner}/${name}`) ?? null
    },
    async createUserRepo({ name, isPrivate, description }) {
      calls.push({ method: 'createUserRepo', name, isPrivate, description })
      if (failCreate) throw failCreate
      const repo = { name, private: isPrivate, full_name: `${login}/${name}` }
      repos.set(`${login}/${name}`, repo)
      return repo
    },
  }
}

test('ensureSyncRepo：仓库已存在时复用，不重复创建', async () => {
  const repos = new Map([['octo/dsh-one-pack-sync', { name: 'dsh-one-pack-sync', private: true }]])
  const client = makeAccountClient({ login: 'octo', repos })
  const result = await ensureSyncRepo({ token: 't', client })
  assert.deepEqual(result, {
    repo: 'octo/dsh-one-pack-sync',
    login: 'octo',
    name: 'dsh-one-pack-sync',
    created: false,
    private: true,
  })
  assert.equal(client.calls.filter((call) => call.method === 'createUserRepo').length, 0)
})

test('ensureSyncRepo：仓库不存在时创建私有仓库并返回 created=true', async () => {
  const client = makeAccountClient({ login: 'octo' })
  const result = await ensureSyncRepo({ token: 't', client })
  assert.equal(result.repo, `octo/${DEFAULT_REPO_NAME}`)
  assert.equal(result.created, true)
  assert.equal(result.private, true)
  const create = client.calls.find((call) => call.method === 'createUserRepo')
  assert.ok(create, 'createUserRepo must be called')
  assert.equal(create.isPrivate, true)
  assert.match(create.description, /One Pack/)
})

test('ensureSyncRepo：仓库名非法时直接拒绝，不访问 GitHub', async () => {
  const client = makeAccountClient()
  await assert.rejects(ensureSyncRepo({ token: 't', name: 'bad name!', client }), /仓库名不合法/)
  assert.equal(client.calls.length, 0)
})

test('ensureSyncRepo：无创建权限（403）给出可操作的权限提示', async () => {
  const client = makeAccountClient({
    failCreate: new GitHubError(403, 'Resource not accessible by integration'),
  })
  await assert.rejects(ensureSyncRepo({ token: 't', client }), (err) => {
    assert.ok(err instanceof GitHubError)
    assert.equal(err.status, 403)
    assert.match(err.message, /Administration: write/)
    assert.match(err.message, /手动创建仓库/)
    return true
  })
})

test('autoCreateRepo：调用 repoCreator 并把仓库写回 state', async () => {
  const home = mkdtempSync(join(tmpdir(), 'one-pack-repo-'))
  const previousHome = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = home
    const store = new StateStore()
    const calls = []
    const engine = new SyncEngine({
      store,
      svc: { credentials: { resolve: async () => ({ value: 'fake-token' }) } },
      repoCreator: async (options) => {
        calls.push(options)
        return {
          repo: `octo/${options.name}`,
          login: 'octo',
          name: options.name,
          created: true,
          private: true,
        }
      },
    })
    const before = store.read()
    assert.equal(before.branch, 'main')

    const result = await engine.autoCreateRepo({})
    assert.equal(calls.length, 1)
    assert.equal(calls[0].token, 'fake-token')
    assert.equal(calls[0].name, DEFAULT_REPO_NAME)
    assert.deepEqual(result, {
      repo: `octo/${DEFAULT_REPO_NAME}`,
      login: 'octo',
      name: DEFAULT_REPO_NAME,
      created: true,
      private: true,
    })
    const after = store.read()
    assert.equal(after.repo, `octo/${DEFAULT_REPO_NAME}`)
    assert.equal(after.branch, 'main')
    assert.equal(after.device.id, before.device.id)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('autoCreateRepo：没有 token 时抛 NO_TOKEN，不创建仓库', async () => {
  const home = mkdtempSync(join(tmpdir(), 'one-pack-repo-'))
  const previousHome = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = home
    const store = new StateStore()
    let called = false
    const engine = new SyncEngine({
      store,
      svc: { credentials: { resolve: async () => null } },
      repoCreator: async () => {
        called = true
        return { repo: 'octo/x' }
      },
    })
    await assert.rejects(engine.autoCreateRepo({}), (err) => {
      assert.equal(err.code, 'NO_TOKEN')
      return true
    })
    assert.equal(called, false)
    assert.equal(store.read().repo, '')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('autoCreateRepo：GitHub 401/403 映射为类型化错误码', async () => {
  const home = mkdtempSync(join(tmpdir(), 'one-pack-repo-'))
  const previousHome = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = home
    const store = new StateStore()
    const svc = { credentials: { resolve: async () => ({ value: 'fake-token' }) } }
    const engine401 = new SyncEngine({
      store,
      svc,
      repoCreator: async () => {
        throw new GitHubError(401, 'Bad credentials')
      },
    })
    await assert.rejects(engine401.autoCreateRepo({}), (err) => err.code === 'GITHUB_UNAUTHORIZED')

    const engine403 = new SyncEngine({
      store,
      svc,
      repoCreator: async () => {
        throw new GitHubError(403, 'Resource not accessible by integration')
      },
    })
    await assert.rejects(engine403.autoCreateRepo({}), (err) => err.code === 'GITHUB_FORBIDDEN')

    const engineBoom = new SyncEngine({
      store,
      svc,
      repoCreator: async () => {
        throw new Error('boom')
      },
    })
    await assert.rejects(engineBoom.autoCreateRepo({}), (err) => {
      assert.equal(err.code, 'REPO_CREATE_FAILED')
      assert.match(err.message, /boom/)
      return true
    })
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})
test('clearToken：删除 token 时同时清理所有别名，避免回退到旧 GITHUB_TOKEN', async () => {
  const home = mkdtempSync(join(tmpdir(), 'one-pack-clear-'))
  const previousHome = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = home
    const store = new StateStore()
    const values = new Map([
      ['ONE_PACK_GITHUB_TOKEN', 'new-token'],
      ['GITHUB_TOKEN', 'stale-token'],
    ])
    const unsetCalls = []
    const credentials = {
      async resolve(ref) {
        const value = values.get(ref)
        return value ? { value } : null
      },
      async unset(ref) {
        unsetCalls.push(ref)
        values.delete(ref)
      },
    }
    const engine = new SyncEngine({ store, svc: { credentials } })
    assert.equal(await engine.hasToken(), true)
    assert.equal(await engine.clearToken(), true)
    assert.deepEqual(unsetCalls, ['ONE_PACK_GITHUB_TOKEN', 'GITHUB_TOKEN'])
    assert.equal(values.size, 0)
    // 旧实现只清 ONE_PACK_GITHUB_TOKEN，会回退到 GITHUB_TOKEN，这里必须为 false。
    assert.equal(await engine.hasToken(), false)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})
