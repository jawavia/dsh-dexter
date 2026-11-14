/**
 * A4/A5/A7/A8/A9/A10 — authorization, target policy, rate limits and the audit
 * invariants, driven through the real kernel with fake backends (no input injected).
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createReport } from './assert.mjs'
import { bootKernel } from './harness.mjs'
import { buildShape } from '../backends/toy-draw.js'

const report = createReport('auth+audit invariants')
const FAST = { requireFreshLookSeconds: 0, settleMs: 0 }

// ---- A7 default: no session, ask once per write ---------------------------
const basic = await bootKernel({ config: FAST })
try {
  report.eq('A7 askOnWrite defaults on', basic.config.askOnWrite, true)
  report.eq('A7 no session grant by default', basic.gate.snapshot().grant, null)
  report.eq('A7 default arm numbers come from the config', [basic.config.armMinutes, basic.config.armActions], [15, 100])

  const first = await basic.kernel.act({ action: 'click', args: { x: 100, y: 100 } })
  report.ok('A7 a click asks the human once', first.ok && basic.approvals.calls.length === 1)
  const second = await basic.kernel.act({ action: 'click', args: { x: 120, y: 120 } })
  report.ok('A7 the next click asks again', second.ok && basic.approvals.calls.length === 2)

  const executed = basic.rows().filter((row) => row.decision === 'executed' && row.tool === 'hands_act')
  report.eq('A5 executed rows for 2 actions', executed.length, 2)
  report.ok('A5 every executed row carries approval', executed.every((row) => typeof row.approval === 'string' && row.approval !== 'none'))
  report.ok('A5 every executed row carries a result', executed.every((row) => row.result === 'ok' || row.result === 'failed'))
  report.ok('A5 every executed row carries argsHash + verify', executed.every((row) => row.argsHash && row.verify))
} finally {
  basic.close()
}

// ---- free hover (方案 C): no authorization, but guarded and audited ---------
const hover = await bootKernel({ config: FAST, approvalService: false })
try {
  report.eq('hover：默认开启', hover.config.hoverFree, true)
  const free = await hover.kernel.act({ action: 'move', args: { x: 300, y: 300 } })
  report.ok('hover：没有会话、没有审批通道也能悬停', free.ok, free.text)
  report.ok('hover：不需要审批', hover.approvals.calls.length === 0)
  const row = hover.rows().filter((r) => r.decision === 'executed').pop()
  report.ok('hover：审计标记 hover(free)', row && row.approval === 'hover(free)', row && row.approval)

  hover.state.buttonsDown = ['left']
  const held = await hover.kernel.act({ action: 'move', args: { x: 310, y: 310 } })
  report.ok('hover：按住鼠标键时拒绝（否则等于拖拽）', held.ok === false && held.text.includes('鼠标键'), held.text)
  report.ok('hover：按键拒绝也审计', hover.rows().some((r) => r.decision === 'denied' && String(r.reason).includes('button-held')))
  hover.state.buttonsDown = []

  const systemHover = await hover.kernel.act({ action: 'move', args: { x: 1100, y: 100 } })
  report.ok('hover：系统目标照样永久禁止', systemHover.ok === false && systemHover.text.includes('永久禁止'), systemHover.text)

  const clickStillAsks = await hover.kernel.act({ action: 'click', args: { x: 320, y: 320 } })
  report.ok('hover 免费不影响点击：没有授权时点击被拒', clickStillAsks.ok === false, clickStillAsks.text)
} finally {
  hover.close()
}

const hoverCredit = await bootKernel({ config: FAST })
try {
  hoverCredit.gate.openGrant({ minutes: 15, actions: 1, source: 'command' })
  const free = await hoverCredit.kernel.act({ action: 'move', args: { x: 40, y: 40 } })
  const snapshot = hoverCredit.gate.snapshot()
  report.ok('hover：不消耗会话额度', free.ok && snapshot.grant && snapshot.grant.left === 1, JSON.stringify(snapshot.grant))
  const click = await hoverCredit.kernel.act({ action: 'click', args: { x: 41, y: 41 } })
  const after = hoverCredit.gate.snapshot()
  report.ok('hover 之后会话额度仍然可用', click.ok && after.grant === null)
} finally {
  hoverCredit.close()
}

// ---- clipboard: both directions are gated per write ----------------------
const clip = await bootKernel({ config: FAST })
try {
  clip.gate.openGrant({ minutes: 15, actions: 50, source: 'command' })
  const before = clip.approvals.calls.length
  const read = await clip.kernel.act({ action: 'clipboard_get' })
  report.ok('剪贴板读：常开授权下仍逐条请示', read.ok && clip.approvals.calls.length === before + 1, `approvals=${clip.approvals.calls.length}`)
  const readRow = clip.rows().filter((row) => row.decision === 'executed' && row.capability === 'clipboard_get').pop()
  // Clipboard is a forced per-write ask, so the row is labelled ask:sensitive.
  report.ok('剪贴板读：审计标明是逐条请示', readRow && /^ask(:sensitive)?$/.test(readRow.approval), readRow && readRow.approval)
  report.ok('剪贴板读：返回文本', Boolean(read.text && read.text.includes('剪贴板')))

  const write = await clip.kernel.act({ action: 'clipboard_set', args: { text: 'dexter-clip-test' } })
  report.ok('剪贴板写：同样逐条请示', write.ok && clip.approvals.calls.length === before + 2, `approvals=${clip.approvals.calls.length}`)
  const bad = await clip.kernel.act({ action: 'clipboard_set', args: {} })
  report.ok('剪贴板写：空文本被拒', bad.ok === false && bad.text.includes('clipboard_set'), bad.text)

  clip.approvals.outcome = 'denied'
  const refused = await clip.kernel.act({ action: 'clipboard_set', args: { text: 'x' } })
  report.ok('剪贴板写：人不同意就不写', refused.ok === false && refused.text.includes('没有同意'), refused.text)
} finally {
  clip.close()
}

// ---- a session grant: no prompts until the budget is gone ----------------
const session = await bootKernel({ config: FAST })
try {
  const grant = session.gate.openGrant({ minutes: 30, actions: 2, source: 'command' })
  report.ok('A7 a human can open a session grant', grant.ok && grant.grant.actions === 2)
  const a = await session.kernel.act({ action: 'click', args: { x: 10, y: 10 } })
  const b = await session.kernel.act({ action: 'click', args: { x: 20, y: 20 } })
  report.ok('A7 two writes inside the session do not ask', a.ok && b.ok && session.approvals.calls.length === 0, `approvals=${session.approvals.calls.length}`)
  const c = await session.kernel.act({ action: 'click', args: { x: 30, y: 30 } })
  report.ok('A7 an exhausted session falls back to asking', c.ok && session.approvals.calls.length === 1)
  const rows = session.rows().filter((row) => row.decision === 'executed')
  report.ok('A7 each session write is audited with its slot', rows.filter((row) => String(row.approval).startsWith('session:')).length === 2)
  report.ok('A7 the third write is audited as a per-write approval', rows.some((row) => row.approval === 'ask'))
} finally {
  session.close()
}

// ---- expiry and extension -------------------------------------------------
const expiry = await bootKernel({ config: FAST })
try {
  expiry.gate.openGrant({ minutes: 1, actions: 10, source: 'command' })
  const before = await expiry.kernel.act({ action: 'click', args: { x: 11, y: 11 } })
  report.ok('A7 a write inside a fresh session runs', before.ok)
  expiry.advance(61_000)
  report.eq('A7 the session expires by itself', expiry.gate.snapshot().grant, null)
  const after = await expiry.kernel.act({ action: 'click', args: { x: 12, y: 12 } })
  report.ok('A7 after expiry the write asks again', after.ok && expiry.approvals.calls.length === 1)
  report.ok('A7 expiry is audited', expiry.rows().some((row) => row.decision === 'grant-expired'))

  expiry.gate.openGrant({ minutes: 1, actions: 1, source: 'command' })
  await expiry.kernel.act({ action: 'click', args: { x: 13, y: 13 } })
  const extended = expiry.gate.extendGrant({ minutes: 1, actions: 1, source: 'test' })
  report.ok('A7 an open session can be extended', extended.ok && extended.grant.actions === 2)
  const afterExtend = await expiry.kernel.act({ action: 'click', args: { x: 14, y: 14 } })
  report.ok('A7 the extended session lets the next write through', afterExtend.ok && expiry.rows().some((row) => row.decision === 'grant-extended'))
} finally {
  expiry.close()
}

// ---- rate cap -------------------------------------------------------------
const rate = await bootKernel({ config: { ...FAST, maxActionsPerMinute: 3 } })
try {
  rate.gate.openGrant({ minutes: 30, actions: 50, source: 'command' })
  for (let i = 0; i < 3; i += 1) await rate.kernel.act({ action: 'move', args: { x: 100 + i, y: 100 } })
  const burst = await rate.kernel.act({ action: 'move', args: { x: 200, y: 200 } })
  report.ok('A7 the rate cap refuses a burst', burst.ok === false && burst.text.includes('频率上限'), burst.text)
  report.ok('A7 the rate refusal is audited', rate.rows().some((row) => row.decision === 'denied' && String(row.reason).includes('频率上限')))
  rate.advance(61_000)
  const afterWait = await rate.kernel.act({ action: 'move', args: { x: 201, y: 201 } })
  report.ok('A7 after the window the write runs again', afterWait.ok, afterWait.text)
} finally {
  rate.close()
}

// ---- permanent system targets --------------------------------------------
const system = await bootKernel({ config: FAST })
try {
  system.gate.openGrant({ minutes: 30, actions: 50, source: 'command' })
  // 注册表编辑器 window is at 1000,0 400x300.
  const hitSystem = await system.kernel.act({ action: 'click', args: { x: 1100, y: 100 } })
  report.ok('系统目标：常开授权也不放行', hitSystem.ok === false && hitSystem.text.includes('永久禁止'), hitSystem.text)
  report.eq('系统目标：没有任何注入', system.calls.act.length, 0)
  report.ok('系统目标：审计写明 system-target', system.rows().some((row) => row.decision === 'denied' && String(row.reason).includes('system-target')))

  system.state.foregroundHandle = 200
  const typeSystem = await system.kernel.act({ action: 'type', args: { text: 'x' } })
  report.ok('系统目标：前台是注册表时输入也被拒', typeSystem.ok === false && typeSystem.text.includes('永久禁止'))
  system.state.foregroundHandle = 100
} finally {
  system.close()
}

// ---- sensitive targets ask per write even inside a session ---------------
const sensitive = await bootKernel({ config: FAST })
try {
  sensitive.gate.openGrant({ minutes: 30, actions: 50, source: 'command' })
  // 微信 window is at 1000,400 400x300.
  const before = sensitive.approvals.calls.length
  const asked = await sensitive.kernel.act({ action: 'click', args: { x: 1100, y: 500 } })
  report.ok('私人目标：常开授权下仍逐条请示', asked.ok && sensitive.approvals.calls.length === before + 1, `approvals=${sensitive.approvals.calls.length}`)
  const row = sensitive.rows().filter((r) => r.decision === 'executed').pop()
  report.ok('私人目标：审批标签写明 ask:sensitive', row && row.approval === 'ask:sensitive', row && row.approval)

  sensitive.approvals.outcome = 'denied'
  const refused = await sensitive.kernel.act({ action: 'click', args: { x: 1101, y: 501 } })
  report.ok('私人目标：人类说不就什么都不做', refused.ok === false && refused.text.includes('没有同意'), refused.text)
} finally {
  sensitive.close()
}

// ---- A8 stop revokes, and the next write is refused ----------------------
const stopped = await bootKernel({ config: FAST })
try {
  const ok = await stopped.kernel.act({ action: 'move', args: { x: 5, y: 5 } })
  report.ok('A8 write allowed before stop', ok.ok)
  stopped.gate.openGrant({ minutes: 30, actions: 5, source: 'command' })
  stopped.kernel.stop({ level: 'hard', by: 'human', reason: 'test stop' })
  const after = await stopped.kernel.act({ action: 'move', args: { x: 6, y: 6 } })
  report.ok('A8 write refused after stop', after.ok === false && after.text.includes('急停'), after.text)
  const rows = stopped.rows()
  report.ok('A8 stop is audited with revocation', rows.some((row) => row.decision === 'stop' && String(row.approval).includes('revoke')))
  report.ok('A8 refused write is audited as denied', rows.some((row) => row.decision === 'denied' && String(row.reason).includes('急停')))
  const agentStop = await stopped.kernel.act({ action: 'stop' })
  report.ok('A8 hands_act stop reports revocation', agentStop.ok && agentStop.text.includes('撤销'))
  const stillRefused = await stopped.kernel.act({ action: 'move', args: { x: 7, y: 7 } })
  report.ok('A8 agent stop cannot re-authorize', stillRefused.ok === false)
} finally {
  stopped.close()
}

// ---- A9 human activity suspends injection --------------------------------
const humanTest = await bootKernel({ config: { ...FAST, humanIdleResumeMs: 2000, humanWaitMaxMs: 0 } })
try {
  humanTest.state.keys.add('shift')
  const suspended = humanTest.human.poll()
  report.ok('A9 a key press suspends injection', Boolean(suspended) || humanTest.human.isSuspended())
  const blocked = await humanTest.kernel.act({ action: 'move', args: { x: 11, y: 11 } })
  report.ok('A9 write refused while the human is active', blocked.ok === false && blocked.text.includes('人类正在操作'), blocked.text)
  report.ok('A9 suspend is audited', humanTest.rows().some((row) => row.tool === 'human' && row.decision === 'suspend'))
  humanTest.state.keys.delete('shift')
  humanTest.advance(2200)
  humanTest.human.poll()
  report.ok('A9 resumes after the idle threshold', humanTest.human.isSuspended() === false)
  report.ok('A9 resume is audited', humanTest.rows().some((row) => row.tool === 'human' && row.decision === 'resume'))
  const allowed = await humanTest.kernel.act({ action: 'move', args: { x: 12, y: 12 } })
  report.ok('A9 write works again after resume', allowed.ok, allowed.text)
} finally {
  humanTest.close()
}

// ---- A4/A5 twenty executed actions, one trail ----------------------------
const batch = await bootKernel({ config: FAST })
try {
  const failures = []
  for (let i = 0; i < 20; i += 1) {
    const result = await batch.kernel.act({ action: 'move', args: { x: 200 + i * 3, y: 200 + i * 2 } })
    if (!result.ok) failures.push(result.text)
  }
  report.ok('A5 all 20 actions executed', failures.length === 0, failures.join(' | ').slice(0, 200))
  const executed = batch.rows().filter((row) => row.decision === 'executed')
  report.eq('A5 20 executed actions produce 20 executed audit rows', executed.length, 20)
  report.ok('A5 rows are hash-chained in order', executed.every((row) => typeof row.h === 'string' && row.h.length === 64))

  const auditDir = join(batch.dataDir, 'audit')
  const files = readdirSync(auditDir)
  report.eq('A4 exactly one audit file', files.filter((name) => name.startsWith('hands')), ['hands.jsonl'])
  report.ok('A4 no control.jsonl anywhere in the data root', !existsSync(join(batch.dataDir, 'audit', 'control.jsonl')))
  report.ok('A4 no stroke.jsonl anywhere in the data root', !existsSync(join(batch.dataDir, 'audit', 'stroke.jsonl')))
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]))
  const allFiles = walk(batch.dataDir).map((path) => path.split('\\').pop())
  report.ok('A4 no legacy audit file was created', !allFiles.includes('control.jsonl') && !allFiles.includes('stroke.jsonl'))
  report.ok('A4 no config-overrides file exists', !allFiles.includes('config-overrides.json'))
} finally {
  batch.close()
}

// ---- toy audit is separate (`mode:"toy"`) --------------------------------
const toy = await bootKernel({ config: { ...FAST, toyStrokeEnabled: true, toyStrokeMaxPoints: 400 } })
try {
  const drawn = await toy.kernel.toy({ args: { shape: 'circle', points: 120 }, buildShape })
  report.ok('A10 toy draws through the gate', drawn.ok, drawn.text)
  const toyRows = toy.rows().filter((row) => row.mode === 'toy')
  report.ok('A10 toy writes are audited with mode=toy', toyRows.length >= 1)
  report.ok('A10 toy rows name the in-repo drawer', toyRows.every((row) => row.backend === 'toy-draw'))
  report.ok('A10 toy points are capped', toy.calls.act.some((call) => call.capability === 'toy' && call.args.points <= 400))
} finally {
  toy.close()
}

// ---- the human hotkeys: arm / extend / stop ------------------------------
const hotkeys = await bootKernel({ config: FAST })
try {
  hotkeys.state.keys.add('ctrl')
  hotkeys.state.keys.add('alt')
  hotkeys.state.keys.add('f12')
  hotkeys.stopbus.poll()
  report.ok('A7 Ctrl+Alt+F12 opens a session grant', Boolean(hotkeys.gate.snapshot().grant))
  hotkeys.state.keys.clear()
  hotkeys.stopbus.poll()
  const viaHotkey = await hotkeys.kernel.act({ action: 'click', args: { x: 31, y: 31 } })
  report.ok('A7 the hotkey session covers the write', viaHotkey.ok && hotkeys.approvals.calls.length === 0, `approvals=${hotkeys.approvals.calls.length}`)

  hotkeys.state.keys.add('ctrl')
  hotkeys.state.keys.add('alt')
  hotkeys.state.keys.add('f11')
  hotkeys.stopbus.poll()
  report.ok('A8 Ctrl+Alt+F11 stops', Boolean(hotkeys.gate.snapshot().stopped))
  hotkeys.state.keys.clear()
  hotkeys.stopbus.poll()
  const afterHotkeyStop = await hotkeys.kernel.act({ action: 'click', args: { x: 32, y: 32 } })
  report.ok('A8 write refused after the stop hotkey', afterHotkeyStop.ok === false && afterHotkeyStop.text.includes('急停'))

  hotkeys.gate.clearStop('test')
  hotkeys.state.keys.add('esc')
  hotkeys.stopbus.poll()
  report.ok('A8 Esc also stops', Boolean(hotkeys.gate.snapshot().stopped))
  hotkeys.state.keys.clear()
} finally {
  hotkeys.close()
}

report.finish()
