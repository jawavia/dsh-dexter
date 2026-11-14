/**
 * 10 — configuration from the desktop panel.
 *
 * DSH has no generic plugin form (its Settings page renders volatile fields, but no shipped
 * client renders them), so the three tunable numbers are adjusted on the panel itself. The
 * panel is a separate process: it writes `cfg <key> <±n>` into `panel-requests.txt` and this
 * plugin performs the validated write, one per tick. These tests pin the parser, the clamp,
 * and the one-shot consume behaviour.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPanel } from '../kernel/panel.js'
import { createReport } from './assert.mjs'

const report = createReport('panel config')
const dir = mkdtempSync(join(tmpdir(), 'dexter-panel-cfg-'))
const panel = createPanel({ dataDir: dir })

try {
  report.eq('parses a relative change', panel.parseRequest('cfg armMinutes +5'), { key: 'armMinutes', delta: 5 })
  report.eq('parses a decrease', panel.parseRequest('cfg armActions -50'), { key: 'armActions', delta: -50 })
  report.eq('parses reset', panel.parseRequest('cfg reset'), { reset: true })
  report.eq('ignores unknown lines', panel.parseRequest('show'), null)
  report.eq('ignores a missing delta', panel.parseRequest('cfg armMinutes'), null)
  report.eq('ignores a non-numeric delta', panel.parseRequest('cfg armMinutes abc'), null)

  report.eq('clamps to the field maximum', panel.nextValue(478, 5, { min: 1, max: 480 }), 480)
  report.eq('clamps to the field minimum', panel.nextValue(2, -10, { min: 1, max: 480 }), 1)
  report.eq('rate 0 stays 0 (0 = no cap)', panel.nextValue(0, -10, { min: 0, max: 600 }), 0)
  report.eq('a plain increase passes through', panel.nextValue(15, 5, { min: 1, max: 480 }), 20)

  // Requests are consumed exactly once: the panel sends one, the plugin applies one.
  const requestPath = join(dir, 'panel-requests.txt')
  writeFileSync(requestPath, 'cfg armMinutes +5\r\ncfg armActions +50\r\n', 'utf8')
  const first = panel.readRequests()
  report.eq('reads both requests', first, ['cfg armMinutes +5', 'cfg armActions +50'])
  report.ok('consumes the file', !existsSync(requestPath))
  report.eq('a second read is empty', panel.readRequests(), [])

  report.ok('state carries three lines', (() => {
    panel.writeState('head', 'detail', 'settings')
    const text = readFileSync(join(dir, 'state.txt'), 'utf8')
    return text.split('\n').filter((line) => line !== '').length >= 3
  })())
} finally {
  rmSync(dir, { recursive: true, force: true })
}

const ok = report.finish()
process.exit(ok ? 0 : 1)
