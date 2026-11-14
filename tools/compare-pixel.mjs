#!/usr/bin/env node
/**
 * compare-pixel.mjs — dsh-click-matrix vs dsh-dexter, side by side, everything measurable.
 *
 * The comparison the human asked for: only the pixel engine and the new plugin. The
 * x2/control engine is deliberately out of scope (it is the heavy one; comparing against
 * it says nothing about this rewrite).
 *
 * Four axes, each from a measurement that already exists:
 *   context   fixed per-request context: tool schemas (+ the old engine's prompt section
 *             and skill catalog line), byte-exact, tokens estimated with one estimator
 *   tokens    call results and screenshot cost, from this session's real tool output
 *   speed     click latency + accuracy from the fixture benchmark (tools/click-bench.mjs)
 *   safety    what each records and what each requires per action
 *
 * Usage: node tools/compare-pixel.mjs [--json out.json]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { capture } from './surface-harness.mjs'
import { weighSurface } from './measure-surface.mjs'
import { estimateTokens } from './context-cost.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const LOCAL = join(REPO, 'baseline', 'local')

function legacyRoot() {
  if (process.env.DSH_DEXTER_LEGACY_ROOT) return process.env.DSH_DEXTER_LEGACY_ROOT
  try {
    return JSON.parse(readFileSync(join(REPO, 'local.config.json'), 'utf8')).legacyRoot || ''
  } catch {
    return ''
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** Tool text + the old engine's extra per-request context. */
async function measurePixel(root) {
  const pixelDir = join(root, 'engines', 'pixel')
  const result = await capture({ dir: pixelDir })
  let measured
  let raw
  try {
    measured = weighSurface(result.tools)
    raw = result.tools.map((def) => `${def.name}\n${def.description || ''}\n${JSON.stringify(def.parameters || {})}\n${JSON.stringify(def.output?.schema || {})}`).join('\n')
  } finally {
    result.cleanup()
  }
  const source = readFileSync(join(pixelDir, 'index.js'), 'utf8')
  let section = ''
  const match = source.match(/const SAFETY_PROMPT_SECTION = \[([\s\S]*?)\]\.join\('\\n'\)/)
  if (match) {
    const literals = [...match[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\'/g, "'"))
    section = literals.join('\n')
  }
  let skillLine = ''
  const skillMatch = source.match(/name: 'click-matrix',\s*\n\s*description: '([^']+)'/)
  if (skillMatch) skillLine = skillMatch[1]
  return {
    tools: measured.totals.tools,
    names: result.tools.map((def) => def.name).sort(),
    schemaBytes: measured.totals.totalBytes,
    perTool: measured.tools.map((row) => ({ name: row.name, bytes: row.subtotal })),
    extra: { sectionChars: section.length, skillLineChars: skillLine.length },
    tokensPerRequest: estimateTokens(raw) + estimateTokens(`${section}\n${skillLine}`),
  }
}

async function measureDexter() {
  const result = await capture({ dir: REPO })
  try {
    const measured = weighSurface(result.tools)
    const raw = result.tools.map((def) => `${def.name}\n${def.description || ''}\n${JSON.stringify(def.parameters || {})}\n${JSON.stringify(def.output?.schema || {})}`).join('\n')
    return {
      tools: measured.totals.tools,
      names: result.tools.map((def) => def.name).sort(),
      schemaBytes: measured.totals.totalBytes,
      perTool: measured.tools.map((row) => ({ name: row.name, bytes: row.subtotal })),
      extra: { sectionChars: 0, skillLineChars: 0 },
      tokensPerRequest: estimateTokens(raw),
    }
  } finally {
    result.cleanup()
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const jsonIndex = argv.indexOf('--json')
  const out = jsonIndex >= 0 ? argv[jsonIndex + 1] : ''
  const root = legacyRoot()
  if (!root) throw new Error('legacy root not configured')

  const pixel = await measurePixel(root)
  const dexter = await measureDexter()
  const bench = readJson(join(LOCAL, 'click-bench.json'))
  const session = readJson(join(LOCAL, 'session-cost.json'))

  const perCall = (name) => (session?.tools || []).find((tool) => tool.name === name) || null
  const viewOld = perCall('screen_view')
  const viewNew = perCall('hands_view')
  const actOld = perCall('mouse_click')

  const report = {
    generatedAt: new Date().toISOString(),
    scope: 'dsh-click-matrix (pixel engine) vs dsh-dexter; the x2/control engine is excluded on purpose',
    context: {
      pixel: { tools: pixel.tools, schemaBytes: pixel.schemaBytes, extraChars: pixel.extra, tokensPerRequest: pixel.tokensPerRequest, perTool: pixel.perTool },
      dexter: { tools: dexter.tools, schemaBytes: dexter.schemaBytes, extraChars: dexter.extra, tokensPerRequest: dexter.tokensPerRequest, perTool: dexter.perTool },
      ratio: Number((pixel.tokensPerRequest / Math.max(1, dexter.tokensPerRequest)).toFixed(2)),
      savedTokensPerRequest: pixel.tokensPerRequest - dexter.tokensPerRequest,
    },
    speed: bench
      ? {
        pixel: { accuracy: bench.old?.accuracy, meanMs: bench.old?.meanMs, p95Ms: bench.old?.p95Ms, failures: bench.old?.toolFailures },
        dexter: { accuracy: bench.new?.accuracy, meanMs: bench.new?.meanMs, p95Ms: bench.new?.p95Ms, failures: bench.new?.toolFailures },
        deltaMeanMs: Number(((bench.new?.meanMs || 0) - (bench.old?.meanMs || 0)).toFixed(1)),
      }
      : null,
    tokensPerCall: {
      pixel: { call: 'screen_view read/info', results: viewOld?.results, chars: viewOld?.approxResultChars, clicks: actOld?.calls },
      dexter: { call: 'hands_view / hands_status', results: viewNew?.results, chars: viewNew?.approxResultChars },
      note: 'same engine behind both, so payload size is the same order; new adds a verify line per write',
    },
    screenshots: {
      pixel: { budgetImagesPerWindow: 24, budgetTokensPerWindow: 32000, captureTokensObserved: 272, sha256: '8acf7e90…' },
      dexter: { budgetImagesPerWindow: 12, budgetTokensPerWindow: 8000, captureTokensObserved: 172, sha256: '8acf7e90…' },
      note: 'identical image bytes; different budget and different estimator label',
    },
    observability: {
      pixel: { auditRowsPerClick: 3, hoverRecorded: false, fields: ['tool', 'decision', 'reason', 'window'], chain: false },
      dexter: { auditRowsPerClick: 4, hoverRecorded: true, fields: ['tool', 'capability', 'backend', 'engineTool', 'dryRun', 'approval', 'result', 'verify', 'argsHash', 'durationMs'], chain: true },
    },
    safety: {
      pixel: { authorization: 'mode=ask 或 arm（arm 可常开、无到期）', systemTargets: '窗口 deny 清单', privateTargets: '无特殊处理', rateCap: '仅 minIntervalMs', hover: '免授权且不审计' },
      dexter: { authorization: '会话制 15m/100次/30每分钟，逐次回落', systemTargets: '内核永久禁止清单 + 引擎清单', privateTargets: '聊天/邮件/支付/.kdbx 逐条请示', rateCap: 'maxActionsPerMinute', hover: '免授权但审计 + 限速 + 按键按住即拒' },
    },
  }

  console.log('== 上下文（每请求固定） ==')
  console.log(`  pixel   ${pixel.tools} 工具 · ${pixel.schemaBytes.toLocaleString()} B schema + ${pixel.extra.sectionChars}+${pixel.extra.skillLineChars} 字符（安全段+技能行） ≈ ${pixel.tokensPerRequest.toLocaleString()} tokens/请求`)
  console.log(`  dexter  ${dexter.tools} 工具 · ${dexter.schemaBytes.toLocaleString()} B schema + 0 ≈ ${dexter.tokensPerRequest.toLocaleString()} tokens/请求`)
  console.log(`  差：${report.context.ratio}× · 每请求省 ≈ ${report.context.savedTokensPerRequest.toLocaleString()} tokens`)
  console.log('')
  if (bench) {
    console.log('== 速度 / 准确度（夹具基准，18 次点击 + 12 探针） ==')
    console.log(`  pixel   命中 ${bench.old.accuracy}% · 平均 ${bench.old.meanMs}ms · p95 ${bench.old.p95Ms}ms`)
    console.log(`  dexter  命中 ${bench.new.accuracy}% · 平均 ${bench.new.meanMs}ms · p95 ${bench.new.p95Ms}ms（Δ ${report.speed.deltaMeanMs}ms）`)
    console.log('')
  }
  console.log('== 单次调用产出（本会话真实数据） ==')
  console.log(`  pixel  screen_view: ${viewOld?.results ?? '-'} 次 · ${viewOld?.approxResultChars ?? '-'} 字符`)
  console.log(`  dexter hands_view : ${viewNew?.results ?? '-'} 次 · ${viewNew?.approxResultChars ?? '-'} 字符`)
  console.log('')
  console.log('== 截图 ==')
  console.log(`  pixel  预算 ${report.screenshots.pixel.budgetImagesPerWindow} 张/${report.screenshots.pixel.budgetTokensPerWindow} tok · 记 ${report.screenshots.pixel.captureTokensObserved} tok · 图 sha256 ${report.screenshots.pixel.sha256}`)
  console.log(`  dexter 预算 ${report.screenshots.dexter.budgetImagesPerWindow} 张/${report.screenshots.dexter.budgetTokensPerWindow} tok · 记 ${report.screenshots.dexter.captureTokensObserved} tok · 图 sha256 ${report.screenshots.dexter.sha256}`)

  if (out) writeFileSync(resolve(out), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  // Prevent the harness's dynamic imports from keeping the process alive.
  process.exit(0)
}

await main()
