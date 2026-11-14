// hotkey.js — 人类热键开/关授权窗口
//
// 用 RegisterHotKey 而不是轮询 GetAsyncKeyState：按键可能是"一瞬间"按下的（尤其程序合成的），
// 150ms 轮询会漏；RegisterHotKey 由系统在按下时往线程消息队列投一条 WM_HOTKEY，不会漏。
// 不需要窗口：hWnd 传 NULL，自己 PeekMessage 抽消息即可，也不占用别人的热键。
//
// 默认：Ctrl+Alt+F9 开授权窗口（armSeconds 秒），Ctrl+Alt+F10 立即关，Ctrl+Alt+F8 取消当前批次。
// 与 click-matrix 的 Ctrl+Alt+F12/F11 不冲突。
import koffi from 'koffi'
import { isKeyDown } from './win32.js'
import { arm, disarm, cancel } from './policy.js'

const MOD_ALT = 0x0001
const MOD_CONTROL = 0x0002
const MOD_NOREPEAT = 0x4000
const WM_HOTKEY = 0x0312

const DEFAULTS = {
  arm: { id: 0xf901, mods: MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, vk: 0x78 }, // F9
  disarm: { id: 0xf902, mods: MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, vk: 0x79 }, // F10
  cancel: { id: 0xf903, mods: MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, vk: 0x77 }, // F8
}

let api = null
function loadApi() {
  if (api) return api
  const user32 = koffi.load('user32.dll')
  const POINT = koffi.struct('DSHX2_POINT', { x: 'long', y: 'long' })
  const MSG = koffi.struct('DSHX2_MSG', {
    hwnd: 'void*',
    message: 'uint32',
    wParam: 'uintptr_t',
    lParam: 'intptr_t',
    time: 'uint32',
    pt: POINT,
  })
  api = {
    RegisterHotKey: user32.func('bool __stdcall RegisterHotKey(void* hWnd, int id, uint32 fsModifiers, uint32 vk)'),
    UnregisterHotKey: user32.func('bool __stdcall UnregisterHotKey(void* hWnd, int id)'),
    PeekMessageW: user32.func('bool __stdcall PeekMessageW(DSHX2_MSG* msg, void* hWnd, uint32 min, uint32 max, uint32 remove)'),
    msg: koffi.alloc(MSG, 1),
  }
  return api
}

/**
 * @param {{config?:object, onArm?:Function, onDisarm?:Function, onCancel?:Function, usePolling?:boolean}} opts
 * @returns {() => void} stop
 */
export function startHotkeys({ config = {}, onArm, onDisarm, onCancel, usePolling = false } = {}) {
  if (config.hotkeyArm === false) return () => {}
  const seconds = Math.max(30, Math.min(8 * 3600, Math.round(config.armSeconds ?? 1200)))
  const fire = (name) => {
    try {
      if (name === 'arm') { arm(seconds, 'hotkey', config); onArm?.(seconds) }
      else if (name === 'disarm') { disarm(config); onDisarm?.() }
      else { cancel(config); onCancel?.() }
    } catch { /* 状态写不进去也不能让插件崩 */ }
  }

  if (usePolling) return startPolling(fire)

  let stop = null
  try {
    const a = loadApi()
    const registered = {}
    for (const [name, spec] of Object.entries(DEFAULTS)) {
      registered[name] = Boolean(a.RegisterHotKey(null, spec.id, spec.mods, spec.vk))
    }
    if (!Object.values(registered).some(Boolean)) return startPolling(fire)

    const byId = new Map(Object.entries(DEFAULTS).map(([name, spec]) => [spec.id, name]))
    const timer = setInterval(() => {
      try {
        for (;;) {
          if (!a.PeekMessageW(a.msg, null, 0, 0, 1)) break
          const message = koffi.decode(a.msg, 'DSHX2_MSG')
          if (message.message !== WM_HOTKEY) continue
          const name = byId.get(Number(message.wParam))
          if (name) fire(name)
        }
      } catch { /* 抽消息失败就下一轮再试 */ }
    }, 60)
    timer.unref?.()

    stop = () => {
      clearInterval(timer)
      for (const [name, spec] of Object.entries(DEFAULTS)) {
        if (registered[name]) {
          try { a.UnregisterHotKey(null, spec.id) } catch { /* 已经没了 */ }
        }
      }
    }
  } catch {
    stop = startPolling(fire)
  }
  return stop
}

/** 兜底：RegisterHotKey 失败时退回按键轮询（人按住不放也能被采到）。 */
function startPolling(fire) {
  const keys = { arm: ['ctrl', 'alt', 'f9'], disarm: ['ctrl', 'alt', 'f10'], cancel: ['ctrl', 'alt', 'f8'] }
  const prev = { arm: false, disarm: false, cancel: false }
  const timer = setInterval(() => {
    for (const name of Object.keys(keys)) {
      let pressed = false
      try { pressed = keys[name].every((k) => isKeyDown(k)) } catch { pressed = false }
      if (pressed && !prev[name]) fire(name)
      prev[name] = pressed
    }
  }, 80)
  timer.unref?.()
  return () => clearInterval(timer)
}
