/**
 * 06 — the /dexter command contract.
 *
 * The gateway rejects a handler that returns a bare string with
 * "command handler must return a CommandResult", which is exactly what happened in the
 * live install (nine failed `command.execute` rows). This pins the shape:
 *   { kind: 'success' | 'error', text: string }
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootPlugin } from './harness.mjs'
import { createReport } from './assert.mjs'

const report = createReport('command contract')
const plugin = await bootPlugin({ config: {} })
try {
  const command = plugin.mock.commands.find((entry) => entry && entry.name === 'dexter')
  report.ok('/dexter registered', Boolean(command))
  if (command) {
    const status = await command.handler({ rawInput: 'status' })
    report.ok('status returns a CommandResult', Boolean(status) && status.kind === 'success' && typeof status.text === 'string', JSON.stringify(status)?.slice(0, 120))
    report.ok('status text is not empty', Boolean(status && status.text && status.text.length > 20))

    const arm = await command.handler({ rawInput: 'arm 15m 50' })
    report.ok('arm returns success', arm && arm.kind === 'success', JSON.stringify(arm)?.slice(0, 200))
    report.ok('arm text states the window and budget', Boolean(arm && arm.text && arm.text.includes('15') && arm.text.includes('50')))

    const bad = await command.handler({ rawInput: 'arm nonsense' })
    report.ok('bad arguments return an error result', bad && bad.kind === 'error', JSON.stringify(bad)?.slice(0, 160))

    const panel = await command.handler({ rawInput: 'panel show' })
    report.ok('panel command returns a result', panel && (panel.kind === 'success' || panel.kind === 'error'))

    const stop = await command.handler({ rawInput: 'stop' })
    report.ok('stop returns success', stop && stop.kind === 'success')
    const clear = await command.handler({ rawInput: 'clear' })
    report.ok('clear returns success', clear && clear.kind === 'success')

    const help = await command.handler({ rawInput: 'wat' })
    report.ok('unknown verb returns the help as success', help && help.kind === 'success' && help.text.includes('/dexter'))
    // The gateway passes the text after the command name as `rawInput`; `input` is the
    // older shape and must keep working too.
    const legacy = await command.handler({ input: 'stop' })
    report.ok('legacy `input` shape still works', legacy && legacy.kind === 'success')
    report.ok('empty invocation means status', (await command.handler({})).kind === 'success')

    // `/dexter set` validates every key. The three tunable numbers go to the runtime-override
    // layer (the host editor refuses a nested include); other keys go to the host editor.
    const setOk = await command.handler({ rawInput: 'set armMinutes 30' })
    report.ok('set accepts a valid number', setOk.kind === 'success' && setOk.text.includes('armMinutes'), setOk.text.slice(0, 80))
    const overridesFile = join(plugin.dataDir, 'runtime-overrides.json')
    const overrides = existsSync(overridesFile) ? JSON.parse(readFileSync(overridesFile, 'utf8')) : null
    report.ok('an override key lands in runtime-overrides.json', Boolean(overrides) && overrides.armMinutes === 30, JSON.stringify(overrides))
    report.ok('an override key does not touch the host editor', (plugin.mock.edits || []).length === 0)
    const hostKey = await command.handler({ rawInput: 'set askOnWrite false' })
    const hostEdit = (plugin.mock.edits || []).pop()
    report.ok('a non-override key goes through the config editor', hostKey.kind === 'success' && Boolean(hostEdit) && hostEdit.candidate.askOnWrite === false, JSON.stringify(hostEdit && hostEdit.candidate))
    const setRange = await command.handler({ rawInput: 'set armMinutes 0' })
    report.ok('set rejects a value below the range', setRange.kind === 'error' && setRange.text.includes('范围'), setRange.text.slice(0, 60))
    const setType = await command.handler({ rawInput: 'set armActions abc' })
    report.ok('set rejects a non-integer', setType.kind === 'error' && setType.text.includes('整数'), setType.text.slice(0, 60))
    const setKey = await command.handler({ rawInput: 'set nope 1' })
    report.ok('set rejects an unknown key', setKey.kind === 'error' && setKey.text.includes('未知配置键'), setKey.text.slice(0, 60))
    const setEnum = await command.handler({ rawInput: 'set verifyMode nonsense' })
    report.ok('set rejects an out-of-enum value', setEnum.kind === 'error' && setEnum.text.includes('只能是'), setEnum.text.slice(0, 60))
    report.ok('every result carries kind and text only', [status, arm, bad, panel, stop, clear, help].every(
      (result) => result && Object.keys(result).every((key) => key === 'kind' || key === 'text'),
    ))
  }
} finally {
  plugin.close()
}

const ok = report.finish()
process.exit(ok ? 0 : 1)
