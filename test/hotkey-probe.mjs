// Can Ctrl+Alt+F11 be registered right now? Confirms whether a stale process owned it.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const local = JSON.parse(readFileSync('local.config.json', 'utf8'))
const koffiModule = await import(pathToFileURL(`${local.legacyRoot.replace(/\\\\/g, '\\')}\\engines\\control\\node_modules\\koffi\\index.js`).href)
const koffi = koffiModule.default ?? koffiModule
const user32 = koffi.load('user32.dll')
const RegisterHotKey = user32.func('bool __stdcall RegisterHotKey(void* hWnd, int id, uint32 fsModifiers, uint32 vk)')
const UnregisterHotKey = user32.func('bool __stdcall UnregisterHotKey(void* hWnd, int id)')

const MOD_ALT = 0x0001
const MOD_CONTROL = 0x0002
const MOD_NOREPEAT = 0x4000
const combos = [
  ['Ctrl+Alt+F11', MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, 0x7A, 0xfa11],
  ['Ctrl+Alt+F12', MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, 0x7B, 0xfa12],
  ['Ctrl+Alt+F10', MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, 0x79, 0xfa10],
]
for (const [name, mods, vk, id] of combos) {
  const ok = RegisterHotKey(null, id, mods, vk)
  console.log(`${name}: register=${ok}`)
  if (ok) UnregisterHotKey(null, id)
}
