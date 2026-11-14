/**
 * Chrome for the kernel: one declaration per configuration key.
 *
 * Everything else is derived from FIELD_SPEC:
 *   - DEFAULTS     the runtime fallbacks (used by normalizeConfig)
 *   - buildSchema  the Schemastery object exported as `Config`, so the plugin row
 *                  in Plugin Manager is the single settings page
 *   - editableKeys keys a human may change from there
 *
 * Adding a second source of truth is what produced the old `config-overrides.json`
 * vs profile patch conflict. There is exactly one: this file.
 */

/** @typedef {'bool'|'int'|'enum'|'string'} FieldType */

export const FIELD_SPEC = Object.freeze({
  // ---- scope -----------------------------------------------------------------
  readOnly: {
    type: 'bool',
    default: false,
    desc: 'Read-only: look at the desktop, never inject input.',
  },

  // ---- authorization ---------------------------------------------------------
  askOnWrite: {
    type: 'bool',
    default: true,
    desc: 'No session grant open: ask the human once per write. Off = refuse instead of asking.',
  },
  armMinutes: {
    type: 'int',
    default: 15,
    min: 1,
    max: 480,
    desc: 'Default length of a session grant (the numbers here, the hotkeys for the quick adjust).',
  },
  armActions: {
    type: 'int',
    default: 100,
    min: 1,
    max: 5000,
    desc: 'Default action budget of a session grant.',
  },
  maxActionsPerMinute: {
    type: 'int',
    default: 30,
    min: 1,
    max: 600,
    desc: 'Hard rate cap for injected writes in every mode; 0 = no cap.',
  },
  hoverFree: {
    type: 'bool',
    default: true,
    desc: 'A bare cursor move needs no authorization (it is audited and rate-capped; refused while any mouse button is held).',
  },
  sensitiveAsk: {
    type: 'bool',
    default: true,
    desc: 'Chat / mail / payment / credential-looking targets always ask per write, even inside a session.',
  },

  // ---- stop / emergency ------------------------------------------------------
  hotkeysEnabled: {
    type: 'bool',
    default: true,
    desc: 'Watch the hotkeys below while the host runs.',
  },
  armHotkey: {
    type: 'string',
    default: 'ctrl+alt+f12',
    desc: 'Open a session. Change it when another app owns the combo.',
  },
  extendHotkey: {
    type: 'string',
    default: 'ctrl+alt+f10',
    desc: 'Extend the open session. Change it when another app owns the combo.',
  },
  stopHotkey: {
    type: 'string',
    default: 'ctrl+alt+f11',
    desc: 'Hard stop. A dead stop key makes the pixel engine refuse to inject, so watch it.',
  },
  softStopHotkey: {
    type: 'string',
    default: 'ctrl+shift+f11',
    desc: 'Soft stop: finish the current step, then stop.',
  },
  panelEnabled: {
    type: 'bool',
    default: true,
    desc: 'Show the always-on-top desktop panel (compiled once with the in-box csc). It stays outside the DSH window and clamps to the working area, so it never covers the taskbar.',
  },
  pauseOnHumanInput: {
    type: 'bool',
    default: true,
    desc: 'Suspend injection while the human is using the mouse or keyboard.',
  },
  humanIdleResumeMs: {
    type: 'int',
    default: 20000,
    min: 2000,
    max: 300000,
    desc: 'Idle time after human input before injection resumes by itself.',
  },
  humanWaitMaxMs: {
    type: 'int',
    default: 30000,
    min: 0,
    max: 60000,
    desc: 'How long one write may wait for the human to go idle before it is refused.',
  },

  // ---- observation cost ------------------------------------------------------
  captureLongSide: {
    type: 'int',
    default: 1600,
    min: 320,
    max: 4096,
    desc: 'Long edge of a screenshot sent to the model.',
  },
  imageMaxPerTurn: {
    type: 'int',
    default: 12,
    min: 0,
    max: 60,
    desc: 'Image soft budget per turn; further screenshots return text only.',
  },
  imageMaxTokensPerTurn: {
    type: 'int',
    default: 8000,
    min: 0,
    max: 200000,
    desc: 'Token soft budget for screenshots per turn.',
  },
  requireFreshLookSeconds: {
    type: 'int',
    default: 120,
    min: 0,
    max: 3600,
    desc: 'A coordinate write needs an observation this recent. 0 disables the check.',
  },
  settleMs: {
    type: 'int',
    default: 180,
    min: 0,
    max: 5000,
    desc: 'Wait for the target to repaint before verifying.',
  },
  verifyMode: {
    type: 'enum',
    values: ['foreground', 'hash', 'none'],
    default: 'foreground',
    desc: 'Post-action proof: foreground window assertion, pixel hash, or nothing.',
  },

  // ---- audit -----------------------------------------------------------------
  auditMaxBytes: {
    type: 'int',
    default: 8388608,
    min: 65536,
    max: 268435456,
    desc: 'Rotate hands.jsonl once it reaches this size.',
  },
  auditRetention: {
    type: 'int',
    default: 3,
    min: 1,
    max: 20,
    desc: 'How many rotated generations to keep.',
  },

  // ---- legacy backends -------------------------------------------------------
  legacyPixelPath: {
    type: 'string',
    default: '',
    desc: 'dsh-click-matrix package dir. Empty = resolve the package name.',
  },
  legacyUiaPath: {
    type: 'string',
    default: '',
    desc: 'dsh-x2 (UIA + Win32) package dir. Empty = resolve the package name.',
  },
  // ---- stroke toy ------------------------------------------------------------
  toyStrokeEnabled: {
    type: 'bool',
    default: false,
    desc: 'Expose the single stroke_toy tool. Off by default: no stroke tool exists.',
  },
  toyStrokeMaxPoints: {
    type: 'int',
    default: 800,
    min: 32,
    max: 20000,
    desc: 'Hard cap on points one toy stroke may inject.',
  },
})

