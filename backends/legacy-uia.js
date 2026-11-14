/**
 * legacy-uia backend — dsh-x2's Win32 + UI Automation primitives.
 *
 * What this backend owns: injection *primitives* (`SendInput`, `SetCursorPos`,
 * `BitBlt`, the UIA PowerShell bridge). What it does not own: authorization,
 * auditing, verification, the human pause. Those moved into the kernel, which is
 * why the same primitives can now serve `hands_view` and a UIA-targeted
 * `hands_act` without a second audit file appearing.
 *
 * The package is loaded by absolute file URL, so the host's module resolution
 * (profile `node_modules`, plugin links) never decides which copy is used.
 */
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { resolveEngine } from './resolve.js'

function url(dir, file) {
  return pathToFileURL(join(dir, file)).href
}

export async function createUiaBackend({ config, logger = () => {} } = {}) {
  const resolved = resolveEngine('uia', config.legacyUiaPath)
  if (!resolved.ok) {
    return { ok: false, name: 'legacy-uia', reason: resolved.reason, dir: resolved.dir }
  }
  const src = join(resolved.dir, 'src')
  let win32
  let uiaBridge
  let capture
  try {
    win32 = await import(url(src, 'win32.js'))
    uiaBridge = await import(url(src, 'uia.js'))
    capture = await import(url(src, 'capture.js'))
  } catch (error) {
    return {
      ok: false,
      name: 'legacy-uia',
      reason: `加载 ${src} 失败: ${error && error.message ? error.message : error}`,
      dir: resolved.dir,
    }
  }

  const shotDir = join(process.env.DSH_DEXTER_DATA_DIR || join(process.env.DSH_HOME || '', 'dexter'), 'shots')

  const backend = {
    ok: true,
    name: 'legacy-uia',
    dir: resolved.dir,
    source: resolved.source,
    /** Probe used by the kernel's stop bus and human-activity detector. */
    probe: {
      cursor: () => win32.cursorPosition(),
      keyDown: (name) => win32.isKeyDown(name),
    },
    metrics() {
      const metrics = win32.screenMetrics()
      let monitors = []
      try {
        monitors = win32.listMonitors()
      } catch { /* multi-monitor info is optional */ }
      return { ...metrics, monitors }
    },
    windows() {
      return win32.listWindows().map((win) => ({
        handle: win.handle,
        hwndRaw: win.hwndRaw,
        title: win.title,
        class: win.class,
        pid: win.pid,
        rect: win.rect,
        minimized: win.minimized,
        maximized: win.maximized,
      }))
    },
    foreground() {
      const window = win32.foregroundWindow()
      if (!window) return null
      return { ...window, process: this.processNameOf(window.pid) }
    },
    /** Executable path behind a pid ('' when unreadable). */
    processNameOf(pid) {
      try {
        return win32.processNameOfPid(Number(pid)) || ''
      } catch {
        return ''
      }
    },
    focus(handle) {
      const windows = win32.listWindows()
      const target = windows.find((win) => String(win.handle) === String(handle))
      if (!target) {
        const byTitle = win32.windowHandleByTitle(String(handle))
        if (!byTitle) return { ok: false, reason: `找不到窗口 ${handle}` }
        return { ok: win32.focusWindow(byTitle.hwndRaw), window: byTitle }
      }
      return { ok: win32.focusWindow(target.hwndRaw), window: target }
    },
    isLocked() {
      try {
        return win32.isLocked()
      } catch {
        return true
      }
    },
    /** Screenshot with the engine's dedupe/scale bookkeeping intact. */
    capture(options = {}) {
      return capture.grab({ dir: shotDir, maxWidth: config.captureLongSide, maxHeight: config.captureLongSide, ...options })
    },
    uia(request) {
      return uiaBridge.uia(request, { timeoutMs: 20000 })
    },
    uiaActions: uiaBridge.uiaActions,
    click(point, options = {}) {
      win32.click(point.x, point.y, options)
    },
    drag(from, to, options = {}) {
      win32.drag(from, to, options)
    },
    scroll(point, options = {}) {
      win32.scroll(point.x, point.y, options)
    },
    type(text, options = {}) {
      win32.typeText(text, options)
    },
    key(name, options = {}) {
      win32.pressKey(name, options)
    },
    hotkey(keys) {
      win32.hotkey(keys)
    },
    move(point) {
      return win32.tryMoveCursor(point.x, point.y)
    },
    releaseAll() {
      try {
        win32.releaseAllInputs()
      } catch { /* nothing held */ }
    },
    /** Window-relative rectangle lookup used by target resolution. */
    rectOf(handle) {
      const windows = win32.listWindows()
      const hit = windows.find((win) => String(win.handle) === String(handle))
      return hit ? hit.rect : null
    },
    dispose() {
      try {
        uiaBridge.stopUiaWorker()
      } catch { /* worker never started */ }
      logger('[dexter] legacy-uia backend disposed')
    },
  }
  return backend
}
