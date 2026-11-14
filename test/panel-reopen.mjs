/**
 * panel-reopen.mjs — closing the panel must not leave it unopenable.
 *
 * Regression for "面板在后台关了之后就开不了": the plugin only called start() once at apply,
 * so an Exit (or any close) left it dead until the plugin reloaded. `panel.ensure()` is what
 * `/dexter panel show` and the authorize button now call.
 */
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { createPanel } from '../kernel/panel.js'

const dataDir = join(process.env.LOCALAPPDATA || process.env.USERPROFILE || '', 'dsh-dexter-probe-reopen')
const panel = createPanel({ dataDir, logger: (line) => console.log('[panel]', line) })
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const count = () => Number(execFileSync('powershell.exe', ['-NoProfile', '-Command',
  `(Get-CimInstance Win32_Process -Filter "Name='Panel.exe'" | Where-Object { $_.CommandLine -like '*${dataDir}*' } | Measure-Object).Count`,
], { encoding: 'utf8', windowsHide: true }).trim())

const first = panel.start()
console.log('start:', JSON.stringify(first), 'processes:', count())
await sleep(1500)

panel.stop()
await sleep(2000)
const afterClose = count()
console.log('after close: processes =', afterClose, 'running =', panel.running)

const reopened = panel.ensure()
await sleep(1500)
const afterReopen = count()
console.log('reopen:', JSON.stringify(reopened), 'processes =', afterReopen, 'running =', panel.running)

panel.stop()
await sleep(1500)

const ok = first.ok && afterClose === 0 && reopened.ok && afterReopen === 1 && count() === 0
console.log(`checks: closed=${afterClose === 0} reopened=${afterReopen === 1} reapedAgain=${count() === 0}`)
console.log(ok ? 'panel reopen: OK' : 'panel reopen: FAILED')
process.exit(ok ? 0 : 1)
