// Host-half smoke test: mount apply() on a fake Cordis context, verify the
// plugin registers its HTTP route + tools and that GET status answers JSON
// without touching the network or the real profile.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, inject } from '../index.js'

function makeCtx({ home, credentials = null }) {
  const routes = []
  const tools = []
  const ctx = {
    get: () => undefined,
    effect(factory) {
      return factory()
    },
    webServer: {
      register(registration) {
        routes.push(registration)
        return () => {}
      },
    },
    tools: {
      register(tool) {
        tools.push(tool)
        return () => {}
      },
    },
    credentials: credentials || {
      async resolve() {
        return null
      },
      async set() {},
      async unset() {},
    },
    workspaceRegistry: {
      list: () => [],
    },
    connection: undefined,
  }
  return { ctx, routes, tools }
}

function fakeResponse() {
  return {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(text) {
      this.body = text
    },
  }
}

test('apply() wires the HTTP API and agent tools', async () => {
  const home = mkdtempSync(join(tmpdir(), 'one-pack-host-'))
  const previousHome = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = home
    assert.ok(inject.includes('webServer'))
    assert.ok(inject.includes('tools'))
    assert.ok(inject.includes('credentials'))

    const { ctx, routes, tools } = makeCtx({ home })
    apply(ctx)

    assert.equal(routes.length, 1)
    assert.equal(routes[0].path, '/one-pack/api')
    assert.equal(routes[0].kind, 'prefix')
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ['one_pack_setup', 'one_pack_status', 'one_pack_sync'],
    )
    for (const tool of tools) {
      assert.equal(typeof tool.execute, 'function')
      assert.equal(tool.parameters.type, 'object')
      assert.equal(typeof tool.output.render, 'function')
    }

    // GET /one-pack/api/status without a token still answers (repo unset).
    const res = fakeResponse()
    await routes[0].handler({ method: 'GET', url: '/one-pack/api/status', headers: {} }, res)
    assert.equal(res.status, 200)
    const payload = JSON.parse(res.body)
    assert.equal(payload.ok, true)
    assert.equal(payload.result.repo, '')
    assert.equal(payload.result.hasToken, false)
    assert.equal(payload.result.repoValid, false)
    assert.equal(payload.result.pending.length, 0)
    assert.equal(payload.result.activeJob, null)
    assert.ok(payload.result.schedule && typeof payload.result.schedule.enabled === 'boolean')
    assert.ok(payload.result.device.id, 'a stable device id must exist')

    // unknown subpath -> 404 JSON
    const missing = fakeResponse()
    await routes[0].handler({ method: 'GET', url: '/one-pack/api/nope', headers: {} }, missing)
    assert.equal(missing.status, 404)
    assert.equal(JSON.parse(missing.body).error.code, 'NOT_FOUND')

    // POST state persists repo/branch/sections through the state file
    const stateRes = fakeResponse()
    await routes[0].handler(
      {
        method: 'POST',
        url: '/one-pack/api/state',
        headers: {},
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(JSON.stringify({ repo: 'octo/one-pack', branch: 'sync', sections: { skills: true } }))
        },
      },
      stateRes,
    )
    assert.equal(stateRes.status, 200)
    const next = JSON.parse(stateRes.body).result
    assert.equal(next.repo, 'octo/one-pack')
    assert.equal(next.branch, 'sync')
    assert.equal(next.sections.skills, true)
    assert.equal(next.sections.plugins, true)
    assert.ok(existsSync(join(home, 'one-pack', 'state.json')))

    // invalid repo is rejected with a typed error
    const badRes = fakeResponse()
    await routes[0].handler(
      {
        method: 'POST',
        url: '/one-pack/api/state',
        headers: {},
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(JSON.stringify({ repo: 'not a repo' }))
        },
      },
      badRes,
    )
    assert.equal(badRes.status, 400)
    assert.equal(JSON.parse(badRes.body).error.code, 'INVALID_REPO')

    // POST repo/auto without a token -> typed NO_TOKEN (route exists, no network)
    const autoRes = fakeResponse()
    await routes[0].handler(
      {
        method: 'POST',
        url: '/one-pack/api/repo/auto',
        headers: {},
        async *[Symbol.asyncIterator]() {
          yield Buffer.from('{}')
        },
      },
      autoRes,
    )
    assert.equal(autoRes.status, 400)
    assert.equal(JSON.parse(autoRes.body).error.code, 'NO_TOKEN')

    // invalid repo name is rejected before touching GitHub
    const badName = fakeResponse()
    await routes[0].handler(
      {
        method: 'POST',
        url: '/one-pack/api/repo/auto',
        headers: {},
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(JSON.stringify({ name: 'bad name!' }))
        },
      },
      badName,
    )
    assert.equal(badName.status, 400)
    assert.equal(JSON.parse(badName.body).error.code, 'INVALID_REPO_NAME')

    // POST schedule validates + persists the daily auto-push window
    const schedRes = fakeResponse()
    await routes[0].handler(
      {
        method: 'POST',
        url: '/one-pack/api/schedule',
        headers: {},
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(JSON.stringify({ enabled: true, time: '18:00' }))
        },
      },
      schedRes,
    )
    assert.equal(schedRes.status, 200)
    const schedule = JSON.parse(schedRes.body).result.schedule
    assert.equal(schedule.enabled, true)
    assert.equal(schedule.time, '18:00')
    assert.equal(schedule.direction, 'push')

    const badSched = fakeResponse()
    await routes[0].handler(
      {
        method: 'POST',
        url: '/one-pack/api/schedule',
        headers: {},
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(JSON.stringify({ time: '25:99' }))
        },
      },
      badSched,
    )
    assert.equal(badSched.status, 400)
    assert.equal(JSON.parse(badSched.body).error.code, 'INVALID_SCHEDULE')

    const statusAfterSchedule = fakeResponse()
    await routes[0].handler({ method: 'GET', url: '/one-pack/api/status', headers: {} }, statusAfterSchedule)
    assert.equal(statusAfterSchedule.status, 200)
    assert.equal(JSON.parse(statusAfterSchedule.body).result.schedule.enabled, true)

    // background sync start/job plumbing: no token -> the job fails, UI can poll it
    const startRes = fakeResponse()
    await routes[0].handler(
      {
        method: 'POST',
        url: '/one-pack/api/sync/start',
        headers: {},
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(JSON.stringify({ direction: 'push', token: 'preview-token' }))
        },
      },
      startRes,
    )
    assert.equal(startRes.status, 202)
    const job = JSON.parse(startRes.body).result.job
    assert.ok(job.id)
    assert.equal(job.direction, 'push')
    assert.ok(['running', 'done', 'failed'].includes(job.status))

    let polled = null
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const pollRes = fakeResponse()
      await routes[0].handler(
        { method: 'GET', url: '/one-pack/api/sync/job?id=' + encodeURIComponent(job.id), headers: {} },
        pollRes,
      )
      assert.equal(pollRes.status, 200)
      polled = JSON.parse(pollRes.body).result.job
      if (polled.status !== 'running') break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(polled.status, 'failed')
    assert.equal(polled.error.code, 'PREVIEW_EXPIRED', 'background start still honours the one-shot preview token')

    const missingJob = fakeResponse()
    await routes[0].handler(
      { method: 'GET', url: '/one-pack/api/sync/job?id=job-nope', headers: {} },
      missingJob,
    )
    assert.equal(missingJob.status, 400)
    assert.equal(JSON.parse(missingJob.body).error.code, 'JOB_NOT_FOUND')

    // discarding a waiting preview is idempotent and touches nothing remote
    const discardRes = fakeResponse()
    await routes[0].handler(
      {
        method: 'POST',
        url: '/one-pack/api/sync/discard',
        headers: {},
        async *[Symbol.asyncIterator]() {
          yield Buffer.from('{}')
        },
      },
      discardRes,
    )
    assert.equal(discardRes.status, 200)
    assert.equal(JSON.parse(discardRes.body).result.discarded, 0)

    // restart endpoint acknowledges the reload request
    const restartRes = fakeResponse()
    await routes[0].handler(
      {
        method: 'POST',
        url: '/one-pack/api/restart',
        headers: {},
        async *[Symbol.asyncIterator]() {
          yield Buffer.from('{}')
        },
      },
      restartRes,
    )
    assert.equal(restartRes.status, 200)
    assert.equal(JSON.parse(restartRes.body).result.mode, 'reload')

    // status tool returns human-readable text
    const statusTool = tools.find((tool) => tool.name === 'one_pack_status')
    const status = await statusTool.execute({})
    assert.match(status.text, /One Pack/)
    assert.equal(typeof statusTool.output.render({}, status)[0].text, 'string')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})
