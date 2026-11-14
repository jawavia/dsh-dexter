#!/usr/bin/env node
/**
 * click-bench.mjs — the fixture-based click speed/accuracy benchmark, run against
 * BOTH generations of the pixel engine on the same machine, in the same session.
 *
 * The testbed is the old package's own acceptance fixture (`engines/pixel/test/fixture.cs`):
 * a topmost WinForms window with TARGET-A/B/C buttons. Every real click appends
 * `<ticks>|<control>|<x>|<y>|<foreground>` to a log, and the window publishes the
 * button centres as JSON. So "accuracy" is not a guess: either the click landed on the
 * intended button (the fixture says so) or it did not.
 *
 * What is compared:
 *   accuracy  — fraction of clicks whose logged control matches the intended target
 *   latency   — wall time of the tool call itself (ms)
 *   overhead  — new vs old latency delta (the kernel's gate + audit + verify work)
 *
 * Both sides run with their own scratch data root, and their gates are armed
 * programmatically (`source: 'test'`) because a human cannot press a key for every
 * benchmark click. Nothing here touches the live audit trail.
 *
 * Usage: node tools/click-bench.mjs [--rounds 4] [--json out.json]
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

function legacyRoot() {
  if (process.env.DSH_DEXTER_LEGACY_ROOT) return process.env.DSH_DEXTER_LEGACY_ROOT
  try {
    return JSON.parse(readFileSync(join(REPO, 'local.config.json'), 'utf8')).legacyRoot || ''
  } catch {
    return ''
  }
}

/**
 * Build (once) and start the old package's acceptance fixture.
 *
 * It must NOT be a descendant of this process: the pixel engine protects its own
 * process tree, so a fixture spawned by node is refused as "host process tree". The
 * shell (explorer.exe) launches it instead — the same thing a double-click does — which
 * puts it outside our tree while still passing arguments.
 */
async function startFixture(root, work) {
  const pixelDir = join(root, 'engines', 'pixel')
  const built = join(pixelDir, 'test', 'bin', 'fixture.exe')
  if (!existsSync(built)) {
    console.log('building fixture…')
    const build = spawnSync(process.execPath, [join(pixelDir, 'tools', 'build-fixture.mjs')], { encoding: 'utf8' })
    if (build.status !== 0) throw new Error(`fixture build failed: ${build.stderr || build.stdout}`)
  }
  if (!existsSync(built)) throw new Error('fixture.exe missing after build')
  const exe = join(work, 'fixture.exe')
  copyFileSync(built, exe)
  const logPath = join(work, 'fixture.log')
  const boundsPath = join(work, 'bounds.json')
  const stopPath = join(work, 'fixture.stop')
  const launch = spawnSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    `$sh = New-Object -ComObject Shell.Application; $sh.ShellExecute('${exe.replace(/'/g, "''")}', '${logPath.replace(/'/g, "''")} ${boundsPath.replace(/'/g, "''")} ${stopPath.replace(/'/g, "''")}', '', 'open', 1)`,
  ], { encoding: 'utf8', windowsHide: true })
  if (launch.status !== 0) throw new Error(`shell launch failed: ${launch.stderr || launch.stdout}`)
  const deadline = Date.now() + 20000
  while (Date.now() < deadline && !existsSync(boundsPath)) await sleep(120)
  if (!existsSync(boundsPath)) throw new Error('fixture did not publish bounds.json')
  const bounds = JSON.parse(readFileSync(boundsPath, 'utf8'))
  await sleep(800) // let the window settle above everything
  return {
    bounds,
    logPath,
    stop() {
      try {
        writeFileSync(stopPath, 'stop')
      } catch { /* ignore */ }
    },
  }
}

function readHits(logPath) {
  try {
    return readFileSync(logPath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [ticks, control, x, y, fg] = line.split('|')
        return { ticks: Number(ticks), control, x: Number(x), y: Number(y), foreground: fg || '' }
      })
  } catch {
    return []
  }
}

const WHICH = { A: 'TARGET-A', B: 'TARGET-B', C: 'TARGET-C' }

