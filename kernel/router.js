/**
 * Router — which backend injects, and which target was actually resolved.
 *
 * One write surface, two legacy engines behind it:
 *   control (UIA path)  → legacy-uia: re-measure the control, invoke it, or click
 *                         its centre with Win32
 *   coordinates / window / text → legacy-pixel: the proven path (lattice snapping,
 *                         window deny list, window-relative fx/fy)
 *
 * The order is deliberate: UIA first when a control was named (it survives layout
 * drift), pixel otherwise. A missing UIA backend falls back to pixel and says so in
 * the result instead of failing the call.
 */

export const WRITE_CAPABILITIES = Object.freeze(['move', 'click', 'drag', 'scroll', 'type', 'key', 'hotkey', 'stop'])
export const CONTROL_CAPABILITIES = Object.freeze(['click', 'type', 'key', 'hotkey'])

export function hasCoords(args = {}) {
  return (typeof args.x === 'number' && typeof args.y === 'number')
    || (typeof args.fx === 'number' && typeof args.fy === 'number')
    || (args.window && typeof args.window === 'object')
}

/**
 * @param {{capability:string, args:object, backends:{pixel?:object, uia?:object}}} input
 * @returns {{kind:'uia'|'pixel', backend:object|null, reason:string}}
 */
export function routeAct({ capability, args = {}, backends = {} }) {
  const wantsControl = typeof args.control === 'string' && args.control.trim() !== ''
  if (wantsControl) {
    if (CONTROL_CAPABILITIES.includes(capability)) {
      if (backends.uia && backends.uia.ok) return { kind: 'uia', backend: backends.uia, reason: 'UIA 控件路径' }
      return { kind: 'uia', backend: null, reason: 'UIA 控件路径，但 legacy-uia 后端不可用' }
    }
    return { kind: 'pixel', backend: backends.pixel || null, reason: `capability=${capability} 不走 UIA 控件路径` }
  }
  if (backends.pixel && backends.pixel.ok) return { kind: 'pixel', backend: backends.pixel, reason: '坐标/窗口路径' }
  if (backends.uia && backends.uia.ok) return { kind: 'uia', backend: backends.uia, reason: 'legacy-pixel 不可用，退回 Win32 坐标' }
  return { kind: 'pixel', backend: null, reason: '没有可用的写后端' }
}

/** Which view action the pixel engine answers, and which the UIA backend answers. */
export const VIEW_ROUTES = Object.freeze({
  info: 'pixel',
  list: 'uia',
  focus: 'uia',
  capture: 'pixel',
  zoom: 'pixel',
  locate: 'pixel',
  text: 'pixel',
  read: 'pixel',
  wait: 'pixel',
  wait_window: 'pixel',
  uia: 'uia',
})

export const VIEW_ACTIONS = Object.freeze(Object.keys(VIEW_ROUTES))
