/**
 * dsh-click-matrix — lattice / coordinate math (pure, no I/O).
 *
 * Two independent dials:
 *   - lattice tier: DIP spacing of the cross lattice (coarse 180, standard 90,
 *     fine 45, micro 22.5 DIP). Converted to physical screen px per monitor
 *     scale: spacingScreen = round(dip * scale).
 *   - capture binning: how many screen px are merged into one output image px
 *     ("target" auto-fits the long side, or an integer divisor 2/4/6/8).
 *
 * All screen coordinates are PHYSICAL virtual-desktop pixels (multi-monitor
 * origin may be negative). fx/fy are normalized coordinates in [0,1].
 */

export const LATTICE_TIERS = Object.freeze({
  coarse: 180,
  standard: 90,
  fine: 45,
  micro: 22.5,
})

export const LATTICE_NAMES = Object.freeze(['coarse', 'standard', 'fine', 'micro'])
export const BINNING_VALUES = Object.freeze(['target', '2', '4', '6', '8'])
export const MIN_SPACING_IMAGE_PX = 8
export const VIEW_VALUES = Object.freeze(['lattice', 'hierarchical', 'clean'])
export const OVERLAY_MODES = Object.freeze(['auto', 'on', 'off'])

const TARGET_MIN_SCALE = 1 / 8 // never downscale more than binning 8 with auto target
const DEFAULT_MONITOR_SCALE = 1
const DEFAULT_DPI = 96

/** True when v is a finite number. */
export function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v)
}

/** Bounded number with numeric-string tolerance (helper JSON / cached status). */
function numIn(v, lo, hi, fallback) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.min(hi, Math.max(lo, n))
}

/** Boolean-ish helper flag (true / 1 / "true" / "yes" / "on"). */
function isTrueFlag(v) {
  if (v === true) return true
  if (typeof v === 'number') return v === 1
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    return s === 'true' || s === '1' || s === 'yes' || s === 'on'
  }
  return false
}

/**
 * Per-monitor scale factor: >0 finite number (numeric strings accepted), clamped
 * to [0.25, 8]; anything else falls back to 1x (NOT 0.25 — a bogus scale must not
 * silently shrink the lattice on a normal monitor).
 */
function scaleIn(v) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MONITOR_SCALE
  return Math.min(8, Math.max(0.25, n))
}

/** Clamp a finite number into [lo, hi]; non-numeric falls back to `fallback`. */
export function clampNum(v, lo, hi, fallback) {
  const n = isNum(v) ? v : fallback
  if (!isNum(n)) return lo
  return Math.min(hi, Math.max(lo, n))
}

export function clamp01(v) {
  if (!isNum(v)) return 0
  return Math.min(1, Math.max(0, v))
}

export function clampInt(v, lo, hi, fallback) {
  const n = clampNum(v, lo, hi, fallback)
  return Math.round(n)
}

/** Normalize a lattice tier name; returns null for "off"/unknown. */
export function normalizeLattice(value, fallback = 'standard') {
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (v === 'off' || v === 'none') return null
    if (Object.prototype.hasOwnProperty.call(LATTICE_TIERS, v)) return v
  }
  if (value === false || value === null) return null
  if (fallback === null) return null
  return Object.prototype.hasOwnProperty.call(LATTICE_TIERS, fallback) ? fallback : 'standard'
}

/** Lattice spacing in DIP for a tier; null for off. */
export function latticeDip(tier) {
  const name = normalizeLattice(tier, null)
  return name === null ? null : LATTICE_TIERS[name]
}

/**
 * Lattice spacing in physical screen px for a monitor scale.
 * `scale` is that monitor's Per-Monitor-V2 factor (numeric strings tolerated,
 * clamped to [0.25, 8]); invalid scale means 1x, never below 1 px.
 */
export function latticeSpacingScreen(tier, scale = DEFAULT_MONITOR_SCALE) {
  const dip = latticeDip(tier)
  if (dip === null) return 0
  const s = scaleIn(scale)
  return Math.max(1, Math.round(dip * s))
}