/** Old generation: click-matrix runtime, gate armed programmatically. */
async function benchOld({ root, bounds, rounds }) {
  const pixelDir = join(root, 'engines', 'pixel')
  const scratch = mkdtempSync(join(tmpdir(), 'bench-old-'))
  const prev = { DSH_HOME: process.env.DSH_HOME, DSH_HANDS_DATA_DIR: process.env.DSH_HANDS_DATA_DIR }
  process.env.DSH_HOME = join(scratch, 'dsh-home')
  const module = await import(pathToFileURL(join(pixelDir, 'index.js')).href)
  const configModule = await import(pathToFileURL(join(pixelDir, 'lib', 'config.js')).href)
  // Bench only: the abort-hotkey check depends on who owns a global hotkey, not on
  // click quality. Both engines get the same treatment, so it cannot bias the result.
  const config = configModule.normalizeConfig({ mode: 'ask', minIntervalMs: 0, pauseOnHumanInput: false, overlayMode: 'off', pillOnArm: false, requireAbortHotkey: false })
  const ctx = { logger: { warn: () => {}, info: () => {} }, get: () => undefined }
  const state = module.__createRuntime(ctx, config)
  const tools = new Map(module.__buildToolDefinitions(state).map((def) => [def.name, def]))
  const click = tools.get('mouse_click')
  // Warm-up: the first call pays the helper start-up; it must not pollute latency.
  {
    const [wx, wy] = bounds.buttons.A
    state.gate.humanArm(600, 'bench')
    await click.execute({ x: wx, y: wy, verify: 'none' }, { agent: { id: 'bench' }, callId: 'old-warmup' })
    await sleep(200)
  }
  const results = []
  for (let round = 0; round < rounds; round += 1) {
    for (const key of ['A', 'B', 'C']) {
      const [x, y] = bounds.buttons[key]
      state.gate.humanArm(600, 'bench')
      const startedAt = performance.now()
      const value = await click.execute({ x, y, verify: 'none' }, { agent: { id: 'bench' }, callId: `old-${round}-${key}` })
      const ms = performance.now() - startedAt
      results.push({ target: key, intended: WHICH[key], ms, x, y, text: String(value && value.text || '').slice(0, 300), ok: !/^已拒绝|^错误|未执行|^移动失败/.test(String(value && value.text || '')) })
      await sleep(120)
    }
  }
  // Precision probes: inside-the-button offsets should still hit; a point just outside
  // should land on the form instead. Half extents of a fixture button are 85x32 px.
  for (const key of ['A', 'B', 'C']) {
    const [bx, by] = bounds.buttons[key]
    for (const [dx, dy, expect] of [[-70, -20, 'hit'], [70, 20, 'hit'], [0, 30, 'hit'], [92, 0, 'miss']]) {
      state.gate.humanArm(600, 'bench')
      const startedAt = performance.now()
      await click.execute({ x: bx + dx, y: by + dy, verify: 'none' }, { agent: { id: 'bench' }, callId: `old-probe-${key}-${dx}` })
      results.push({ phase: 'probe', target: key, intended: WHICH[key], expect, ms: performance.now() - startedAt, x: bx + dx, y: by + dy, ok: true })
      await sleep(120)
    }
  }
  try {
    state.helper.stop()
  } catch { /* ignore */ }
  if (prev.DSH_HOME === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = prev.DSH_HOME
  rmSync(scratch, { recursive: true, force: true })
  return results
}

/** New generation: the plugin's own kernel + adapters, gate armed as source:'test'. */
async function benchNew({ root, bounds, rounds }) {
  const scratch = mkdtempSync(join(tmpdir(), 'bench-new-'))
  const prev = { ...process.env }
  process.env.DSH_DEXTER_DATA_DIR = join(scratch, 'dexter')
  process.env.DSH_HOME = join(scratch, 'dsh-home')
  process.env.DSH_HANDS_DATA_DIR = join(scratch, 'hands')
  const imp = (p) => import(pathToFileURL(join(REPO, p)).href)
  const { Audit } = await imp('kernel/audit.js')
  const { Gate } = await imp('kernel/gate.js')
  const { StopBus } = await imp('kernel/stopbus.js')
  const { HumanActivity } = await imp('kernel/human.js')
  const { Kernel } = await imp('kernel/kernel.js')
  const { normalizeConfig } = await imp('kernel/config.js')
  const { createPixelBackend } = await imp('backends/legacy-pixel.js')
  const { createUiaBackend } = await imp('backends/legacy-uia.js')
  const { createButtonProbe } = await imp('backends/win-probe.js')

  // The rate cap is a production guard, not a click-quality property: raising it here
  // keeps the measurement comparable (the guard is reported separately, see CLICK-BENCH.md).
  const config = normalizeConfig({ requireFreshLookSeconds: 0, settleMs: 0, hoverFree: true, verifyMode: 'foreground', humanWaitMaxMs: 0, maxActionsPerMinute: 600 })
  const audit = new Audit({ dir: process.env.DSH_DEXTER_DATA_DIR })
  const gate = new Gate({ config, audit, approval: null })
  const uia = await createUiaBackend({ config })
  const pixel = await createPixelBackend({ config, audit, approval: null, attachments: null, requireAbortHotkey: false })
  const buttons = await createButtonProbe({ uia })
  const stopbus = new StopBus({ dataDir: process.env.DSH_DEXTER_DATA_DIR, probe: uia.ok ? uia.probe : null })
  const human = new HumanActivity({ config, probe: uia.ok ? uia.probe : null })
  const kernel = new Kernel({ config, audit, gate, stopbus, human, backends: { pixel, uia }, buttons })
  // Warm-up (helper start-up is not a click's cost).
  {
    const [wx, wy] = bounds.buttons.A
    gate.openGrant({ minutes: 10, actions: 100, source: 'test' })
    await kernel.act({ action: 'click', args: { x: wx, y: wy }, exec: { agent: { id: 'bench' }, callId: 'new-warmup' } })
    await sleep(200)
  }
  const results = []
  for (let round = 0; round < rounds; round += 1) {
    for (const key of ['A', 'B', 'C']) {
      const [x, y] = bounds.buttons[key]
      gate.openGrant({ minutes: 10, actions: 100, source: 'test' })
      const startedAt = performance.now()
      const outcome = await kernel.act({ action: 'click', args: { x, y }, exec: { agent: { id: 'bench' }, callId: `new-${round}-${key}` } })
      const ms = performance.now() - startedAt
      results.push({ target: key, intended: WHICH[key], ms, x, y, text: String(outcome && outcome.text || '').slice(0, 300), ok: Boolean(outcome.ok) })
      await sleep(120)
    }
  }
  for (const key of ['A', 'B', 'C']) {
    const [bx, by] = bounds.buttons[key]
    for (const [dx, dy, expect] of [[-70, -20, 'hit'], [70, 20, 'hit'], [0, 30, 'hit'], [92, 0, 'miss']]) {
      gate.openGrant({ minutes: 10, actions: 100, source: 'test' })
      const startedAt = performance.now()
      const outcome = await kernel.act({ action: 'click', args: { x: bx + dx, y: by + dy }, exec: { agent: { id: 'bench' }, callId: `new-probe-${key}-${dx}` } })
      results.push({ phase: 'probe', target: key, intended: WHICH[key], expect, ms: performance.now() - startedAt, x: bx + dx, y: by + dy, ok: Boolean(outcome.ok), text: String(outcome && outcome.text || '').slice(0, 200) })
      await sleep(120)
    }
  }
  try {
    pixel.dispose()
    uia.dispose()
  } catch { /* ignore */ }
  for (const key of Object.keys(process.env)) if (!(key in prev)) delete process.env[key]
  Object.assign(process.env, prev)
  rmSync(scratch, { recursive: true, force: true })
  return results
}

function score(results, hits, logStartIndex) {
  const fresh = hits.slice(logStartIndex)
  const matched = new Set()
  // Match each click to the fixture's own log line by coordinate, then judge it.
  const logFor = (row) => {
    const index = fresh.findIndex((hit, i) => !matched.has(i) && Math.abs(hit.x - row.x) <= 6 && Math.abs(hit.y - row.y) <= 6)
    if (index < 0) return null
    matched.add(index)
    return fresh[index]
  }
  const gridRows = results.filter((row) => row.phase !== 'probe')
  const probeRows = results.filter((row) => row.phase === 'probe')
  let correct = 0
  for (const row of gridRows) {
    const hit = logFor(row)
    if (hit && hit.control === row.intended) correct += 1
  }
  let probeHits = 0
  let probeHitTotal = 0
  let probeMisses = 0
  let probeMissTotal = 0
  for (const row of probeRows) {
    const hit = logFor(row)
    if (!hit) continue
    if (row.expect === 'hit') {
      probeHitTotal += 1
      if (hit.control === row.intended) probeHits += 1
    } else {
      probeMissTotal += 1
      if (hit.control !== row.intended) probeMisses += 1
    }
  }
  const times = gridRows.map((row) => row.ms).sort((a, b) => a - b)
  const mean = times.reduce((sum, value) => sum + value, 0) / Math.max(1, times.length)
  const p95 = times[Math.min(times.length - 1, Math.floor(times.length * 0.95))] || 0
  return {
    clicks: gridRows.length,
    correct,
    accuracy: gridRows.length ? Number(((correct / gridRows.length) * 100).toFixed(1)) : 0,
    insideProbeHitRate: probeHitTotal ? Number(((probeHits / probeHitTotal) * 100).toFixed(1)) : 0,
    outsideProbeMissRate: probeMissTotal ? Number(((probeMisses / probeMissTotal) * 100).toFixed(1)) : 0,
    meanMs: Number(mean.toFixed(1)),
    p95Ms: Number(p95.toFixed(1)),
    minMs: times[0] || 0,
    maxMs: times[times.length - 1] || 0,
    toolFailures: results.filter((row) => !row.ok).length,
    firstFailure: (results.find((row) => !row.ok) || {}).text || '',
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const roundsIndex = argv.indexOf('--rounds')
  const rounds = roundsIndex >= 0 ? Math.max(1, Math.min(20, Number(argv[roundsIndex + 1]) || 4)) : 4
  const jsonIndex = argv.indexOf('--json')
  const out = jsonIndex >= 0 ? argv[jsonIndex + 1] : ''
  const root = legacyRoot()
  if (!root) throw new Error('legacy root not configured (local.config.json / DSH_DEXTER_LEGACY_ROOT)')

  const work = mkdtempSync(join(tmpdir(), 'click-bench-'))
  mkdirSync(work, { recursive: true })
  const fixture = await startFixture(root, work)
  console.log(`fixture: "${fixture.bounds.title}" pid=${fixture.bounds.pid} window=${JSON.stringify(fixture.bounds.window)}`)
  console.log(`buttons: A=${fixture.bounds.buttons.A} B=${fixture.bounds.buttons.B} C=${fixture.bounds.buttons.C}`)

  const report = { generatedAt: new Date().toISOString(), rounds, clicksPerEngine: rounds * 3, fixture: fixture.bounds }
  try {
    const oldHitsStart = readHits(fixture.logPath).length
    const oldResults = await benchOld({ root, bounds: fixture.bounds, rounds })
    await sleep(400)
    const oldHits = readHits(fixture.logPath)
    report.old = { label: 'dsh-click-matrix (mouse_click)', ...score(oldResults, oldHits, oldHitsStart) }
    console.log(`old: ${JSON.stringify(report.old)}`)

    const newHitsStart = readHits(fixture.logPath).length
    const newResults = await benchNew({ root, bounds: fixture.bounds, rounds })
    await sleep(400)
    const newHits = readHits(fixture.logPath)
    report.new = { label: 'dsh-dexter (hands_act click)', ...score(newResults, newHits, newHitsStart) }
    console.log(`new: ${JSON.stringify(report.new)}`)

    report.delta = {
      accuracy: Number((report.new.accuracy - report.old.accuracy).toFixed(1)),
      meanMs: Number((report.new.meanMs - report.old.meanMs).toFixed(1)),
      p95Ms: Number(report.new.p95Ms - report.old.p95Ms),
    }
  } catch (error) {
    console.error('BENCH ERROR:', error && error.stack ? error.stack : error)
  } finally {
    fixture.stop()
    await sleep(1200)
    rmSync(work, { recursive: true, force: true })
    if (out) writeFileSync(resolve(out), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    console.log('\nsummary:')
    console.log(`  accuracy  old ${report.old?.accuracy}%  new ${report.new?.accuracy}%  (Δ ${report.delta?.accuracy} pp)`)
    console.log(`  latency   old mean ${report.old?.meanMs}ms / p95 ${report.old?.p95Ms}ms   new mean ${report.new?.meanMs}ms / p95 ${report.new?.p95Ms}ms`)
    process.exit(report.old && report.new && report.new.accuracy >= report.old.accuracy && report.new.toolFailures === 0 ? 0 : 1)
  }
}

await main()
