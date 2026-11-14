/**
 * dsh-click-matrix — plugin config defaults + validation/clamping.
 *
 * Config is a plain flat object coming from the bundle patch row (`config:`).
 * Unknown fields are ignored; every known field is validated and clamped so a
 * typo in the profile can never produce an unusable safety configuration.
 * There is deliberately no schemastery export.
 */

export const DEFAULTS = Object.freeze({
  mode: 'ask',
  lattice: 'standard',
  binning: 'target',
  captureLongSide: 1600,
  overlayMode: 'auto',
  armWindowMs: 25000,
  armClicks: 10,
  hotkeyArmMs: 60000,
  maxImagesPerTurn: 12,
  maxImageTokensPerTurn: 6000,
  minIntervalMs: 150,
  denyProcesses: [],
  denyTitleContains: [],
  // 三层 ACL（v0.2.x）：放行 / 拒绝 / 申请。
  // 优先级：拒绝 > 放行 > 申请 > 默认。拒绝=拦；放行=豁免「申请」；申请=需人类确认。
  // 内置安全清单永远最高优先，放行盖不过它。
  allowProcesses: [],
  allowTitleContains: [],
  askProcesses: [],
  askTitleContains: [],
  auditMaxBytes: 2097152,
  helperTimeoutMs: 20000,
  uiaTimeoutMs: 4000,
  // v0.2 — keyboard / clipboard exposure, batches, human-takeover pause, pill.
  enableKeyboard: true,
  enableClipboard: true,
  batchMaxActions: 20,
  pauseOnHumanInput: true,
  pillOnArm: true,
  // v0.9.5 (P4) / I2：读侧合并开关。**默认 true（合并态）**，工具面与它强相关：
  //   true（默认）= 不注册旧 10 个（7 读 + 3 窗口），只留 screen_view → pixel 14 个工具
  //                  （全包 25；装完即兑现描述 token 缩减，不需要写 config-overrides + 重启）；
  //   false        = 旧 10 个与 screen_view 并存 → pixel 24 个工具（全包 35），
  //                  这是**回退路径**：显式写 mergeReadSide: false 即可回到旧工具面。
  // 改完需重启 DSH 才生效（工具定义只在 apply() 时构建一次）。
  mergeReadSide: true,
  waitDefaultTimeoutMs: 5000,
  waitStableMs: 400,
  // v0.3 — keep-on latch, human-activity suspension with idle auto-resume.
  armDefaultSeconds: 60,
  humanIdleResumeMs: 20000,
  autoResumeHumanActivity: true,
  // v0.4 — human-activity internal wait + scoped allowSelf (own-window exception).
  humanWaitMaxMs: 30000,
  allowSelfWindow: false,
  allowSelfRect: null,
  allowSelfMaxMs: 120000,
  // v1.4: how many rotated audit files to keep (total disk <= maxBytes*(N+1)).
  auditRetentionFiles: 5,
  // v1.1 (D-08): refuse to arm/inject when Ctrl+Alt+F11 is not registered.
  // The env override exists ONLY for the pseudo-host test rig; never set it in
  // a real profile.
  // v1.2 (D-08b): TEST-ONLY bypass. When false the host refuses latched (arm on)
  // authorization, audits every arm with unsafe-bypass, and reports degraded in
  // status. Never set this in a real profile.
  requireAbortHotkey: process.env.DSH_CLICK_MATRIX_REQUIRE_ABORT_HOTKEY === "0" ? false : true,
})

const MODES = ['off', 'ask', 'auto']
const LATTICES = ['coarse', 'standard', 'fine', 'micro']
const BINNINGS = ['target', '2', '4', '6', '8']
const OVERLAY = ['auto', 'on', 'off']

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function intIn(v, lo, hi, fallback) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.round(Math.min(hi, Math.max(lo, n)))
}

