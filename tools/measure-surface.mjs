#!/usr/bin/env node
/**
 * measure-surface.mjs — tool-surface weight, in the same unit as the old baseline.
 *
 * Metric (identical to `tools/baseline.json` of dsh-desktop-hands v0.2.6):
 *   descBytes          UTF-8 bytes of the tool description
 *   paramSchemaBytes   UTF-8 bytes of JSON.stringify(parameters) — a bare
 *                      `properties` map is wrapped as {type:'object', properties}
 *   outputSchemaBytes  UTF-8 bytes of JSON.stringify(output.schema)
 *   subtotal           descBytes + paramSchemaBytes + outputSchemaBytes
 *
 * Usage
 *   node tools/measure-surface.mjs legacy <old-package-dir> [--out file.json]
 *   node tools/measure-surface.mjs dexter [repo-dir]        [--out file.json]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { capture } from './surface-harness.mjs'

// Booting the plugin must not claim the real global hotkeys (and must not leave a compiled
// listener behind): this tool only measures the tool surface.
process.env.DSH_DEXTER_NO_HOTKEYS = '1'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')

/** The old surface metric, applied to one tool definition. */
export function weighTool(def) {
  const description = typeof def.description === 'string' ? def.description : ''
  const rawParameters = def.parameters && typeof def.parameters === 'object' ? def.parameters : { type: 'object', properties: {} }
  const parameters = Object.hasOwn(rawParameters, 'type') && rawParameters.type === 'object'
    ? rawParameters
    : { type: 'object', properties: rawParameters }
  const outputSchema = def.output && def.output.schema && typeof def.output.schema === 'object'
    ? def.output.schema
    : {}
  const descBytes = Buffer.byteLength(description, 'utf8')
  const paramSchemaBytes = Buffer.byteLength(JSON.stringify(parameters), 'utf8')
  const outputSchemaBytes = Buffer.byteLength(JSON.stringify(outputSchema), 'utf8')
  const paramCount = parameters.properties && typeof parameters.properties === 'object'
    ? Object.keys(parameters.properties).length
    : 0
  return {
    name: def.name,
    descChars: [...description].length,
    descBytes,
    paramCount,
    paramSchemaBytes,
    outputSchemaBytes,
    subtotal: descBytes + paramSchemaBytes + outputSchemaBytes,
  }
}

/** Weigh a set of definitions and total them. */
export function weighSurface(tools) {
  const rows = tools.map(weighTool)
  const totals = rows.reduce(
    (acc, row) => ({
      tools: acc.tools + 1,
      descBytes: acc.descBytes + row.descBytes,
      paramSchemaBytes: acc.paramSchemaBytes + row.paramSchemaBytes,
      outputSchemaBytes: acc.outputSchemaBytes + row.outputSchemaBytes,
      totalBytes: acc.totalBytes + row.subtotal,
    }),
    { tools: 0, descBytes: 0, paramSchemaBytes: 0, outputSchemaBytes: 0, totalBytes: 0 },
  )
  return { tools: rows, totals }
}

async function measureLegacy(oldRoot) {
  const root = resolve(oldRoot)
  const baselinePath = join(root, 'tools', 'baseline.json')
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
  const engines = [
    ['pixel', join(root, 'engines', 'pixel'), 'index.js', {}],
    ['control', join(root, 'engines', 'control'), 'src/index.js', { hotkeyArm: false, overlayWarm: false }],
    ['stroke', join(root, 'engines', 'stroke'), 'index.js', {}],
  ]
  const groups = {}
  const all = []
  for (const [name, dir, entry, config] of engines) {
    const result = await capture({ dir, entry, config })
    try {
      const measured = weighSurface(result.tools)
      groups[name] = { ...measured, logs: result.logs.slice(0, 20) }
      all.push(...result.tools)
    } finally {
      result.cleanup()
    }
  }
  const total = weighSurface(all)
  return {
    // Publishable output: a machine path in a tracked baseline is a leak (R7/A13).\n    source: { kind: 'legacy', root: '<legacy-root>' },
    baseline: baseline.totals,
    groups,
    totals: total.totals,
    names: all.map((def) => def.name).sort(),
    matchesBaselineBytes: total.totals.totalBytes === baseline.totals.totalBytes,
    matchesBaselineTools: total.totals.tools === baseline.totals.tools,
  }
}

async function measureDexter(repoRoot) {
  const dir = resolve(repoRoot)
  const result = await capture({ dir })
  try {
    const measured = weighSurface(result.tools)
    return { source: { kind: 'dexter', dir: '<repo>' }, ...measured, names: result.tools.map((def) => def.name).sort(), logs: result.logs.slice(0, 40) }
  } finally {
    result.cleanup()
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const outIndex = argv.indexOf('--out')
  const out = outIndex >= 0 ? argv[outIndex + 1] : ''
  const args = outIndex >= 0 ? argv.filter((_, i) => i !== outIndex && i !== outIndex + 1) : argv
  const [mode, target] = args
  let report
  if (mode === 'legacy') report = await measureLegacy(target || '')
  else if (mode === 'dexter') report = await measureDexter(target || REPO)
  else {
    process.stderr.write('usage: measure-surface.mjs legacy <old-package-dir> | dexter [repo-dir] [--out file]\n')
    process.exit(2)
  }
  const json = `${JSON.stringify(report, null, 2)}\n`
  if (out) {
    mkdirSync(dirname(resolve(out)), { recursive: true })
    writeFileSync(resolve(out), json, 'utf8')
  }
  process.stdout.write(`${JSON.stringify({ totals: report.totals, matchesBaselineBytes: report.matchesBaselineBytes, matchesBaselineTools: report.matchesBaselineTools, groups: report.groups && Object.fromEntries(Object.entries(report.groups).map(([k, v]) => [k, v.totals || { tools: v.tools.length, totalBytes: v.totalBytes }])) }, null, 2)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
