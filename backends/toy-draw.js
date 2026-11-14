/**
 * The stroke toy's whole injection path — ~120 lines, no third-party binary.
 *
 * Why it exists: the previous bundle drew strokes with `dsh-stroke`, which ships an
 * unsigned `stroke-helper.exe` and (checked 2026-11-14) has **no LICENSE file and no
 * `license` field**. The repair order allows the stroke capability to survive as a
 * toy, so the capability stays and the unlicensed dependency goes: points are sent
 * through the same Win32 `SendInput` path the UIA backend already uses (MIT, dsh-x2 /
 * dsh-screen), and the shapes are generated here.
 *
 * The input plumbing below is derived from `dsh-x2`'s `src/win32.js` (MIT, Copyright
 * (c) 2026 ql0423) because that module keeps its `mouseEvent` private. See
 * THIRD-PARTY-NOTICES.md.
 *
 * Bounds: preset shapes only, a hard point cap, one button, and the caller can abort
 * between points. There is no API here for an arbitrary trajectory.
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveEngine } from './resolve.js'

const SHAPES = Object.freeze(['circle', 'square', 'triangle', 'heart', 'star', 'wave'])
export const TOY_SHAPES = SHAPES

const MOUSEEVENTF = Object.freeze({
  MOVE: 0x0001,
  LEFTDOWN: 0x0002,
  LEFTUP: 0x0004,
  RIGHTDOWN: 0x0008,
  RIGHTUP: 0x0010,
  ABSOLUTE: 0x8000,
  VIRTUALDESK: 0x4000,
})
const INPUT_SIZE = 40

function circlePoints(cx, cy, radius, count) {
  const points = []
  for (let i = 0; i <= count; i += 1) {
    const angle = (i / count) * Math.PI * 2
    points.push({ x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) })
  }
  return points
}

function squarePoints(cx, cy, radius, count) {
  const corners = [
    { x: cx - radius, y: cy - radius },
    { x: cx + radius, y: cy - radius },
    { x: cx + radius, y: cy + radius },
    { x: cx - radius, y: cy + radius },
    { x: cx - radius, y: cy - radius },
  ]
  const points = []
  const perEdge = Math.max(2, Math.floor(count / 4))
  for (let edge = 0; edge < 4; edge += 1) {
    const from = corners[edge]
    const to = corners[edge + 1]
    for (let i = 0; i < perEdge; i += 1) {
      const t = i / perEdge
      points.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t })
    }
  }
  points.push(corners[0])
  return points
}

function trianglePoints(cx, cy, radius, count) {
  const corners = [0, 1, 2, 3].map((i) => {
    const angle = -Math.PI / 2 + (i % 3) * ((Math.PI * 2) / 3)
    return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) }
  })
  const points = []
  const perEdge = Math.max(2, Math.floor(count / 3))
  for (let edge = 0; edge < 3; edge += 1) {
    const from = corners[edge]
    const to = corners[edge + 1]
    for (let i = 0; i < perEdge; i += 1) {
      const t = i / perEdge
      points.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t })
    }
  }
  points.push(corners[0])
  return points
}

function heartPoints(cx, cy, radius, count) {
  const points = []
  const scale = radius / 17
  for (let i = 0; i <= count; i += 1) {
    const t = (i / count) * Math.PI * 2
    const x = 16 * Math.sin(t) ** 3
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)
    points.push({ x: cx + x * scale, y: cy - y * scale })
  }
  return points
}

function starPoints(cx, cy, radius, count) {
  const points = []
  const spikes = 5
  const vertices = spikes * 2
  const perEdge = Math.max(2, Math.floor(count / vertices))
  const ring = []
  for (let i = 0; i <= vertices; i += 1) {
    const angle = -Math.PI / 2 + (i * Math.PI) / spikes
    const r = i % 2 === 0 ? radius : radius * 0.42
    ring.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) })
  }
  for (let i = 0; i < ring.length - 1; i += 1) {
    const from = ring[i]
    const to = ring[i + 1]
    for (let s = 0; s < perEdge; s += 1) {
      const t = s / perEdge
      points.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t })
    }
  }
  points.push(ring[0])
  return points
}

function wavePoints(cx, cy, radius, count) {
  const points = []
  for (let i = 0; i <= count; i += 1) {
    const t = i / count
    points.push({
      x: cx - radius + t * radius * 2,
      y: cy + Math.sin(t * Math.PI * 4) * radius * 0.4,
    })
  }
  return points
}

/** Build one bounded stroke for a preset shape (no caller-supplied geometry). */
export function buildShape({ shape = 'circle', cx = 0, cy = 0, radius = 160, points = 240, durationMs = 600, maxPoints = 4000 } = {}) {
  const name = SHAPES.includes(String(shape)) ? String(shape) : 'circle'
  const hardCap = Math.max(16, Math.min(4000, Math.round(Number(maxPoints) || 4000)))
  const count = Math.max(16, Math.min(hardCap, Math.round(Number(points) || 240)))
  const r = Math.max(8, Math.min(1200, Math.round(Number(radius) || 160)))
  const centreX = Math.round(Number(cx) || 0)
  const centreY = Math.round(Number(cy) || 0)
  const generator = {
    circle: circlePoints,
    square: squarePoints,
    triangle: trianglePoints,
    heart: heartPoints,
    star: starPoints,
    wave: wavePoints,
  }[name]
  // Closed shapes append their start point, so trim to the hard cap afterwards: the
  // cap must hold for the returned array, not for the requested sample count.
  const raw = generator(centreX, centreY, r, count).slice(0, hardCap)
  const span = Math.max(1, Math.round(Number(durationMs) || 600))
  return raw.map((point, index) => ({
    x: Math.round(point.x),
    y: Math.round(point.y),
    t: Math.round((index / Math.max(1, raw.length - 1)) * span),
  }))
}

