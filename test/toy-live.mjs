/**
 * toy-live.mjs — the stroke toy's real drawer without firing a drag.
 *
 * A toy stroke is a real left-button drag on whatever is under the cursor, which can
 * select text or move a window on someone's desktop. So this check proves what is safe
 * to prove on a live desktop: the drawer builds against the real Win32 API, the shape
 * geometry is the exported function, and the hard point cap holds. The DRAW itself is
 * deliberately not fired here.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createUiaBackend } from '../backends/legacy-uia.js'
import { createToyDrawer, buildShape, TOY_SHAPES } from '../backends/toy-draw.js'
import { normalizeConfig } from '../kernel/config.js'

const REPO = join(import.meta.dirname, '..')
const config = normalizeConfig({ toyStrokeEnabled: true, toyStrokeMaxPoints: 400 })
const uia = await createUiaBackend({ config, logger: (m) => console.log(m) })
const drawer = await createToyDrawer({ uia, logger: (m) => console.log(m) })

const report = { drawerOk: Boolean(drawer.ok), uiaOk: Boolean(uia.ok), shapes: TOY_SHAPES }
if (drawer.ok) {
  const circle = buildShape({ shape: 'circle', cx: 800, cy: 500, radius: 120, points: 200, durationMs: 600 })
  report.circlePoints = circle.length
  report.closesOnStart = circle[0].x === circle[circle.length - 1].x && circle[0].y === circle[circle.length - 1].y
  report.startsAtRight = circle[0].x === 920 && circle[0].y === 500
  const clamped = buildShape({ shape: 'wave', cx: 800, cy: 500, radius: 300, points: 9999, maxPoints: config.toyStrokeMaxPoints })
  report.clampedPoints = clamped.length
  report.clampHonoured = clamped.length <= config.toyStrokeMaxPoints
} else {
  report.reason = drawer.reason
}
console.log(JSON.stringify(report, null, 2))
try {
  readFileSync(join(REPO, 'package.json'))
} catch { /* nothing */ }
const ok = report.drawerOk && report.uiaOk && report.clampHonoured === true
process.exit(ok ? 0 : 1)
