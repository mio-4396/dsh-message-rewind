#!/usr/bin/env node
/**
 * Build script.
 *
 * The browser half ships as one classic script because the shell evaluates it
 * with `window.__ModuleLoader__`, and the Host half ships as one ES module
 * because the Loader imports it. Neither needs bundling, so this step is a copy
 * plus the checks that make a broken build fail here instead of at runtime:
 *
 *   1. copy `src/` into `lib/`,
 *   2. syntax-check both outputs with `node --check`,
 *   3. validate the manifest, patch, locales, and icon,
 *   4. prove the patch row and the client module id agree with the package name.
 *
 * Run with `npm run build`; `npm test` builds first.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'src')
const LIB = path.join(ROOT, 'lib')

const failures = []

function fail(message) {
  failures.push(message)
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function check(condition, message) {
  if (!condition) fail(message)
}

// ---- 1. copy -----------------------------------------------------------------
mkdirSync(LIB, { recursive: true })
for (const entry of readdirSync(SRC)) {
  const from = path.join(SRC, entry)
  if (!statSync(from).isFile()) continue
  copyFileSync(from, path.join(LIB, entry))
  console.log(`  copied src/${entry} -> lib/${entry}`)
}

// ---- 2. syntax ---------------------------------------------------------------
for (const file of ['lib/index.js', 'lib/client.js']) {
  const target = path.join(ROOT, file)
  if (!existsSync(target)) {
    fail(`${file} is missing after the copy`)
    continue
  }
  try {
    execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' })
    console.log(`  syntax ok: ${file}`)
  } catch (error) {
    fail(`${file} does not parse: ${String(error.stderr ?? error.message).trim()}`)
  }
}

// ---- 3. manifest, patch, locales, icon --------------------------------------
const manifest = readJson(path.join(ROOT, 'package.json'))
check(typeof manifest.name === 'string' && manifest.name !== '', 'package.json needs a name')
check(manifest.main === 'lib/index.js', 'package.json main must be lib/index.js')
check(manifest.dsh?.bundle?.patch === './cordis.patch.yml', 'package.json dsh.bundle.patch must point at cordis.patch.yml')
check(manifest.dsh?.client?.platform === 'web', 'package.json dsh.client.platform must be web')
check(manifest.exports?.['.'] === './lib/index.js', 'exports["."] must point at the built Host half')
check(manifest.exports?.['./client'] === './lib/client.js', 'exports["./client"] must point at the built browser half')
for (const required of ['lib/index.js', 'lib/client.js', 'cordis.patch.yml']) {
  check(Array.isArray(manifest.files) && manifest.files.includes(required), `files must include ${required}`)
}

const patch = readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8')
const rowId = patch.match(/^\s*-\s*id:\s*(\S+)\s*$/m)?.[1]
check(rowId === manifest.name, `cordis.patch.yml row id "${rowId ?? 'missing'}" must equal the package name`)
check(patch.includes(`name: '${manifest.name}'`), 'cordis.patch.yml must insert this package by name')

for (const locale of ['en', 'zh']) {
  const file = path.join(ROOT, 'locale', `${locale}.json`)
  check(existsSync(file), `locale/${locale}.json is missing`)
  if (!existsSync(file)) continue
  const dict = readJson(file)
  check(typeof dict.meta?.title === 'string' && dict.meta.title !== '', `locale/${locale}.json needs meta.title`)
  check(typeof dict.meta?.description === 'string' && dict.meta.description !== '', `locale/${locale}.json needs meta.description`)
}

const iconFile = path.join(ROOT, 'icon.svg')
check(existsSync(iconFile), 'icon.svg is missing')
if (existsSync(iconFile)) {
  const icon = readFileSync(iconFile, 'utf8')
  check(icon.includes('<svg') && icon.trimEnd().endsWith('</svg>'), 'icon.svg is not a complete SVG document')
  check(Buffer.byteLength(icon) <= 256 * 1024, 'icon.svg exceeds the 256 KiB icon limit')
}

// ---- 4. runtime agreement ----------------------------------------------------
const host = readFileSync(path.join(ROOT, 'lib/index.js'), 'utf8')
check(/export\s+const\s+name\s*=\s*'[^']+'/.test(host), 'lib/index.js must export the plugin name')
const client = readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8')
const moduleId = client.match(/__ModuleLoader__\.load\(\s*\{\s*id:\s*'([^']+)'/)?.[1]
check(moduleId === manifest.name, `browser module id "${moduleId ?? 'missing'}" must equal the package name`)

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`)
  process.exit(1)
}
console.log('build ok')
