/**
 * Key-combo parsing for the human hotkeys.
 *
 * The defaults are fine on most machines, but a global combo is first-come-first-served:
 * on this machine `Ctrl+Alt+F10` was already owned by another application, which made the
 * "extend" key dead with no explanation. So the four combos are configuration, parsed
 * here into the key names the poller and the probe understand.
 */

export const DEFAULT_COMBOS = Object.freeze({
  arm: ['ctrl', 'alt', 'f12'],
  extend: ['ctrl', 'alt', 'f10'],
  stop: ['ctrl', 'alt', 'f11'],
  softStop: ['ctrl', 'shift', 'f11'],
})

const MODIFIERS = new Set(['ctrl', 'control', 'alt', 'shift', 'win', 'lwin', 'rwin'])

function normalise(key) {
  const value = String(key || '').trim().toLowerCase()
  if (value === 'control') return 'ctrl'
  return value
}

/** `"ctrl+alt+f12"` → `['ctrl','alt','f12']`; an unparsable value falls back. */
export function parseCombo(text, fallback = []) {
  if (typeof text !== 'string' || text.trim() === '') return [...fallback]
  const keys = text
    .split('+')
    .map(normalise)
    .filter((key) => key !== '')
    .filter((key) => MODIFIERS.has(key) || /^(f([1-9]|1[0-9]|2[0-4])|[a-z0-9])$/.test(key))
  if (keys.length === 0) return [...fallback]
  // The last key must not be a modifier on its own.
  if (MODIFIERS.has(keys[keys.length - 1])) return [...fallback]
  return keys
}

/** Build the four combos from the config, each falling back to its default. */
export function combosFromConfig(config = {}) {
  return {
    arm: parseCombo(config.armHotkey, DEFAULT_COMBOS.arm),
    extend: parseCombo(config.extendHotkey, DEFAULT_COMBOS.extend),
    stop: parseCombo(config.stopHotkey, DEFAULT_COMBOS.stop),
    softStop: parseCombo(config.softStopHotkey, DEFAULT_COMBOS.softStop),
  }
}

export function comboLabel(keys) {
  return (keys || []).map((key) => key.toUpperCase()).join('+')
}
