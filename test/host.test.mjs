// Host-half smoke test: mount apply() on a fake Cordis context, verify the
// plugin registers its HTTP route + tools and that GET status answers JSON
// without touching the network or the real profile.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, inject } from '../index.js'

function makeCtx({ home }) {
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
    credentials: {
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