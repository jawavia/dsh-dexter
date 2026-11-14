/**
 * clipboard-live.mjs — round-trip the real clipboard through the adapter, then restore it.
 *
 * The kernel gates the clipboard per write, but a gate test does not prove the plumbing.
 * This drives the adapter's own clipboard tools (the engine's `clipboard_get` /
 * `clipboard_set`), which is what the kernel calls after the human says yes.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPixelBackend } from '../backends/legacy-pixel.js'
import { normalizeConfig } from '../kernel/config.js'

const MARKER = `dsh-dexter clipboard test ${Date.now()}`
const scratch = mkdtempSync(join(tmpdir(), 'clip-live-'))
process.env.DSH_HOME = join(scratch, 'dsh-home')
const config = normalizeConfig({})
const audit = { append: () => null, seq: 0, head: '', tail: () => [] }
const pixel = await createPixelBackend({ config, audit, approval: null, attachments: null, requireAbortHotkey: false })

const report = { ok: Boolean(pixel.ok) }
if (pixel.ok) {
  const original = await pixel.clipboardGet({ requireText: false })
  report.originalHasText = /剪贴板文本/.test(String(original.text || ''))
  report.originalChars = (String(original.text || '').match(/（(\d+) 字符/) || [])[1] || '0'

  const write = await pixel.act({ capability: 'clipboard_set', args: { text: MARKER } })
  report.writeOk = Boolean(write.ok)
  report.writeText = String(write.text || '').slice(0, 120)

  await new Promise((done) => setTimeout(done, 400))
  const readBack = await pixel.clipboardGet({ requireText: true })
  report.readTextSample = String(readBack.text || '').slice(0, 200)
  report.readOk = Boolean(readBack.ok)
  report.roundTrip = String(readBack.text || '').includes(MARKER)

  // Restore whatever was there before (only when we could read it as text).
  if (report.originalHasText) {
    const originalText = String(original.text || '').split('\n')[1] || ''
    if (originalText) await pixel.act({ capability: 'clipboard_set', args: { text: originalText } })
    report.restored = Boolean(originalText)
  }
  pixel.dispose()
} else {
  report.reason = pixel.reason
}
rmSync(scratch, { recursive: true, force: true })

console.log(JSON.stringify(report, null, 2))
const ok = report.ok && report.writeOk && report.readOk && report.roundTrip === true
console.log(ok ? 'clipboard: round-trip OK' : 'clipboard: FAILED')
process.exit(ok ? 0 : 1)
