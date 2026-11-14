/**
 * 11 — the audit chain survives two writers.
 *
 * On a plugin reload the old instance may still append its helper-exit rows while the new one
 * starts; two independent counters used to interleave and break the chain (4 breaks in one
 * day). The trail must stay a single chain: seq +1 and prev === previous h.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Audit } from '../kernel/audit.js'
import { createReport } from './assert.mjs'

const report = createReport('audit chain')
const dir = mkdtempSync(join(tmpdir(), 'dexter-audit-chain-'))
const file = join(dir, 'audit', 'hands.jsonl')

try {
  const a = new Audit({ dir })
  const b = new Audit({ dir })
  a.append({ tool: 'plugin', capability: 'lifecycle', decision: 'loaded' })
  a.append({ tool: 'legacy', capability: 'helper', decision: 'exit' })
  // b never read the file before this write: it must adopt a's tail, not start at 1.
  b.append({ tool: 'plugin', capability: 'surface', decision: 'registered' })
  a.append({ tool: 'plugin', capability: 'lifecycle', decision: 'disposed' })
  b.append({ tool: 'legacy', capability: 'helper', decision: 'exit' })

  const rows = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
  let breaks = 0
  let gaps = 0
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i].prev !== rows[i - 1].h) breaks += 1
    if (rows[i].seq !== rows[i - 1].seq + 1) gaps += 1
  }
  report.eq('five rows were written', rows.length, 5)
  report.eq('the chain has no break', breaks, 0)
  report.eq('seq is continuous across writers', gaps, 0)
  report.eq('the last row is the last writer’s', rows[rows.length - 1].decision, 'exit')
  report.ok('every row carries a hash', rows.every((row) => typeof row.h === 'string' && row.h.length === 64))

  // A single writer keeps working normally.
  const c = new Audit({ dir })
  c.append({ tool: 'plugin', capability: 'lifecycle', decision: 'loaded' })
  const after = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
  report.eq('a fresh instance continues the same chain', after[after.length - 1].seq, rows[rows.length - 1].seq + 1)
  report.eq('and links to the previous hash', after[after.length - 1].prev, rows[rows.length - 1].h)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

const ok = report.finish()
process.exit(ok ? 0 : 1)