/**
 * Normalize helper `monitors` into a stable list.
 *
 * Multi-monitor / mixed-DPI rules:
 *   - x/y are PHYSICAL virtual-desktop px and MAY BE NEGATIVE (left/upper monitor).
 *   - scale is PER MONITOR (Per-Monitor-V2); missing/invalid scale falls back to 1x,
 *     never to the primary monitor's scale (that would break mixed-DPI spacing).
 *   - entries with a missing/zero/negative size are skipped instead of being
 *     clamped to a 1x1 "phantom monitor": a transient 0x0 report (display topology
 *     change, unplugged cable) must not stretch the virtual screen or steal points.
 *   - numeric strings are accepted for x/y/w/h/scale (older helper builds / cached
 *     status JSON), and `primary` accepts true|1|"true"|"yes"|"on".
 */
export function normalizeMonitors(monitors) {
  if (!Array.isArray(monitors)) return []
  const out = []
  for (let i = 0; i < monitors.length; i++) {
    const m = monitors[i]
    if (!m || typeof m !== 'object') continue
    const w = Math.round(numIn(m.w ?? m.width, 0, 1e6, 0))
    const h = Math.round(numIn(m.h ?? m.height, 0, 1e6, 0))
    if (w < 1 || h < 1) continue
    out.push({
      id: m.id ?? i + 1,
      device: typeof m.device === 'string' ? m.device : '',
      primary: isTrueFlag(m.primary),
      x: Math.round(numIn(m.x, -1e7, 1e7, 0)),
      y: Math.round(numIn(m.y, -1e7, 1e7, 0)),
      w,
      h,
      scale: scaleIn(m.scale),
    })
  }
  return out
}

/** Virtual screen bounds covering every monitor. Falls back to helper data. */
export function virtualScreen(monitors, fallbackVirtual) {
  const list = normalizeMonitors(monitors)
  if (list.length > 0) {
    let x1 = Infinity
    let y1 = Infinity
    let x2 = -Infinity
    let y2 = -Infinity
    for (const m of list) {
      x1 = Math.min(x1, m.x)
      y1 = Math.min(y1, m.y)
      x2 = Math.max(x2, m.x + m.w)
      y2 = Math.max(y2, m.y + m.h)
    }
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
  }
  if (fallbackVirtual && typeof fallbackVirtual === 'object') {
    const w = Math.round(clampNum(fallbackVirtual.w ?? fallbackVirtual.width, 1, 1e7, 1))
    const h = Math.round(clampNum(fallbackVirtual.h ?? fallbackVirtual.height, 1, 1e7, 1))
    return {
      x: Math.round(clampNum(fallbackVirtual.x, -1e7, 1e7, 0)),
      y: Math.round(clampNum(fallbackVirtual.y, -1e7, 1e7, 0)),
      w,
      h,
    }
  }
  return { x: 0, y: 0, w: 0, h: 0 }
}

/**
 * Monitor containing point; nearest monitor otherwise; null when unknown.
 *
 * When several monitors contain the point (Windows "duplicate" / mirror mode
 * reports the same rect for each display) the PRIMARY one wins, so the lattice
 * spacing on the primary screen is not computed from a secondary's scale in a
 * mixed-DPI setup. Equal-distance ties outside every monitor also prefer primary.
 */
export function monitorAt(monitors, x, y) {
  const list = normalizeMonitors(monitors)
  if (list.length === 0) return null
  const px = isNum(x) ? x : 0
  const py = isNum(y) ? y : 0
  let firstHit = null
  for (const m of list) {
    if (px >= m.x && px < m.x + m.w && py >= m.y && py < m.y + m.h) {
      if (m.primary) return m
      if (firstHit === null) firstHit = m
    }
  }
  if (firstHit !== null) return firstHit
  let best = null
  let bestD = Infinity
  for (const m of list) {
    const dx = px < m.x ? m.x - px : px >= m.x + m.w ? px - (m.x + m.w) : 0
    const dy = py < m.y ? m.y - py : py >= m.y + m.h ? py - (m.y + m.h) : 0
    const d = Math.hypot(dx, dy)
    if (d < bestD - 1e-9) {
      bestD = d
      best = m
    } else if (Math.abs(d - bestD) <= 1e-9 && m.primary && best && !best.primary) {
      best = m
    }
  }
  return best
}

/** Monitor scale at a point (Per-Monitor DPI). 1 when unknown. */
export function screenScaleAt(monitors, x, y) {
  const m = monitorAt(monitors, x, y)
  return m ? m.scale : DEFAULT_MONITOR_SCALE
}

/** System DPI from monitor scale at a point. */
export function dpiAt(monitors, x, y) {
  return Math.round(screenScaleAt(monitors, x, y) * DEFAULT_DPI)
}

