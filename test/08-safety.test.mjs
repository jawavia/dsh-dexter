/**
 * 08 — the safety edges a review found missing: rehearsal must answer like the real call,
 * an unidentifiable target must fail closed, and a broken audit trail must refuse to inject.
 */
import { bootKernel } from './harness.mjs'
import { createReport } from './assert.mjs'

const report = createReport('safety edges')
const FAST = { requireFreshLookSeconds: 0, settleMs: 0, humanWaitMaxMs: 0, hoverFree: false, maxActionsPerMinute: 600 }

// ---- a rehearsal answers exactly like the real call -------------------------
const system = await bootKernel({ config: FAST })
try {
  system.state.windows.push({ handle: 777, pid: 999, process: 'regedit.exe', title: '注册表编辑器', rect: { x: 0, y: 0, width: 400, height: 300 } })
  system.gate.openGrant({ minutes: 5, actions: 10, source: 'command' })
  const dry = await system.kernel.act({ action: 'click', args: { x: 10, y: 10, dryRun: true } })
  const real = await system.kernel.act({ action: 'click', args: { x: 10, y: 10 } })
  report.ok('dryRun refuses a permanently forbidden target', dry.ok === false && dry.text.includes('永久禁止'), dry.text.slice(0, 120))
  report.ok('the real call refuses the same target', real.ok === false && real.text.includes('永久禁止'))

  // A target nobody can identify: fail closed instead of "normal".
  const empty = await bootKernel({ config: FAST })
  try {
    empty.state.windows.length = 0
    empty.state.foregroundHandle = null
    empty.gate.openGrant({ minutes: 5, actions: 10, source: 'command' })
    const blind = await empty.kernel.act({ action: 'click', args: { x: 44, y: 44 } })
    report.ok('an unidentifiable target is refused', blind.ok === false && blind.text.includes('无法确认目标窗口'), blind.text.slice(0, 120))
    report.ok('nothing was injected for it', empty.calls.act.length === 0)
  } finally {
    empty.close()
  }
} finally {
  system.close()
}

// ---- no evidence, no injection ---------------------------------------------
const broken = await bootKernel({ config: FAST })
try {
  broken.gate.openGrant({ minutes: 5, actions: 10, source: 'command' })
  // Rehearsal first: a successful audit write would clear the flag.
  broken.audit.broken = true
  const dry = await broken.kernel.act({ action: 'click', args: { x: 5, y: 5, dryRun: true } })
  report.ok('the rehearsal mentions the broken trail', dry.ok === false && dry.text.includes('审计'), dry.text.slice(0, 120))
  broken.audit.broken = true
  const refused = await broken.kernel.act({ action: 'click', args: { x: 5, y: 5 } })
  report.ok('a broken audit trail refuses the write', refused.ok === false && refused.text.includes('审计'), refused.text.slice(0, 120))
  report.ok('and injects nothing', broken.calls.act.length === 0)

} finally {
  broken.close()
}

// ---- batching accepts a per-step expect ------------------------------------
const expect = await bootKernel({ config: FAST })
try {
  expect.gate.openGrant({ minutes: 5, actions: 10, source: 'command' })
  const result = await expect.kernel.run({
    steps: [{ action: 'click', x: 3, y: 3, expect: { process: 'notepad.exe' } }],
  })
  report.ok('a step-level expect is accepted', result.ok === true, result.text.split('\n')[0])
  const row = expect.rows().filter((entry) => entry.decision === 'executed').pop()
  report.ok('the step verify runs with the expect', Boolean(row && row.verify), row && row.verify)
} finally {
  expect.close()
}

// ---- extend without arguments uses the configured defaults -----------------
const extend = await bootKernel({ config: { ...FAST, armActions: 50, armMinutes: 7 } })
try {
  extend.gate.openGrant({ minutes: 7, actions: 50, source: 'command' })
  const before = extend.gate.snapshot().grant
  const extended = extend.gate.extendGrant({ minutes: 7, actions: 50, source: 'test' })
  report.ok('extend adds the configured amount', extended.ok && extended.grant.actions === before.actions + 50, extended.grant && extended.grant.actions)
} finally {
  extend.close()
}

const ok = report.finish()
process.exit(ok ? 0 : 1)
