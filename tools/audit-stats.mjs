#!/usr/bin/env node
/**
 * audit-stats.mjs — one reader for every audit trail this project has produced.
 *
 * The old package wrote three incompatible formats:
 *   pixel   ~/.dsh/click-matrix/audit.jsonl         {ts,tool,decision,reason,seq,prev,h}
 *   control <data>/dsh-desktop-hands/audit/control.jsonl   {seq,b:"<inner json>",prev,h}
 *   stroke  <data>/dsh-desktop-hands/audit/stroke.jsonl    {engine,seq,t,tool,decision}
 * The kernel writes one format:
 *   dexter  <data>/audit/hands.jsonl                {ts,iso,seq,tool,capability,...,prev,h}
 *
 * Usage
 *   node tools/audit-stats.mjs all [--json out.json]
 *   node tools/audit-stats.mjs <file> [<file>...] [--kind pixel|control|stroke|dexter]
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

function parseJsonl(path) {
  const text = readFileSync(path, 'utf8')
  const rows = []
  let bad = 0
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      bad += 1
    }
  }
  return { rows, bad, bytes: Buffer.byteLength(text, 'utf8') }
}

function countBy(rows, pick) {
  const out = {}
  for (const row of rows) {
    const key = pick(row)
    if (key === undefined || key === null || key === '') continue
    out[key] = (out[key] || 0) + 1
  }
  return out
}

function chainCheck(rows) {
  // Key-less hash chain: we can only verify that prev/h are present and that seq
  // increases, never that a row was not rewritten. Honest limit, stated in the docs.
  let seqOk = 0
  let seqBad = 0
  let linked = 0
  let prev = ''
  for (const row of rows) {
    if (typeof row.seq === 'number' && typeof row.h === 'string') seqOk += 1
    else seqBad += 1
    if (typeof row.prev === 'string' && row.prev === prev) linked += 1
    prev = typeof row.h === 'string' ? row.h : prev
  }
  return { withChainFields: seqOk, missingChainFields: seqBad, prevLinksMatching: linked }
}

export function statsPixel(path) {
  const { rows, bad, bytes } = parseJsonl(path)
  const decisions = countBy(rows, (row) => row.decision)
  const tools = countBy(rows, (row) => (row.decision === 'attempt' || row.decision === 'finished' ? row.tool : undefined))
  return {
    kind: 'pixel',
    path,
    bytes,
    lines: rows.length,
    unparsable: bad,
    decisions,
    attempts: decisions.attempt || 0,
    finished: decisions.finished || 0,
    denies: decisions.denied || 0,
    paused: decisions.paused || 0,
    mutatingTools: tools,
    chain: chainCheck(rows),
  }
}

export function statsControl(path) {
  const { rows, bad, bytes } = parseJsonl(path)
  const inner = []
  let undecodable = 0
  for (const row of rows) {
    try {
      inner.push(typeof row.b === 'string' ? JSON.parse(row.b) : row.b)
    } catch {
      undecodable += 1
    }
  }
  const kinds = countBy(inner, (row) => row && row.kind)
  return {
    kind: 'control',
    path,
    bytes,
    lines: rows.length,
    unparsable: bad,
    undecodable,
    kinds,
    allow: kinds.allow || 0,
    dryRun: kinds['dry-run'] || 0,
    deny: kinds.deny || 0,
    actions: countBy(inner, (row) => (row && row.kind === 'allow' ? row.action : undefined)),
    chain: chainCheck(rows),
  }
}

export function statsStroke(path) {
  const { rows, bad, bytes } = parseJsonl(path)
  return {
    kind: 'stroke',
    path,
    bytes,
    lines: rows.length,
    unparsable: bad,
    decisions: countBy(rows, (row) => row.decision),
    tools: countBy(rows, (row) => row.tool),
  }
}

/** Kernel format: the reconciler used by A4/A5. */
export function statsDexter(path) {
  const { rows, bad, bytes } = parseJsonl(path)
  const decisions = countBy(rows, (row) => row.decision)
  const executed = rows.filter((row) => row.decision === 'executed')
  const attempts = rows.filter((row) => row.decision === 'attempt')
  const withoutApproval = executed.filter((row) => !row.approval || row.approval === 'none')
  const withoutResult = executed.filter((row) => row.result === undefined || row.result === null || row.result === '')
  return {
    kind: 'dexter',
    path,
    bytes,
    lines: rows.length,
    unparsable: bad,
    decisions,
    attempts: attempts.length,
    executed: executed.length,
    denied: decisions.denied || 0,
    dryRuns: decisions['dry-run'] || 0,
    toy: rows.filter((row) => row.mode === 'toy').length,
    capabilities: countBy(executed, (row) => row.capability),
    backends: countBy(executed, (row) => row.backend),
    approvals: countBy(executed, (row) => row.approval),
    executedWithoutApproval: withoutApproval.length,
    executedWithoutResult: withoutResult.length,
    chain: chainCheck(rows),
  }
}

