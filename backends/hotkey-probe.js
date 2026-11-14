/**
 * Hotkey health — can this process actually take the emergency/arm combos?
 *
 * `RegisterHotKey` is first-come-first-served and system-wide. Two common ways it fails:
 * a stale helper from a previous plugin instance still owns the combo, or another
 * application does. When the pixel engine cannot register `Ctrl+Alt+F11` it refuses to
 * inject at all ("fail-loud"), so "clicks stopped working" is usually this, not the mouse.
 *
 * This probe answers the question *now*: it registers each combo, releases it
 * immediately, and reports which ones are available. Registering and dropping within a
 * millisecond is harmless, but it is only run for status display, never per action.
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveEngine } from './resolve.js'
import { DEFAULT_COMBOS } from '../kernel/keys.js'

const MOD_ALT = 0x0001
const MOD_CONTROL = 0x0002
const MOD_SHIFT = 0x0004
const MOD_NOREPEAT = 0x4000

/** Map a key name to a virtual-key code (only what a combo may contain). */
function vkOf(key) {
  const name = String(key || '').toLowerCase()
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(name)) return 0x6f + Number(name.slice(1))
  if (/^[a-z]$/.test(name)) return name.toUpperCase().charCodeAt(0)
  if (/^[0-9]$/.test(name)) return name.charCodeAt(0)
  if (name === 'ctrl') return 0x11
  if (name === 'alt') return 0x12
  if (name === 'shift') return 0x10
  if (name === 'win') return 0x5b
  return 0
}

/** Build the probe descriptors from configured combos (`{arm,extend,stop,softStop}` arrays). */
export function describeCombos(combos) {
  const out = []
  let id = 0xfa10
  for (const name of ['arm', 'extend', 'stop', 'softStop']) {
    const keys = (combos && combos[name]) || []
    if (keys.length === 0) continue
    let mods = MOD_NOREPEAT
    for (const key of keys.slice(0, -1)) {
      if (key === 'ctrl') mods |= MOD_CONTROL
      else if (key === 'alt') mods |= MOD_ALT
      else if (key === 'shift') mods |= MOD_SHIFT
    }
    const vk = vkOf(keys[keys.length - 1])
    if (vk === 0) continue
    id += 1
    out.push({ name, label: keys.map((key) => key.toUpperCase()).join('+'), mods, vk, id })
  }
  return out
}

/**
 * @param {{combos?: {arm:string[],extend:string[],stop:string[],softStop:string[]}}} [options]
 * @returns {Promise<{ok:boolean, reason?:string, combos:Array<{name:string,label:string,available:boolean}>}>}
 */
export async function createHotkeyProbe({ combos = null } = {}) {
  const resolved = resolveEngine('uia', '')
  if (!resolved.ok) return { ok: false, reason: resolved.reason, combos: [] }
  let RegisterHotKey
  let UnregisterHotKey
  try {
    const koffiModule = await import(pathToFileURL(join(resolved.dir, 'node_modules', 'koffi', 'index.js')).href)
    const koffi = koffiModule.default ?? koffiModule
    const user32 = koffi.load('user32.dll')
    RegisterHotKey = user32.func('bool __stdcall RegisterHotKey(void* hWnd, int id, uint32 fsModifiers, uint32 vk)')
    UnregisterHotKey = user32.func('bool __stdcall UnregisterHotKey(void* hWnd, int id)')
  } catch (error) {
    return { ok: false, reason: `加载 koffi 失败: ${error && error.message ? error.message : error}`, combos: [] }
  }
  const descriptors = describeCombos(combos || DEFAULT_COMBOS)
  return {
    ok: true,
    combos: [],
    /** Ask the OS right now; cheap (register/unregister per configured combo). */
    check() {
      const result = descriptors.map((combo) => {
        let available = false
        try {
          available = Boolean(RegisterHotKey(null, combo.id, combo.mods, combo.vk))
        } catch {
          available = false
        } finally {
          if (available) {
            try {
              UnregisterHotKey(null, combo.id)
            } catch { /* released with the call */ }
          }
        }
        return { name: combo.name, label: combo.label, available }
      })
      this.combos = result
      return result
    },
    /** One-line summary for hands_status. */
    summary() {
      const combos = this.combos.length > 0 ? this.combos : this.check()
      const taken = combos.filter((combo) => !combo.available)
      if (taken.length === 0) return '热键：四个组合都可用'
      return `热键：${taken.map((combo) => `${combo.label} 被占用`).join(' · ')}`
        + (taken.some((combo) => combo.name === 'stop') ? '（急停热键被占时 pixel 引擎会拒绝注入）' : '')
    },
  }
}
