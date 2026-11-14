#!/usr/bin/env node
/**
 * run-all.mjs — the fast suite (no injection): surface, invariants, config, repo.
 * The live smoke test and the dual-run are separate on purpose: they move the
 * real cursor, so they run when a human says so.
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const STEPS = [
  ['01-surface.test.mjs', 'A1/A2/A3/A10 surface'],
  ['02-auth-invariants.test.mjs', 'A4/A5/A7/A8/A9/A10 invariants'],
  ['03-config-single-source.test.mjs', 'A6 config'],
  ['04-tool-output.test.mjs', 'tool output contract'],
  ['05-compat.test.mjs', 'compat / edge cases'],
  [join('..', 'tools', 'check-repo.mjs'), 'A13 repository hygiene'],
]

let failed = 0
for (const [file, label] of STEPS) {
  console.log(`\n=== ${label} (${file}) ===`)
  const result = spawnSync(process.execPath, [join(HERE, file)], { stdio: 'inherit', windowsHide: true })
  if (result.status !== 0) {
    failed += 1
    console.log(`FAILED: ${label}`)
  }
}
console.log(`\nrun-all: ${STEPS.length - failed}/${STEPS.length} suites passed`)
process.exit(failed === 0 ? 0 : 1)
