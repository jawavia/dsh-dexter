#!/usr/bin/env node
/**
 * context-cost.mjs — how much context does each plugin inject, and what does that cost?
 *
 * Three sources of per-request context differ between the two bundles:
 *
 *   1. tool schemas      (name + description + parameter JSON + output schema) — paid on
 *                        every request, in the cached prefix
 *   2. system prompt     the old pixel engine registers a safety section; dsh-dexter
 *      section           registers none
 *   3. skill catalog     the old bundle registers a `click-matrix` skill (its one-line
 *                        catalog entry is in every request; the SKILL.md body is only
 *                        loaded when the model opens it). dsh-dexter registers none
 *
 * Bytes are exact (measured from the definitions). Token counts are estimates with a
 * stated ratio — ~1.5 CJK characters per token, ~4 ASCII characters per token, which is
 * the usual order of magnitude for Chinese-heavy prompts; both sides use the same
 * estimator, so the comparison is consistent even if the absolute figure is ±20 %.
 *
 * Usage: node tools/context-cost.mjs [--requests 591] [--json out.json]
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { weighSurface } from './measure-surface.mjs'
import { capture } from './surface-harness.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')

const CJK = /[\u3000-\u9fff\uff00-\uffef]/g
const CJK_PER_TOKEN = 1.5
const ASCII_PER_TOKEN = 4

export function estimateTokens(text) {
  const value = String(text || '')
  const cjk = (value.match(CJK) || []).length
  const rest = value.length - cjk
  return Math.round(cjk / CJK_PER_TOKEN + rest / ASCII_PER_TOKEN)
}

function legacyRoot() {
  if (process.env.DSH_DEXTER_LEGACY_ROOT) return process.env.DSH_DEXTER_LEGACY_ROOT
  try {
    return JSON.parse(readFileSync(join(REPO, 'local.config.json'), 'utf8')).legacyRoot || ''
  } catch {
    return ''
  }
}

/** The old engine's extra context: safety prompt section + skill catalog line. */
function legacyExtras(root) {
  const indexSource = readFileSync(join(root, 'engines', 'pixel', 'index.js'), 'utf8')
  let section = ''
  const sectionMatch = indexSource.match(/const SAFETY_PROMPT_SECTION = \[([\s\S]*?)\]\.join\('\\n'\)/)
  if (sectionMatch) {
    // The block is a JS array of single-quoted strings; evaluate it in isolation.
    try {
      const literals = [...sectionMatch[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\'/g, "'"))
      section = literals.join('\n')
    } catch {
      section = ''
    }
  }
  let skillLine = ''
  const skillMatch = indexSource.match(/name: 'click-matrix',\s*\n\s*description: '([^']+)'/)
  if (skillMatch) skillLine = skillMatch[1]
  let skillBodyBytes = 0
  try {
    skillBodyBytes = readFileSync(join(root, 'engines', 'pixel', 'skills', 'click-matrix', 'SKILL.md')).length
  } catch { /* skill file optional */ }
  return { section, skillLine, skillBodyBytes }
}

async function surfaceOf(runner) {
  const result = await runner()
  try {
    const measured = weighSurface(result.tools)
    const raw = result.tools.map((def) => {
      const description = typeof def.description === 'string' ? def.description : ''
      const parameters = def.parameters && typeof def.parameters === 'object' ? def.parameters : {}
      const output = def.output && def.output.schema ? def.output.schema : {}
      return `${def.name}\n${description}\n${JSON.stringify(parameters)}\n${JSON.stringify(output)}`
    }).join('\n')
    return { measured, raw }
  } finally {
    result.cleanup()
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const requestsIndex = argv.indexOf('--requests')
  const requests = requestsIndex >= 0 ? Number(argv[requestsIndex + 1]) || 591 : 591
  const jsonIndex = argv.indexOf('--json')
  const out = jsonIndex >= 0 ? argv[jsonIndex + 1] : ''

  const root = legacyRoot()
  if (!root) throw new Error('legacy root not configured')

  const oldEngines = [
    ['pixel', join(root, 'engines', 'pixel'), 'index.js', {}],
    ['control', join(root, 'engines', 'control'), 'src/index.js', { hotkeyArm: false, overlayWarm: false }],
    ['stroke', join(root, 'engines', 'stroke'), 'index.js', {}],
  ]
  const oldParts = []
  let oldTools = 0
  let oldBytes = 0
  let oldRaw = ''
  for (const [name, dir, entry, config] of oldEngines) {
    const part = await surfaceOf(() => capture({ dir, entry, config }))
    oldParts.push({ engine: name, tools: part.measured.totals.tools, bytes: part.measured.totals.totalBytes })
    oldTools += part.measured.totals.tools
    oldBytes += part.measured.totals.totalBytes
    oldRaw += `${part.raw}\n`
  }

  const newPart = await surfaceOf(() => capture({ dir: REPO }))
  const newTools = newPart.measured.totals.tools
  const newBytes = newPart.measured.totals.totalBytes

  const extras = legacyExtras(root)
  const oldExtraBytes = Buffer.byteLength(extras.section, 'utf8') + Buffer.byteLength(extras.skillLine, 'utf8')
  const oldExtraRaw = `${extras.section}\n${extras.skillLine}`

  const oldTokens =
    estimateTokens(oldRaw) + estimateTokens(oldExtraRaw)
  const newTokens = estimateTokens(newPart.raw)

  const report = {
    generatedAt: new Date().toISOString(),
    requests,
    estimator: { cjkCharsPerToken: CJK_PER_TOKEN, asciiCharsPerToken: ASCII_PER_TOKEN, note: 'both sides use the same estimator; absolute values ±20 %' },
    old: {
      label: 'dsh-desktop-hands 0.2.6 (pixel + control + stroke)',
      tools: oldTools,
      engines: oldParts,
      schemaBytes: oldBytes,
      extraBytes: oldExtraBytes,
      extra: {
        systemPromptSectionChars: extras.section.length,
        skillCatalogLineChars: extras.skillLine.length,
        skillBodyBytesOnDemand: extras.skillBodyBytes,
      },
      tokensPerRequest: oldTokens,
      tokensOverSession: oldTokens * requests,
    },
    new: {
      label: 'dsh-dexter 0.10.0 (kernel + adapters)',
      tools: newTools,
      schemaBytes: newBytes,
      extraBytes: 0,
      tokensPerRequest: newTokens,
      tokensOverSession: newTokens * requests,
    },
  }
  report.delta = {
    tools: report.new.tools - report.old.tools,
    schemaBytes: report.new.schemaBytes - report.old.schemaBytes,
    tokensPerRequest: report.new.tokensPerRequest - report.old.tokensPerRequest,
    ratio: Number((report.old.tokensPerRequest / Math.max(1, report.new.tokensPerRequest)).toFixed(2)),
    tokensOverSession: report.new.tokensOverSession - report.old.tokensOverSession,
  }

  console.log(`per-request context injected (fixed, before any tool call):`)
  console.log(`  old  ${String(oldTools).padStart(2)} tools · ${oldBytes.toLocaleString()} B schemas + ${oldExtraBytes.toLocaleString()} B (safety prompt ${extras.section.length} chars, skill line ${extras.skillLine.length} chars)`)
  console.log(`       ≈ ${oldTokens.toLocaleString()} tokens/request → ${report.old.tokensOverSession.toLocaleString()} tokens over ${requests} requests`)
  console.log(`  new  ${String(newTools).padStart(2)} tools · ${newBytes.toLocaleString()} B schemas + 0 B extra`)
  console.log(`       ≈ ${newTokens.toLocaleString()} tokens/request → ${report.new.tokensOverSession.toLocaleString()} tokens over ${requests} requests`)
  console.log('')
  console.log(`saved: ${report.delta.tools} tools · ${(-report.delta.schemaBytes).toLocaleString()} B · ≈ ${(-report.delta.tokensPerRequest).toLocaleString()} tokens/request (${report.delta.ratio}× smaller) · ≈ ${(-report.delta.tokensOverSession).toLocaleString()} tokens over ${requests} requests`)
  console.log(`the old bundle also carries a ${extras.skillBodyBytes.toLocaleString()} B skill body, loaded only when the model opens the skill`)
  if (out) writeFileSync(resolve(out), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

import { writeFileSync } from 'node:fs'
main()
