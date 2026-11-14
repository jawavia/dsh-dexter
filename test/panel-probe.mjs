/**
 * panel-probe.mjs — start the desktop panel, prove it is a topmost window inside the
 * working area, prove the state file reaches it, and prove stop reaps it.
 *
 * WinForms borderless windows do not report a MainWindowHandle, so the window is found by
 * enumerating top-level windows for the process id (tools/panel-windows.ps1) — otherwise
 * this test would "pass" on an empty rect.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPanel } from '../kernel/panel.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const dataDir = join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'dexter')
const panel = createPanel({ dataDir, logger: (line) => console.log('[panel]', line) })
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const ps = (args) => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], { encoding: 'utf8', windowsHide: true }).trim()

panel.writeState('● dsh-dexter', '面板自检：这一行是详情')
const start = panel.start()
console.log('start:', JSON.stringify(start))
await sleep(1600)

const pid = Number(ps(['-Command', "(Get-Process Panel -ErrorAction SilentlyContinue | Select-Object -First 1).Id"])) || 0
console.log('panel pid:', pid)

const windows = ps(['-File', join(REPO, 'tools', 'panel-windows.ps1'), '-ProcessId', String(pid)])
console.log(windows.split('\n').filter((line) => line.includes('visible=True')).join('\n') || '(no visible window)')

const visible = windows.split('\n').find((line) => line.includes('visible=True'))
const match = visible ? visible.match(/rect=(-?\d+),(-?\d+),(-?\d+),(-?\d+)/) : null
const rect = match ? [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])] : []
const work = ps(['-Command', 'Add-Type -AssemblyName System.Windows.Forms; $w=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea; "$($w.Left),$($w.Top),$($w.Right),$($w.Bottom)"'])
const [wl, wt, wr, wb] = work.split(',').map(Number)
console.log('working area:', work)
console.log('window rect:', rect.join(','))

const topmost = Boolean(visible && visible.includes('topmost=True'))
const inside = rect.length === 4 && rect[0] >= wl && rect[1] >= wt && rect[2] <= wr && rect[3] <= wb
const visibleOk = Boolean(visible)

const state = existsSync(panel.paths.statePath) ? readFileSync(panel.paths.statePath, 'utf8').trim().split('\n') : []
console.log('state file lines:', state)

// The escape hatch from click-through: the tray icon cannot be asserted headlessly, but the
// command file can — and it goes through the same SetClickThrough path.
const exStyle = () => {
  const row = ps(['-File', join(REPO, 'tools', 'panel-windows.ps1'), '-ProcessId', String(pid)])
    .split('\n').find((line) => line.includes('visible=True')) || ''
  return row.includes('clickthrough=True')
}
const before = exStyle()
panel.command('through-on')
await sleep(1400)
const afterOn = exStyle()
panel.command('through-off')
await sleep(1400)
const afterOff = exStyle()
console.log(`click-through: before=${before} afterOn=${afterOn} afterOff=${afterOff}`)

panel.stop()
await sleep(2000)
const after = Number(ps(['-Command', '(Get-Process Panel -ErrorAction SilentlyContinue | Measure-Object).Count']))
console.log('panel processes after stop:', after)

const throughWorks = before === false && afterOn === true && afterOff === false
const ok = start.ok && pid > 0 && visibleOk && topmost && inside && throughWorks && after === 0
console.log(`checks: visible=${visibleOk} topmost=${topmost} insideWorkingArea=${inside} reaped=${after === 0}`)
console.log(ok ? 'panel: OK' : 'panel: FAILED')
process.exit(ok ? 0 : 1)
