// Read-only diagnostic: is any key/button logically stuck, are accessibility filters on,
// and which processes from the desktop-automation experiments are still alive?
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const local = JSON.parse(readFileSync('local.config.json', 'utf8'))
const dir = `${local.legacyRoot}\\engines\\control`
const koffiModule = await import(pathToFileURL(`${dir}\\node_modules\\koffi\\index.js`).href)
const koffi = koffiModule.default ?? koffiModule
const user32 = koffi.load('user32.dll')
const GetAsyncKeyState = user32.func('short __stdcall GetAsyncKeyState(int vKey)')

const down = (vk) => (GetAsyncKeyState(vk) & 0x8000) !== 0
const pressedSince = (vk) => (GetAsyncKeyState(vk) & 0x0001) !== 0

const keys = [
  ['LButton', 0x01], ['RButton', 0x02], ['MButton', 0x04], ['XButton1', 0x05], ['XButton2', 0x06],
  ['Shift', 0x10], ['Ctrl', 0x11], ['Alt', 0x12], ['LShift', 0xA0], ['RShift', 0xA1],
  ['LCtrl', 0xA2], ['RCtrl', 0xA3], ['LAlt', 0xA4], ['RAlt', 0xA5],
  ['LWin', 0x5B], ['RWin', 0x5C], ['CapsLock', 0x14], ['NumLock', 0x90], ['ScrollLock', 0x91],
  ['Esc', 0x1B], ['Tab', 0x09], ['Space', 0x20], ['F11', 0x7A], ['F12', 0x7B],
]
const stuck = keys.filter(([, vk]) => down(vk)).map(([name]) => name)

console.log('STUCK_KEYS=' + JSON.stringify(stuck))
console.log('KEYS_WITH_PENDING_STATE=' + JSON.stringify(keys.filter(([, vk]) => pressedSince(vk)).map(([name]) => name)))

// Toggle states that change wheel / shortcut behaviour.
const user32b = koffi.load('user32.dll')
const GetKeyState = user32b.func('short __stdcall GetKeyState(int vKey)')
const capsOn = (GetKeyState(0x14) & 1) !== 0
const numOn = (GetKeyState(0x90) & 1) !== 0
const scrollOn = (GetKeyState(0x91) & 1) !== 0
console.log(`TOGGLES caps=${capsOn} num=${numOn} scroll=${scrollOn}`)

// Accessibility filters (StickyKeys / FilterKeys / ToggleKeys / MouseKeys) change what
// a modifier or the wheel does, so a "broken wheel" report must rule them out.
const { execFileSync } = await import('node:child_process')
const regValue = (key, value) => {
  try {
    const text = execFileSync('reg', ['query', key, '/v', value], { encoding: 'utf8', stdio: 'pipe' })
    return text.match(/0x[0-9a-fA-F]+/)?.[0] ?? '?'
  } catch {
    return 'absent'
  }
}
console.log('STICKYKEYS_FLAGS=' + regValue('HKCU\\Control Panel\\Accessibility\\StickyKeys', 'Flags'))
console.log('FILTERKEYS_FLAGS=' + regValue('HKCU\\Control Panel\\Accessibility\\FilterKeys', 'Flags'))
console.log('TOGGLEKEYS_FLAGS=' + regValue('HKCU\\Control Panel\\Accessibility\\ToggleKeys', 'Flags'))
console.log('MOUSEKEYS_FLAGS=' + regValue('HKCU\\Control Panel\\Accessibility\\MouseKeys', 'Flags'))

const win32 = await import(pathToFileURL(`${dir}\\src\\win32.js`).href)
const fg = win32.foregroundWindow()
console.log('FOREGROUND=' + JSON.stringify(fg && { title: fg.title, pid: fg.pid, class: fg.class }))
const windows = win32.listWindows()
  .filter((w) => w.title && w.title.trim())
  .sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height)
  .slice(0, 12)
  .map((w) => `${w.handle}|${w.title}|pid=${w.pid}`)
console.log('TOP_WINDOWS=' + JSON.stringify(windows, null, 0))
