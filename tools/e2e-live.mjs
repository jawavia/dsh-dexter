/**
 * e2e-live.mjs — the real end-to-end loop on the CURRENT kernel: click → type → save →
 * read the file back from disk.
 *
 * Requires an open session grant (the human opens it: `/dexter arm 15m 100` or Ctrl+Alt+F12)
 * and a quiet desktop. The target is a fresh Notepad opened through the SHELL, because the
 * pixel engine refuses windows that belong to the DSH process tree.
 *
 * Usage: node tools/e2e-live.mjs [--keep]
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO = 'D:/DEEPSEEKworkplace/dsh-dexter'
const marker = `dexter-e2e-${Date.now()}`
const file = join(tmpdir(), `dexter-e2e-${Date.now()}.txt`)
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const ps = (args) => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], { encoding: 'utf8', windowsHide: true }).trim()

// Load the live plugin module in a scratch context? No: this drives the *installed* plugin
// through its own tool surface by reading the data dir? Neither. Keep it self-contained:
// use the kernel with real backends, like the install does.
const { createPixelBackend } = await import(pathToFileURL(join(REPO, 'backends', 'legacy-pixel.js')).href)
const { createUiaBackend } = await import(pathToFileURL(join(REPO, 'backends', 'legacy-uia.js')).href)
const { createButtonProbe } = await import(pathToFileURL(join(REPO, 'backends', 'win-probe.js')).href)
const { Audit } = await import(pathToFileURL(join(REPO, 'kernel', 'audit.js')).href)
const { Gate } = await import(pathToFileURL(join(REPO, 'kernel', 'gate.js')).href)
const { StopBus } = await import(pathToFileURL(join(REPO, 'kernel', 'stopbus.js')).href)
const { HumanActivity } = await import(pathToFileURL(join(REPO, 'kernel', 'human.js')).href)
const { Kernel } = await import(pathToFileURL(join(REPO, 'kernel', 'kernel.js')).href)
const { normalizeConfig } = await import(pathToFileURL(join(REPO, 'kernel', 'config.js')).href)
const { combosFromConfig } = await import(pathToFileURL(join(REPO, 'kernel', 'keys.js')).href)

// This script is the human's own harness for a fixed scratch window, so the human-pause
// guard is off (the plugin itself still defaults it on). Noted in the evidence.
const config = normalizeConfig({ humanWaitMaxMs: 8000, settleMs: 120, pauseOnHumanInput: false })
const dataDir = join(process.env.LOCALAPPDATA || '', 'dsh-dexter-e2e')
const audit = new Audit({ dir: dataDir })
const gate = new Gate({ config, audit, approval: null })
const uia = await createUiaBackend({ config })
const pixel = await createPixelBackend({ config, audit, approval: null, attachments: null })
const buttons = await createButtonProbe({ uia })
const stopbus = new StopBus({ dataDir, probe: uia.ok ? uia.probe : null, combos: combosFromConfig(config) })
const human = new HumanActivity({ config, probe: uia.ok ? uia.probe : null })
const kernel = new Kernel({ config, audit, gate, stopbus, human, backends: { pixel, uia }, buttons, docsPath: '', combos: combosFromConfig(config) })
human.start()
stopbus.start()

const report = { marker, file, steps: [] }
try {
  // 1. A fresh blank file, opened by the shell (outside the DSH process tree).
  writeFileSync(file, '', 'utf8')
  const sh = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    `$s = New-Object -ComObject Shell.Application; $s.ShellExecute('notepad.exe', '${file}', '', 'open', 1)`], { encoding: 'utf8', windowsHide: true })
  if (sh.status !== 0) throw new Error('shell launch failed')
  await sleep(1800)

  const window = uia.windows().find((win) => String(win.title || '').includes('dexter-e2e'))
  if (!window) throw new Error('the Notepad window did not appear')
  report.window = { handle: window.handle, title: window.title, rect: window.rect }

  // 2. Session grant (this script is the human's own tool, so `test` source is honest here).
  const opened = gate.openGrant({ minutes: 5, actions: 10, source: 'test' })
  if (!opened.ok) throw new Error(`grant failed: ${opened.error}`)
  report.grant = opened.grant

  const view = await kernel.view({ action: 'read', args: { window: { handle: window.handle } } })
  report.steps.push({ step: 'read', ok: view.ok })

  // 3. Click into the edit area, type the marker, save.
  const click = await kernel.act({ action: 'click', args: { window: { handle: window.handle }, fx: 0.5, fy: 0.55 } })
  report.steps.push({ step: 'click', ok: click.ok, text: click.text.slice(0, 80) })
  const type = await kernel.act({ action: 'type', args: { text: marker } })
  report.steps.push({ step: 'type', ok: type.ok, text: type.text.slice(0, 80) })
  const save = await kernel.act({ action: 'hotkey', args: { keys: 'ctrl+s' }, expect: { process: 'notepad.exe' } })
  report.steps.push({ step: 'save', ok: save.ok, text: save.text.slice(0, 80) })
  await sleep(800)

  // 4. The proof: the file on disk carries the marker.
  const content = existsSync(file) ? readFileSync(file, 'utf8').trim() : ''
  report.fileContent = content
  report.fileBytes = existsSync(file) ? readFileSync(file).length : 0
  report.ok = content === marker
} catch (error) {
  report.error = String(error && error.message ? error.message : error)
  report.ok = false
} finally {
  try { gate.stop({ level: 'hard', by: 'test', reason: 'e2e done' }) } catch { /* ignore */ }
  try { pixel.dispose() } catch { /* ignore */ }
  try { uia.dispose() } catch { /* ignore */ }
  try { human.dispose() } catch { /* ignore */ }
  try { stopbus.stop() } catch { /* ignore */ }
  const keep = process.argv.includes('--keep')
  if (!keep) {
    try { rmSync(file, { force: true }) } catch { /* ignore */ }
  }
}

console.log(JSON.stringify(report, null, 2))
console.log(report.ok ? 'e2e: OK (the marker reached the file on disk)' : 'e2e: FAILED')
process.exit(report.ok ? 0 : 1)
