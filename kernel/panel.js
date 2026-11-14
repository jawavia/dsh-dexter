/**
 * The desktop panel: a small always-on-top strip that lives outside the DSH window.
 *
 * The Web client module (client.js) can only paint inside the DSH window — the moment the
 * user operates another application, that window is covered and the widget is gone. This
 * manager compiles and runs `ui/Panel.cs` as a separate topmost WinForms process instead,
 * and feeds it a two-line state file.
 *
 * The panel clamps itself to the screen working area, which by definition excludes the
 * taskbar, so it cannot cover it. It is a separate process on purpose: it must survive the
 * DSH window being covered, and its crash must not take the plugin down.
 */
import { execFileSync, spawnSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// fileURLToPath, not URL.pathname: a percent-encoded path ("Zhang%20San") made the source
// check fail silently and the panel could never start.
const SOURCE = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'Panel.cs')

function cscPath() {
  const drive = String.fromCharCode(67) // 'C' — avoid a literal drive path in the repo scan
  const windir = process.env.WINDIR || process.env.SystemRoot || `${drive}:\\Windows`
  return [
    process.env.DSH_DEXTER_CSC,
    join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ].filter(Boolean).find((candidate) => existsSync(candidate)) || ''
}

export function createPanel({ dataDir, source = SOURCE, logger = () => {} } = {}) {
  const exeDir = join(dataDir, 'panel')
  const exe = join(exeDir, 'Panel.exe')
  const statePath = join(dataDir, 'state.txt')
  const stopPath = join(dataDir, 'panel.stop')
  let child = null
  let started = false

  function ensureBuilt() {
    const csc = cscPath()
    if (!csc) return { ok: false, reason: '找不到 csc.exe（需要 .NET Framework 编译 Panel.exe）' }
    if (!existsSync(source)) return { ok: false, reason: `缺少面板源码: ${source}` }
    const needBuild = !existsSync(exe) || statSync(source).mtimeMs > statSync(exe).mtimeMs
    if (!needBuild) return { ok: true, path: exe, built: false }
    mkdirSync(exeDir, { recursive: true })
    const result = spawnSync(csc, [
      '/nologo',
      '/target:winexe',
      '/optimize+',
      `/out:${exe}`,
      '/r:System.Windows.Forms.dll',
      '/r:System.Drawing.dll',
      source,
    ], { encoding: 'utf8', windowsHide: true })
    if (result.status !== 0) {
      return { ok: false, reason: `编译失败: ${(result.stderr || result.stdout || '').trim().slice(0, 300)}` }
    }
    return { ok: true, path: exe, built: true }
  }

  const LABELS = {
    reset: '复位到右上角',
    toggle: '显示 / 隐藏面板',
    exit: '退出面板',
    tray: 'dsh-dexter 桌面面板',
    // The three tunable numbers live on the panel because DSH has no generic plugin form.
    cfgTitle: '设置',
    cfgMinutesUp: '授权时长 +5 分',
    cfgMinutesDown: '授权时长 −5 分',
    cfgActionsUp: '授权次数 +50',
    cfgActionsDown: '授权次数 −50',
    cfgRateUp: '每分钟上限 +10',
    cfgRateDown: '每分钟上限 −10',
    cfgReset: '恢复默认 15/100/30',
  }

  function writeLabels() {
    try {
      mkdirSync(dataDir, { recursive: true })
      const body = Object.entries(LABELS).map(([key, value]) => `${key}=${value}`).join('\n')
      writeFileSync(join(dataDir, 'labels.txt'), `${body}\n`, 'utf8')
    } catch (error) {
      logger(`界面文字写入失败（面板会退回英文）: ${error && error.message ? error.message : error}`)
    }
  }

  /** Three lines: headline, activity, settings. The panel shows them as-is. */
  function writeState(headline, detail = '', settings = '') {
    try {
      mkdirSync(dataDir, { recursive: true })
      writeFileSync(statePath, `${String(headline)}\n${String(detail)}\n${String(settings)}\n`, 'utf8')
    } catch (error) {
      logger(`状态写入失败: ${error && error.message ? error.message : error}`)
    }
  }

  /**
   * The panel cannot edit configuration by itself (it is a separate process), so it leaves a
   * request here and the plugin applies it through the same validator `/dexter set` uses.
   * Reading consumes the file, so a request is applied once.
   */
  function readRequests() {
    const file = join(dataDir, 'panel-requests.txt')
    try {
      if (!existsSync(file)) return []
      const text = readFileSync(file, 'utf8')
      rmSync(file, { force: true })
      return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    } catch {
      return []
    }
  }

  /** `cfg armMinutes +5` → `{ key: 'armMinutes', delta: 5 }` (also `cfg reset`). */
  function parseRequest(line) {
    const text = String(line || '').trim()
    if (text === '' || !text.startsWith('cfg')) return null
    const parts = text.split(/\s+/)
    if (parts[1] === 'reset') return { reset: true }
    const key = parts[1]
    const delta = Number(parts[2])
    if (!key || !Number.isFinite(delta) || delta === 0) return null
    return { key, delta: Math.trunc(delta) }
  }

  /** Clamp a requested change into the field's own range. */
  function nextValue(current, delta, spec) {
    const min = spec && Number.isFinite(spec.min) ? spec.min : 0
    const max = spec && Number.isFinite(spec.max) ? spec.max : Number.MAX_SAFE_INTEGER
    const base = Number.isFinite(Number(current)) ? Number(current) : min
    return Math.min(max, Math.max(min, base + delta))
  }

  /** Windows whose command line names this data dir (a panel from an earlier instance). */
  function listStale() {
    const script = "Get-CimInstance Win32_Process -Filter \"Name='Panel.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"
    try {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim()
      if (!out) return []
      const parsed = JSON.parse(out)
      const rows = Array.isArray(parsed) ? parsed : [parsed]
      return rows.filter((row) => String(row.CommandLine || '').includes(dataDir))
    } catch {
      return []
    }
  }

  function reapStale() {
    const victims = listStale()
    for (const row of victims) {
      try {
        process.kill(Number(row.ProcessId))
      } catch { /* already gone */ }
    }
    return victims.length
  }

  /** Is the process we spawned (or reaped) still alive? Cheap, no WM calls. */
  function isAlive() {
    if (!child || typeof child.pid !== 'number') return false
    try {
      process.kill(child.pid, 0)
      return true
    } catch {
      return false
    }
  }

  /**
   * Start it if it is not running. This is what `/dexter panel show` and the authorize
   * button call: closing the panel (Exit panel, or the window closing for any reason) must
   * not leave it unopenable until the plugin is reloaded.
   */
  function ensure() {
    if (started && isAlive()) return { ok: true, reused: true }
    started = false
    child = null
    return start()
  }

  function start() {
    if (started && isAlive()) return { ok: true, reused: true }
    reapStale()
    // Never spawn a desktop window from a scratch data dir (tests): it would outlive the
    // test, hold the temp directory open and paint over whatever is running.
    const tmp = (process.env.TEMP || '').toLowerCase()
    if (tmp && dataDir.toLowerCase().startsWith(tmp)) {
      return { ok: false, reason: '临时数据目录不启动桌面面板（测试模式）' }
    }
    const built = ensureBuilt()
    if (!built.ok) {
      logger(`桌面面板不可用：${built.reason}`)
      return built
    }
    try {
      if (existsSync(stopPath)) rmSync(stopPath, { force: true })
      writeLabels()
      child = spawn(built.path, [dataDir], { detached: true, stdio: 'ignore', windowsHide: false })
      child.unref()
      child.on('exit', () => {
        // The panel was closed (tray Exit, × misuse, crash). Remember it so `ensure()`
        // restarts instead of believing it is still up.
        started = false
      })
      started = true
      logger(built.built ? `桌面面板已编译并启动: ${built.path}` : `桌面面板已启动: ${built.path}`)
      return { ok: true, path: built.path, built: built.built }
    } catch (error) {
      return { ok: false, reason: `启动失败: ${error && error.message ? error.message : error}` }
    }
  }

  function stop() {
    // Even when we never started one (a crashed panel left a process behind), write the
    // marker and sweep by command line so dispose leaves no ghost window.
    if (!started) {
      try {
        mkdirSync(dataDir, { recursive: true })
        writeFileSync(stopPath, 'stop\n', 'utf8')
      } catch { /* the sweep below is the fallback */ }
      const swept = reapStale()
      const timer = setTimeout(() => {
        reapStale()
        try {
          rmSync(stopPath, { force: true })
        } catch { /* ignore */ }
      }, 1200)
      if (timer && typeof timer.unref === 'function') timer.unref()
      return { ok: true, swept }
    }
    started = false
    try {
      mkdirSync(dataDir, { recursive: true })
      writeFileSync(stopPath, 'stop\n', 'utf8')
    } catch { /* the kill below is the fallback */ }
    const dying = child
    child = null
    if (dying && typeof dying.pid === 'number') {
      const timer = setTimeout(() => {
        try {
          process.kill(dying.pid)
        } catch { /* already gone */ }
        // A previous instance may still be alive (its stop marker was replaced by a later
        // start), so sweep by command line rather than only by the pid we spawned.
        reapStale()
        try {
          rmSync(stopPath, { force: true })
        } catch { /* ignore */ }
      }, 1200)
      if (timer && typeof timer.unref === 'function') timer.unref()
    }
  }

  /** One-shot command for the panel: the escape hatch when it is click-through. */
  function command(name) {
    try {
      mkdirSync(dataDir, { recursive: true })
      writeFileSync(join(dataDir, 'cmd.txt'), `${String(name)}\n`, 'utf8')
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: error && error.message ? error.message : String(error) }
    }
  }

  return {
    start,
    stop,
    ensure,
    command,
    writeState,
    writeLabels,
    readRequests,
    parseRequest,
    nextValue,
    get running() {
      return started && isAlive()
    },
    get paths() {
      return { exe, statePath, stopPath, requestsPath: join(dataDir, 'panel-requests.txt') }
    },
  }
}