test('DELETE /token clears every token alias so the panel disconnects', async () => {
  const home = mkdtempSync(join(tmpdir(), 'one-pack-host-token-'))
  const previousHome = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = home
    const values = new Map([
      ['ONE_PACK_GITHUB_TOKEN', 'new-token'],
      ['GITHUB_TOKEN', 'stale-token'],
    ])
    const credentials = {
      async resolve(ref) {
        const value = values.get(ref)
        return value ? { value } : null
      },
      async set(ref, value) {
        values.set(ref, value)
      },
      async unset(ref) {
        values.delete(ref)
      },
    }
    const { ctx, routes } = makeCtx({ home, credentials })
    apply(ctx)
    const handler = routes[0].handler

    const before = fakeResponse()
    await handler({ method: 'GET', url: '/one-pack/api/status', headers: {} }, before)
    assert.equal(JSON.parse(before.body).result.hasToken, true)

    const removed = fakeResponse()
    await handler({ method: 'DELETE', url: '/one-pack/api/token', headers: {} }, removed)
    assert.equal(removed.status, 200)
    assert.equal(JSON.parse(removed.body).result.hasToken, false)
    assert.equal(values.size, 0, 'both ONE_PACK_GITHUB_TOKEN and GITHUB_TOKEN must be cleared')

    const after = fakeResponse()
    await handler({ method: 'GET', url: '/one-pack/api/status', headers: {} }, after)
    assert.equal(JSON.parse(after.body).result.hasToken, false)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})
