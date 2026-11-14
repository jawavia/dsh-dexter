#!/usr/bin/env node
/**
 * dual-run.mjs — A11: is the new kernel behaviourally equivalent to the old bundle?
 *
 * Method: the old engine is the oracle. For each scenario the same intent runs
 * twice — once through the old pixel engine's own tool handler, once through
 * `dsh-dexter` — and the two outcomes are compared as *classes*, never as bytes:
 *
 *   outcome  executed | refused | error
 *   category ok | validation | auth | target | interface | engine-unavailable
 *
 * Both sides run against the real desktop (that is the point: the injection code is
 * the same code). Write scenarios only MOVE the cursor: this file never clicks, so
 * running it cannot press anything in whatever window happens to be in front.
 *
 * Every call is bounded (25 s) and every scenario is logged to
 * baseline/local/dual-run-progress.log before and after it runs, so a hang is
 * visible as a last line instead of a silent stall.
 *
 * Usage: node tools/dual-run.mjs [--json out.json]
 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { bootPlugin } from '../test/harness.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const PROGRESS = join(REPO, 'baseline', 'local', 'dual-run-progress.log')

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

function progress(line) {
  try {
    appendFileSync(PROGRESS, `${new Date().toISOString()} ${line}\n`)
  } catch { /* progress is best effort */ }
}

