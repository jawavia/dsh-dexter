#!/usr/bin/env node
/**
 * live-smoke.mjs — the same invariants as the unit tests, but through the REAL
 * backends: real Win32 helper, real cursor movement, real audit file on disk.
 *
 * It only MOVES the cursor (20 harmless moves inside a small rectangle) and, for the
 * human-activity check, taps `shift` once. It never clicks, never types into an
 * application and never presses Enter.
 *
 * Evidence written to baseline/local/live-smoke.json (git-ignored; the summary is
 * copied into evidence/).
 */
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { bootPlugin } from '../test/harness.mjs'

const REPO = join(import.meta.dirname, '..')
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const progress = []
const note = (line) => {
  progress.push(`${new Date().toISOString()} ${line}`)
  console.log(line)
}

// The deterministic human-activity hook: a file the detector watches (see
// kernel/human.js). It has to exist as an env value before the plugin is applied.
const SIGNAL_FILE = join(tmpdir(), `dexter-human-signal-${Date.now()}.txt`)
process.env.DSH_DEXTER_HUMAN_SIGNAL = SIGNAL_FILE

// Key-up safety net: this file presses a real Shift, so it also owns releasing it.
// A stranded modifier is a user-visible defect (every shortcut gains Shift, and
// Shift+wheel scrolls sideways), so the release is unconditional and idempotent.
async function releaseModifiers() {
  const local = JSON.parse(readFileSync(join(REPO, 'local.config.json'), 'utf8'))
  const koffiModule = await import(pathToFileURL(join(local.legacyRoot, 'engines', 'control', 'node_modules', 'koffi', 'index.js')).href)
  const koffi = koffiModule.default ?? koffiModule
  const user32 = koffi.load('user32.dll')
  const keybd = user32.func('void __stdcall keybd_event(uint8 bVk, uint8 bScan, uint32 dwFlags, uintptr_t dwExtraInfo)')
  const KEYEVENTF_KEYUP = 0x0002
  for (const vk of [0x10, 0xA0, 0xA1]) {
    keybd(vk, 0, KEYEVENTF_KEYUP, 0)
    await sleep(30)
  }
}

/** Which modifiers are logically down right now (should be none between tests). */
async function stuckModifiers() {
  const local = JSON.parse(readFileSync(join(REPO, 'local.config.json'), 'utf8'))
  const koffiModule = await import(pathToFileURL(join(local.legacyRoot, 'engines', 'control', 'node_modules', 'koffi', 'index.js')).href)
  const koffi = koffiModule.default ?? koffiModule
  const user32 = koffi.load('user32.dll')
  const GetAsyncKeyState = user32.func('short __stdcall GetAsyncKeyState(int vKey)')
  const names = [[0x10, 'Shift'], [0xA0, 'LShift'], [0xA1, 'RShift'], [0x11, 'Ctrl'], [0x12, 'Alt'], [0x5B, 'LWin'], [0x5C, 'RWin']]
  return names.filter(([vk]) => (GetAsyncKeyState(vk) & 0x8000) !== 0).map(([, name]) => name)
}

const run = await bootPlugin({ config: { requireFreshLookSeconds: 0, humanIdleResumeMs: 2000, humanWaitMaxMs: 6000, settleMs: 40 } })
const result = { generatedAt: new Date().toISOString(), backendLogs: [], checks: {}, audit: {}, progress }

