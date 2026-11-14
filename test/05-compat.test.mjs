import { readFileSync } from 'node:fs'
import { join } from 'node:path'
/**
 * 05 — compatibility / edge cases at the kernel layer.
 *
 * The old engine's regression net covers DPI, multi-monitor, UWP and DRM behaviour inside
 * the engine; dsh-dexter adds a layer in front of it, so this file covers the cases that
 * layer could break: target classification, routing, verification verdicts, argument
 * coercion and hotkey parsing.
 */
import { createReport } from './assert.mjs'
import { classifyTarget, POLICY_LISTS } from '../kernel/targets.js'
import { routeAct, VIEW_ROUTES } from '../kernel/router.js'
import { verifyForeground, verifyHash } from '../kernel/verify.js'
import { parseCombo, combosFromConfig, comboLabel, DEFAULT_COMBOS } from '../kernel/keys.js'
import { clampInt, redactArgs, hashArgs, stableStringify } from '../kernel/util.js'

const report = createReport('compat/edge cases')

// ---- target classification -------------------------------------------------
const cases = [
  [{ process: 'Huorong\\hipsmain.exe', title: '火绒安全软件' }, 'system', 'security software'],
  [{ process: 'regedit.exe', title: '注册表编辑器' }, 'system', 'registry editor'],
  [{ process: 'taskmgr.exe', title: 'Task Manager' }, 'system', 'task manager'],
  [{ process: 'KeePassXC.exe', title: 'KeePassXC' }, 'system', 'credential manager'],
  [{ process: 'evil.exe', title: 'Windows 安全中心' }, 'system', 'security panel by title'],
  [{ process: 'anything.exe', title: '随便', elevated: true }, 'system', 'elevated window'],
  [{ process: 'WeChat.exe', title: '微信' }, 'sensitive', 'chat app'],
  [{ process: 'chrome.exe', title: '网上银行 - 转账' }, 'sensitive', 'banking title'],
  [{ process: 'notepad.exe', title: 'github2fa.kdbx - Notepad' }, 'sensitive', 'password database in an editor'],
  [{ process: 'outlook.exe', title: 'Inbox' }, 'sensitive', 'mail client'],
  [{ process: 'notepad.exe', title: 'dexter-ab.txt - Notepad' }, 'normal', 'ordinary document'],
  [{ process: '', title: '' }, 'normal', 'unknown target'],
]
for (const [target, expected, label] of cases) {
  const result = classifyTarget(target)
  report.eq(`classify: ${label}`, result.category, expected)
}
report.ok('classify: system reasons are explained', classifyTarget({ process: 'regedit.exe', title: '' }).reasons.length > 0)
report.ok('classify: policy lists are exported read-only', Object.isFrozen(POLICY_LISTS))

// ---- routing ---------------------------------------------------------------
const pixel = { ok: true, name: 'legacy-pixel' }
const uia = { ok: true, name: 'legacy-uia' }
const route = (capability, args, backends) => routeAct({ capability, args, backends }).kind
report.eq('route: coordinates → pixel', route('click', { x: 10, y: 10 }, { pixel, uia }), 'pixel')
report.eq('route: UIA control → uia', route('click', { control: '0/2/1' }, { pixel, uia }), 'uia')
report.eq('route: typing a control → uia', route('type', { control: '0/1', text: 'x' }, { pixel, uia }), 'uia')
report.eq('route: scroll with control falls back to pixel', route('scroll', { control: '0/1' }, { pixel, uia }), 'pixel')
report.eq('route: no pixel → uia fallback', route('click', { x: 1, y: 1 }, { uia }), 'uia')
report.ok('route: no backend reports null', routeAct({ capability: 'click', args: { x: 1, y: 1 }, backends: {} }).backend === null)
report.ok('route: view routes cover every documented action', ['info', 'list', 'focus', 'capture', 'zoom', 'locate', 'text', 'read', 'wait', 'wait_window', 'uia'].every((action) => Object.hasOwn(VIEW_ROUTES, action)))