function boolIn(v, fallback) {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    if (['true', '1', 'yes', 'on'].includes(s)) return true
    if (['false', '0', 'no', 'off'].includes(s)) return false
  }
  if (typeof v === 'number' && (v === 0 || v === 1)) return v === 1
  return fallback
}

function oneOf(v, allowed, fallback) {
  if (typeof v !== 'string') return fallback
  const s = v.trim().toLowerCase()
  return allowed.includes(s) ? s : fallback
}

/**
 * 归一化矩形 {x,y,w,h}：x/y 非负整数、w/h 为正整数（兼容 width/height 别名）。
 * 任何不合法输入一律返回 null（调用方 fail-closed），合法时返回冻结的规范对象。
 * allowSelfRect（配置）与 AccessGate.selfAllowArm（人类命令）共用此校验。
 */
export function normalizeRect(v) {
  if (!isObject(v)) return null
  const num = (val) => {
    if (typeof val === 'number') return Number.isFinite(val) ? val : NaN
    if (typeof val === 'string' && val.trim() !== '') return Number(val)
    return NaN
  }
  const x = num(v.x)
  const y = num(v.y)
  const w = num(v.w ?? v.width)
  const h = num(v.h ?? v.height)
  if (![x, y, w, h].every((n) => Number.isInteger(n))) return null
  if (x < 0 || y < 0 || w <= 0 || h <= 0) return null
  return Object.freeze({ x, y, w, h })
}

/** Normalize a string list (deny lists): trim, drop empties, lowercase-preserve original text. */
function stringList(v, max = 100) {
  if (!Array.isArray(v)) return []
  const out = []
  for (const item of v) {
    if (typeof item !== 'string') continue
    const s = item.trim()
    if (s === '') continue
    if (out.some((x) => x.toLowerCase() === s.toLowerCase())) continue
    out.push(s)
    if (out.length >= max) break
  }
  return out
}

/**
 * Merge user config over the defaults and clamp every field.
 * @param {unknown} raw config object from the bundle patch row
 * @returns {typeof DEFAULTS}
 */
export function normalizeConfig(raw) {
  const c = isObject(raw) ? raw : {}
  const d = DEFAULTS
  return Object.freeze({
    mode: oneOf(c.mode, MODES, d.mode),
    lattice: oneOf(c.lattice, LATTICES, d.lattice),
    binning: oneOf(c.binning, BINNINGS, d.binning),
    captureLongSide: intIn(c.captureLongSide, 320, 4096, d.captureLongSide),
    overlayMode: oneOf(c.overlayMode, OVERLAY, d.overlayMode),
    armWindowMs: intIn(c.armWindowMs, 1000, 300000, d.armWindowMs),
    armClicks: intIn(c.armClicks, 1, 100, d.armClicks),
    hotkeyArmMs: intIn(c.hotkeyArmMs, 5000, 600000, d.hotkeyArmMs),
    maxImagesPerTurn: intIn(c.maxImagesPerTurn, 0, 60, d.maxImagesPerTurn),
    maxImageTokensPerTurn: intIn(c.maxImageTokensPerTurn, 0, 200000, d.maxImageTokensPerTurn),
    minIntervalMs: intIn(c.minIntervalMs, 0, 5000, d.minIntervalMs),
    denyProcesses: Object.freeze(stringList(c.denyProcesses)),
    denyTitleContains: Object.freeze(stringList(c.denyTitleContains)),
    allowProcesses: Object.freeze(stringList(c.allowProcesses)),
    allowTitleContains: Object.freeze(stringList(c.allowTitleContains)),
    askProcesses: Object.freeze(stringList(c.askProcesses)),
    askTitleContains: Object.freeze(stringList(c.askTitleContains)),
    auditMaxBytes: intIn(c.auditMaxBytes, 65536, 64 * 1024 * 1024, d.auditMaxBytes),
    helperTimeoutMs: intIn(c.helperTimeoutMs, 1000, 120000, d.helperTimeoutMs),
    uiaTimeoutMs: intIn(c.uiaTimeoutMs, 500, 30000, d.uiaTimeoutMs),
    enableKeyboard: boolIn(c.enableKeyboard, d.enableKeyboard),
    enableClipboard: boolIn(c.enableClipboard, d.enableClipboard),
    batchMaxActions: intIn(c.batchMaxActions, 1, 50, d.batchMaxActions),
    pauseOnHumanInput: boolIn(c.pauseOnHumanInput, d.pauseOnHumanInput),
    pillOnArm: boolIn(c.pillOnArm, d.pillOnArm),
    mergeReadSide: boolIn(c.mergeReadSide, d.mergeReadSide),
    waitDefaultTimeoutMs: intIn(c.waitDefaultTimeoutMs, 200, 30000, d.waitDefaultTimeoutMs),
    waitStableMs: intIn(c.waitStableMs, 50, 5000, d.waitStableMs),
    armDefaultSeconds: intIn(c.armDefaultSeconds, 10, 86400, d.armDefaultSeconds),
    humanIdleResumeMs: intIn(c.humanIdleResumeMs, 2000, 300000, d.humanIdleResumeMs),
    autoResumeHumanActivity: boolIn(c.autoResumeHumanActivity, d.autoResumeHumanActivity),
    humanWaitMaxMs: intIn(c.humanWaitMaxMs, 0, 60000, d.humanWaitMaxMs),
    allowSelfWindow: boolIn(c.allowSelfWindow, d.allowSelfWindow),
    allowSelfRect: normalizeRect(c.allowSelfRect),
    allowSelfMaxMs: intIn(c.allowSelfMaxMs, 5000, 600000, d.allowSelfMaxMs),
    auditRetentionFiles: intIn(c.auditRetentionFiles, 1, 20, d.auditRetentionFiles),
    requireAbortHotkey: boolIn(c.requireAbortHotkey, d.requireAbortHotkey),
  })
}

