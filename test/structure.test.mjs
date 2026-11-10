// Static packaging / contract checks for dsh-one-pack.
// Runs without installing the plugin and without network access.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const json = (rel) => JSON.parse(read(rel))

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

test('package.json declares a complete DSH plugin', () => {
  const pkg = json('package.json')
  assert.equal(pkg.name, 'dsh-one-pack')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.private, undefined, 'must not be private:true')
  assert.equal(pkg.license, 'MIT')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.dsh.client.immediately, true)
  assert.match(pkg.engines.node, />=22/)
  assert.match(pkg.engines.dsh, />=/)
  assert.equal(pkg.publishConfig?.access, 'public')

  // exports must point at real files
  for (const [key, target] of Object.entries(pkg.exports ?? {})) {
    const file = typeof target === 'string' ? target : target?.import ?? target?.default
    if (key.includes('*')) continue
    assert.ok(file && existsSync(join(ROOT, file)), `exports["${key}"] -> ${file} missing`)
  }
  assert.ok(existsSync(join(ROOT, 'client.js')), 'client.js must ship')
  for (const needed of ['index.js', 'client.js', 'lib/', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md', 'LICENSE', 'NOTICE']) {
    assert.ok(pkg.files.includes(needed), `files[] must include ${needed}`)
  }
})

test('cordis.patch.yml inserts the plugin entry', () => {
  const patch = read('cordis.patch.yml')
  assert.match(patch, /^- insert:/m)
  assert.match(patch, /id:\s*one-pack/)
  assert.match(patch, /name:\s*['"]?dsh-one-pack['"]?/)
})

test('host side only uses Node built-ins and self modules', () => {
  const pkg = json('package.json')
  assert.equal(pkg.dependencies, undefined, 'no runtime dependencies')
  const hostFiles = ['index.js', ...walk(join(ROOT, 'lib')).map((f) => f.slice(ROOT.length + 1))]
  for (const rel of hostFiles) {
    const src = read(rel)
    for (const m of src.matchAll(/(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1]
      if (spec.startsWith('.') || spec.startsWith('node:')) continue
      assert.fail(`${rel} imports bare module "${spec}" (Node built-ins only)`)
    }
  }
})

test('all JS and MJS files parse', () => {
  const files = walk(ROOT).filter((f) => /\.(mjs|js)$/.test(f))
  assert.ok(files.length >= 8)
  for (const file of files) {
    const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    assert.equal(res.status, 0, `${file}\n${res.stderr}`)
  }
})

test('index.js exports the cordis plugin surface', () => {
  const src = read('index.js')
  assert.match(src, /export function apply\s*\(/)
  assert.match(src, /export const inject\s*=\s*\[/)
  for (const svc of ['webServer', 'credentials', 'workspaceRegistry', 'tools']) {
    assert.ok(src.includes(`'${svc}'`), `inject must request ${svc}`)
  }
  for (const route of ['/one-pack/api', 'one_pack_status', 'one_pack_sync', 'one_pack_setup']) {
    assert.ok(src.includes(route), `index.js must expose ${route}`)
  }
  assert.match(src, /requestRejection/, 'HTTP routes must authenticate')
})

test('client half registers sidebar entry and main panel', () => {
  const src = read('client.js')
  assert.match(src, /__ModuleLoader__\.load\(/)
  assert.match(src, /id:\s*['"]dsh-one-pack['"]/)
  assert.match(src, /sidebar\.panellist/)
  assert.match(src, /name:\s*['"]main['"]/)
  assert.ok(src.includes("require('react')"), 'client must only require react')
  for (const m of src.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    assert.ok(m[1] === 'react' || m[1].startsWith('.') || m[1].startsWith('node:'), `client requires unexpected module "${m[1]}"`)
  }
  assert.ok(src.includes('/one-pack/api/'), 'client must call the plugin HTTP API')
  assert.ok(!/document\.body/.test(src), 'client must not touch document.body')
  assert.ok(!/<iframe/i.test(src), 'client must not use iframes')
})

test('locale metadata and icon are present', () => {
  for (const lang of ['zh', 'en']) {
    const doc = json(`locale/${lang}.json`)
    assert.equal(doc.meta.title, 'One Pack')
    assert.ok(doc.meta.description.length > 0)
  }
  const svg = read('icon.svg')
  assert.match(svg, /<svg[\s>]/)
  assert.match(svg, /viewBox="0 0 24 24"/)
})

test('required libraries are present', () => {
  const required = [
    'lib/paths.mjs',
    'lib/util.mjs',
    'lib/state.mjs',
    'lib/orchestrator.mjs',
    'lib/cloud.mjs',
    'lib/sessions.mjs',
    'lib/sections/plugins.mjs',
    'lib/sections/settings.mjs',
    'lib/sections/skills.mjs',
    'lib/sections/files.mjs',
    'lib/vendor/github.mjs',
    'lib/vendor/guard.mjs',
    'lib/vendor/folders.mjs',
    'lib/vendor/projectkey.mjs',
    'lib/vendor/zstdframe.mjs',
    'lib/vendor/sessionlog.mjs',
    'lib/vendor/localsessions.mjs',
    'lib/vendor/attachments.mjs',
    'lib/vendor/sessiondir.mjs'
  ]
  for (const rel of required) {
    assert.ok(existsSync(join(ROOT, rel)), `${rel} missing`)
    assert.ok(statSync(join(ROOT, rel)).size > 0, `${rel} empty`)
  }
})

test('vendored files carry the MIT attribution', () => {
  const notice = read('NOTICE')
  for (const file of readdirSync(join(ROOT, 'lib/vendor'))) {
    assert.ok(notice.includes(`lib/vendor/${file}`), `NOTICE must list ${file}`)
    assert.match(read(`lib/vendor/${file}`), /MIT/i, `${file} must carry a license header`)
  }
})