function withTimeout(promise, ms, label) {
  let timer = null
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => {
      progress(`TIMEOUT ${label} after ${ms}ms`)
      resolve({ text: `超时（${ms}ms 未返回）`, ok: false })
    }, ms)
    timer.unref?.()
  })
  return Promise.race([promise, guard]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function legacyRoot() {
  if (process.env.DSH_DEXTER_LEGACY_ROOT) return process.env.DSH_DEXTER_LEGACY_ROOT
  try {
    return JSON.parse(readFileSync(join(REPO, 'local.config.json'), 'utf8')).legacyRoot || ''
  } catch {
    return ''
  }
}

function classify(text, ok) {
  const value = String(text || '')
  // A rehearsal is a rehearsal: the preview text lists possible blockers, so it must be
  // classified before those words are read as a refusal.
  if (/^dryRun/.test(value.trim())) return { outcome: 'previewed', category: 'dryRun' }
  // A real human at the machine: the new kernel holds writes back (by design), the old
  // engine in this harness does not pause. That is an environment condition, not an
  // equivalence result, so it is classified apart and excluded from the ratio.
  if (/人类正在操作|人类已停止操作|等真人停下来/.test(value)) {
    return { outcome: 'refused', category: 'human-active' }
  }
  // The engine could not even start its helper: that is an environment failure, not
  // a behavioural difference, and it must not be counted as "executed".
  if (/helper 不可用|helper 启动失败|spawn EPERM|helper 恢复前/.test(value)) {
    return { outcome: 'error', category: 'engine-unavailable' }
  }
  // Validation refusals: both generations say "this call is unusable" and neither
  // injects anything; they only spell it differently.
  if (/不能为空|需要非空|需要坐标|参数不完整|需要 toX|不支持|需要有效的 action|未知 action/.test(value)) {
    return { outcome: 'refused', category: 'validation' }
  }
  if (!ok) {
    if (/授权|approval|arm|急停/.test(value)) return { outcome: 'refused', category: 'auth' }
    if (/找不到|没有目标|窗口|超时/.test(value)) return { outcome: 'refused', category: 'target' }
    if (/错误|失败|不可用|抛错/.test(value)) return { outcome: 'error', category: 'interface' }
    return { outcome: 'refused', category: 'other' }
  }
  if (/超时|没有找到/.test(value)) return { outcome: 'executed', category: 'target' }
  return { outcome: 'executed', category: 'ok' }
}

/** Old bundle: the pixel engine built exactly as the installed bundle builds it. */
async function startOld() {
  const root = legacyRoot()
  if (!root) throw new Error('legacy root not configured (local.config.json / DSH_DEXTER_LEGACY_ROOT)')
  const pixelDir = join(root, 'engines', 'pixel')
  const scratch = mkdtempSync(join(tmpdir(), 'dexter-dual-old-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = scratch
  const module = await import(pathToFileURL(join(pixelDir, 'index.js')).href)
  const configModule = await import(pathToFileURL(join(pixelDir, 'lib', 'config.js')).href)
  const services = { approval: { request: async () => 'allowed-once' } }
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    get: (name) => (name === 'approval' ? services.approval : name === 'attachments' ? null : undefined),
  }
  const config = configModule.normalizeConfig({
    mode: 'ask',
    mergeReadSide: true,
    pauseOnHumanInput: false,
    autoResumeHumanActivity: false,
    overlayMode: 'off',
    pillOnArm: false,
    minIntervalMs: 0,
    requireAbortHotkey: false,
  })
  const state = module.__createRuntime(ctx, config)
  const tools = new Map(module.__buildToolDefinitions(state).map((def) => [def.name, def]))
  return {
    state,
    services,
    tools,
    async call(name, args) {
      const def = tools.get(name)
      if (!def) throw new Error(`old tool missing: ${name}`)
      try {
        const value = await def.execute(args, { agent: { id: 'dual-run' }, callId: `old-${name}-${Date.now()}` })
        const text = value && typeof value.text === 'string' ? value.text : String(value)
        const failed = /^(错误|已拒绝|输入未执行|点击未执行|移动失败|⚠️ 未发出|⛔)/.test(text.trim())
        return { text, ok: !failed }
      } catch (error) {
        return { text: `抛错: ${error && error.message ? error.message : error}`, ok: false }
      }
    },
    arm(seconds = 300) {
      try {
        state.gate.humanArm(seconds, 'dual-run')
      } catch { /* ignore */ }
    },
    close() {
      try {
        state.helper.stop()
      } catch { /* ignore */ }
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      rmSync(scratch, { recursive: true, force: true })
    },
  }
}

const READ_SCENARIOS = [
  { name: 'view info', kind: 'read', old: ['screen_view', { action: 'info' }], next: ['hands_view', { action: 'info' }] },
  { name: 'view list', kind: 'read', old: ['screen_view', { action: 'list', limit: 5 }], next: ['hands_view', { action: 'list', limit: 5 }] },
  { name: 'view read', kind: 'read', old: ['screen_view', { action: 'read', maxElements: 10 }], next: ['hands_view', { action: 'read' }] },
  { name: 'view text', kind: 'read', old: ['screen_view', { action: 'text', maxElements: 10 }], next: ['hands_view', { action: 'text' }] },
  { name: 'view capture', kind: 'read', old: ['screen_view', { action: 'capture' }], next: ['hands_view', { action: 'capture' }] },
  { name: 'view zoom', kind: 'read', old: ['screen_view', { action: 'zoom', x: 600, y: 400 }], next: ['hands_view', { action: 'zoom', x: 600, y: 400 }] },
  { name: 'view locate', kind: 'read', old: ['screen_view', { action: 'locate', x: 700, y: 500 }], next: ['hands_view', { action: 'locate', x: 700, y: 500 }] },
  { name: 'view wait', kind: 'read', old: ['screen_view', { action: 'wait', timeoutMs: 600 }], next: ['hands_view', { action: 'wait', timeoutMs: 600 }] },
  {
    name: 'view wait_window missing title',
    kind: 'read',
    old: ['screen_view', { action: 'wait_window', titleContains: 'zzz-not-a-window-zzz', timeoutMs: 400 }],
    next: ['hands_view', { action: 'wait_window', window: { titleContains: 'zzz-not-a-window-zzz' }, timeoutMs: 400 }],
  },
  { name: 'view wait_window foreground', kind: 'read', old: ['screen_view', { action: 'wait_window' }], next: ['hands_view', { action: 'wait_window' }] },
]

const ACT_SCENARIOS = [
  { name: 'dryRun click', kind: 'dryrun', old: ['mouse_click', { x: 500, y: 500, dryRun: true }], next: ['hands_act', { action: 'click', x: 500, y: 500, dryRun: true }] },
  { name: 'dryRun click with expect mismatch', kind: 'dryrun', old: ['mouse_click', { x: 500, y: 500, dryRun: true, expect: { titleContains: 'zzz' } }], next: ['hands_act', { action: 'click', x: 500, y: 500, dryRun: true, expect: { titleContains: 'zzz' } }] },
  { name: 'move 1', kind: 'act', old: ['mouse_move', { x: 420, y: 320 }], next: ['hands_act', { action: 'move', x: 420, y: 320 }] },
  { name: 'move 2', kind: 'act', old: ['mouse_move', { x: 520, y: 380 }], next: ['hands_act', { action: 'move', x: 520, y: 380 }] },
  { name: 'move 3', kind: 'act', old: ['mouse_move', { x: 620, y: 420 }], next: ['hands_act', { action: 'move', x: 620, y: 420 }] },
  { name: 'move 4', kind: 'act', old: ['mouse_move', { x: 720, y: 460 }], next: ['hands_act', { action: 'move', x: 720, y: 460 }] },
  { name: 'move 5', kind: 'act', old: ['mouse_move', { x: 820, y: 500, durationMs: 120 }], next: ['hands_act', { action: 'move', x: 820, y: 500 }] },
  { name: 'type validation empty', kind: 'act', old: ['type_text', { text: '' }], next: ['hands_act', { action: 'type', text: '' }] },
  { name: 'unknown view action', kind: 'read', old: ['screen_view', { action: 'nonsense' }], next: ['hands_view', { action: 'nonsense' }] },
]

async function main() {
  const outIndex = process.argv.indexOf('--json')
  const out = outIndex >= 0 ? process.argv[outIndex + 1] : ''
  try {
    writeFileSync(PROGRESS, '')
  } catch { /* ignore */ }
  progress('boot new side')
  // The human pause is deliberately OFF on BOTH sides: whoever is sitting at the
  // keyboard would otherwise modulate every write, and A9 measures the pause on its
  // own (live-smoke). This run isolates injection and refusal equivalence.
  const newSide = await bootPlugin({
    config: { requireFreshLookSeconds: 0, pauseOnHumanInput: false, humanWaitMaxMs: 0, settleMs: 40 },
  })
  progress(`boot old side (${legacyRoot() || 'no legacy root'})`)
  const oldSide = await startOld()
  const armCommand = (newSide.mock.commands[0] && newSide.mock.commands[0].handler) || null
  // Warm-up: the pixel helper compiles its C# once per source version, which can take
  // most of a minute on a cold machine. Pay that outside the measured scenarios so a
  // compile is never mistaken for a behavioural difference.
  progress('warmup old helper')
  await withTimeout(oldSide.call('screen_view', { action: 'info' }), 120000, 'old warmup')
  progress('warmup new side')
  await withTimeout(newSide.call('hands_view', { action: 'info' }), 60000, 'new warmup')
  progress('both sides ready')

  // A quiet desktop is a precondition: the kernel holds writes back while a human uses
  // the machine (by design), and nothing about equivalence can be measured during that.
  progress('waiting for a quiet desktop')
  const quietDeadline = Date.now() + 90000
  let quiet = false
  while (Date.now() < quietDeadline) {
    const status = await withTimeout(newSide.call('hands_status', { tail: 0 }), 10000, 'quiet-check')
    if (/人类未在操作/.test(String(status.text || ''))) {
      quiet = true
      break
    }
    await sleep(1500)
  }
  progress(`desktop quiet: ${quiet}`)

  const rows = []
  const runPair = async (scenario) => {
    progress(`START ${scenario.name}`)
    oldSide.arm(300)
    const oldResult = await withTimeout(oldSide.call(scenario.old[0], scenario.old[1]), 25000, `old ${scenario.name}`)
    await sleep(220)
    const newResult = await withTimeout(newSide.call(scenario.next[0], scenario.next[1]), 25000, `new ${scenario.name}`)
    await sleep(220)
    const oldVerdict = classify(oldResult.text, oldResult.ok)
    const newVerdict = classify(newResult.text, newResult.ok)
    const same = oldVerdict.outcome === newVerdict.outcome
      && (oldVerdict.outcome !== 'refused' || oldVerdict.category === newVerdict.category)
    const skipped = oldVerdict.category === 'human-active' || newVerdict.category === 'human-active'
    rows.push({
      name: scenario.name,
      kind: scenario.kind,
      old: { outcome: oldVerdict.outcome, category: oldVerdict.category, text: oldResult.text.split('\n')[0].slice(0, 160) },
      next: { outcome: newVerdict.outcome, category: newVerdict.category, text: newResult.text.split('\n')[0].slice(0, 160) },
      same,
      skipped,
    })
    progress(`DONE ${scenario.name} old=${oldVerdict.outcome}/${oldVerdict.category} new=${newVerdict.outcome}/${newVerdict.category} same=${same}`)
  }

  for (const scenario of READ_SCENARIOS.slice(0, 6)) await runPair(scenario)

  // The authorization scenario needs a live helper on the old side (the reads above
  // started one), so it runs here rather than at the end.
  progress('START write without any authorization')
  oldSide.services.approval = null
  oldSide.state.gate.disarm('dual-run')
  const deniedOld = await withTimeout(oldSide.call('mouse_move', { x: 400, y: 300 }), 25000, 'old auth-deny')
  oldSide.services.approval = { request: async () => 'allowed-once' }
  const noApprovalNew = await bootPlugin({ approvalService: false, config: { requireFreshLookSeconds: 0 } })
  const deniedNew = await withTimeout(noApprovalNew.call('hands_act', { action: 'move', x: 400, y: 300 }), 25000, 'new auth-deny')
  noApprovalNew.close()
  const deniedOldVerdict = classify(deniedOld.text, deniedOld.ok)
  const deniedNewVerdict = classify(deniedNew.text, deniedNew.ok)
  rows.push({
    name: 'write without any authorization',
    kind: 'auth',
    old: { outcome: deniedOldVerdict.outcome, category: deniedOldVerdict.category, text: deniedOld.text.split('\n')[0].slice(0, 160) },
    next: { outcome: deniedNewVerdict.outcome, category: deniedNewVerdict.category, text: deniedNew.text.split('\n')[0].slice(0, 160) },
    same: deniedOldVerdict.outcome === deniedNewVerdict.outcome,
  })
  progress(`DONE write without any authorization old=${deniedOldVerdict.outcome}/${deniedOldVerdict.category} new=${deniedNewVerdict.outcome}/${deniedNewVerdict.category}`)

  for (const scenario of READ_SCENARIOS.slice(6)) await runPair(scenario)
  for (const scenario of ACT_SCENARIOS) await runPair(scenario)

  const comparable = rows.filter((row) => !row.skipped)
  const same = comparable.filter((row) => row.same).length
  const report = {
    generatedAt: new Date().toISOString(),
    scenarios: rows.length,
    comparable: comparable.length,
    skippedHumanActive: rows.length - comparable.length,
    same,
    ratio: `${same}/${comparable.length}`,
    passesA11: same >= 19 && comparable.length >= 20,
    desktopQuiet: quiet,
    rows,
  }
  for (const row of rows) {
    const label = row.skipped ? 'SKIP' : row.same ? 'SAME' : 'DIFF'
    console.log(`${label} ${row.name} — old=${row.old.outcome}/${row.old.category} new=${row.next.outcome}/${row.next.category}`)
    if (!row.same && !row.skipped) {
      console.log(`     old: ${row.old.text}`)
      console.log(`     new: ${row.next.text}`)
    }
  }
  console.log(`\ndual-run: ${same}/${comparable.length} identical outcome classes (A11 needs >=19/20)`)
  if (rows.length !== comparable.length) {
    console.log(`${rows.length - comparable.length} scenario(s) skipped: a real human was using the machine, so the kernel held the write back`)
  }
  const json = `${JSON.stringify(report, null, 2)}\n`
  if (out) writeFileSync(out, json, 'utf8')
  if (report.passesA11 && out) {
    try {
      writeFileSync(out.replace(/\.json$/, '-pass.json'), json, 'utf8')
    } catch { /* the evidence copy is best effort */ }
  }
  progress(`SUMMARY ${same}/${comparable.length} skipped=${rows.length - comparable.length}`)
  oldSide.close()
  newSide.close()
  // Helper children are detached GUI processes; without an explicit exit the event
  // loop can stay alive on them and the run looks like it hangs after printing.
  process.exit(report.passesA11 ? 0 : 1)
}

await main()
