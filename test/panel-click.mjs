/**
 * panel-click.mjs — prove the panel's × actually hides it (and that dragging is manual, so
 * child clicks are not swallowed by the window manager's move loop).
 *
 * Runs against a panel in an isolated data directory, clicks the close label through the
 * real Win32 input path, and checks that the window shrank to the edge strip.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createPanel } from '../kernel/panel.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const dataDir = join(process.env.LOCALAPPDATA || process.env.USERPROFILE || '', 'dsh-dexter-probe-click')
const panel = createPanel({ dataDir, logger: (line) => console.log('[panel]', line) })
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const ps = (args) => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], { encoding: 'utf8', windowsHide: true }).trim()

async function mouse() {
  const local = JSON.parse(readFileSync(join(REPO, 'local.config.json'), 'utf8'))
  const koffiModule = await import(pathToFileURL(join(local.legacyRoot, 'engines', 'control', 'node_modules', 'koffi', 'index.js')).href)
  const koffi = koffiModule.default ?? koffiModule
  const user32 = koffi.load('user32.dll')
  return {
    setCursor: user32.func('bool __stdcall SetCursorPos(int x, int y)'),
    mouseEvent: user32.func('void __stdcall mouse_event(uint32 flags, uint32 dx, uint32 dy, uint32 data, uintptr_t extra)'),
  }
}

panel.writeState('● dsh-dexter', '点击测试')
const start = panel.start()
console.log('start:', JSON.stringify(start))
await sleep(1600)

const pid = Number(ps(['-Command', `Get-CimInstance Win32_Process -Filter "Name='Panel.exe'" | Where-Object { $_.CommandLine -like '*${dataDir}*' } | Select-Object -First 1 -ExpandProperty ProcessId`])) || 0
const windows = ps(['-File', join(REPO, 'tools', 'panel-windows.ps1'), '-ProcessId', String(pid)])
const visible = windows.split('\n').find((line) => line.includes('visible=True')) || ''
const match = visible.match(/rect=(-?\d+),(-?\d+),(-?\d+),(-?\d+)/)
const rect = match ? [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])] : []
console.log('panel window:', rect.join(','), 'pid:', pid)

const mouseApi = await mouse()
// The close label sits at the right end of the 42px-high strip.
const closeX = rect[2] - 13
const closeY = rect[1] + 21
console.log('clicking close at', closeX, closeY)
mouseApi.setCursor(closeX, closeY)
await sleep(120)
mouseApi.mouseEvent(0x0002, 0, 0, 0, 0) // LEFTDOWN
await sleep(60)
mouseApi.mouseEvent(0x0004, 0, 0, 0, 0) // LEFTUP
await sleep(900)

const after = ps(['-File', join(REPO, 'tools', 'panel-windows.ps1'), '-ProcessId', String(pid)])
const afterVisible = after.split('\n').find((line) => line.includes('visible=True')) || ''
const afterMatch = afterVisible.match(/rect=(-?\d+),(-?\d+),(-?\d+),(-?\d+)/)
const afterRect = afterMatch ? [Number(afterMatch[1]), Number(afterMatch[2]), Number(afterMatch[3]), Number(afterMatch[4])] : []
const width = afterRect.length === 4 ? afterRect[2] - afterRect[0] : -1
const height = afterRect.length === 4 ? afterRect[3] - afterRect[1] : -1
console.log('after close:', afterRect.join(','), `(${width}x${height})`)

panel.stop()
await sleep(1500)
const stillAlive = Number(ps(['-Command', `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Measure-Object).Count`]))

const hiddenToStrip = width === 14 && height === 56
const ok = start.ok && hiddenToStrip && stillAlive === 0
console.log(`checks: hiddenToStrip=${hiddenToStrip} reaped=${stillAlive === 0}`)
console.log(ok ? 'panel close: OK' : 'panel close: FAILED')
process.exit(ok ? 0 : 1)