/** Config summary for screen_info / doctor (one line per field-group). */
export function describeConfig(cfg) {
  return [
    `mode=${cfg.mode} lattice=${cfg.lattice} binning=${cfg.binning} captureLongSide=${cfg.captureLongSide}`,
    `overlayMode=${cfg.overlayMode} armWindowMs=${cfg.armWindowMs} armClicks=${cfg.armClicks} hotkeyArmMs=${cfg.hotkeyArmMs}`,
    `maxImagesPerTurn=${cfg.maxImagesPerTurn} maxImageTokensPerTurn=${cfg.maxImageTokensPerTurn} minIntervalMs=${cfg.minIntervalMs}`,
    `denyProcesses=${cfg.denyProcesses.length} denyTitleContains=${cfg.denyTitleContains.length} allow=${cfg.allowProcesses.length + cfg.allowTitleContains.length} ask=${cfg.askProcesses.length + cfg.askTitleContains.length}`,
    `enableKeyboard=${cfg.enableKeyboard} enableClipboard=${cfg.enableClipboard} batchMaxActions=${cfg.batchMaxActions} mergeReadSide=${cfg.mergeReadSide}`,
    `pauseOnHumanInput=${cfg.pauseOnHumanInput} pillOnArm=${cfg.pillOnArm} waitDefaultTimeoutMs=${cfg.waitDefaultTimeoutMs} waitStableMs=${cfg.waitStableMs}`,
    `armDefaultSeconds=${cfg.armDefaultSeconds} autoResumeHumanActivity=${cfg.autoResumeHumanActivity} humanIdleResumeMs=${cfg.humanIdleResumeMs}`,
    `humanWaitMaxMs=${cfg.humanWaitMaxMs} allowSelfWindow=${cfg.allowSelfWindow} allowSelfMaxMs=${cfg.allowSelfMaxMs} allowSelfRect=${
      cfg.allowSelfRect ? `${cfg.allowSelfRect.x},${cfg.allowSelfRect.y} ${cfg.allowSelfRect.w}x${cfg.allowSelfRect.h}` : 'null'
    }`,
  ].join('；')
}
