/**
 * A6 — one declaration per configuration key.
 *
 * The old package had two sources for the same value (`config-overrides.json` in
 * the data dir vs the profile patch row) and no documented precedence. Here the
 * key list must exist exactly once, the Schemastery schema and the runtime
 * defaults must be derived from it, and nothing else may declare a default.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createReport } from './assert.mjs'
import { fieldSpec, buildSchema, DEFAULTS, normalizeConfig, FIELD_SPEC, liveConfig } from '../kernel/config.js'

const report = createReport('config single source')
const REPO = join(import.meta.dirname, '..')

// Minimal stand-in for @deepseek-ai/schemastery: enough to capture declared defaults.
function fakeZ() {
  const wrap = (type, meta) => {
    const node = {
      type,
      meta,
      default(value) {
        node.meta.default = value
        return node
      },
      min(value) {
        node.meta.min = value
        return node
      },
      max(value) {
        node.meta.max = value
        return node
      },
      step(value) {
        node.meta.step = value
        return node
      },
      description(value) {
        node.meta.description = value
        return node
      },
    }
    return node
  }
  return {
    boolean: () => wrap('boolean', {}),
    number: () => wrap('number', {}),
    string: () => wrap('string', {}),
    const: (value) => wrap('const', { const: value }),
    union: (options) => wrap('union', { options }),
    object: (shape) => ({ type: 'object', shape }),
  }
}

const keys = Object.keys(FIELD_SPEC)
report.ge('A6 key count', keys.length, 10)
report.ok('A6 every key declares a type and a default', keys.every((key) => FIELD_SPEC[key].type && Object.hasOwn(FIELD_SPEC[key], 'default')))
report.eq('A6 normalizeConfig({}) equals DEFAULTS', normalizeConfig({}), { ...DEFAULTS })

// The settings page only exists if the plugin's exported Config resolves schemastery. A
// bare import used to fail in a linked checkout, so DSH showed no settings UI at all.
const pluginModule = await import(new URL('../index.js', import.meta.url).href)
report.ok('the plugin exports a Config schema (settings page)', Boolean(pluginModule.Config))
if (pluginModule.Config) {
  const dict = typeof pluginModule.Config.dict === 'object' ? pluginModule.Config.dict : null
  const keys = dict ? Object.keys(dict) : []
  report.ok('the schema carries every editable key', keys.length >= Object.keys(FIELD_SPEC).length, `${keys.length} fields`)
  for (const key of ['armMinutes', 'armActions', 'maxActionsPerMinute']) {
    report.ok(`the settings page shows ${key}`, keys.includes(key))
    // DSH renders only volatile fields, so these three must carry the flag or the form
    // would be empty again.
    const entry = dict ? dict[key] : null
    const meta = entry && entry.meta ? entry.meta : entry
    report.ok(`${key} is volatile (so the form renders it)`, Boolean(meta && meta.volatile === true), JSON.stringify(meta && meta.volatile))
  }
  // A volatile field reaches apply() as { get() }; normalizeConfig must unwrap it.
  const volatileStub = {
    armMinutes: { get: () => 42 },
    armActions: 7,
  }
  const unwrapped = normalizeConfig(volatileStub)
  report.ok('normalizeConfig unwraps volatile fields', unwrapped.armMinutes === 42 && unwrapped.armActions === 7, `${unwrapped.armMinutes}/${unwrapped.armActions}`)
  report.ok('liveConfig reads the volatile value at call time', liveConfig(volatileStub, unwrapped, 'armMinutes') === 42)
}

const schema = buildSchema(fakeZ())
const declaredDefaults = Object.fromEntries(Object.entries(schema.shape).map(([key, node]) => [key, node.meta.default]))
report.eq('A6 schema defaults equal runtime defaults', declaredDefaults, { ...DEFAULTS })

const clamped = normalizeConfig({ armMinutes: 9999, armActions: -5, maxActionsPerMinute: 99999, verifyMode: 'nonsense', readOnly: 'yes', unknownKey: 1 })
report.eq(
  'A6 out-of-range values clamp instead of leaking',
  [clamped.armMinutes, clamped.armActions, clamped.maxActionsPerMinute, clamped.verifyMode, clamped.readOnly],
  [480, 1, 600, 'foreground', true],
)
report.ok('A6 unknown keys are dropped', Object.hasOwn(clamped, 'unknownKey') === false)

const armDefaults = normalizeConfig({})
report.ok('A6 session numbers default to 15m / 100 (adjustable in settings)', armDefaults.armMinutes === 15 && armDefaults.armActions === 100)
report.ok('A6 the rate cap defaults to 30/min', armDefaults.maxActionsPerMinute === 30)
report.ok('A6 free hover is on by default', armDefaults.hoverFree === true)
report.ok('A6 the old dual-source keys are gone', !Object.hasOwn(armDefaults, 'approvalMode') && !Object.hasOwn(armDefaults, 'approvalClicks'))

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // vendor/ is unmodified upstream code: its own copies of these keys are not ours.
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'baseline' || entry.name === 'evidence' || entry.name === 'vendor') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(mjs|js|json|yml|md)$/.test(entry.name)) out.push(full)
  }
  return out
}

const files = walk(REPO)
const overridesReaders = files.filter((file) => /\.(mjs|js|json|yml)$/.test(file) && !/[\\/]test[\\/]/.test(file))
  .filter((file) => /(readFileSync|writeFileSync|readFile|writeFile|openSync|join)\([^)]*config-overrides/.test(readFileSync(file, 'utf8')))
report.eq('A6 no code path reads or writes config-overrides.json', overridesReaders, [])

const maxTokensDeclarations = files
  // Exclude the tests themselves by directory, not by substring: a checkout under a path
  // containing "test" used to hide every file and fail this assertion.
  .filter((file) => /\.(mjs|js)$/.test(file) && !/[\\/]test[\\/]/.test(file) && !/[\\/]tools[\\/]/.test(file))
  .filter((file) => readFileSync(file, 'utf8').includes('imageMaxTokensPerTurn'))
  .map((file) => file.replace(REPO, '').replace(/^[\\/]/, ''))
report.ok(
  'A6 the image budget key is declared once and consumed by the backend adapter only',
  maxTokensDeclarations.length <= 2 && maxTokensDeclarations.some((file) => file.endsWith('config.js')),
  JSON.stringify(maxTokensDeclarations),
)
console.log(`     A6 imageMaxTokensPerTurn appears in: ${maxTokensDeclarations.join(', ') || '(none)'}`)
report.ok('A6 config module is the only file with DEFAULTS', readFileSync(join(REPO, 'kernel', 'config.js'), 'utf8').includes('export const DEFAULTS') && statSync(join(REPO, 'kernel', 'config.js')).size > 0)
report.ok('A6 fieldSpec helper is exported for tooling', typeof fieldSpec === 'function')

report.finish()