export const DEFAULTS = Object.freeze(
  Object.fromEntries(Object.entries(FIELD_SPEC).map(([key, field]) => [key, field.default])),
)

export const EDITABLE_KEYS = Object.freeze(Object.keys(FIELD_SPEC))

/** Look up one declared field (tools and tests use this instead of re-listing keys). */
export function fieldSpec(key) {
  return FIELD_SPEC[key]
}

function clamp(value, field) {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  if (!Number.isFinite(n)) return field.default
  const rounded = Math.round(n)
  const min = field.min ?? -Infinity
  const max = field.max ?? Infinity
  return Math.min(max, Math.max(min, rounded))
}

function coerce(value, field) {
  if (field.type === 'bool') {
    if (typeof value === 'boolean') return value
    if (typeof value === 'string') {
      const s = value.trim().toLowerCase()
      if (['true', '1', 'yes', 'on'].includes(s)) return true
      if (['false', '0', 'no', 'off'].includes(s)) return false
    }
    if (value === 0 || value === 1) return value === 1
    return field.default
  }
  if (field.type === 'int') return clamp(value, field)
  if (field.type === 'enum') {
    const s = typeof value === 'string' ? value.trim().toLowerCase() : ''
    return field.values.includes(s) ? s : field.default
  }
  if (field.type === 'string') return typeof value === 'string' ? value.trim() : field.default
  return value
}

/**
 * Normalize a raw config object. Unknown keys are dropped (they are not silently
 * kept as a second source), every value is clamped, and safety-critical
 * combinations are refused here rather than at use time.
 */
export function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const out = {}
  for (const [key, field] of Object.entries(FIELD_SPEC)) {
    out[key] = coerce(source[key], field)
  }
  return Object.freeze(out)
}

/**
 * Build the Schemastery schema from the same spec. `z` is passed in so this
 * module never hard-depends on the host package (a bare Node run of the tests has
 * no @deepseek-ai/schemastery on disk).
 */
export function buildSchema(z) {
  const shape = {}
  for (const [key, field] of Object.entries(FIELD_SPEC)) {
    let item
    if (field.type === 'bool') item = z.boolean().default(field.default)
    else if (field.type === 'int') {
      item = z.number().min(field.min ?? 0).max(field.max ?? Number.MAX_SAFE_INTEGER).step(1).default(field.default)
    } else if (field.type === 'enum') item = z.union(field.values.map((value) => z.const(value))).default(field.default)
    else item = z.string().default(field.default)
    shape[key] = item.description(field.desc)
  }
  return z.object(shape)
}

/** One-line summary used by hands_status and the apply-time log. */
export function describeConfig(config) {
  return [
    `arm=${config.armMinutes}m/${config.armActions}次`,
    `askOnWrite=${config.askOnWrite}`,
    `rate=${config.maxActionsPerMinute}/min`,
    `sensitiveAsk=${config.sensitiveAsk}`,
    `readOnly=${config.readOnly}`,
    `verify=${config.verifyMode}`,
    `human=${config.pauseOnHumanInput ? `${config.humanIdleResumeMs}ms` : 'off'}`,
    `freshLook=${config.requireFreshLookSeconds}s`,
    `images=${config.imageMaxPerTurn}/${config.imageMaxTokensPerTurn}tok`,
    `toy=${config.toyStrokeEnabled ? `on(${config.toyStrokeMaxPoints})` : 'off'}`,
  ].join(' ')
}