/** Locate the three legacy trails plus any sealed generations. */
function legacyTargets() {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const pixelDir = join(home, '.dsh', 'click-matrix')
  const handsAudit = join(home, '.dsh', 'dsh-desktop-hands', 'audit')
  const targets = []
  const pixel = join(pixelDir, 'audit.jsonl')
  if (existsSync(pixel)) targets.push(['pixel', pixel])
  const control = join(handsAudit, 'control.jsonl')
  if (existsSync(control)) targets.push(['control', control])
  const stroke = join(handsAudit, 'stroke.jsonl')
  if (existsSync(stroke)) targets.push(['stroke', stroke])
  const sealed = []
  try {
    for (const name of readdirSync(pixelDir)) {
      if (name.startsWith('audit.') && name !== 'audit.jsonl') sealed.push(join(pixelDir, name))
    }
  } catch { /* no sealed generations */ }
  return { targets, sealed }
}

function readOne(kind, path) {
  if (kind === 'pixel') return statsPixel(path)
  if (kind === 'control') return statsControl(path)
  if (kind === 'stroke') return statsStroke(path)
  if (kind === 'dexter') return statsDexter(path)
  // Unknown kind: infer from row shape.
  const { rows } = parseJsonl(path)
  const first = rows[0] || {}
  if (typeof first.b === 'string') return statsControl(path)
  if (first.engine === 'stroke') return statsStroke(path)
  if (typeof first.capability === 'string' || first.backend) return statsDexter(path)
  return statsPixel(path)
}

function main() {
  const argv = process.argv.slice(2)
  const outIndex = argv.indexOf('--json')
  const out = outIndex >= 0 ? argv[outIndex + 1] : ''
  const kindIndex = argv.indexOf('--kind')
  const forcedKind = kindIndex >= 0 ? argv[kindIndex + 1] : ''
  const args = argv.filter((_, i) => {
    if (outIndex >= 0 && (i === outIndex || i === outIndex + 1)) return false
    if (kindIndex >= 0 && (i === kindIndex || i === kindIndex + 1)) return false
    return true
  })
  const report = { generatedAt: new Date().toISOString(), trails: [], sealed: [] }
  if (args[0] === 'all' || args.length === 0) {
    const { targets, sealed } = legacyTargets()
    for (const [kind, path] of targets) report.trails.push(readOne(kind, path))
    for (const path of sealed) report.sealed.push(readOne('pixel', path))
  } else {
    for (const target of args) {
      if (!existsSync(target)) {
        report.trails.push({ kind: forcedKind || 'missing', path: target, error: 'not found' })
        continue
      }
      report.trails.push(readOne(forcedKind, target))
    }
  }
  const json = `${JSON.stringify(report, null, 2)}\n`
  if (out) writeFileSync(out, json, 'utf8')
  process.stdout.write(json)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
