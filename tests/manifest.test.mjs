/**
 * Manifest and build-output tests.
 *
 * These are the failures that would leave a user with an installed plugin that
 * silently does nothing: a patch row that names the wrong package, a client
 * module whose id does not match, a missing locale title, or a build output that
 * fell behind its source. Everything here runs without a browser or a Host.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

/** Same bytes in src and lib, so a stale build fails the test instead of shipping. */
function assertFresh(file) {
  const source = readFileSync(path.join(ROOT, 'src', file))
  const built = readFileSync(path.join(ROOT, 'lib', file))
  assert.deepEqual(built, source, `lib/${file} is stale; run npm run build`)
}

test('package metadata is complete', () => {
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.license, 'MIT')
  assert.equal(manifest.icon, './icon.svg')
  assert.ok(manifest.description.length > 20, 'description should describe the capability')
  assert.ok(!manifest.dependencies, 'this plugin needs no runtime dependencies')
})

test('the bundle patch inserts exactly this package', () => {
  const patch = readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8')
  const ids = [...patch.matchAll(/^\s*-\s*id:\s*(\S+)\s*$/gm)].map((match) => match[1])
  assert.deepEqual(ids, [manifest.name])
  assert.ok(patch.includes(`name: '${manifest.name}'`))
})

test('exports point at the built halves', () => {
  assert.equal(manifest.main, 'lib/index.js')
  assert.equal(manifest.exports['.'], './lib/index.js')
  assert.equal(manifest.exports['./client'], './lib/client.js')
  assert.equal(manifest.exports['./icon'], './icon.svg')
})

test('the browser half declares the same module id as the package', () => {
  const client = readFileSync(path.join(ROOT, 'src', 'client.js'), 'utf8')
  const id = client.match(/__ModuleLoader__\.load\(\s*\{\s*id:\s*'([^']+)'/)?.[1]
  assert.equal(id, manifest.name)
  assert.ok(client.includes('conversation.chat.user.before'), 'the action lives in the user-row seat')
})

test('the host half exports the plugin name and the cancel route', () => {
  const host = readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf8')
  assert.match(host, /export\s+const\s+name\s*=\s*'[^']+'/)
  assert.ok(host.includes("route === '/cancel'"), 'the cancel route is the reason this half exists')
  assert.ok(host.includes('sessionController'), 'cancellation goes through the Session Controller')
})

test('the build outputs are fresh', () => {
  assertFresh('index.js')
  assertFresh('client.js')
})

test('both build outputs parse', () => {
  for (const file of ['lib/index.js', 'lib/client.js']) {
    execFileSync(process.execPath, ['--check', path.join(ROOT, file)], { stdio: 'pipe' })
  }
})

test('every locale carries a title and a description', () => {
  const files = readdirSync(path.join(ROOT, 'locale')).filter((name) => name.endsWith('.json'))
  assert.ok(files.length >= 2, 'at least English and Chinese')
  for (const file of files) {
    const dict = JSON.parse(readFileSync(path.join(ROOT, 'locale', file), 'utf8'))
    assert.ok(typeof dict.meta?.title === 'string' && dict.meta.title !== '', `${file} meta.title`)
    assert.ok(typeof dict.meta?.description === 'string' && dict.meta.description !== '', `${file} meta.description`)
  }
})

test('the icon is a small complete SVG', () => {
  const icon = readFileSync(path.join(ROOT, 'icon.svg'), 'utf8')
  assert.ok(icon.startsWith('<svg') || icon.includes('<svg'))
  assert.ok(icon.trimEnd().endsWith('</svg>'))
  assert.ok(statSync(path.join(ROOT, 'icon.svg')).size <= 256 * 1024)
})