try {
  note(`tools: ${run.tools.map((tool) => tool.name).join(',')}`)
  for (const line of run.mock.logs.filter((entry) => entry.includes('dexter')).slice(0, 6)) result.backendLogs.push(line)

  // Warm the helper and prove the read path works.
  const info = await run.call('hands_view', { action: 'info' })
  note(`hands_view info -> ${String(info.text).split('\n')[0].slice(0, 90)}`)
  result.checks.viewInfo = Boolean(info && info.text)

  const capture = await run.call('hands_view', { action: 'capture', region: { x: 200, y: 200, w: 320, h: 200 } })
  result.checks.captureReturnsImage = Boolean(capture && capture.imageRef)
  note(`hands_view capture -> imageRef=${capture && capture.imageRef ? 'yes' : 'no'}`)

  // 20 real writes, all of them cursor moves. Wait for a quiet desktop first: if a
  // real human is using the mouse/keyboard, every write is (correctly) held back, and
  // a run like that measures the human, not the plugin.
  const quiet = await (async () => {
    const startedAt = Date.now()
    while (Date.now() - startedAt < 25000) {
      const status = await run.call('hands_status', { tail: 0 })
      if (/人类未在操作/.test(status.text)) return true
      await sleep(400)
    }
    return false
  })()
  result.checks.desktopWasQuiet = quiet
  if (!quiet) {
    note('BLOCKED: a real human keeps using the machine, so no write could be measured')
    result.checks.blockedByRealHumanInput = true
  } else {
    note('desktop quiet: starting the 20 measured writes')
  }

  const before = run.mock.approvalCalls.length
  let executed = 0
  const failures = []
  for (let i = 0; i < 20; i += 1) {
    const outcome = await run.call('hands_act', { action: 'move', x: 600 + (i % 5) * 12, y: 400 + Math.floor(i / 5) * 10 })
    if (outcome && /光标已移动|移动/.test(outcome.text) && !/失败|未发|拒绝|错误/.test(outcome.text)) executed += 1
    else failures.push(outcome && outcome.text)
    await sleep(80)
  }
  note(`20 live moves: ${executed} executed, ${failures.length} failed`)
  result.checks.liveMovesExecuted = executed
  result.checks.liveMovesFailed = failures.length
  if (failures.length > 0) result.checks.failureSample = failures[0].split('\n').slice(0, 3)

  const approvals = run.mock.approvalCalls.length - before
  result.checks.approvalRequestsFor20Writes = approvals

  // Our own 20 moves must not look like the human taking over. Informational, not
  // gated: on a machine where a real person is present, a genuine mouse move also
  // produces exactly this row, and the two are indistinguishable on purpose.
  const auditFileEarly = join(run.dataDir, 'audit', 'hands.jsonl')
  const earlyText = existsSync(auditFileEarly) ? readFileSync(auditFileEarly, 'utf8') : ''
  const spuriousSuspends = (earlyText.match(/"decision":"suspend"/g) || []).length
  result.checks.spuriousSuspendRowsAfterOwnMoves = spuriousSuspends
  note(`suspend rows after our own 20 moves: ${spuriousSuspends} (0 = detector clean, 1 = either a real human move or our own tail)`)

  // ---- A9, deterministic: the documented test hook -----------------------
  // The detector watches DSH_DEXTER_HUMAN_SIGNAL; any change to that file counts as
  // human input. A live mouse/keyboard check is non-deterministic on a machine where
  // a human really is sitting (moving the mouse *is* human input, so it suspends for
  // the right reason and spoils the measurement), so timing is measured here and the
  // real-key observation below is reported as informational.
  const auditFilePath = join(run.dataDir, 'audit', 'hands.jsonl')
  const waitForRow = async (needle, budgetMs) => {
    const startedAt = Date.now()
    while (Date.now() - startedAt < budgetMs) {
      const text = existsSync(auditFilePath) ? (await import('node:fs')).readFileSync(auditFilePath, 'utf8') : ''
      if (text.includes(needle)) return Date.now() - startedAt
      await sleep(50)
    }
    return -1
  }
  const rowsSoFar = (await import('node:fs')).readFileSync(auditFilePath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  const humanRowsBefore = rowsSoFar.filter((row) => row.tool === 'human').length
  void humanRowsBefore

  let signalSuspendMs = -1
  const suspendRowsBeforeSignal = (readFileSync(auditFilePath, 'utf8').match(/"decision":"suspend"/g) || []).length
  result.checks.suspendRowsBeforeSignal = suspendRowsBeforeSignal
  try {
    appendFileSync(process.env.DSH_DEXTER_HUMAN_SIGNAL, `activity ${Date.now()}\n`)
    signalSuspendMs = await waitForRow('"decision":"suspend"', 2000)
  } catch (error) {
    result.checks.signalHookError = String(error && error.message ? error.message : error)
  }
  result.checks.signalSuspendMs = signalSuspendMs
  result.checks.suspendWithin2s = signalSuspendMs >= 0 && signalSuspendMs <= 2000
  note(`signal-hook suspend detected in ${signalSuspendMs >= 0 ? `${signalSuspendMs}ms` : 'NOT DETECTED'}`)

  // A write attempted while suspended waits for the human to go idle (bounded by
  // humanWaitMaxMs), then proceeds — and both the suspend and the resume are audited
  // before the executed row. (The refusal path, humanWaitMaxMs=0, is covered by
  // test/02-auth-invariants.test.mjs.)
  let waitedForIdle = false
  let actedElapsedMs = -1
  if (signalSuspendMs >= 0) {
    const actStarted = Date.now()
    const during = await run.call('hands_act', { action: 'move', x: 640, y: 420 })
    actedElapsedMs = Date.now() - actStarted
    waitedForIdle = Boolean(during && during.text && !/拒绝|没有授权|未注入/.test(during.text))
    result.checks.writeWaitedForIdle = waitedForIdle
    result.checks.writeWaitedMs = actedElapsedMs
    note(`a write attempted during the suspend waited ${actedElapsedMs}ms and then ran: ${waitedForIdle}`)
  }

  const afterRows = readFileSync(auditFilePath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  const resumeRow = afterRows.filter((row) => row.tool === 'human' && row.decision === 'resume').pop()
  const executedRowsNow = afterRows.filter((row) => row.decision === 'executed' && row.capability === 'move')
  const executedAfterResume = resumeRow && executedRowsNow.some((row) => row.seq > resumeRow.seq)
  result.checks.resumeAuditedBeforeExecutedRow = Boolean(executedAfterResume)
  note(`auto-resume row seq=${resumeRow ? resumeRow.seq : 0}, executed rows after it: ${executedAfterResume}`)
  result.checks.resumeDetectedMs = actedElapsedMs
  // If a real human had already suspended injection, the idle countdown started
  // before this test and the wait is legitimately shorter than one full idle period.
  result.checks.resumeWithinBudget = actedElapsedMs <= 15000
    && (suspendRowsBeforeSignal > 0 || actedElapsedMs >= 1500)
  note(`resume wait ${actedElapsedMs}ms (pre-existing suspend rows: ${suspendRowsBeforeSignal})`)

  // ---- real key press: informational -------------------------------------
  // A child process holds shift for 900 ms. This is a real key press through the same
  // Win32 path the human's keyboard uses; nothing is typed and no window is activated.
  // Reported, not gated: a human touching the mouse during the run legitimately
  // suspends first, and then no second suspend row appears.
  let realKeyMs = -1
  try {
    const local = JSON.parse((await import('node:fs')).readFileSync(join(REPO, 'local.config.json'), 'utf8'))
    const { spawn } = await import('node:child_process')
    const stamps = (await import('node:fs')).readFileSync(auditFilePath, 'utf8').match(/"decision":"suspend"/g) || []
    const before = stamps.length
    const child = spawn(process.execPath, ['-e', `
      import(${JSON.stringify(pathToFileURL(join(local.legacyRoot, 'engines', 'control', 'src', 'win32.js')).href)}).then((win32) => {
        win32.pressKey('shift', { holdMs: 900 })
        process.exit(0)
      })
    `], { windowsHide: true, stdio: 'ignore' })
    const startedAt = Date.now()
    while (Date.now() - startedAt < 3000) {
      const text = (await import('node:fs')).readFileSync(auditFilePath, 'utf8')
      const now = (text.match(/"decision":"suspend"/g) || []).length
      if (now > before) {
        realKeyMs = Date.now() - startedAt
        break
      }
      await sleep(50)
    }
    // NEVER kill the holder mid-press: a killed process cannot send its key-up, and a
    // stranded Shift breaks every shortcut and turns wheel into horizontal scroll.
    // Wait for it to release by itself, then send a key-up anyway as a safety net.
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* already gone */ }
        resolve()
      }, 8000)
      child.on('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    await releaseModifiers()
  } catch (error) {
    result.checks.realKeyError = String(error && error.message ? error.message : error)
    try { await releaseModifiers() } catch { /* best effort */ }
  }
  result.checks.realKeySuspendMs = realKeyMs
  note(`real-key suspend observed in ${realKeyMs >= 0 ? `${realKeyMs}ms` : 'not observed (a human or an earlier suspend may own it)'}`)

  const kernelStatusBefore = await run.call('hands_status', { tail: 0 })
  result.checks.statusBeforeHuman = String(kernelStatusBefore.text).split('\n').slice(0, 3)

  // The audit is the evidence: read it back from disk.
  const auditFile = join(run.dataDir, 'audit', 'hands.jsonl')
  result.audit.file = auditFile
  result.audit.exists = existsSync(auditFile)
  const rows = existsSync(auditFile)
    ? (await import('node:fs')).readFileSync(auditFile, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    : []
  const executedRows = rows.filter((row) => row.tool === 'hands_act' && row.decision === 'executed' && row.capability === 'move')
  result.audit.totalRows = rows.length
  result.audit.executedMoveRows = executedRows.length
  result.audit.executedRowsWithApproval = executedRows.filter((row) => row.approval && row.approval !== 'none').length
  result.audit.executedRowsWithVerify = executedRows.filter((row) => row.verify).length
  result.audit.executedRowsWithArgsHash = executedRows.filter((row) => typeof row.argsHash === 'string' && row.argsHash.length === 64).length
  result.audit.decisions = rows.reduce((acc, row) => {
    acc[row.decision] = (acc[row.decision] || 0) + 1
    return acc
  }, {})
  result.audit.approvals = executedRows.reduce((acc, row) => {
    acc[row.approval] = (acc[row.approval] || 0) + 1
    return acc
  }, {})

  const auditDir = join(run.dataDir, 'audit')
  const auditFiles = readdirSync(auditDir)
  result.checks.auditDirFiles = auditFiles
  result.checks.singleAuditFile = auditFiles.filter((name) => name.startsWith('hands')).length === 1
  const legacyHands = join(run.dataDir, '..', 'hands')
  result.checks.noControlTrail = !existsSync(join(auditDir, 'control.jsonl'))
  result.checks.noStrokeTrail = !existsSync(join(auditDir, 'stroke.jsonl'))
  void legacyHands

  // The legacy pixel engine's own trail: only its startup marker should be there.
  const pixelTrail = join(run.dataDir, '..', 'dsh-home', 'click-matrix', 'audit.jsonl')
  result.checks.pixelTrailPath = pixelTrail
  result.checks.pixelTrailRows = existsSync(pixelTrail)
    ? (await import('node:fs')).readFileSync(pixelTrail, 'utf8').split(/\r?\n/).filter(Boolean).length
    : 0
  if (existsSync(pixelTrail)) {
    const trail = (await import('node:fs')).readFileSync(pixelTrail, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    result.checks.pixelTrailDecisions = trail.reduce((acc, row) => {
      acc[row.decision] = (acc[row.decision] || 0) + 1
      return acc
    }, {})
  }

  result.checks.stopRefusesNextWrite = await (async () => {
    await run.call('hands_act', { action: 'stop' })
    const after = await run.call('hands_act', { action: 'move', x: 500, y: 500 })
    return Boolean(after && /急停|拒绝/.test(after.text))
  })()

  const status = await run.call('hands_status', { tail: 5 })
  result.statusTail = String(status.text).split('\n').slice(0, 16)

  // Regression guard for the incident on 2026-11-14: a test that presses a real key must
  // never leave a modifier down (a stranded Shift breaks shortcuts and turns the wheel
  // into horizontal scrolling).
  result.checks.stuckModifiersBeforeCleanup = await stuckModifiers()
  if (result.checks.stuckModifiersBeforeCleanup.length > 0) await releaseModifiers()
  result.checks.stuckModifiersAfterCleanup = await stuckModifiers()
  result.checks.noStuckModifiers = result.checks.stuckModifiersAfterCleanup.length === 0
  note(`stuck modifiers: before=${JSON.stringify(result.checks.stuckModifiersBeforeCleanup)} after=${JSON.stringify(result.checks.stuckModifiersAfterCleanup)}`)
} finally {
  const summary = {
    ...result,
    progress,
  }
  writeFileSync(join(REPO, 'baseline', 'local', 'live-smoke.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  run.close()
  const failed = Object.entries(result.checks).filter(([, value]) => value === false && !result.checks.blockedByRealHumanInput)
  if (result.checks.blockedByRealHumanInput) {
    console.log('\nlive-smoke: BLOCKED — a real human kept using the machine; rerun on a quiet desktop')
    process.exit(2)
  }
  if (failed.length === 0) {
    try {
      writeFileSync(join(REPO, 'baseline', 'local', 'live-smoke-pass.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
    } catch { /* the evidence copy is best effort */ }
  }
  console.log(`\nlive-smoke: ${failed.length === 0 ? 'all checks passed' : `FAILED ${failed.map(([key]) => key).join(', ')}`}`)
  process.exit(failed.length === 0 ? 0 : 1)
}
