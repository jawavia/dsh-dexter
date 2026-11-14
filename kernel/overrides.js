/**
 * Runtime overrides for the three tunable numbers.
 *
 * Why this exists: DSH's settings page renders only *volatile* fields and no shipped client
 * renders a form for them; its config editor refuses to touch a nested include ("HMR
 * transactions cannot be nested"), which is what our row is. So the panel needs a place to
 * put the numbers that does not go through the host's configuration transaction.
 *
 * The file is a plain override layer with a fixed precedence:
 *   panel/runtime override > host config (volatile) > FIELD_SPEC defaults
 *
 * It is validated with the same FIELD_SPEC ranges as everything else, every change is
 * audited, and `hands_status` shows the effective values, so this is a third *layer*, not a
 * second declaration: defaults still live only in kernel/config.js.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fieldSpec } from './config.js'

export const OVERRIDE_KEYS = Object.freeze(['armMinutes', 'armActions', 'maxActionsPerMinute'])

export function overridePath(dataDir) {
  return join(dataDir, 'runtime-overrides.json')
}

/** Read the persisted overrides, dropping keys/ranges that no longer validate. */
export function loadOverrides(dataDir) {
  const file = overridePath(dataDir)
  try {
    if (!existsSync(file)) return {}
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const out = {}
    for (const key of OVERRIDE_KEYS) {
      const spec = fieldSpec(key)
      const value = Number(raw[key])
      if (!spec || !Number.isFinite(value)) continue
      const min = Number.isFinite(spec.min) ? spec.min : 0
      const max = Number.isFinite(spec.max) ? spec.max : Number.MAX_SAFE_INTEGER
      if (value < min || value > max) continue
      out[key] = Math.round(value)
    }
    return out
  } catch {
    return {}
  }
}

/** Persist overrides atomically enough for a single writer (the plugin). */
export function saveOverrides(dataDir, overrides) {
  const file = overridePath(dataDir)
  try {
    mkdirSync(dataDir, { recursive: true })
    const payload = {}
    for (const key of OVERRIDE_KEYS) {
      if (Number.isFinite(Number(overrides[key]))) payload[key] = Math.round(Number(overrides[key]))
    }
    writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    return { ok: true, path: file }
  } catch (error) {
    return { ok: false, reason: error && error.message ? error.message : String(error) }
  }
}

/** Clamp one value into its field range; returns null when the key is not an override key. */
export function clampOverride(key, value) {
  if (!OVERRIDE_KEYS.includes(key)) return null
  const spec = fieldSpec(key)
  if (!spec) return null
  const min = Number.isFinite(spec.min) ? spec.min : 0
  const max = Number.isFinite(spec.max) ? spec.max : Number.MAX_SAFE_INTEGER
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return null
  return Math.min(max, Math.max(min, Math.round(numeric)))
}