/** A screen-space rect clamped to the virtual screen; null when no overlap. */
export function clampRect(rect, virtual) {
  const vs = virtual
  const rx = Math.round(clampNum(rect?.x, -1e7, 1e7, 0))
  const ry = Math.round(clampNum(rect?.y, -1e7, 1e7, 0))
  const rw = Math.round(clampNum(rect?.w ?? rect?.width, 1, 1e7, 1))
  const rh = Math.round(clampNum(rect?.h ?? rect?.height, 1, 1e7, 1))
  const x1 = Math.max(vs.x, rx)
  const y1 = Math.max(vs.y, ry)
  const x2 = Math.min(vs.x + vs.w, rx + rw)
  const y2 = Math.min(vs.y + vs.h, ry + rh)
  if (x2 - x1 < 1 || y2 - y1 < 1) return null
  return { x: Math.round(x1), y: Math.round(y1), w: Math.round(x2 - x1), h: Math.round(y2 - y1) }
}

/** True when the point is inside the virtual screen. */
export function pointInVirtual(x, y, virtual) {
  if (!isNum(x) || !isNum(y) || !virtual) return false
  return x >= virtual.x && x < virtual.x + virtual.w && y >= virtual.y && y < virtual.y + virtual.h
}

/** Outside point moved to the nearest virtual-screen corner-ish point (1 px in). */
export function clampPointToVirtual(x, y, virtual) {
  const px = Math.min(virtual.x + virtual.w - 1, Math.max(virtual.x, Math.round(isNum(x) ? x : virtual.x)))
  const py = Math.min(virtual.y + virtual.h - 1, Math.max(virtual.y, Math.round(isNum(y) ? y : virtual.y)))
  return { x: px, y: py }
}

/**
 * Output scale for a binning option over a region.
 * - "target": fit the long side to captureLongSide, never upscale above 1.
 * - "2".."8": merge that many screen px into one image px.
 */
export function binningScale(binning, regionW, regionH, captureLongSide) {
  const w = Math.max(1, Math.round(isNum(regionW) ? regionW : 1))
  const h = Math.max(1, Math.round(isNum(regionH) ? regionH : 1))
  const v = typeof binning === 'number' ? String(binning) : String(binning ?? '').trim().toLowerCase()
  if (v === 'target' || v === '' || v === 'auto') {
    const longSide = Math.max(w, h)
    const target = clampNum(captureLongSide, 320, 4096, 1600)
    const s = target / longSide
    return Math.min(1, Math.max(TARGET_MIN_SCALE, s))
  }
  const n = Number(v)
  if (BINNING_VALUES.includes(v) && n > 1) return 1 / n
  return 1
}

/** Output image size for a region under a scale. */
export function captureOutputSize(regionW, regionH, scale) {
  const s = isNum(scale) && scale > 0 ? scale : 1
  return {
    w: Math.max(1, Math.round(regionW * s)),
    h: Math.max(1, Math.round(regionH * s)),
  }
}

/**
 * Validate that lattice crosses survive binning: spacing in the FINAL image must
 * be >= MIN_SPACING_IMAGE_PX. Returns { ok, spacingImage, minImagePx, error }.
 */
export function validateLatticeInImage(spacingScreen, scale, minImagePx = MIN_SPACING_IMAGE_PX) {
  const spacingImage = (isNum(spacingScreen) ? spacingScreen : 0) * (isNum(scale) && scale > 0 ? scale : 1)
  if (spacingImage >= minImagePx) {
    return { ok: true, spacingImage: Math.round(spacingImage * 100) / 100, minImagePx }
  }
  return {
    ok: false,
    spacingImage: Math.round(spacingImage * 100) / 100,
    minImagePx,
    error:
      `晶格在最终图像里只有 ${Math.round(spacingImage * 100) / 100}px（要求 ≥ ${minImagePx}px），`
      + '会糊成一片。请改用更粗的 binning（如 binning:"target"/2/4）或更粗的 lattice（如 coarse）。',
  }
}

/**
 * Find a lattice tier that survives the current binning for this monitor scale.
 * Returns the name, or null when even `coarse` is too dense.
 */
export function suggestLatticeTier(scale, screenScale, minImagePx = MIN_SPACING_IMAGE_PX) {
  for (const name of LATTICE_NAMES) {
    const spacing = latticeSpacingScreen(name, screenScale)
    if (spacing * scale >= minImagePx) return name
  }
  return null
}

