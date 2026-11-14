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
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const SOURCE = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'ui', 'Panel.cs')

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

  /** One or two lines: headline, optional detail. The panel shows them as-is. */
  function writeState(headline, detail = '') {
    try {
      mkdirSync(dataDir, { recursive: true })
      writeFileSync(statePath, `${String(headline)}\n${String(detail)}\n`, 'utf8')
    } catch (error) {
      logger(`状态写入失败: ${error && error.message ? error.message : error}`)
    }
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

  function start() {
    if (started) return { ok: true, reused: true }
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
      child = spawn(built.path, [dataDir], { detached: true, stdio: 'ignore', windowsHide: false })
      child.unref()
      started = true
      logger(built.built ? `桌面面板已编译并启动: ${built.path}` : `桌面面板已启动: ${built.path}`)
      return { ok: true, path: built.path, built: built.built }
    } catch (error) {
      return { ok: false, reason: `启动失败: ${error && error.message ? error.message : error}` }
    }
  }

  function stop() {
    if (!started) return
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

  return {
    start,
    stop,
    writeState,
    get running() {
      return started
    },
    get paths() {
      return { exe, statePath, stopPath }
    },
  }
}
