/**
 * Physical mouse-button state — the guard that makes free hovering safe.
 *
 * A "move" is harmless *unless* a button is already held: then SendInput movement
 * becomes a drag (window moves, text selection, file drag). Windows exposes the state
 * through GetAsyncKeyState, so a hover can be refused whenever any button is down.
 *
 * `dsh-x2`'s `win32.js` has no mouse-button names in its VK table, so this module
 * loads koffi from that package (MIT) and asks user32 directly.
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveEngine } from './resolve.js'

const BUTTONS = [
  ['left', 0x01],
  ['right', 0x02],
  ['middle', 0x04],
  ['x1', 0x05],
  ['x2', 0x06],
]

/**
 * @param {{uia?: object}} options
 * @returns {Promise<{ok:boolean, reason?:string, buttonsDown:()=>string[]}>}
 */
export async function createButtonProbe({ uia = null } = {}) {
  const resolved = resolveEngine('uia', '')
  if (!resolved.ok) return { ok: false, reason: resolved.reason, buttonsDown: () => [] }
  try {
    const koffiModule = await import(pathToFileURL(join(resolved.dir, 'node_modules', 'koffi', 'index.js')).href)
    const koffi = koffiModule.default ?? koffiModule
    const user32 = koffi.load('user32.dll')
    const GetAsyncKeyState = user32.func('short __stdcall GetAsyncKeyState(int vKey)')
    void uia
    return {
      ok: true,
      buttonsDown() {
        const down = []
        for (const [name, vk] of BUTTONS) {
          try {
            if ((GetAsyncKeyState(vk) & 0x8000) !== 0) down.push(name)
          } catch { /* a failed probe must not look like "no buttons" */ }
        }
        return down
      },
    }
  } catch (error) {
    return {
      ok: false,
      reason: `加载 koffi 失败: ${error && error.message ? error.message : error}`,
      buttonsDown: () => [],
    }
  }
}
