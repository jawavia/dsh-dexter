// Release a logically stuck Shift (and any other modifier/button a killed test process
// could have left down), then verify the state is clean. Sends key-up / button-up only:
// it can never press anything.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const local = JSON.parse(readFileSync('local.config.json', 'utf8'))
const dir = `${local.legacyRoot}\\engines\\control`
const koffiModule = await import(pathToFileURL(`${dir}\\node_modules\\koffi\\index.js`).href)
const koffi = koffiModule.default ?? koffiModule
const user32 = koffi.load('user32.dll')
const GetAsyncKeyState = user32.func('short __stdcall GetAsyncKeyState(int vKey)')

const KEYEVENTF_KEYUP = 0x0002
const VK = { SHIFT: 0x10, LSHIFT: 0xA0, RSHIFT: 0xA1, LCTRL: 0xA2, RCTRL: 0xA3, LALT: 0xA4, RALT: 0xA5, LWIN: 0x5B, RWIN: 0x5C }
const down = (vk) => (GetAsyncKeyState(vk) & 0x8000) !== 0

const before = Object.entries(VK).filter(([, vk]) => down(vk)).map(([name]) => name)
console.log('BEFORE=' + JSON.stringify(before))

const keybd = user32.func('void __stdcall keybd_event(uint8 bVk, uint8 bScan, uint32 dwFlags, uintptr_t dwExtraInfo)')
for (const [, vk] of Object.entries(VK)) {
  // Two passes cover both the generic and the left/right virtual keys.
  for (let i = 0; i < 2; i += 1) {
    keybd(vk, 0, KEYEVENTF_KEYUP, 0)
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
}
await new Promise((resolve) => setTimeout(resolve, 150))

const after = Object.entries(VK).filter(([, vk]) => down(vk)).map(([name]) => name)
console.log('AFTER=' + JSON.stringify(after))
console.log('FIXED=' + (after.length === 0))
process.exit(after.length === 0 ? 0 : 1)
