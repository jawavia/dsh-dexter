#!/usr/bin/env node
/**
 * ci-local.mjs — run the published CI definition locally, and check that it stays
 * static.
 *
 * A15 says the public workflow must run static checks only and must pass. Until a
 * repository exists (and the human allows a push) the workflow cannot execute on
 * GitHub, so this script does the two things that can be verified here:
 *
 *   1. static validation of `.github/workflows/ci.yml`: every `node <path>` it runs
 *      exists, the file parses as the expected block shape, and neither GUI suite
 *      (live-smoke / dual-run) is listed;
 *   2. it then runs exactly those commands, in order, in this checkout.
 *
 * What it does NOT prove: that GitHub Actions accepts the file. That stays "prepared,
 * not proven" in evidence/P6.md.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const WORKFLOW = join(REPO, '.github', 'workflows', 'ci.yml')
const FORBIDDEN = ['live-smoke.mjs', 'dual-run.mjs']

const findings = []
const fail = (message) => findings.push(`FAIL ${message}`)
const ok = (message) => findings.push(`ok   ${message}`)

if (!existsSync(WORKFLOW)) {
  console.error('FAIL .github/workflows/ci.yml is missing')
  process.exit(1)
}
const text = readFileSync(WORKFLOW, 'utf8')

// --- structural checks (no YAML library available in this checkout) -------------
const lines = text.split(/\r?\n/)
if (!/^name:\s*\S+/m.test(text)) fail('workflow has no top-level name')
if (!/^on:/m.test(text)) fail('workflow has no trigger block')
if (!/^jobs:/m.test(text)) fail('workflow has no jobs block')
if (!/runs-on:\s*windows-latest/.test(text)) fail('workflow does not run on windows-latest')
const tabs = lines.filter((line) => line.startsWith('\t'))
if (tabs.length > 0) fail('workflow uses tabs for indentation')
if (findings.length === 0) ok('workflow structure: name / on / jobs / windows-latest, spaces only')

// --- every node command must exist, and no GUI suite may be listed -------------
const commands = [...text.matchAll(/^\s*node\s+([^\s]+)/gm)].map((match) => match[1])
if (commands.length === 0) fail('workflow runs no node command')
for (const command of commands) {
  const target = join(REPO, command.split('/').join('/'))
  if (!existsSync(target)) fail(`workflow references a missing file: ${command}`)
  else ok(`command exists: ${command}`)
}
for (const forbidden of FORBIDDEN) {
  // Only real `node <path>` invocations count: the workflow's comments explain why the
  // GUI suites are excluded, and naming them there must not look like running them.
  if (commands.some((command) => command.includes(forbidden))) fail(`GUI suite is listed in CI: ${forbidden}`)
}
if (!FORBIDDEN.some((name) => commands.some((command) => command.includes(name)))) ok('GUI suites are not run in CI (static only)')

// --- run them, in workflow order ----------------------------------------------
let failed = 0
for (const command of commands) {
  const [file, ...args] = command.split(' ')
  console.log(`\n=== node ${command} ===`)
  const result = spawnSync(process.execPath, [file, ...args], { cwd: REPO, stdio: 'inherit', windowsHide: true })
  if (result.status !== 0) {
    failed += 1
    fail(`command failed: node ${command}`)
  }
}

for (const line of findings) console.log(line)
const failures = findings.filter((line) => line.startsWith('FAIL'))
console.log(`\nci-local: ${commands.length - failed}/${commands.length} commands passed, ${failures.length} structural failure(s)`)
console.log('note: GitHub Actions itself has not run this workflow; see evidence/P6.md')
process.exit(failures.length === 0 ? 0 : 1)
