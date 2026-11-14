/**
 * 04 — every tool result must be lossless JSON with exactly the declared keys.
 *
 * The host rejected `hands_view` on 2026-11-14 with "value is not lossless JSON"
 * because the kernel handed back `{ok, text, imageRef: undefined}`. Nothing in the
 * unit tests caught it, because the harness never validates tool output. This test
 * does: it round-trips each tool's result through JSON and rejects extra keys.
 *
 * Only read tools and dry runs are called here — nothing is injected.
 */
import { createReport } from './assert.mjs'
import { bootPlugin } from './harness.mjs'

const report = createReport('tool output contract')
const ALLOWED = new Set(['text', 'imageRef'])

function checkValue(label, value) {
  report.ok(`${label}: returns an object`, value !== null && typeof value === 'object' && !Array.isArray(value), typeof value)
  const keys = Object.keys(value || {})
  const extra = keys.filter((key) => !ALLOWED.has(key))
  report.eq(`${label}: only declared keys`, extra, [])
  report.ok(`${label}: text is a string`, typeof value?.text === 'string')
  let roundTrip = null
  try {
    roundTrip = JSON.parse(JSON.stringify(value))
  } catch (error) {
    report.fail(`${label}: JSON round-trip`, String(error && error.message))
    return
  }
  report.eq(`${label}: JSON round-trip is lossless`, roundTrip, value)
  const hasUndefined = JSON.stringify(value, (key, item) => {
    if (item === undefined) report.fail(`${label}: undefined property "${key}"`)
    if (typeof item === 'number' && !Number.isFinite(item)) report.fail(`${label}: non-finite number "${key}"`)
    return item
  })
  report.ok(`${label}: serializes`, typeof hasUndefined === 'string')
}

const run = await bootPlugin({ config: { requireFreshLookSeconds: 0 } })
try {
  checkValue('hands_status', await run.call('hands_status', { tail: 2 }))
  checkValue('hands_view info', await run.call('hands_view', { action: 'info' }))
  checkValue('hands_view list', await run.call('hands_view', { action: 'list', limit: 3 }))
  checkValue('hands_act dryRun click', await run.call('hands_act', { action: 'click', x: 400, y: 300, dryRun: true }))
  checkValue('hands_run dryRun', await run.call('hands_run', { steps: [{ action: 'move', x: 400, y: 300 }], dryRun: true }))
} finally {
  run.close()
}

const ok = report.finish()
// The plugin spawns helper/UIA children; without an explicit exit the event loop stays
// alive on them and the run looks like a hang after printing.
process.exit(ok ? 0 : 1)