/** Coarsest feasible binning divisor for a lattice tier, for error hints. */
export function maxBinningDivisor(spacingScreen, minImagePx = MIN_SPACING_IMAGE_PX) {
  if (!isNum(spacingScreen) || spacingScreen <= 0) return 8
  return Math.max(1, Math.min(8, Math.floor(spacingScreen / minImagePx)))
}

// ---------------------------------------------------------------------------
// normalized <-> screen mapping
// ---------------------------------------------------------------------------

/**
 * fx/fy in [0,1] over `region` -> screen physical px.
 * Convention matches the mapping formula shown to the model:
 *   screen = region.origin + f * region.size
 * and the rounded pixel is kept inside the region (size-1 max).
 */
export function normToScreen(fx, fy, region) {
  const x = region.x + clamp01(fx) * region.w
  const y = region.y + clamp01(fy) * region.h
  return {
    x: Math.round(Math.min(region.x + region.w - 1, Math.max(region.x, x))),
    y: Math.round(Math.min(region.y + region.h - 1, Math.max(region.y, y))),
  }
}

/** Screen physical px -> fx/fy in [0,1] over `region`. */
export function screenToNorm(x, y, region) {
  return {
    fx: region.w > 0 ? clamp01((x - region.x) / region.w) : 0,
    fy: region.h > 0 ? clamp01((y - region.y) / region.h) : 0,
  }
}

/** Bitmap px (ix,iy over the captured image) -> screen px. */
export function imageToScreen(ix, iy, capture) {
  const source = capture.source
  return {
    x: source.x + (capture.width > 0 ? ix * source.w / capture.width : 0),
    y: source.y + (capture.height > 0 ? iy * source.h / capture.height : 0),
  }
}

/** Screen px -> bitmap px over the captured image. */
export function screenToImage(x, y, capture) {
  const source = capture.source
  return {
    ix: source.w > 0 ? (x - source.x) * capture.width / source.w : 0,
    iy: source.h > 0 ? (y - source.y) * capture.height / source.h : 0,
  }
}

/** Human-readable mapping formula for a capture result. */
export function mappingFormula(capture) {
  const s = capture.source
  const pxPerImagePx = capture.width > 0 ? s.w / capture.width : 1
  return {
    norm: `屏幕x = ${s.x} + fx*${s.w}；屏幕y = ${s.y} + fy*${s.h}`,
    image: `屏幕x = ${s.x} + ix*${round2(pxPerImagePx)}；屏幕y = ${s.y} + iy*${round2(capture.height > 0 ? s.h / capture.height : 1)}`,
    imagePxPerScreenPx: `1 屏幕px = ${round2(capture.width / Math.max(1, s.w))} 图像px`,
    note: 'fx,fy ∈ [0,1] 是相对本图裁剪区的归一化坐标；ix,iy 是图像像素坐标。',
  }
}

export function round2(v) {
  return Math.round((isNum(v) ? v : 0) * 100) / 100
}

// ---------------------------------------------------------------------------
// lattice snapping / cell math
// ---------------------------------------------------------------------------

/**
 * Nearest lattice point.
 * Lattice origin defaults to the virtual-screen origin (helper draws from it).
 * Returns { x, y, distance, dx, dy, onLattice }.
 */
export function snapToLattice(x, y, { originX = 0, originY = 0, spacing }) {
  const sp = isNum(spacing) && spacing > 0 ? spacing : 1
  const px = isNum(x) ? x : 0
  const py = isNum(y) ? y : 0
  const sx = Math.round(originX + Math.round((px - originX) / sp) * sp)
  const sy = Math.round(originY + Math.round((py - originY) / sp) * sp)
  const distance = Math.hypot(sx - px, sy - py)
  return {
    x: sx,
    y: sy,
    dx: sx - px,
    dy: sy - py,
    distance: Math.round(distance * 100) / 100,
    onLattice: distance <= sp / 3,
  }
}

/** Lattice cell (col,row) containing a point. */
export function cellOfPoint(x, y, { originX = 0, originY = 0, spacing }) {
  const sp = isNum(spacing) && spacing > 0 ? spacing : 1
  return {
    col: Math.floor((x - originX) / sp),
    row: Math.floor((y - originY) / sp),
  }
}