/**
 * @param {{uia: object, logger?: (m:string)=>void}} options
 * @returns {Promise<{ok:boolean, name:string, reason?:string, draw?:Function, stop?:Function, dispose?:Function}>}
 */
export async function createToyDrawer({ uia = null, logger = () => {} } = {}) {
  if (!uia || !uia.ok) {
    return { ok: false, name: 'toy-draw', reason: '玩具笔势需要 legacy-uia 的 Win32 原语（未加载）' }
  }
  const resolved = resolveEngine('uia', '')
  const koffiPath = join(resolved.dir, 'node_modules', 'koffi', 'index.js')
  let SendInput
  let metrics
  try {
    const koffiModule = await import(pathToFileURL(koffiPath).href)
    const koffi = koffiModule.default ?? koffiModule
    const user32 = koffi.load('user32.dll')
    SendInput = user32.func('uint32 __stdcall SendInput(uint32 nInputs, void* pInputs, int cbSize)')
    metrics = () => uia.metrics()
  } catch (error) {
    return { ok: false, name: 'toy-draw', reason: `加载 koffi 失败: ${error && error.message ? error.message : error}` }
  }

  let stopRequested = false

  function absolute(x, y) {
    const screen = metrics()
    const width = Math.max(1, screen.width)
    const height = Math.max(1, screen.height)
    const nx = Math.round(((x - screen.x) * 65535) / Math.max(1, width - 1))
    const ny = Math.round(((y - screen.y) * 65535) / Math.max(1, height - 1))
    return {
      nx: Math.max(0, Math.min(65535, nx)),
      ny: Math.max(0, Math.min(65535, ny)),
    }
  }

  function mouseEvent(flags, x, y) {
    const buffer = Buffer.alloc(INPUT_SIZE)
    buffer.writeUInt32LE(0, 0)
    buffer.writeInt32LE(x, 8)
    buffer.writeInt32LE(y, 12)
    buffer.writeUInt32LE(0, 16)
    buffer.writeUInt32LE(flags >>> 0, 20)
    buffer.writeUInt32LE(0, 24)
    buffer.writeUInt32LE(0, 28)
    buffer.writeUInt32LE(0, 32)
    const sent = SendInput(1, buffer, INPUT_SIZE)
    if (sent !== 1) throw new Error('SendInput 被拒绝（桌面可能已锁定）')
  }

  const wait = (ms) => {
    if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.round(ms))
  }

  return {
    ok: true,
    name: 'toy-draw',
    shapes: SHAPES,
    /**
     * Draw one bounded stroke.
     * @param {{points:Array<{x:number,y:number,t:number}>, button?: 'L'|'R', shouldStop?: ()=>boolean}} input
     */
    draw({ points, button = 'L', shouldStop = null }) {
      const list = Array.isArray(points) ? points : []
      if (list.length === 0) return { sent: 0, elapsed: 0, aborted: true, reason: '没有点' }
      const down = button === 'R' ? MOUSEEVENTF.RIGHTDOWN : MOUSEEVENTF.LEFTDOWN
      const up = button === 'R' ? MOUSEEVENTF.RIGHTUP : MOUSEEVENTF.LEFTUP
      const startedAt = Date.now()
      let sent = 0
      let aborted = false
      let reason = ''
      const first = absolute(list[0].x, list[0].y)
      mouseEvent(MOUSEEVENTF.ABSOLUTE | MOUSEEVENTF.VIRTUALDESK | MOUSEEVENTF.MOVE, first.nx, first.ny)
      mouseEvent(down, first.nx, first.ny)
      try {
        for (let i = 1; i < list.length; i += 1) {
          if (stopRequested || (typeof shouldStop === 'function' && shouldStop())) {
            aborted = true
            reason = '停止请求'
            break
          }
          const previous = list[i - 1]
          const point = list[i]
          const { nx, ny } = absolute(point.x, point.y)
          mouseEvent(MOUSEEVENTF.ABSOLUTE | MOUSEEVENTF.VIRTUALDESK | MOUSEEVENTF.MOVE, nx, ny)
          sent += 1
          const gap = Math.max(0, Math.min(50, Math.round((point.t || 0) - (previous.t || 0))))
          wait(gap)
        }
      } finally {
        // The button must never stay down, whatever happened above.
        try {
          const last = absolute(list[list.length - 1].x, list[list.length - 1].y)
          mouseEvent(up, last.nx, last.ny)
        } catch {
          try {
            uia.releaseAll()
          } catch { /* nothing else to try */ }
        }
      }
      if (stopRequested) stopRequested = false
      return { sent, elapsed: Date.now() - startedAt, aborted, reason }
    },
    stop() {
      stopRequested = true
    },
    dispose() {
      stopRequested = true
    },
  }
}
