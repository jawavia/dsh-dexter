/**
 * 06 — the /dexter command contract.
 *
 * The gateway rejects a handler that returns a bare string with
 * "command handler must return a CommandResult", which is exactly what happened in the
 * live install (nine failed `command.execute` rows). This pins the shape:
 *   { kind: 'success' | 'error', text: string }
 */
import { bootPlugin } from './harness.mjs'
import { createReport } from './assert.mjs'

const report = createReport('command contract')
const plugin = await bootPlugin({ config: {} })
try {
  const command = plugin.mock.commands.find((entry) => entry && entry.name === 'dexter')
  report.ok('/dexter registered', Boolean(command))
  if (command) {
    const status = command.handler({ rawInput: 'status' })
    report.ok('status returns a CommandResult', Boolean(status) && status.kind === 'success' && typeof status.text === 'string', JSON.stringify(status)?.slice(0, 120))
    report.ok('status text is not empty', Boolean(status && status.text && status.text.length > 20))

    const arm = command.handler({ rawInput: 'arm 15m 50' })
    report.ok('arm returns success', arm && arm.kind === 'success', JSON.stringify(arm)?.slice(0, 200))
    report.ok('arm text states the window and budget', Boolean(arm && arm.text && arm.text.includes('15') && arm.text.includes('50')))

    const bad = command.handler({ rawInput: 'arm nonsense' })
    report.ok('bad arguments return an error result', bad && bad.kind === 'error', JSON.stringify(bad)?.slice(0, 160))

    const panel = command.handler({ rawInput: 'panel show' })
    report.ok('panel command returns a result', panel && (panel.kind === 'success' || panel.kind === 'error'))

    const stop = command.handler({ rawInput: 'stop' })
    report.ok('stop returns success', stop && stop.kind === 'success')
    const clear = command.handler({ rawInput: 'clear' })
    report.ok('clear returns success', clear && clear.kind === 'success')

    const help = command.handler({ rawInput: 'wat' })
    report.ok('unknown verb returns the help as success', help && help.kind === 'success' && help.text.includes('/dexter'))
    // The gateway passes the text after the command name as `rawInput`; `input` is the
    // older shape and must keep working too.
    const legacy = command.handler({ input: 'stop' })
    report.ok('legacy `input` shape still works', legacy && legacy.kind === 'success')
    report.ok('empty invocation means status', command.handler({}).kind === 'success')
    report.ok('every result carries kind and text only', [status, arm, bad, panel, stop, clear, help].every(
      (result) => result && Object.keys(result).every((key) => key === 'kind' || key === 'text'),
    ))
  }
} finally {
  plugin.close()
}

const ok = report.finish()
process.exit(ok ? 0 : 1)