/** Center of a lattice cell. */
export function cellCenter(col, row, { originX = 0, originY = 0, spacing }) {
  const sp = isNum(spacing) && spacing > 0 ? spacing : 1
  return { x: Math.round(originX + (col + 0.5) * sp), y: Math.round(originY + (row + 0.5) * sp) }
}

/** Stable human cell label like "C7" (1-based row), only for display. */
export function cellLabel(col, row) {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const c = ((col % 26) + 26) % 26
  return letters[c] + String(row + 1)
}

// ---------------------------------------------------------------------------
// zoom math (per PROTOCOL zoom mapping)
// ---------------------------------------------------------------------------

/** Zoom source rect: size screen px centered on (cx,cy), clamped to virtual. */
export function zoomSourceRect(cx, cy, size, virtual) {
  const s = clampNum(size, 32, 2048, 270)
  const x1 = Math.round(cx - s / 2)
  const y1 = Math.round(cy - s / 2)
  let x = Math.max(virtual.x, Math.min(x1, virtual.x + virtual.w - s))
  let y = Math.max(virtual.y, Math.min(y1, virtual.y + virtual.h - s))
  const w = Math.min(s, virtual.w)
  const h = Math.min(s, virtual.h)
  x = Math.round(Math.max(virtual.x, Math.min(x, virtual.x + virtual.w - w)))
  y = Math.round(Math.max(virtual.y, Math.min(y, virtual.y + virtual.h - h)))
  return { x, y, w, h }
}

/**
 * Screen coordinates of a zoom sub-cell center.
 * sx = source.x + (col + 0.5) * source.w / subCols  (PROTOCOL zoom mapping)
 */
export function zoomSubPoint(source, col, row, subCols, subRows) {
  const cols = Math.max(1, Math.round(isNum(subCols) ? subCols : 6))
  const rows = Math.max(1, Math.round(isNum(subRows) ? subRows : 6))
  const c = clampInt(col, 0, cols - 1, 0)
  const r = clampInt(row, 0, rows - 1, 0)
  const cellW = source.w / cols
  const cellH = source.h / rows
  return {
    x: Math.round(source.x + (c + 0.5) * cellW),
    y: Math.round(source.y + (r + 0.5) * cellH),
    cellW,
    cellH,
    col: c,
    row: r,
    subCols: cols,
    subRows: rows,
  }
}

/** Sub-lattice spacing in screen px for a zoom. */
export function zoomSubSpacing(source, subCols, subRows) {
  const cols = Math.max(1, Math.round(isNum(subCols) ? subCols : 6))
  const rows = Math.max(1, Math.round(isNum(subRows) ? subRows : 6))
  return {
    x: Math.round((source.w / cols) * 100) / 100,
    y: Math.round((source.h / rows) * 100) / 100,
  }
}

/** Smallest zoom sub-spacing that maps to >= 8 image px at the given zoom scale. */
export function validateZoomSubSpacing(source, subCols, subRows, imageScale, minImagePx = MIN_SPACING_IMAGE_PX) {
  const sp = zoomSubSpacing(source, subCols, subRows)
  const s = isNum(imageScale) && imageScale > 0 ? imageScale : 1
  const imagePx = Math.min(sp.x, sp.y) * s
  if (imagePx >= minImagePx) return { ok: true, imagePx: round2(imagePx), spacingScreen: sp }
  return { ok: false, imagePx: round2(imagePx), spacingScreen: sp, error: `zoom 子格在图像中仅 ${round2(imagePx)}px（建议 ≥ ${minImagePx}px），请减小 subCols/subRows 或增大 size。` }
}

// ---------------------------------------------------------------------------
// token estimation (host-side fallback when llm pricing is unavailable)
// ---------------------------------------------------------------------------

/** Rough vision-token estimate for an image (matches common patch-based counting). */
export function estimateVisualTokens(width, height) {
  const w = Math.max(1, Math.round(isNum(width) ? width : 1))
  const h = Math.max(1, Math.round(isNum(height) ? height : 1))
  return Math.min(1024, (Math.ceil(w / 42) + 1) * (Math.ceil(h / 42) + 1))
}

/** Estimate total cost including the ~70-token metadata/descriptor text. */
export function estimateImageTokens(width, height, descriptorTokens = 70) {
  return estimateVisualTokens(width, height) + Math.max(0, Math.round(descriptorTokens))
}

/** JSON-safe rect for tool output/text. */
export function rectText(rect) {
  if (!rect) return '?'
  return `(${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.w)}x${Math.round(rect.h)})`
}
