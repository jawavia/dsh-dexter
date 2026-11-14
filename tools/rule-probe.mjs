#!/usr/bin/env node
/**
 * rule-probe.mjs — the `move` gating difference, measured without injecting anything.
 *
 * The dual-run can only observe this when the desktop is quiet (a human moving the
 * mouse suspends the old engine too). This probe asks both authorization layers the
 * same question directly: "may this caller move the cursor right now, with no grant
 * and no approval service?"
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Gate } from '../kernel/gate.js'
import { normalizeConfig } from '../kernel/config.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')

function legacyRoot() {
  if (process.env.DSH_DEXTER_LEGACY_ROOT) return process.env.DSH_DEXTER_LEGACY_ROOT
  try {
    return JSON.parse(readFileSync(join(REPO, 'local.config.json'), 'utf8')).legacyRoot || ''
  } catch {
    return ''
  }
}

const root = legacyRoot()
if (!root) {
  console.error('legacy root not configured')
  process.exit(2)
}

const { AccessGate } = await import(pathToFileURL(join(root, 'engines', 'pixel', 'lib', 'access.js')).href)
const { normalizeConfig: normalizePixelConfig } = await import(pathToFileURL(join(root, 'engines', 'pixel', 'lib', 'config.js')).href)

const silentAudit = { append: () => null, tail: () => [], writable: true, lastError: '', chainSeq: 0, chainHead: '' }
const oldGate = new AccessGate({
  ctx: { get: () => null },
  config: normalizePixelConfig({ mode: 'ask', minIntervalMs: 0, pauseOnHumanInput: false }),
  audit: silentAudit,
})
const oldMove = oldGate.checkMove('mouse_move')
const oldClick = await oldGate.check({ toolName: 'mouse_click' })

const config = normalizeConfig({ requireFreshLookSeconds: 0 })
const newGate = new Gate({ config, audit: { append: () => null }, approval: null })
const newMove = await newGate.authorize({ tool: 'hands_act', capability: 'move', exec: {} })
const newClick = await newGate.authorize({ tool: 'hands_act', capability: 'click', exec: {} })

const report = {
  question: 'may this caller inject with no grant and no approval service?',
  old: {
    move: { allowed: oldMove.allowed, code: oldMove.code },
    click: { allowed: oldClick.allowed, code: oldClick.code },
  },
  next: {
    move: { allowed: newMove.allowed, approval: newMove.approval },
    click: { allowed: newClick.allowed, approval: newClick.approval },
  },
  differsOnMoveOnly: oldMove.allowed === true && newMove.allowed === false
    && oldClick.allowed === newClick.allowed,
}
console.log(JSON.stringify(report, null, 2))
process.exit(report.differsOnMoveOnly ? 0 : 1)
