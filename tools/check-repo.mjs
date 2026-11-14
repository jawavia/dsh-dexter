#!/usr/bin/env node
/**
 * check-repo.mjs — repository hygiene, A13.
 *
 * Fails on anything that must never be published:
 *   - a machine path, a user name, a credential-shaped string;
 *   - an audit log, a screenshot, a compiled binary;
 *   - a missing LICENSE / THIRD-PARTY / SECURITY document;
 *   - a manifest whose `files` does not cover a runtime module.
 * Also prints the license of every package the plugin loads at runtime, so an
 * unknown license is a visible line instead of a surprise after publishing.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const SKIP_DIRS = new Set(['node_modules', '.git', 'baseline', 'evidence'])
const TEXT_EXT = /\.(mjs|js|json|yml|yaml|md|txt|svg|cmd|ps1)$/
const SKIP_FILES = new Set(['local.config.json'])

const findings = []
const fail = (message) => findings.push({ level: 'FAIL', message })
const warn = (message) => findings.push({ level: 'WARN', message })
const info = (message) => findings.push({ level: 'INFO', message })

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

const files = walk(REPO).filter((file) => !SKIP_FILES.has(relative(REPO, file)))

// ---- 1. required documents ------------------------------------------------
for (const required of ['LICENSE', 'THIRD-PARTY-NOTICES.md', 'SECURITY.md', 'README.md', 'package.json', 'cordis.patch.yml', 'locale/en.json', 'locale/zh.json', 'icon.svg']) {
  if (!existsSync(join(REPO, required))) fail(`missing required file: ${required}`)
}
const security = existsSync(join(REPO, 'SECURITY.md')) ? readFileSync(join(REPO, 'SECURITY.md'), 'utf8') : ''
for (const needle of ['local execution', 'network', 'per-action', 'not a security boundary', 'Reporting a vulnerability']) {
  if (!security.toLowerCase().includes(needle.toLowerCase())) fail(`SECURITY.md does not state: ${needle}`)
}

// ---- 2. forbidden content -------------------------------------------------
const forbidden = [
  { name: 'absolute Windows user path', pattern: /[A-Za-z]:[\\/]{1,2}Users[\\/]/i },
  { name: 'absolute drive path', pattern: /[A-Za-z]:\\\\[A-Za-z0-9_]/ },
  { name: 'known local user name', pattern: /\bpzc45/i },
  { name: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'npm token', pattern: /\bnpm_[A-Za-z0-9]{30,}/ },
  { name: 'generic api key', pattern: /\bsk-[A-Za-z0-9]{20,}/ },
]
for (const file of files) {
  const rel = relative(REPO, file)
  const ext = file.slice(file.lastIndexOf('.'))
  if (['.jsonl', '.log', '.exe', '.dll', '.node', '.png', '.jpg'].includes(ext)) {
    fail(`forbidden artifact in repo: ${rel}`)
    continue
  }
  if (!TEXT_EXT.test(file)) continue
  if (statSync(file).size > 2 * 1024 * 1024) {
    warn(`large text file: ${rel}`)
    continue
  }
  const text = readFileSync(file, 'utf8')
  for (const rule of forbidden) {
    if (rule.pattern.test(text)) fail(`${rule.name} in ${rel}`)
  }
}

// ---- 3. manifest ----------------------------------------------------------
const manifest = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))
if (manifest.os && !manifest.os.includes('win32')) fail('package.json must declare os: ["win32"] (Windows-only)')
if (!manifest.dsh || !manifest.dsh.bundle || !manifest.dsh.bundle.patch) fail('package.json is not a bundle (dsh.bundle.patch)')
else if (!existsSync(join(REPO, manifest.dsh.bundle.patch))) fail(`bundle patch missing: ${manifest.dsh.bundle.patch}`)
for (const entry of ['locale/en.json', 'locale/zh.json', 'icon.svg']) {
  if (!existsSync(join(REPO, entry))) fail(`manifest display resource missing: ${entry}`)
}
for (const runtimeDir of ['kernel', 'backends', 'tools']) {
  if (!existsSync(join(REPO, runtimeDir))) fail(`runtime directory missing: ${runtimeDir}`)
  const listed = (manifest.files || []).some((pattern) => pattern === runtimeDir || pattern.startsWith(`${runtimeDir}/`))
  if (!listed) fail(`package.json files[] does not cover ${runtimeDir}/`)
}
if (!(manifest.files || []).includes('index.js')) fail('package.json files[] does not cover index.js')

// ---- 4. patch sanity ------------------------------------------------------
const patch = readFileSync(join(REPO, 'cordis.patch.yml'), 'utf8')
if (!patch.includes('dsh-dexter')) fail('cordis.patch.yml does not insert the dsh-dexter row')
if (!/name:\s*dsh-dexter/.test(patch)) fail('cordis.patch.yml row name is not dsh-dexter')

// ---- 5. license scan ------------------------------------------------------
const licenseOf = (dir) => {
  try {
    const file = join(dir, 'package.json')
    if (!existsSync(file)) return null
    const pkg = JSON.parse(readFileSync(file, 'utf8'))
    return { name: pkg.name, version: pkg.version, license: pkg.license || (existsSync(join(dir, 'LICENSE')) ? 'see LICENSE file' : 'UNKNOWN') }
  } catch {
    return null
  }
}
info(`in-repo license: MIT (LICENSE)`)

function resolveLegacyRoot() {
  if (process.env.DSH_DEXTER_LEGACY_ROOT) return process.env.DSH_DEXTER_LEGACY_ROOT
  try {
    const local = JSON.parse(readFileSync(join(REPO, 'local.config.json'), 'utf8'))
    return local.legacyRoot || ''
  } catch {
    return ''
  }
}
const root = resolveLegacyRoot()
const runtimeLicenses = []
if (root) {
  for (const [name, sub] of [['pixel', 'pixel'], ['uia', 'control']]) {
    const dir = join(root, 'engines', sub)
    const license = licenseOf(dir)
    runtimeLicenses.push({ engine: name, ...(license || { name: '(not found)', license: 'MISSING' }) })
  }
}
if (runtimeLicenses.length === 0) warn('legacy engines not resolvable here: runtime license check skipped')
for (const entry of runtimeLicenses) {
  if (!entry.license || entry.license === 'UNKNOWN' || entry.license === 'MISSING') {
    warn(`runtime prerequisite ${entry.engine} (${entry.name}) declares no license: not redistributed by this repo`)
  } else {
    info(`runtime prerequisite ${entry.engine}: ${entry.name} ${entry.license}`)
  }
}

// ---- report ---------------------------------------------------------------
const fails = findings.filter((finding) => finding.level === 'FAIL')
const warns = findings.filter((finding) => finding.level === 'WARN')
for (const finding of findings) {
  if (finding.level !== 'INFO') console.log(`${finding.level} ${finding.message}`)
  else console.log(`     ${finding.message}`)
}
const summary = {
  generatedAt: new Date().toISOString(),
  files: files.length,
  fails: fails.length,
  warns: warns.length,
  runtimeLicenses,
  inRepoLicense: 'MIT',
}
console.log(`\ncheck-repo: ${files.length} files, ${fails.length} FAIL, ${warns.length} WARN`)
console.log(JSON.stringify(summary))
process.exitCode = fails.length === 0 ? 0 : 1
