/**
 * 12 — the plugin owns the arm/extend hotkeys.
 *
 * The pixel engine's helper hardcodes Ctrl+Alt+F12 for a gate this plugin bypasses, so a press
 * used to do nothing here. The listener (`ui/Hotkeys.cs`) is now the owner; these tests pin the
 * line protocol, the mapping to human actions, and the fact that tests never claim the real
 * global hotkeys.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { actionOfEvent, cscPath, parseHotkeyLine } from '../kernel/hotkeys.js'
import { StopBus } from '../kernel/stopbus.js'
import { createReport } from './assert.mjs'

const report = createReport('hotkeys')

report.eq('ready line parses four flags', parseHotkeyLine('ready arm=1 extend=1 soft=0 stop=1'), {
  kind: 'ready',
  registered: { arm: true, extend: true, soft: false, stop: true },
})
report.eq('ready none means nothing registered', parseHotkeyLine('ready none'), {
  kind: 'ready',
  registered: { arm: false, extend: false, soft: false, stop: false },
})
report.eq('a failed combo is reported', parseHotkeyLine('failed soft'), { kind: 'failed', name: 'soft' })
report.eq('an event is reported', parseHotkeyLine('event arm'), { kind: 'event', name: 'arm' })
report.eq('free text is ignored', parseHotkeyLine('hotkey Ctrl+Alt+F12 registered after 1 attempts'), null)
report.eq('an empty line is ignored', parseHotkeyLine('   '), null)

report.eq('arm maps to arm', actionOfEvent('arm'), 'arm')
report.eq('extend maps to extend', actionOfEvent('extend'), 'extend')
report.eq('soft maps to softStop', actionOfEvent('soft'), 'softStop')
report.eq('stop maps to stop', actionOfEvent('stop'), 'stop')
report.eq('an unknown name maps to nothing', actionOfEvent('nope'), '')

// The listener must dispatch into the same human actions the buttons use.
let armed = 0
let extended = 0
let stopped = []
const bus = new StopBus({
  dataDir: process.env.TEMP,
  onArm: () => { armed += 1 },
  onExtend: () => { extended += 1 },
  onStop: ({ level, by }) => { stopped.push(`${level}:${by}`) },
})
bus.hotkey('arm')
bus.hotkey('extend')
bus.hotkey('soft')
bus.hotkey('stop')
report.eq('arm fires onArm once', armed, 1)
report.eq('extend fires onExtend once', extended, 1)
report.eq('soft and stop request a stop as the human', stopped, ['soft:human', 'stop:human'])
report.eq('an unknown hotkey is refused', bus.hotkey('nope'), false)

// The listener is a .cs file compiled by the in-box csc, like the panel.
const source = readFileSync(join(import.meta.dirname, '..', 'ui', 'Hotkeys.cs'), 'utf8')
report.ok('the listener registers four ids', /RegisterHotKey/.test(source) && /WM_HOTKEY/.test(source))
report.ok('it never shows a window', !/form\.Show\(\)/.test(source) && /Application\.Run\(new ApplicationContext\(\)\)/.test(source))
report.ok('it is a tool window (no taskbar/Alt+Tab entry)', /WS_EX_TOOLWINDOW/.test(source))
report.ok('it exits when the parent closes stdin', /OpenStandardInput/.test(source))
report.ok('csc resolves on this machine', cscPath().toLowerCase().endsWith('csc.exe'), cscPath())
// CI has no desktop session; starting the listener there locked a compiled .exe inside the temp
// dir and made measure-surface fail with EPERM on unlink. Both guards must stay.
const indexSource = readFileSync(join(import.meta.dirname, '..', 'index.js'), 'utf8')
report.ok('the listener is skipped in CI', indexSource.includes(process.env.CI !== 'true'))
const measureSource = readFileSync(join(import.meta.dirname, '..', 'tools', 'measure-surface.mjs'), 'utf8')
report.ok('measure-surface never claims the hotkeys', measureSource.includes('DSH_DEXTER_NO_HOTKEYS'))

const ok = report.finish()
process.exit(ok ? 0 : 1)
