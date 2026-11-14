/**
 * Small shared helpers. No host imports, so every module here also runs under a
 * bare `node` for tests.
 */
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Data root: env override, then <DSH_HOME>/dexter, then ~/.dsh/dexter. */
export function dataDir() {
  const override = process.env.DSH_DEXTER_DATA_DIR
  if (typeof override === 'string' && override.trim() !== '') return override.trim()
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(home, 'dexter')
}

export function auditPath() {
  return join(dataDir(), 'audit', 'hands.jsonl')
}

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex')
}

/** Stable JSON: keys sorted, so an args hash never moves because of key order. */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

export function hashArgs(args) {
  return sha256Hex(stableStringify(args ?? {}))
}

export function nowIso(now = Date.now()) {
  return new Date(now).toISOString()
}

export function sleep(ms) {
  // Deliberately NOT unref'd: every caller awaits it, and an unref'd timer lets the
  // process exit mid-await when nothing else holds the loop open.
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms))
  })
}

export function clampInt(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.round(Math.min(max, Math.max(min, n)))
}

export function isNum(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Strings only, bounded: audit rows must never carry a payload dump. */
export function shortText(value, max = 300) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/**
 * Reduce an argument object to what may be persisted: coordinates and enums are
 * kept, free text and clipboard payloads are replaced by their length.
 */
export function redactArgs(args) {
  const source = args && typeof args === 'object' ? args : {}
  const out = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (key === 'text' || key === 'value') {
      out[`${key}Chars`] = typeof value === 'string' ? value.length : 0
      continue
    }
    if (key === 'steps') {
      out.steps = Array.isArray(value) ? value.length : 0
      continue
    }
    if (typeof value === 'string') out[key] = shortText(value, 120)
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) out[key] = value
    else if (Array.isArray(value)) out[key] = value.length
    else if (typeof value === 'object') out[key] = '[object]'
  }
  return out
}