// ---- verification verdicts -------------------------------------------------
const backend = { foreground: () => ({ handle: 1, title: 'Notepad', process: 'notepad.exe', pid: 10 }) }
report.ok('verify: matching expect passes', verifyForeground({ expect: { titleContains: 'pad' }, backend }).ok)
report.ok('verify: mismatching title fails', verifyForeground({ expect: { titleContains: 'chrome' }, backend }).ok === false)
report.ok('verify: mismatching process fails', verifyForeground({ expect: { process: 'chrome.exe' }, backend }).ok === false)
// Notepad reports the display name "Notepad" in some backends and "notepad.exe" in others.
const displayNameBackend = { foreground: () => ({ handle: 1, title: 'x - Notepad', process: 'Notepad', pid: 10 }) }
report.ok('verify: display name matches image name', verifyForeground({ expect: { process: 'notepad.exe' }, backend: displayNameBackend }).ok)
report.ok('verify: image name matches image name', verifyForeground({ expect: { process: 'notepad.exe' }, backend }).ok)
const anonymousBackend = { foreground: () => ({ handle: 1, title: 'x', pid: 10 }) }
report.ok('verify: unknown process is not a silent pass', verifyForeground({ expect: { process: 'notepad.exe' }, backend: anonymousBackend }).ok === false)
report.ok('verify: no expect is not a failure', verifyForeground({ expect: undefined, backend }).ok)
// A backend without foreground() used to return "后端不提供前台窗口信息" even though the pixel
// backend does know the foreground window; the missing method was the bug.
report.ok('verify: a backend without foreground() is an explicit failure', verifyForeground({ expect: { process: 'notepad.exe' }, backend: { ok: true } }).ok === false)
report.ok('verify: the pixel backend exposes foreground()', (() => {
  const source = readFileSync(join(import.meta.dirname, '..', 'backends', 'legacy-pixel.js'), 'utf8')
  return /\n\s+foreground\(\)\s*\{/.test(source)
})())
// A control name is not a path: the kernel must say so instead of forwarding "文本编辑器" to the
// backend, which failed with a Int32 conversion error.
report.ok('control must be a UIA path, not a name', (() => {
  const source = readFileSync(join(import.meta.dirname, '..', 'kernel', 'kernel.js'), 'utf8')
  return /control 需要 UIA 路径/.test(source)
})())
report.ok('verify: identical hash is a mismatch', verifyHash({ before: 'aa', after: 'aa' }).ok === false)
report.ok('verify: changed hash passes', verifyHash({ before: 'aa', after: 'bb' }).ok)
report.ok('verify: missing hashes are not a failure', verifyHash({ before: '', after: '' }).ok)

// ---- argument coercion -----------------------------------------------------
report.eq('clamp: fractional rounds', clampInt(10.6, 1, 100, 5), 11)
report.eq('clamp: below min', clampInt(-3, 1, 100, 5), 1)
report.eq('clamp: above max', clampInt(9999, 1, 100, 5), 100)
report.eq('clamp: garbage falls back', clampInt('abc', 1, 100, 5), 5)
report.eq('clamp: numeric string accepted', clampInt('42', 1, 100, 5), 42)
const redacted = redactArgs({ text: 'super secret password', x: 10, steps: [1, 2, 3], nested: { a: 1 } })
report.ok('redact: free text becomes a length', redacted.textChars === 'super secret password'.length && redacted.text === undefined)
report.ok('redact: coordinates kept', redacted.x === 10)
report.ok('redact: step list becomes a count', redacted.steps === 3)
report.ok('hash: independent of key order', hashArgs({ a: 1, b: 2 }) === hashArgs({ b: 2, a: 1 }))
report.ok('hash: changes with content', hashArgs({ a: 1 }) !== hashArgs({ a: 2 }))
report.ok('stableStringify: sorts keys', stableStringify({ b: 1, a: 2 }) === '{"a":2,"b":1}')

// ---- hotkey parsing --------------------------------------------------------
report.eq('keys: default arm combo', parseCombo('ctrl+alt+f12', []), ['ctrl', 'alt', 'f12'])
report.eq('keys: alias control → ctrl', parseCombo('control+shift+a', []), ['ctrl', 'shift', 'a'])
report.eq('keys: unparsable falls back', parseCombo('nonsense', DEFAULT_COMBOS.arm), DEFAULT_COMBOS.arm)
report.eq('keys: trailing modifier falls back', parseCombo('ctrl+alt+', DEFAULT_COMBOS.stop), DEFAULT_COMBOS.stop)
const custom = combosFromConfig({ armHotkey: 'ctrl+alt+f8', stopHotkey: 'ctrl+alt+f9' })
report.eq('keys: config overrides arm', custom.arm, ['ctrl', 'alt', 'f8'])
report.eq('keys: config overrides stop', custom.stop, ['ctrl', 'alt', 'f9'])
report.eq('keys: untouched combos keep defaults', custom.extend, DEFAULT_COMBOS.extend)
report.eq('keys: label is upper case', comboLabel(custom.arm), 'CTRL+ALT+F8')

const ok = report.finish()
process.exit(ok ? 0 : 1)
