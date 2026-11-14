#!/usr/bin/env node
/**
 * session-cost.mjs — what did this session actually cost?
 *
 * The DSH session log is a concatenation of zstd frames (`session.v4.jsonl.zstd`), one
 * JSON event per line. This reads it and reports, without guessing:
 *
 *   - token usage actually recorded on each `assistant/message` (input + cache read +
 *     cache write, and output), summed and broken down by the tool calls of that request
 *   - which tools consumed the most: call count, arguments size, result text size,
 *     images attached
 *   - the most expensive individual requests, so a runaway context is visible
 *
 * Derived from the previous bundle's `tools/measure-click-cost.mjs` (same frame scan),
 * extended to report totals instead of only the last rows.
 *
 * Usage:
 *   node tools/session-cost.mjs                 (newest session under ~/.dsh/sessions)
 *   node tools/session-cost.mjs <file|dir>      (a specific session log or session dir)
 *   node tools/session-cost.mjs --json out.json
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function findNewest() {
  const root = join(homedir(), '.dsh', 'sessions')
  if (!existsSync(root)) throw new Error(`no sessions dir at ${root}`)
  let best = null
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.name.endsWith('.zstd')) continue
      const stat = statSync(full)
      if (!best || stat.mtimeMs > best.mtimeMs) best = { path: full, mtimeMs: stat.mtimeMs, size: stat.size }
    }
  }
  walk(root)
  if (!best) throw new Error('no session log found')
  return best
}

function readEvents(file) {
  const buf = readFileSync(file)
  const offsets = []
  for (let i = 0; i <= buf.length - 4; i += 1) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) offsets.push(i)
  }
  const events = []
  let bad = 0
  for (const offset of offsets) {
    try {
      const text = zstdDecompressSync(buf.subarray(offset)).toString('utf8')
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
          events.push(JSON.parse(line))
        } catch {
          bad += 1
        }
      }
    } catch {
      bad += 1
    }
  }
  events.sort((a, b) => (a.seq || 0) - (b.seq || 0))
  return { events, frames: offsets.length, bad }
}

function main() {
  const argv = process.argv.slice(2)
  const jsonIndex = argv.indexOf('--json')
  const out = jsonIndex >= 0 ? argv[jsonIndex + 1] : ''
  const args = argv.filter((_, i) => i !== jsonIndex && i !== jsonIndex + 1)
  const target = args[0]
  let file = ''
  let size = 0
  let mtimeMs = 0
  if (target) {
    const stat = statSync(target)
    if (stat.isDirectory()) {
      const candidate = join(target, 'session.v4.jsonl.zstd')
      file = candidate
      size = statSync(candidate).size
      mtimeMs = statSync(candidate).mtimeMs
    } else {
      file = target
      size = stat.size
      mtimeMs = stat.mtimeMs
    }
  } else {
    const newest = findNewest()
    file = newest.path
    size = newest.size
    mtimeMs = newest.mtimeMs
  }

  const { events, frames, bad } = readEvents(file)
  const usageKeys = new Set()
  let input = 0
  let cacheRead = 0
  let cacheWrite = 0
  let output = 0
  let requests = 0
  const perRequest = []
  const toolTotals = new Map()
  const pendingCalls = []
  const pending = { results: 0, textChars: 0, images: 0 }
  let firstTime = null
  let lastTime = null

  for (const event of events) {
    if (event.time) {
      if (firstTime === null) firstTime = event.time
      lastTime = event.time
    }
    if (event.type === 'tool/call') {
      pendingCalls.push({ name: event.data?.name || '?', argsLen: typeof event.data?.arguments === 'string' ? event.data.arguments.length : 0 })
      continue
    }
    if (event.type === 'tool/result') {
      pending.results += 1
      for (const block of event.data?.message?.content || []) {
        if (block?.type === 'text' && typeof block.text === 'string') pending.textChars += block.text.length
        if (block?.type === 'image') pending.images += 1
      }
      continue
    }
    if (event.type === 'assistant/message') {
      const usage = event.data?.usage || {}
      for (const key of Object.keys(usage)) usageKeys.add(key)
      const inTok = Number(usage.inputTokens) || 0
      const cr = Number(usage.cacheReadTokens) || 0
      const cw = Number(usage.cacheWriteTokens) || 0
      const outTok = Number(usage.outputTokens) || 0
      input += inTok
      cacheRead += cr
      cacheWrite += cw
      output += outTok
      requests += 1
      const calls = pendingCalls.splice(0)
      for (const call of calls) {
        const entry = toolTotals.get(call.name) || { calls: 0, argsChars: 0 }
        entry.calls += 1
        entry.argsChars += call.argsLen
        toolTotals.set(call.name, entry)
      }
      perRequest.push({
        seq: event.seq,
        time: event.time,
        input: inTok,
        cacheRead: cr,
        cacheWrite: cw,
        output: outTok,
        total: inTok + cr + cw + outTok,
        tools: calls.map((call) => call.name),
        results: pending.results,
        resultChars: pending.textChars,
        images: pending.images,
      })
      pending.results = 0
      pending.textChars = 0
      pending.images = 0
    }
  }

  const totalIn = input + cacheRead + cacheWrite
  const grand = totalIn + output
  const top = [...perRequest].sort((a, b) => b.total - a.total).slice(0, 10)
  const toolRows = [...toolTotals.entries()].sort((a, b) => b[1].calls - a[1].calls)
  const resultCharsByTool = new Map()
  for (const row of perRequest) {
    const per = Math.round(row.resultChars / Math.max(1, row.results))
    for (const name of new Set(row.tools)) {
      const entry = resultCharsByTool.get(name) || { results: 0, chars: 0, images: 0 }
      entry.results += 1
      entry.chars += per
      entry.images += row.images
      resultCharsByTool.set(name, entry)
    }
  }

  const GUI_RE = /^(hands_|screen_|mouse_|stroke_|audit_tail|click_matrix|clipboard_|type_text|press_keys)/
  const guiRequests = perRequest.filter((row) => row.tools.some((name) => GUI_RE.test(name)))
  const guiTokens = guiRequests.reduce((sum, row) => sum + row.total, 0)
  const guiImages = guiRequests.reduce((sum, row) => sum + row.images, 0)
  const report = {
    file,
    sizeMB: Number((size / (1024 * 1024)).toFixed(2)),
    mtime: new Date(mtimeMs).toISOString(),
    frames,
    badLines: bad,
    events: events.length,
    timeSpanMinutes: firstTime && lastTime ? Number((((lastTime - firstTime) / 60000) || 0).toFixed(1)) : null,
    usageKeys: [...usageKeys],
    requests,
    tokens: {
      inputUncached: input,
      cacheRead,
      cacheWrite,
      output,
      totalInput: totalIn,
      grandTotal: grand,
      perRequestMean: requests ? Math.round(grand / requests) : 0,
    },
    guiPhase: {
      requests: guiRequests.length,
      tokens: guiTokens,
      shareOfSession: grand ? Number(((guiTokens / grand) * 100).toFixed(1)) : 0,
      images: guiImages,
    },
    tools: toolRows.map(([name, entry]) => ({
      name,
      calls: entry.calls,
      avgArgChars: Math.round(entry.argsChars / Math.max(1, entry.calls)),
      results: resultCharsByTool.get(name)?.results || 0,
      approxResultChars: resultCharsByTool.get(name)?.chars || 0,
      images: resultCharsByTool.get(name)?.images || 0,
    })),
    mostExpensiveRequests: top.map((row) => ({
      seq: row.seq,
      total: row.total,
      input: row.input,
      cacheRead: row.cacheRead,
      output: row.output,
      tools: row.tools,
      images: row.images,
    })),
  }

  console.log(`session: ${report.file}`)
  console.log(`size=${report.sizeMB} MB  frames=${frames}  events=${report.events}  requests=${requests}  span=${report.timeSpanMinutes} min`)
  console.log(`usage keys: ${report.usageKeys.join(',') || '(none)'}`)
  console.log('')
  console.log(`INPUT   uncached=${input.toLocaleString()}  cacheRead=${cacheRead.toLocaleString()}  cacheWrite=${cacheWrite.toLocaleString()}  → ${totalIn.toLocaleString()}`)
  console.log(`OUTPUT  ${output.toLocaleString()}`)
  console.log(`TOTAL   ${grand.toLocaleString()} tokens over ${requests} requests (mean ${report.tokens.perRequestMean.toLocaleString()}/request)`)
  console.log('')
  console.log(`GUI test phase (requests touching hands_*/screen_*/mouse_*): ${guiRequests.length} requests, ${guiTokens.toLocaleString()} tokens (${report.guiPhase.shareOfSession}% of the session), ${guiImages} images`)
  console.log('top tools (calls / avg arg chars / result text chars / images):')
  for (const row of report.tools.slice(0, 12)) {
    console.log(`  ${row.name.padEnd(16)} ${String(row.calls).padStart(4)}  args≈${String(row.avgArgChars).padStart(5)}  result≈${String(row.approxResultChars).padStart(7)}  imgs=${row.images}`)
  }
  console.log('')
  console.log('most expensive requests:')
  for (const row of report.mostExpensiveRequests) {
    console.log(`  seq=${String(row.seq).padStart(5)} total=${String(row.total).padStart(7)} in=${String(row.input).padStart(6)} cache=${String(row.cacheRead).padStart(7)} out=${String(row.output).padStart(5)} tools=${row.tools.join(',') || '-'}`)
  }
  if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

main()
