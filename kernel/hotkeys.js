/**
 * The plugin's own global-hotkey owner.
 *
 * The pixel engine's helper hardcodes its arm combo (Ctrl+Alt+F12) for a gate this plugin
 * never uses, so pressing it did nothing here. This module runs a tiny WinForms message pump
 * (`ui/Hotkeys.cs` → `~/.dsh/dexter/hotkeys/Hotkeys.exe`) that registers the combos and
 * prints one line per press; the kernel turns those lines into the same human actions the
 * panel and the command already perform (open a grant, extend it, stop).
 *
 * The engine is asked to release the arm combo only (`DSH_DEXTER_HOTKEYS=arm`), so its own
 * emergency stop stays where it is: even if this listener dies, Ctrl+Alt+F11 still stops the
 * helper at the injection level.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SOURCE_CANDIDATES = ['ui/Hotkeys.cs']

/** In-box csc, the same discovery the desktop panel uses (no PATH assumptions). */
export function cscPath() {
  const windir = process.env.WINDIR || process.env.SystemRoot || ''
  return [
    process.env.DSH_DEXTER_CSC,
    windir ? join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe') : '',
    windir ? join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe') : '',
  ].filter(Boolean).find((candidate) => existsSync(candidate)) || ''
}

/** Compile once, into the data dir, when the source is newer than the exe. */
export function buildHotkeys({ layout, dataDir, csc, logger = () => {} }) {
  const source = SOURCE_CANDIDATES.map((rel) => join(layout, rel)).find((candidate) => existsSync(candidate)) || ''
  if (!source) return { ok: false, reason: `缺少热键监听源码（ui/Hotkeys.cs）` }
  const dir = join(dataDir, 'hotkeys')
  const exe = join(dir, 'Hotkeys.exe')
  try {
    mkdirSync(dir, { recursive: true })
    const needBuild = !existsSync(exe) || statSync(source).mtimeMs > statSync(exe).mtimeMs
    if (!needBuild) return { ok: true, exe, built: false }
    const out = execFileSync(csc, [
      '/nologo', '/target:winexe', '/optimize+', `/out:${exe}`,
      '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', source,
    ], { encoding: 'utf8', windowsHide: true })
    if (out.trim()) logger(out.trim())
    return { ok: existsSync(exe), exe, built: true }
  } catch (error) {
    return { ok: false, reason: `编译热键监听失败: ${error && error.message ? error.message : error}` }
  }
}

/**
 * Parse one listener line: `ready arm=1 extend=0 …`, `failed arm`, `event stop`.
 * Returns null for anything else (the helper also logs free text).
 */
export function parseHotkeyLine(line) {
  const text = String(line || '').trim()
  if (text === '') return null
  if (text === 'ready none') return { kind: 'ready', registered: { arm: false, extend: false, soft: false, stop: false } }
  if (text.startsWith('ready ')) {
    const registered = { arm: false, extend: false, soft: false, stop: false }
    for (const part of text.slice(6).split(/\s+/)) {
      const [key, value] = part.split('=')
      if (key && (key in registered)) registered[key] = value === '1'
    }
    return { kind: 'ready', registered }
  }
  if (text.startsWith('failed ')) {
    const name = text.slice(7).trim()
    return name ? { kind: 'failed', name } : null
  }
  if (text.startsWith('event ')) {
    const name = text.slice(6).trim()
    return name ? { kind: 'event', name } : null
  }
  return null
}

/** Which human action a listener event maps to; unknown names are ignored. */
export function actionOfEvent(name) {
  switch (name) {
    case 'arm': return 'arm'
    case 'extend': return 'extend'
    case 'soft': return 'softStop'
    case 'stop': return 'stop'
    default: return ''
  }
}

/**
 * Start the listener and feed parsed lines to `onLine`. Returns a controller with `stop()`
 * and `summary()`. A crash is reported, never retried in a loop (a hotkey owner that keeps
 * dying would fight the engine for the combo).
 */
export function startHotkeys({ exe, combos, onEvent, onReady, onFailed, onExit, logger = () => {} }) {
  const args = [
    '--arm', String(combos.arm || ''),
    '--extend', String(combos.extend || ''),
    '--soft', String(combos.softStop || ''),
    '--stop', String(combos.stop || ''),
  ]
  let child = null
  let stopped = false
  let registered = null
  const failed = []

  try {
    child = spawn(exe, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
  } catch (error) {
    return { ok: false, reason: `启动热键监听失败: ${error && error.message ? error.message : error}`, stop() {}, summary: () => ({ registered: null, failed }) }
  }

  let buffer = ''
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
      const parsed = parseHotkeyLine(line)
      if (!parsed) {
        if (line.trim()) logger(`热键监听: ${line.trim()}`)
        continue
      }
      if (parsed.kind === 'ready') {
        registered = parsed.registered
        if (typeof onReady === 'function') onReady(parsed.registered)
      } else if (parsed.kind === 'failed') {
        failed.push(parsed.name)
        if (typeof onFailed === 'function') onFailed(parsed.name)
      } else if (parsed.kind === 'event') {
        if (typeof onEvent === 'function') onEvent(parsed.name)
      }
    }
  })
  child.on('exit', (code) => {
    if (stopped) return
    if (typeof onExit === 'function') onExit({ code })
  })
  child.on('error', (error) => logger(`热键监听错误: ${error && error.message ? error.message : error}`))

  return {
    ok: true,
    stop() {
      stopped = true
      try { child.stdin.end() } catch { /* already gone */ }
      try { child.kill() } catch { /* already gone */ }
    },
    get registered() {
      return registered
    },
    summary() {
      return { registered, failed }
    },
  }
}
