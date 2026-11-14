/**
 * 07 — stop, batch accounting and reserved hotkeys.
 *
 * These pin the failures an independent review found by probe:
 *   - a batch used to spend ONE grant credit and ONE rate tick for up to 25 injections;
 *   - `/dexter stop` stopped the gate but not the stop bus, so a running batch kept going;
 *   - a stop that landed during the approval question still injected afterwards;
 *   - injecting the arm hotkey made the plugin "see" a human and open a grant by itself.
 */
import { bootKernel } from './harness.mjs'
import { createReport } from './assert.mjs'

const report = createReport('stop / batch / hotkeys')
const FAST = { requireFreshLookSeconds: 0, settleMs: 0, humanWaitMaxMs: 0, hoverFree: false, maxActionsPerMinute: 600 }

// ---- batch is charged for every step it covers ------------------------------
const batch = await bootKernel({ config: FAST })
try {
  const injected = () => batch.calls.act.length
  batch.gate.openGrant({ minutes: 5, actions: 10, source: 'command' })
  const before = injected()
  const result = await batch.kernel.run({ steps: [{ action: 'click', x: 1, y: 1 }, { action: 'click', x: 2, y: 2 }, { action: 'click', x: 3, y: 3 }] })
  const grant = batch.gate.snapshot().grant
  report.ok('batch runs all steps', result.ok && injected() - before === 3, result.text.split('\n')[0])
  report.ok('batch charges one credit per step', grant && grant.used === 3, grant && `used=${grant.used}`)
  report.ok('batch charges one rate tick per step', batch.gate.snapshot().rate.lastMinute === 3, batch.gate.snapshot().rate.lastMinute)

  // Not enough credits: refuse the whole batch instead of half-running it.
  const small = await bootKernel({ config: FAST })
  try {
    small.gate.openGrant({ minutes: 5, actions: 2, source: 'command' })
    const started = small.calls.act.length
    const refused = await small.kernel.run({ steps: [{ action: 'click', x: 1, y: 1 }, { action: 'click', x: 2, y: 2 }, { action: 'click', x: 3, y: 3 }] })
    report.ok('insufficient budget refuses the batch', refused.ok === false && small.calls.act.length === started)
    report.ok('refusal explains the shortfall', refused.text.includes('余额不足'), refused.text.slice(0, 80))
  } finally {
    small.close()
  }
} finally {
  batch.close()
}

// ---- a stop interrupts a batch ---------------------------------------------
const halted = await bootKernel({ config: FAST })
try {
  halted.gate.openGrant({ minutes: 5, actions: 10, source: 'command' })
  halted.kernel.stop({ level: 'hard', by: 'command', reason: '/dexter stop' })
  const started = halted.calls.act.length
  const result = await halted.kernel.run({ steps: [{ action: 'click', x: 9, y: 9 }] })
  report.ok('stopped gate refuses a batch', result.ok === false && halted.calls.act.length === started, result.text.split('\n')[0])
  report.ok('the command stop also marks the stop bus', Boolean(halted.stopbus.snapshot().stopped))

  // Re-arming clears both, so the human can work again.
  halted.gate.openGrant({ minutes: 5, actions: 10, source: 'command' })
  halted.gate.clearStop('human')
  halted.stopbus.clear()
  const again = await halted.kernel.run({ steps: [{ action: 'click', x: 5, y: 5 }] })
  report.ok('re-arm makes batches usable again', again.ok === true, again.text.split('\n')[0])
} finally {
  halted.close()
}

// ---- a stop during the approval question is honoured ------------------------
const late = await bootKernel({
  config: { ...FAST, askOnWrite: true },
  approvalOutcome: 'allowed-once',
  approvalService: true,
})
try {
  // Hold the approval open on purpose: an answer only arrives after the human already hit
  // stop, which is exactly the case where the old code injected anyway.
  late.approvals.outcome = async () => {
    await new Promise((done) => setTimeout(done, 200))
    return 'allowed-once'
  }
  const original = late.approvals.calls
  const pending = late.kernel.act({ action: 'click', args: { x: 21, y: 21 } })
  // Give the kernel a moment to reach the approval await, then stop.
  await new Promise((done) => setTimeout(done, 40))
  late.kernel.stop({ level: 'hard', by: 'human', reason: 'esc during prompt' })
  const result = await pending
  report.ok('stop during the prompt prevents the injection', result.ok === false, result.text.slice(0, 80))
  report.ok('the approval really was pending', original.length >= 1, `calls=${original.length}`)
} finally {
  late.close()
}

// ---- injecting a human hotkey is refused ------------------------------------
const keys = await bootKernel({ config: FAST })
try {
  keys.gate.openGrant({ minutes: 5, actions: 10, source: 'command' })
  const started = keys.calls.act.length
  const arm = await keys.kernel.act({ action: 'hotkey', args: { keys: 'ctrl+alt+f12' } })
  report.ok('injecting the arm hotkey is refused', arm.ok === false && arm.text.includes('热键'), arm.text.slice(0, 80))
  report.ok('refused hotkey injects nothing', keys.calls.act.length === started)
  const esc = await keys.kernel.act({ action: 'key', args: { key: 'esc' } })
  report.ok('injecting esc is refused', esc.ok === false, esc.text.slice(0, 60))
  const plain = await keys.kernel.act({ action: 'key', args: { key: 'tab' } })
  report.ok('an ordinary key still passes', plain.ok === true, plain.text.slice(0, 60))
} finally {
  keys.close()
}

// ---- the panel can tell "authorized" from "not" -----------------------------
const shown = await bootKernel({ config: FAST })
try {
  report.ok('no grant reads as inactive', shown.gate.snapshot().grant === null)
  shown.gate.openGrant({ minutes: 5, actions: 10, source: 'command' })
  report.ok('open grant reads as active', shown.gate.snapshot().grant.active === true)
  shown.gate.stop({ level: 'hard', by: 'human', reason: 'test' })
  report.ok('stopped snapshot carries no active grant', !shown.gate.snapshot().grant || shown.gate.snapshot().grant.active === false)
} finally {
  shown.close()
}

// ---- a batch watches the human at every step --------------------------------
const watchful = await bootKernel({ config: FAST })
try {
  watchful.gate.openGrant({ minutes: 5, actions: 10, source: 'command' })
  let idleChecks = 0
  const original = watchful.human.waitForIdle.bind(watchful.human)
  watchful.human.waitForIdle = async (options) => {
    idleChecks += 1
    return original(options)
  }
  await watchful.kernel.run({ steps: [{ action: 'click', x: 1, y: 1 }, { action: 'click', x: 2, y: 2 }, { action: 'click', x: 3, y: 3 }] })
  watchful.human.waitForIdle = original
  report.ok('a batch re-checks the human at every step', idleChecks >= 3, `idleChecks=${idleChecks}`)
} finally {
  watchful.close()
}

// ---- a batch honours the fresh-look rule -----------------------------------
const stale = await bootKernel({ config: { ...FAST, requireFreshLookSeconds: 120 } })
try {
  stale.gate.openGrant({ minutes: 5, actions: 10, source: 'command' })
  const started = stale.calls.act.length
  const result = await stale.kernel.run({ steps: [{ action: 'click', x: 8, y: 8 }] })
  report.ok('a stale observation blocks every batch step', result.ok === false && stale.calls.act.length === started, result.text.split('\n')[1])
} finally {
  stale.close()
}

const ok = report.finish()
process.exit(ok ? 0 : 1)
