import { bootKernel } from '../test/harness.mjs'

const FAST = { requireFreshLookSeconds: 0, settleMs: 0, humanWaitMaxMs: 0, maxActionsPerMinute: 60, hoverFree: false }
const k = await bootKernel({ config: FAST })
try {
  const open = k.gate.openGrant({ minutes: 1, actions: 1, source: 'command' })
  console.log('open:', JSON.stringify(open))
  const first = await k.kernel.act({ action: 'click', args: { x: 13, y: 13 } })
  console.log('first act:', first.ok, first.text.slice(0, 60))
  console.log('snapshot before extend:', JSON.stringify(k.gate.snapshot().grant))
  const extended = k.gate.extendGrant({ minutes: 1, actions: 1, source: 'test' })
  console.log('extended:', JSON.stringify(extended))
  const after = await k.kernel.act({ action: 'click', args: { x: 14, y: 14 } })
  console.log('after act:', after.ok, after.text.slice(0, 80))
} finally {
  k.close()
}
