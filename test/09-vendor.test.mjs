/**
 * 09 — vendored engines: a fresh install must work with no prerequisites.
 *
 * The engines used to be resolved from a local install (`local.config.json`, an env root or
 * an installed package). They now also ship inside `vendor/`, and that copy is what a fresh
 * user gets. This test proves the vendored files exist, that their licenses travel with
 * them, that the resolution order reaches them, and that the whole plugin boots from them
 * with no local wiring at all.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveEngine } from '../backends/resolve.js'
import { bootPlugin } from './harness.mjs'
import { createReport } from './assert.mjs'

const report = createReport('vendored engines')
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')

for (const required of [
  'vendor/pixel/index.js',
  'vendor/pixel/lib/config.js',
  'vendor/pixel/runtime/bootstrap.mjs',
  'vendor/pixel/node_modules/@deepseek-ai/schemastery/package.json',
  'vendor/pixel/LICENSE',
  'vendor/uia/src/win32.js',
  'vendor/uia/src/uia.js',
  'vendor/uia/src/capture.js',
  'vendor/uia/node_modules/koffi/index.js',
  'vendor/uia/node_modules/@koromix',
  'vendor/uia/LICENSE',
]) {
  report.ok(`vendor file present: ${required}`, existsSync(join(REPO, required)))
}

// Both engines load from the vendor copy without a DSH context.
try {
  const pixel = await import(pathToFileURL(join(REPO, 'vendor', 'pixel', 'index.js')).href)
  report.ok('vendored pixel module imports', typeof pixel.apply === 'function')
  report.ok('vendored pixel exposes the runtime factory', typeof pixel.__createRuntime === 'function')
} catch (error) {
  report.ok('vendored pixel module imports', false, error.message)
}
try {
  const win32 = await import(pathToFileURL(join(REPO, 'vendor', 'uia', 'src', 'win32.js')).href)
  report.ok('vendored uia win32 module imports', typeof win32 === 'object' && Object.keys(win32).length > 0)
} catch (error) {
  report.ok('vendored uia win32 module imports', false, error.message)
}

// Resolution order: an explicit config path wins, otherwise the vendor copy answers.
const configured = resolveEngine('pixel', join(REPO, 'vendor', 'pixel'))
report.ok('an explicit config path still wins', configured.ok && configured.source === 'config', configured.source)
const missing = resolveEngine('pixel', join(REPO, 'no-such-engine'))
report.ok('a bogus config path is an error, not a fallback', missing.ok === false && missing.source === 'config', missing.reason)

// Licenses travel with the code: MIT requires the notice in copies.
for (const file of ['vendor/pixel/LICENSE', 'vendor/uia/LICENSE']) {
  const text = existsSync(join(REPO, file)) ? readFileSync(join(REPO, file), 'utf8') : ''
  report.ok(`license text in ${file}`, /MIT License|Permission is hereby granted/i.test(text))
}

// The real proof: boot the whole plugin with local wiring hidden. Every engine must come
// from vendor/, and the surface must still register.
const localPath = join(REPO, 'local.config.json')
const hidden = `${localPath}.test-hidden`
const backup = existsSync(localPath) ? readFileSync(localPath, 'utf8') : null
let plugin = null
try {
  if (backup !== null) renameSync(localPath, hidden)
  const vendorOnly = resolveEngine('pixel', '')
  report.ok('vendor answers when no local wiring exists', vendorOnly.ok && vendorOnly.source === 'vendor', vendorOnly.source)
  plugin = await bootPlugin({ config: {} })
  const status = await plugin.call('hands_status', { tail: 5 })
  report.ok('plugin boots with only the vendored engines', Boolean(status && status.text))
  report.ok('status reports pixel as ok', /pixel=ok/.test(String(status && status.text)), String(status && status.text).slice(0, 80))
  const backendRow = (() => {
    try {
      const file = join(plugin.dataDir, 'audit', 'hands.jsonl')
      const rows = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      return rows.filter((row) => row.decision === 'ready').pop()
    } catch {
      return null
    }
  })()
  report.ok('backends came from vendor', Boolean(backendRow && String(backendRow.reason).includes('vendor')), backendRow && backendRow.reason)
} catch (error) {
  report.ok('plugin boots with only the vendored engines', false, error.message)
} finally {
  if (plugin) plugin.close()
  if (backup !== null) writeFileSync(localPath, backup, 'utf8')
  if (existsSync(hidden)) renameSync(hidden, localPath)
}

const ok = report.finish()
process.exit(ok ? 0 : 1)
