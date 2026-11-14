/**
 * A1/A2/A3/A10 — the model-facing surface, measured the same way as the old
 * baseline (descBytes + paramSchemaBytes + outputSchemaBytes).
 */
import { createReport } from './assert.mjs'
import { bootPlugin } from './harness.mjs'
import { weighSurface } from '../tools/measure-surface.mjs'

const report = createReport('surface')

const defaults = await bootPlugin()
try {
  const names = defaults.tools.map((tool) => tool.name).sort()
  report.eq('A1 default tool set is exactly the four hands tools', names, ['hands_act', 'hands_run', 'hands_status', 'hands_view'])
  report.eq('A1 default tool count', defaults.tools.length, 4)

  const measured = weighSurface(defaults.tools)
  report.le('A2 default schema bytes <= 12000', measured.totals.totalBytes, 12000)
  console.log(`     A2 measured: ${measured.totals.totalBytes} B (baseline 35201 B)`)
  for (const row of measured.tools) {
    console.log(`     ${row.name}: desc=${row.descBytes} params=${row.paramSchemaBytes} out=${row.outputSchemaBytes} = ${row.subtotal}`)
  }

  // A3: each write capability is declared by exactly one top-level action enum.
  const capabilityOwners = new Map()
  for (const tool of defaults.tools) {
    const action = tool.parameters && tool.parameters.properties ? tool.parameters.properties.action : null
    const values = action && Array.isArray(action.enum) ? action.enum : []
    for (const value of values) {
      if (!['move', 'click', 'drag', 'scroll', 'type', 'key', 'hotkey'].includes(value)) continue
      const owners = capabilityOwners.get(value) || []
      owners.push(tool.name)
      capabilityOwners.set(value, owners)
    }
  }
  for (const capability of ['move', 'click', 'drag', 'scroll', 'type', 'key', 'hotkey']) {
    report.eq(`A3 ${capability} belongs to hands_act only`, capabilityOwners.get(capability), ['hands_act'])
  }
  report.ok(
    'A3 no mouse_*/screen_* tool is registered under its old name',
    !names.some((name) => name.startsWith('mouse_') || name.startsWith('screen_') || name === 'type_text' || name === 'press_keys'),
  )

  // A10 default: no stroke tool at all.
  report.ok('A10 no stroke tool by default', !names.some((name) => name.includes('stroke')))
  report.ok('A10 stroke engine is not loaded by default', !defaults.mock.logs.some((line) => line.includes('toy') && line.includes('ok') && line.includes('stroke=ok')))
} finally {
  defaults.close()
}

const toy = await bootPlugin({ config: { toyStrokeEnabled: true, toyStrokeMaxPoints: 400 } })
try {
  const names = toy.tools.map((tool) => tool.name).sort()
  report.eq('A10 toy enabled registers exactly one stroke tool', names.filter((name) => name.includes('stroke')), ['stroke_toy'])
  report.eq('A1 toy enabled tool count', toy.tools.length, 5)
  const strokeToy = toy.byName.get('stroke_toy')
  const description = strokeToy ? strokeToy.description : ''
  report.ok('A10 toy description says 玩法/演示', description.includes('玩法') && description.includes('演示'))
  report.ok('A10 toy description says it is not a productivity tool', description.includes('不是生产力'))
  const shape = strokeToy && strokeToy.parameters.properties.shape
  report.ok('A10 toy only offers preset shapes', Array.isArray(shape && shape.enum) && shape.enum.length > 0 && shape.enum.length <= 8)
  const measured = weighSurface(toy.tools)
  report.le('A2+ toy surface bytes still <= 15000', measured.totals.totalBytes, 15000)
  console.log(`     toy surface measured: ${measured.totals.totalBytes} B`)
} finally {
  toy.close()
}

report.finish()
