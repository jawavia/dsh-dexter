/**
 * The kernel: one place where observation, authorization, injection, verification
 * and the audit row are ordered the same way for every backend.
 *
 * TaskFSM per write:  idle → precheck → authorize → act → settle → verify → audit
 * A `hands_run` batch is the same FSM repeated, with one human decision for the
 * batch and one audit row per step, plus a resume point when a step fails.
 */
import { routeAct, VIEW_ROUTES, CONTROL_CAPABILITIES } from './router.js'
import { verifyForeground, verifyHash, captureHash, settle } from './verify.js'
import { describeConfig } from './config.js'
import { classifyTarget, systemRefusal, sensitiveNote } from './targets.js'
import { clampInt, hashArgs, redactArgs, shortText } from './util.js'

const COORDINATE_CAPABILITIES = new Set(['click', 'drag', 'scroll', 'type', 'key', 'hotkey'])

function splitKeys(value) {
  if (Array.isArray(value)) return value.map((part) => String(part).trim()).filter(Boolean)
  if (typeof value !== 'string') return []
  return value.split('+').map((part) => part.trim()).filter(Boolean)
}

function pointFrom(args = {}) {
  if (typeof args.x === 'number' && typeof args.y === 'number') return { x: Math.round(args.x), y: Math.round(args.y) }
  return null
}

export class Kernel {
  /**
   * @param {object} options
   * @param {object} options.config normalized config
   * @param {import('./audit.js').Audit} options.audit
   * @param {import('./gate.js').Gate} options.gate
   * @param {import('./stopbus.js').StopBus} options.stopbus
   * @param {import('./human.js').HumanActivity} options.human
   * @param {{pixel?:object|null, uia?:object|null, toy?:object|null}} options.backends
   * @param {(message:string)=>void} [options.logger]
   * @param {()=>number} [options.clock]
   */
  constructor({ config, audit, gate, stopbus, human, backends = {}, attachments = null, buttons = null, docsPath = '', logger = () => {}, clock = () => Date.now() } = {}) {
    this.config = config
    this.audit = audit
    this.gate = gate
    this.stopbus = stopbus
    this.human = human
    this.backends = backends
    this.attachments = attachments
    this.buttons = buttons
    this.docsPath = docsPath
    this.logger = logger
    this.now = clock
    this.lastViewAt = 0
    this.lastViewAction = ''
    this.runs = 0
    this.stoppedAt = 0
  }

  // ---- audit ---------------------------------------------------------------

  #row(fields) {
    try {
      return this.audit.append({ tool: 'hands', ...fields })
    } catch {
      return null
    }
  }

  #writeRow({ tool, capability, backend, engineTool, decision, approval, dryRun = false, result, verify, reason, args, durationMs, extra }) {
    return this.#row({
      tool,
      capability,
      backend: backend || 'none',
      engineTool: engineTool || '',
      decision,
      approval: approval || 'none',
      dryRun,
      result: result || '',
      verify: verify || '',
      reason: shortText(reason || '', 240),
      argsHash: args === undefined ? '' : hashArgs(redactArgs(args)),
      durationMs: durationMs === undefined ? undefined : Math.max(0, Math.round(durationMs)),
      ...extra,
    })
  }

  // ---- view ----------------------------------------------------------------

  /**
   * Read path. Never injects; sets the observation freshness stamp that a
   * coordinate write needs.
   */
  async view({ action, args = {}, exec = {} } = {}) {
    const startedAt = this.now()
    const route = VIEW_ROUTES[action] || 'pixel'
    if (route === 'uia') {
      const result = await this.#viewUia({ action, args })
      if (result.ok || result.fatal) {
        this.#recordView({ action, ok: result.ok, startedAt, backend: 'legacy-uia', exec })
        return result
      }
      // Fall through to the pixel engine only for the actions it also answers.
      const fallback = await this.#viewPixel({ action, args, exec })
      if (fallback.ok) fallback.text = `${result.text}\n（legacy-uia 不可用，已退回 legacy-pixel）`
      this.#recordView({ action, ok: fallback.ok, startedAt, backend: 'legacy-pixel', exec })
      return fallback
    }
    const result = await this.#viewPixel({ action, args, exec })
    this.#recordView({ action, ok: result.ok, startedAt, backend: 'legacy-pixel', exec })
    // The handbook is on-demand: only a path is added, so it costs no context until read.
    if (action === 'info' && result.ok && this.docsPath) {
      result.text = `${result.text}\n手册（按需读，不占上下文）：${this.docsPath}`
    }
    return result
  }

  #recordView({ action, ok, startedAt, backend, exec }) {
    if (ok) {
      this.lastViewAt = this.now()
      this.lastViewAction = action
    }
    this.#row({
      tool: 'hands_view',
      capability: action,
      backend,
      decision: 'view',
      approval: 'none',
      dryRun: false,
      result: ok ? 'ok' : 'failed',
      agent: exec?.agent?.id,
      durationMs: this.now() - startedAt,
    })
  }

  async #viewPixel({ action, args, exec }) {
    const pixel = this.backends.pixel
    if (!pixel || !pixel.ok) {
      return { ok: false, fatal: true, text: `没有可用的读屏后端（legacy-pixel ${pixel ? pixel.reason : '未加载'}）。` }
    }
    const payload = {}
    const copy = (keys) => {
      for (const key of keys) if (args[key] !== undefined) payload[key] = args[key]
    }
    switch (action) {
      case 'info':
        break
      case 'capture':
        copy(['x', 'y', 'fx', 'fy', 'includeText', 'window'])
        if (args.region) payload.region_rect = args.region
        break
      case 'zoom':
        copy(['x', 'y', 'fx', 'fy', 'scale', 'size', 'window'])
        break
      case 'locate':
        copy(['x', 'y', 'fx', 'fy', 'window'])
        break
      case 'text':
        copy(['window', 'maxElements', 'region'])
        if (args.query !== undefined) payload.query = args.query
        break
      case 'read':
        copy(['window', 'maxElements', 'region'])
        if (args.query !== undefined) payload.query = args.query
        break
      case 'wait':
        if (args.region) payload.region_rect = args.region
        if (args.timeoutMs !== undefined) payload.timeoutMs = args.timeoutMs
        break
      case 'wait_window':
        copy(['window', 'timeoutMs'])
        break
      case 'list':
        if (args.query !== undefined) payload.filter = args.query
        if (args.limit !== undefined) payload.limit = args.limit
        break
      case 'focus':
        copy(['window'])
        break
      default:
        return { ok: false, text: `legacy-pixel 不支持 view action=${action}` }
    }
    const result = await pixel.view({ action, args: payload, exec })
    return { ok: result.ok, text: result.text, imageRef: result.imageRef }
  }

  async #viewUia({ action, args = {} }) {
    const uia = this.backends.uia
    if (!uia || !uia.ok) {
      return { ok: false, text: `legacy-uia 后端不可用（${uia ? uia.reason : '未加载'}）。` }
    }
    if (action === 'list') {
      try {
        const windows = uia.windows()
        const needle = typeof args.query === 'string' ? args.query.toLowerCase() : ''
        const limit = clampInt(args.limit, 1, 100, 25)
        const rows = windows
          .filter((win) => {
            if (!needle) return Boolean(win.title)
            return String(win.title).toLowerCase().includes(needle)
          })
          .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height))
          .slice(0, limit)
        const foreground = uia.foreground()
        const lines = [`可见窗口 ${rows.length}（共 ${windows.length}）${needle ? `，过滤「${args.query}」` : ''}`]
        for (const win of rows) {
          const rect = win.rect || {}
          const flags = [win.minimized ? '最小化' : '', String(win.handle) === String(foreground?.handle) ? '前台' : ''].filter(Boolean)
          lines.push(`- ${win.title} · handle=${win.handle} pid=${win.pid} ${rect.width}x${rect.height}@${rect.x},${rect.y}${flags.length ? ` [${flags.join(',')}]` : ''}`)
        }
        if (foreground) lines.push(`前台: ${foreground.title} handle=${foreground.handle}`)
        return { ok: true, text: lines.join('\n') }
      } catch (error) {
        return { ok: false, text: `列出窗口失败: ${error && error.message ? error.message : error}` }
      }
    }
    if (action === 'focus') {
      const spec = args.window && typeof args.window === 'object' ? args.window : null
      if (!spec) return { ok: false, text: 'focus 需要 window：{handle} 或 {titleContains}。' }
      const target = this.#resolveWindow(spec)
      if (!target.ok) return { ok: false, text: target.reason }
      const focused = uia.focus(target.handle)
      if (!focused || focused.ok === false) {
        return { ok: false, text: `切不到前台：${focused && focused.reason ? focused.reason : '系统拒绝'}。本次未发送任何输入。` }
      }
      const foreground = uia.foreground()
      return {
        ok: true,
        text: `已切到前台: ${target.title || target.handle}（当前前台: ${foreground ? foreground.title : '未知'}）`,
      }
    }
    if (action === 'uia') {
      const spec = args.window && typeof args.window === 'object' ? args.window : null
      const handle = spec ? this.#resolveWindow(spec) : { ok: true, handle: null }
      if (!handle.ok) return { ok: false, text: handle.reason }
      const numeric = handle.handle ?? (uia.foreground() ? uia.foreground().handle : null)
      if (!numeric) return { ok: false, text: '没有目标窗口：给 window 或者先切一个前台窗口。' }
      try {
        if (typeof args.path === 'string' && args.path.trim() !== '') {
          const rect = await uia.uia({ action: 'rect', handle: Number(numeric), path: args.path.trim() })
          if (!rect || rect.ok === false) return { ok: false, text: `读取控件位置失败: ${rect && rect.error ? rect.error : '未知'}` }
          const r = rect.rect || {}
          return {
            ok: true,
            text: `控件 ${args.path} 位置: ${r.width}x${r.height}@${r.x},${r.y}（可用于 hands_act control=${args.path}）`,
          }
        }
        const request = { action: typeof args.query === 'string' && args.query !== '' ? 'find' : 'tree', handle: Number(numeric) }
        if (typeof args.query === 'string' && args.query !== '') request.name = args.query
        if (args.maxElements !== undefined) request.maxNodes = clampInt(args.maxElements, 1, 200, 40)
        const result = await uia.uia(request)
        if (!result || result.ok === false) return { ok: false, text: `UIA 读取失败: ${result && result.error ? result.error : '未知'}` }
        return { ok: true, text: `UIA ${request.action}：${JSON.stringify(result).slice(0, 4000)}` }
      } catch (error) {
        return { ok: false, text: `UIA 读取抛错: ${error && error.message ? error.message : error}` }
      }
    }
    return { ok: false, text: `legacy-uia 不支持 view action=${action}` }
  }

  // ---- target helpers ------------------------------------------------------

  #resolveWindow(spec = {}) {
    const uia = this.backends.uia
    if (!uia || !uia.ok) return { ok: false, reason: 'legacy-uia 不可用，无法解析窗口。' }
    let windows = []
    try {
      windows = uia.windows()
    } catch (error) {
      return { ok: false, reason: `枚举窗口失败: ${error && error.message ? error.message : error}` }
    }
    if (spec.handle !== undefined && spec.handle !== null) {
      const hit = windows.find((win) => String(win.handle) === String(spec.handle))
      if (!hit) return { ok: false, reason: `找不到窗口 handle=${spec.handle}` }
      return { ok: true, handle: hit.handle, title: hit.title }
    }
    if (typeof spec.titleContains === 'string' && spec.titleContains.trim() !== '') {
      const needle = spec.titleContains.toLowerCase()
      const hit = windows.find((win) => String(win.title).toLowerCase().includes(needle))
      if (!hit) return { ok: false, reason: `找不到标题包含「${spec.titleContains}」的窗口` }
      return { ok: true, handle: hit.handle, title: hit.title }
    }
    if (spec.pid !== undefined && spec.pid !== null) {
      const hit = windows.find((win) => Number(win.pid) === Number(spec.pid))
      if (!hit) return { ok: false, reason: `找不到 pid=${spec.pid} 的窗口` }
      return { ok: true, handle: hit.handle, title: hit.title }
    }
    return { ok: false, reason: 'window 需要 handle / titleContains / pid 之一。' }
  }

  async #resolveControlRect({ control, window: windowSpec }) {
    const uia = this.backends.uia
    if (!uia || !uia.ok) return { ok: false, reason: 'legacy-uia 不可用，无法按控件路径定位。' }
    let handle = null
    if (windowSpec && typeof windowSpec === 'object') {
      const resolved = this.#resolveWindow(windowSpec)
      if (!resolved.ok) return { ok: false, reason: resolved.reason }
      handle = resolved.handle
    } else {
      const foreground = uia.foreground()
      handle = foreground ? foreground.handle : null
    }
    if (handle === null) return { ok: false, reason: '没有目标窗口（也没有前台窗口）。' }
    try {
      const rect = await uia.uia({ action: 'rect', handle: Number(handle), path: control })
      if (!rect || rect.ok === false || !rect.rect) {
        return { ok: false, reason: `控件 ${control} 取不到位置: ${rect && rect.error ? rect.error : '未知'}` }
      }
      const r = rect.rect
      return {
        ok: true,
        handle,
        point: { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) },
        rect: r,
      }
    } catch (error) {
      return { ok: false, reason: `控件 ${control} 定位抛错: ${error && error.message ? error.message : error}` }
    }
  }

  /**
   * Which window will this step actually touch? Best effort, read-only.
   *  - window spec  → the named window
   *  - coordinates  → the window under that point (engine helper probe_at)
   *  - keyboard     → the foreground window
   * Returns a classified target; failures degrade to 'normal' with an honest label so
   * a probe failure can never be mistaken for "this is safe".
   */
  async #classifyForStep(capability, args = {}) {
    let info = null
    let source = 'unknown'
    try {
      if (args.window && typeof args.window === 'object') {
        const resolved = this.#resolveWindow(args.window)
        if (resolved.ok) {
          const uia = this.backends.uia
          const windows = uia && uia.ok ? uia.windows() : []
          const hit = windows.find((win) => String(win.handle) === String(resolved.handle))
          info = {
            process: hit && uia.processNameOf ? uia.processNameOf(hit.pid) : '',
            title: resolved.title || (hit ? hit.title : ''),
            elevated: false,
            handle: resolved.handle,
          }
          source = 'window'
        }
      } else {
        const point = pointFrom(args)
        if (point && this.backends.pixel && this.backends.pixel.ok && typeof this.backends.pixel.probeAt === 'function') {
          const probed = await this.backends.pixel.probeAt(point.x, point.y)
          if (probed) {
            info = {
              process: probed.process || '',
              title: probed.title || '',
              elevated: probed.elevated === true,
              handle: probed.handle,
            }
            source = 'point'
          }
        }
        if (!info) {
          const uia = this.backends.uia
          const foreground = uia && uia.ok ? uia.foreground() : null
          if (foreground) {
            info = {
              process: foreground.process || (uia.processNameOf ? uia.processNameOf(foreground.pid) : ''),
              title: foreground.title || '',
              elevated: false,
              handle: foreground.handle,
            }
            source = capability === 'type' || capability === 'key' || capability === 'hotkey' ? 'foreground' : 'foreground-fallback'
          }
        }
      }
    } catch {
      info = null
    }
    if (!info) return { category: 'normal', reasons: [], label: '(目标未知)', source }
    return classifyTarget({ ...info, source })
  }

  #describeCapability(capability, args) {    const point = pointFrom(args)
    if (capability === 'click') return `点击 ${point ? `${point.x},${point.y}` : args.control ? `控件 ${args.control}` : '未给坐标'}${args.button && args.button !== 'left' ? ` ${args.button}` : ''}`
    if (capability === 'move') return `移动光标 ${point ? `${point.x},${point.y}` : ''}`
    if (capability === 'drag') return `从 ${point ? `${point.x},${point.y}` : '?'} 拖到 ${args.toX !== undefined ? `${args.toX},${args.toY}` : '?'}`
    if (capability === 'scroll') return `滚动 deltaY=${args.deltaY ?? 0} deltaX=${args.deltaX ?? 0}`
    if (capability === 'type') return `输入 ${String(args.text ?? '').length} 个字符`
    if (capability === 'key') return `按键 ${splitKeys(args.key ?? args.keys).join('+')}`
    if (capability === 'hotkey') return `快捷键 ${splitKeys(args.keys ?? args.key).join('+')}`
    if (capability === 'clipboard_get') return '读取剪贴板（隐私）'
    if (capability === 'clipboard_set') return `写入剪贴板 ${String(args.text ?? '').length} 个字符`
    return capability
  }

  // ---- write path ----------------------------------------------------------

  /** `hands_act`. */
  async act({ action, args = {}, exec = {} } = {}) {
    const startedAt = this.now()
    const capability = String(action || '').trim().toLowerCase()
    if (capability === 'stop') return this.#stopFromTool(exec)
    if (!['move', 'click', 'drag', 'scroll', 'type', 'key', 'hotkey', 'clipboard_get', 'clipboard_set'].includes(capability)) {
      return { ok: false, text: `未知 action "${action}"：可用的写动作是 move/click/drag/scroll/type/key/hotkey（另有 stop 立即撤销授权）。` }
    }
    const dryRun = args.dryRun === true
    const invalid = this.#invalidArgument(capability, args)
    if (invalid) return invalid

    if (dryRun) {
      const preview = this.#preview(capability, args)
      this.#writeRow({
        tool: 'hands_act',
        capability,
        backend: preview.backend,
        decision: 'dry-run',
        approval: 'none',
        dryRun: true,
        result: preview.wouldRefuse ? 'would-refuse' : 'ok',
        reason: preview.wouldRefuse ? preview.blockers.join('; ') : '',
        args,
        durationMs: this.now() - startedAt,
        extra: { blocked: preview.blockers.length, agent: exec?.agent?.id },
      })
      return { ok: true, text: preview.text, dryRun: true }
    }

    // Never ask the human for something this plugin refuses permanently.
    const target = await this.#classifyForStep(capability, args)
    if (target.category === 'system') {
      this.#writeRow({
        tool: 'hands_act',
        capability,
        decision: 'denied',
        approval: 'none',
        reason: `system-target: ${target.label}`,
        args,
        durationMs: this.now() - startedAt,
      })
      return { ok: false, text: systemRefusal(target) }
    }

    const idle = await this.human.waitForIdle({ signal: exec.signal })
    // Stop dominates everything: a stopped gate must refuse immediately instead of
    // waiting for the human to go idle and then acting.
    const stopped = this.#stopDenial()
    if (stopped) {
      this.#writeRow({
        tool: 'hands_act',
        capability,
        decision: 'denied',
        approval: 'none',
        reason: stopped,
        args,
        durationMs: this.now() - startedAt,
      })
      return { ok: false, text: stopped }
    }
    if (!idle.ok) {
      this.#writeRow({
        tool: 'hands_act',
        capability,
        decision: 'denied',
        approval: 'none',
        reason: `human-active: ${idle.reason}`,
        args,
        durationMs: this.now() - startedAt,
      })
      return { ok: false, text: `⛔ 人类正在操作这台电脑（${idle.reason}），这一下没有注入任何输入。等真人停下来（或等 ${Math.round(this.config.humanIdleResumeMs / 1000)} 秒空闲）再试。` }
    }

    const reason = this.#describeCapability(capability, args)
    // Free hover (config.hoverFree): authorized by policy, but only when no mouse button
    // is held — a held button turns SendInput movement into a drag — and only with a
    // working button probe (fail closed if it cannot answer).
    let hoverFree = false
    if (capability === 'move' && this.config.hoverFree) {
      const probe = this.buttons
      let down = null
      if (probe && probe.ok) {
        try {
          down = probe.buttonsDown()
        } catch {
          down = null
        }
      }
      if (Array.isArray(down) && down.length === 0) {
        hoverFree = true
      } else if (Array.isArray(down) && down.length > 0) {
        this.#writeRow({
          tool: 'hands_act',
          capability,
          decision: 'denied',
          approval: 'none',
          reason: `button-held: ${down.join(',')}`,
          args,
          durationMs: this.now() - startedAt,
        })
        return { ok: false, text: `⛔ 有鼠标键正按着（${down.join('、')}）：这时候移动光标等于拖拽。先松开再悬停。` }
      } else {
        this.logger('[dexter] 鼠标键探测不可用，悬停按普通写动作处理')
      }
    }
    const auth = await this.gate.authorize({
      tool: 'hands_act',
      capability,
      exec,
      reason,
      target: target.label,
      hoverFree,
      // Clipboard is shared state that other programs may read, so it always takes the
      // per-write question — a session grant never covers the clipboard.
      forceAsk: (target.category === 'sensitive' && this.config.sensitiveAsk) || capability.startsWith('clipboard'),
    })
    if (!auth.allowed) {
      this.#writeRow({
        tool: 'hands_act',
        capability,
        decision: 'denied',
        approval: 'none',
        reason: auth.reason,
        args,
        durationMs: this.now() - startedAt,
      })
      return { ok: false, text: auth.reason }
    }

    const stale = this.#freshLookViolation(capability, args)
    if (stale) {
      this.#writeRow({
        tool: 'hands_act',
        capability,
        decision: 'denied',
        approval: auth.approval,
        reason: 'stale-observation',
        args,
        durationMs: this.now() - startedAt,
      })
      return { ok: false, text: stale }
    }

    const forceAsk = target.category === 'sensitive' && this.config.sensitiveAsk
    const step = await this.#runOne({
      tool: 'hands_act',
      capability,
      args,
      exec,
      approval: auth.approval,
      sensitiveHandled: forceAsk,
    })
    return { ok: step.ok, text: step.text, imageRef: step.imageRef }
  }

  /** Refusal text when the gate is stopped, otherwise ''. */
  #stopDenial() {
    const snapshot = this.gate.snapshot()
    if (!snapshot.stopped) return ''
    return `⛔ 急停状态（${snapshot.stopped.level}，by=${snapshot.stopped.by}${snapshot.stopped.reason ? `，${snapshot.stopped.reason}` : ''}）：`
      + '当前没有任何授权，下一次写动作一律拒绝。需要继续时由人手执行 /dexter arm 或按 Ctrl+Alt+F12 重新授权。'
  }

  #invalidArgument(capability, args) {
    if (capability === 'type' && (typeof args.text !== 'string' || args.text === '')) {
      return { ok: false, text: 'type 需要非空的 text。' }
    }
    if ((capability === 'key' || capability === 'hotkey') && splitKeys(args.key ?? args.keys).length === 0) {
      return { ok: false, text: `${capability} 需要 key（如 "enter"）或 keys（如 "ctrl+s"）。` }
    }
    if (capability === 'clipboard_set' && (typeof args.text !== 'string' || args.text === '')) {
      return { ok: false, text: 'clipboard_set 需要非空的 text。' }
    }
    if (capability === 'drag' && (args.toX === undefined || args.toY === undefined)) {
      return { ok: false, text: 'drag 需要 toX/toY 终点。' }
    }
    if ((capability === 'click' || capability === 'move' || capability === 'drag' || capability === 'scroll')
      && !pointFrom(args) && !args.control && !(args.window && (args.fx !== undefined || args.fy !== undefined))) {
      return { ok: false, text: `${capability} 需要坐标（x/y 或 fx/fy 或 window+fx/fy）或 control 路径。` }
    }
    return null
  }

  #freshLookViolation(capability, args) {
    if (!COORDINATE_CAPABILITIES.has(capability)) return ''
    if (args.control) return ''
    const limitMs = this.config.requireFreshLookSeconds * 1000
    if (limitMs <= 0) return ''
    const age = this.now() - this.lastViewAt
    if (age <= limitMs) return ''
    const detail = this.lastViewAt === 0 ? '还没看过屏幕' : `上一次观察是 ${Math.round(age / 1000)} 秒前`
    return `⛔ 先看一眼再动手：${detail}（要求 ${this.config.requireFreshLookSeconds} 秒内 hands_view 过一次）。`
  }

  /** Rehearse without injecting: same routing and the same blocker list. */
  #preview(capability, args) {
    const route = routeAct({ capability, args, backends: this.backends })
    const blockers = []
    const lines = []
    if (!route.backend) blockers.push(route.reason)
    const snapshot = this.gate.snapshot()
    if (snapshot.stopped) blockers.push(`急停状态（${snapshot.stopped.level}）未解除`)
    if (snapshot.grant) lines.push(`授权：${snapshot.grant.kind} grant 剩 ${snapshot.grant.left} 次 / ${Math.round(snapshot.grant.remainingMs / 1000)}s`)
    else if (this.gate.hasApprovalChannel()) lines.push('授权：正式执行时会逐次向人类请示（预演不请示）')
    else lines.push('授权：正式执行需要人手开授权窗口（预演不消耗）')
    if (this.human.isSuspended()) blockers.push('人类正在操作（正式执行会先暂停）')
    const stale = this.#freshLookViolation(capability, args)
    if (stale) blockers.push(stale.replace('⛔ ', ''))
    if (capability === 'click' && args.control) {
      lines.push(`目标：UIA 控件 ${args.control}（正式执行时重新量位置）`)
    } else if (args.window) {
      lines.push(`目标：窗口 ${JSON.stringify(args.window)} 相对坐标（fx=${args.fx ?? '-'} fy=${args.fy ?? '-'}）`)
    } else {
      const point = pointFrom(args)
      lines.push(`目标：${point ? `屏幕物理坐标 ${point.x},${point.y}` : '未给坐标'}`)
    }
    lines.push(`后端：${route.kind === 'uia' ? 'legacy-uia' : 'legacy-pixel'}`)
    const head = `dryRun（预演：没有注入任何输入、没有移动光标、没有截图、不消耗授权）: ${capability}`
    const verdict = blockers.length > 0
      ? ['预演结论：正式执行会被拒绝', ...blockers.map((blocker, index) => `  ${index + 1}. ⛔ ${blocker}`)]
      : ['预演结论：预计可以执行（正式执行仍会请求人类授权并真的注入输入）。']
    return {
      backend: route.kind === 'uia' ? 'legacy-uia' : 'legacy-pixel',
      wouldRefuse: blockers.length > 0,
      blockers,
      text: [head, ...lines.map((line) => `  ✓ ${line}`), ...verdict].join('\n'),
    }
  }

  /** One authorized action: route → inject → settle → verify → audit. */
  async #runOne({ tool, capability, args, exec = {}, approval, allowResume = false, sensitiveHandled = false }) {
    const startedAt = this.now()
    // Per-step target policy: a batch authorization must never cover a system window,
    // and a sensitive window still needs its own question.
    const target = await this.#classifyForStep(capability, args)
    if (target.category === 'system') {
      this.#writeRow({ tool, capability, decision: 'denied', approval: 'none', reason: `system-target: ${target.label}`, args, durationMs: this.now() - startedAt })
      return { ok: false, text: systemRefusal(target) }
    }
    let stepApproval = approval
    // Clipboard read is a gated read: it has no window target, so it skips routing,
    // verification and the batch machinery and goes straight to the engine's own tool.
    if (capability === 'clipboard_get') {
      const pixel = this.backends.pixel
      if (!pixel || !pixel.ok || typeof pixel.clipboardGet !== 'function') {
        this.#writeRow({ tool, capability, decision: 'error', approval: stepApproval, result: 'no-backend', reason: 'legacy-pixel 不可用', args, durationMs: this.now() - startedAt })
        return { ok: false, text: '⛔ 没有可用的剪贴板后端（legacy-pixel 不可用）。' }
      }
      const read = await pixel.clipboardGet({ exec, requireText: args.requireText === true })
      const okRead = Boolean(read.ok)
      this.#writeRow({
        tool,
        capability,
        backend: 'legacy-pixel',
        engineTool: read.engineTool || 'clipboard_get',
        decision: 'executed',
        approval: stepApproval,
        result: okRead ? 'ok' : 'failed',
        verify: 'none',
        args,
        durationMs: this.now() - startedAt,
        extra: { agent: exec?.agent?.id },
      })
      return { ok: okRead, text: read.text }
    }
    if (target.category === 'sensitive' && this.config.sensitiveAsk && !sensitiveHandled) {
      const asked = await this.gate.authorize({
        tool,
        capability,
        exec,
        reason: this.#describeCapability(capability, args),
        target: target.label,
        forceAsk: true,
      })
      if (!asked.allowed) {
        this.#writeRow({ tool, capability, decision: 'denied', approval: 'none', reason: asked.reason, args, durationMs: this.now() - startedAt })
        return { ok: false, text: `${sensitiveNote(target)}\n${asked.reason}` }
      }
      stepApproval = asked.approval
    }
    const route = routeAct({ capability, args, backends: this.backends })
    if (!route.backend) {
      this.#writeRow({ tool, capability, decision: 'error', approval: stepApproval, result: 'no-backend', reason: route.reason, args, durationMs: this.now() - startedAt })
      return { ok: false, text: `⛔ 没有可用的写后端：${route.reason}` }
    }
    const beforeHash = this.config.verifyMode === 'hash' && this.backends.uia && this.backends.uia.ok
      ? captureHash(this.backends.uia, this.#regionOf(args))
      : ''
    this.human.beginInjection()
    let outcome
    try {
      outcome = route.kind === 'uia'
        ? await this.#performUia({ capability, args, exec })
        : await this.backends.pixel.act({ capability, args, exec })
    } catch (error) {
      outcome = { ok: false, text: `注入抛错: ${error && error.message ? error.message : error}`, engineTool: '' }
    } finally {
      this.human.endInjection()
    }
    await settle(this.config.settleMs)

    let verify = { mode: 'none', ok: true, detail: '' }
    if (this.config.verifyMode === 'foreground') {
      verify = verifyForeground({ expect: args.expect, backend: route.backend })
    } else if (this.config.verifyMode === 'hash') {
      const afterHash = this.backends.uia && this.backends.uia.ok ? captureHash(this.backends.uia, this.#regionOf(args)) : ''
      verify = verifyHash({ before: beforeHash, after: afterHash, region: this.#regionOf(args) })
    }

    const ok = Boolean(outcome.ok)
    const text = `${outcome.text}${verify.mode !== 'none' && !verify.ok ? `\n⚠️ 验证：${verify.detail}` : verify.mode !== 'none' ? `\n验证：${verify.detail}` : ''}`
    this.#writeRow({
      tool,
      capability,
      backend: route.kind === 'uia' ? 'legacy-uia' : 'legacy-pixel',
      engineTool: outcome.engineTool || '',
      decision: 'executed',
      approval: stepApproval,
      result: ok ? 'ok' : 'failed',
      verify: verify.mode === 'none' ? 'none' : `${verify.mode}:${verify.ok ? 'ok' : 'mismatch'}`,
      args,
      durationMs: this.now() - startedAt,
      extra: { agent: exec?.agent?.id, verifyDetail: verify.detail ? shortText(verify.detail, 160) : undefined, resumeFrom: allowResume ? undefined : undefined },
    })
    return { ok, text }
  }

  #regionOf(args = {}) {
    if (args.region && typeof args.region === 'object') return { region: args.region }
    const point = pointFrom(args)
    if (!point) return {}
    return { region: { x: Math.max(0, point.x - 80), y: Math.max(0, point.y - 80), width: 160, height: 160 } }
  }

  async #performUia({ capability, args = {}, exec = {} }) {
    const uia = this.backends.uia
    if (capability === 'click' && typeof args.control === 'string' && args.control.trim() !== '') {
      const control = args.control.trim()
      const how = args.how === 'click' ? 'click' : 'invoke'
      let handle = null
      if (args.window && typeof args.window === 'object') {
        const resolved = this.#resolveWindow(args.window)
        if (!resolved.ok) return { ok: false, text: resolved.reason, engineTool: 'uia' }
        handle = resolved.handle
      } else {
        const foreground = uia.foreground()
        handle = foreground ? foreground.handle : null
      }
      if (handle !== null && how === 'invoke') {
        try {
          const invoked = await uia.uia({ action: 'invoke', handle: Number(handle), path: control })
          if (invoked && invoked.ok !== false && invoked.invoked !== false) {
            return { ok: true, text: `已用 UIA 直接触发控件 ${control}（没有动鼠标）。`, engineTool: 'uia.invoke' }
          }
        } catch { /* no Invoke pattern: fall back to a mouse click on its centre */ }
      }
      const rect = await this.#resolveControlRect({ control, window: args.window })
      if (!rect.ok) return { ok: false, text: rect.reason, engineTool: 'uia' }
      uia.click(rect.point, { button: args.button || 'left', count: clampInt(args.count, 1, 2, 1) })
      return {
        ok: true,
        text: `已点击控件 ${control} 的中心 ${rect.point.x},${rect.point.y}（现状重测，没有用旧坐标）。`,
        engineTool: 'uia.click',
      }
    }
    if (capability === 'type' && typeof args.control === 'string' && args.control.trim() !== '') {
      const rect = await this.#resolveControlRect({ control: args.control.trim(), window: args.window })
      if (!rect.ok) return { ok: false, text: rect.reason, engineTool: 'uia' }
      try {
        const filled = await uia.uia({ action: 'setvalue', handle: Number(rect.handle), path: args.control.trim(), value: String(args.text ?? '') })
        if (filled && filled.ok !== false) {
          return { ok: true, text: `已把 ${String(args.text ?? '').length} 个字符写入控件 ${args.control}（不经过键盘）。`, engineTool: 'uia.setvalue' }
        }
      } catch { /* not a value pattern: fall back to typing */ }
    }
    if (capability === 'type') {
      uia.type(String(args.text ?? ''), { chunkChars: 240, chunkDelayMs: 20 })
      return { ok: true, text: `已输入 ${String(args.text ?? '').length} 个字符（Unicode 注入，不回显内容）。`, engineTool: 'win32.typeText' }
    }
    if (capability === 'key') {
      const keys = splitKeys(args.key ?? args.keys)
      if (keys.length === 1) uia.key(keys[0], { count: clampInt(args.count, 1, 10, 1) })
      else uia.hotkey(keys)
      return { ok: true, text: `已按 ${keys.join('+')}。`, engineTool: 'win32.key' }
    }
    if (capability === 'hotkey') {
      const keys = splitKeys(args.keys ?? args.key)
      uia.hotkey(keys)
      return { ok: true, text: `已按快捷键 ${keys.join('+')}。`, engineTool: 'win32.hotkey' }
    }
    if (capability === 'move') {
      const point = pointFrom(args)
      if (!point) return { ok: false, text: 'move 需要绝对坐标。', engineTool: 'win32' }
      const how = uia.move(point)
      return { ok: Boolean(how), text: how ? `光标已移动到 ${point.x},${point.y}（${how}）。` : `移动失败: ${point.x},${point.y}`, engineTool: 'win32.move' }
    }
    if (capability === 'scroll') {
      const point = pointFrom(args)
      uia.scroll(point || { x: undefined, y: undefined }, { deltaX: clampInt(args.deltaX, -12000, 12000, 0), deltaY: clampInt(args.deltaY, -12000, 12000, 0) })
      return { ok: true, text: `已滚动 deltaY=${args.deltaY ?? 0} deltaX=${args.deltaX ?? 0}。`, engineTool: 'win32.scroll' }
    }
    return { ok: false, text: `legacy-uia 不处理 capability=${capability}`, engineTool: 'uia' }
  }

  // ---- batch ---------------------------------------------------------------

  /** `hands_run`: one human decision, many steps, one audit row per step. */
  async run({ steps, options = {}, exec = {} } = {}) {
    const list = Array.isArray(steps) ? steps : []
    const dryRun = options.dryRun === true
    const stopOnError = options.stopOnError !== false
    const resumeFrom = clampInt(options.resumeFrom, 1, Math.max(1, list.length), 1)
    if (list.length === 0) return { ok: false, text: 'steps 为空。' }
    if (list.length > 25) return { ok: false, text: `steps 太多（${list.length}，上限 25）。` }
    if (dryRun) {
      const lines = [`dryRun（预演 ${list.length} 步：没有注入任何输入）：`]
      for (let i = 0; i < list.length; i += 1) {
        const step = list[i] || {}
        const capability = String(step.action || '').toLowerCase()
        const preview = this.#preview(capability, step)
        lines.push(`  ${i + 1}. ${capability}${preview.wouldRefuse ? ` ⛔ ${preview.blockers.join('; ')}` : ' ✓'}`)
      }
      lines.push('正式执行会为整批请求一次人类授权，并为每一步写一行审计。')
      this.#writeRow({ tool: 'hands_run', capability: 'batch', decision: 'dry-run', approval: 'none', dryRun: true, result: 'ok', args: { steps: list.length }, extra: { steps: list.length } })
      return { ok: true, text: lines.join('\n'), dryRun: true }
    }
    const stoppedText = this.#stopDenial()
    if (stoppedText) {
      this.#writeRow({ tool: 'hands_run', capability: 'batch', decision: 'denied', approval: 'none', reason: stoppedText, args: { steps: list.length } })
      return { ok: false, text: stoppedText }
    }
    const idle = await this.human.waitForIdle({ signal: exec.signal })
    if (!idle.ok) return { ok: false, text: `⛔ 人类正在操作（${idle.reason}），整批没有开始。` }
    const reason = `批量执行 ${list.length} 步（从第 ${resumeFrom} 步开始）: ${list.slice(resumeFrom - 1, resumeFrom + 2).map((step) => step && step.action).filter(Boolean).join(' → ')}`
    const auth = await this.gate.authorize({ tool: 'hands_run', capability: 'batch', exec, reason })
    if (!auth.allowed) {
      this.#writeRow({ tool: 'hands_run', capability: 'batch', decision: 'denied', approval: 'none', reason: auth.reason, args: { steps: list.length } })
      return { ok: false, text: auth.reason }
    }
    this.runs += 1
    const results = []
    let failedAt = 0
    for (let i = resumeFrom - 1; i < list.length; i += 1) {
      const step = list[i] && typeof list[i] === 'object' ? list[i] : {}
      const capability = String(step.action || '').toLowerCase()
      if (this.stopbus && this.stopbus.stopped) {
        results.push(`  ${i + 1}. ⛔ 急停（${this.stopbus.stopped.level}）：整批中断`)
        failedAt = i + 1
        break
      }
      if (!['move', 'click', 'drag', 'scroll', 'type', 'key', 'hotkey'].includes(capability) || this.#invalidArgument(capability, step)) {
        results.push(`  ${i + 1}. ⛔ 参数不合法（${capability || '缺 action'}），本步未执行`)
        failedAt = i + 1
        if (stopOnError) break
        continue
      }
      const stepResult = await this.#runOne({
        tool: 'hands_run',
        capability,
        args: step,
        exec,
        approval: `${auth.approval}:step${i + 1}`,
        allowResume: true,
      })
      results.push(`  ${i + 1}. ${capability} ${stepResult.ok ? '✓' : '✗'} ${shortText(stepResult.text.split('\n')[0], 120)}`)
      if (!stepResult.ok) {
        failedAt = i + 1
        if (stopOnError) break
      }
    }
    const done = results.filter((line) => line.includes('✓')).length
    const head = `批量结果：${done}/${list.length - (resumeFrom - 1)} 步成功${failedAt ? `，停在第 ${failedAt} 步` : ''}`
    const resume = failedAt > 0 && failedAt < list.length ? `\n续跑：hands_run { resumeFrom: ${failedAt + 1}, ... }` : ''
    return { ok: failedAt === 0, text: [head, ...results].join('\n') + resume }
  }

  // ---- toy -----------------------------------------------------------------

  /**
   * `stroke_toy` — the only stroke capability that reaches the model.
   * Same gate, same audit, a hard point cap, and only preset shapes.
   */
  async toy({ args = {}, exec = {}, buildShape } = {}) {
    const startedAt = this.now()
    const toy = this.backends.toy
    if (!toy || !toy.ok) {
      return { ok: false, text: `stroke toy 未启用或后端不可用（${toy ? toy.reason : 'toyStrokeEnabled=false'}）。` }
    }
    const metrics = this.backends.uia && this.backends.uia.ok ? this.backends.uia.metrics() : null
    const centreX = Number.isFinite(Number(args.cx)) ? Math.round(Number(args.cx)) : metrics ? Math.round(metrics.x + metrics.width / 2) : 800
    const centreY = Number.isFinite(Number(args.cy)) ? Math.round(Number(args.cy)) : metrics ? Math.round(metrics.y + metrics.height / 2) : 500
    const points = buildShape({
      shape: args.shape,
      cx: centreX,
      cy: centreY,
      radius: args.radius,
      points: Math.min(this.config.toyStrokeMaxPoints, clampInt(args.points, 16, this.config.toyStrokeMaxPoints, 240)),
      durationMs: args.durationMs,
      maxPoints: this.config.toyStrokeMaxPoints,
    })
    if (points.length > this.config.toyStrokeMaxPoints) {
      return { ok: false, text: `点数超上限（${points.length} > ${this.config.toyStrokeMaxPoints}）：toy 只画预设形状，且点数有硬上限。` }
    }
    const summary = `${args.shape || 'circle'} · ${points.length} 点 · 中心 ${centreX},${centreY}`
    if (args.dryRun === true) {
      this.#row({ tool: 'stroke_toy', capability: 'toy', backend: 'toy-draw', decision: 'dry-run', approval: 'none', dryRun: true, mode: 'toy', result: 'ok', args: { shape: args.shape, points: points.length }, durationMs: this.now() - startedAt })
      return { ok: true, text: `dryRun（玩具预演，没有注入）：${summary}，预计 ${args.durationMs ?? 600}ms。` }
    }
    const toyTarget = await this.#classifyForStep('toy', { x: centreX, y: centreY })
    if (toyTarget.category === 'system') {
      this.#row({ tool: 'stroke_toy', capability: 'toy', backend: 'toy-draw', decision: 'denied', approval: 'none', mode: 'toy', reason: `system-target: ${toyTarget.label}` })
      return { ok: false, text: systemRefusal(toyTarget) }
    }
    const idle = await this.human.waitForIdle({ signal: exec.signal })
    if (!idle.ok) {
      this.#row({ tool: 'stroke_toy', capability: 'toy', backend: 'toy-draw', decision: 'denied', approval: 'none', mode: 'toy', reason: `human-active: ${idle.reason}` })
      return { ok: false, text: `⛔ 人类正在操作（${idle.reason}），这一笔没有画。` }
    }
    const auth = await this.gate.authorize({
      tool: 'stroke_toy',
      capability: 'toy',
      exec,
      reason: `玩具笔势 ${summary}`,
      target: toyTarget.label,
      forceAsk: toyTarget.category === 'sensitive' && this.config.sensitiveAsk,
    })
    if (!auth.allowed) {
      this.#row({ tool: 'stroke_toy', capability: 'toy', backend: 'toy-draw', decision: 'denied', approval: 'none', mode: 'toy', reason: auth.reason })
      return { ok: false, text: auth.reason }
    }
    this.human.beginInjection()
    let result
    try {
      result = await toy.draw({ points, button: args.button === 'R' ? 'R' : 'L' })
    } catch (error) {
      result = { sent: 0, elapsed: 0, aborted: true, reason: String(error && error.message ? error.message : error) }
    } finally {
      this.human.endInjection()
    }
    this.#row({
      tool: 'stroke_toy',
      capability: 'toy',
      backend: 'toy-draw',
      decision: 'executed',
      approval: auth.approval,
      mode: 'toy',
      result: result.aborted ? 'aborted' : 'ok',
      args: { shape: args.shape, points: points.length },
      durationMs: this.now() - startedAt,
      extra: { agent: exec?.agent?.id, sent: result.sent },
    })
    return {
      ok: !result.aborted,
      text: `画完了：${summary}，实发 ${result.sent} 点 / ${result.elapsed}ms${result.aborted ? `（中断：${result.reason || '未知'}）` : ''}。这是玩法/演示，不是生产力能力。`,
    }
  }

  // ---- stop / status -------------------------------------------------------

  #stopFromTool(exec) {
    const stop = this.stop();
    this.#row({
      tool: 'hands_act',
      capability: 'stop',
      decision: 'stop',
      approval: 'revoked',
      result: 'grant revoked',
      agent: exec?.agent?.id,
      reason: 'agent-side emergency stop',
    })
    return {
      ok: true,
      text: `已急停：授权已撤销（${stop.level}）。在此期间下一次写动作会被拒绝，直到人手重新授权（/dexter arm 或 Ctrl+Alt+F12）。`,
    }
  }

  stop({ level = 'hard', by = 'human', reason = '' } = {}) {
    this.stoppedAt = this.now()
    const gateStop = this.gate.stop({ level, by, reason })
    try {
      this.backends.pixel?.abort?.(`dexter-stop:${level}`)
    } catch { /* nothing in flight */ }
    try {
      this.human.suspended = this.human.suspended || { at: this.now(), reason: `stop:${level}` }
    } catch { /* detector optional */ }
    return gateStop
  }

  /** Compact status for hands_status and the apply-time log. */
  status({ tail = 8, doctor = false } = {}) {
    const gate = this.gate.snapshot()
    const backends = {
      pixel: this.backends.pixel ? (this.backends.pixel.ok ? 'ok' : `unavailable: ${this.backends.pixel.reason}`) : 'not loaded',
      uia: this.backends.uia ? (this.backends.uia.ok ? 'ok' : `unavailable: ${this.backends.uia.reason}`) : 'not loaded',
      toy: this.backends.toy ? (this.backends.toy.ok ? 'ok' : `unavailable: ${this.backends.toy.reason}`) : 'not loaded (toy off)',
    }
    return {
      config: describeConfig(this.config),
      gate,
      stop: this.stopbus ? this.stopbus.snapshot() : null,
      human: this.human ? this.human.snapshot() : null,
      backends,
      audit: this.audit ? this.audit.stats() : null,
      hotkeyHealth: this.hotkeys ? this.hotkeys.summary() : '热键：未检测',
      lastView: { at: this.lastViewAt, action: this.lastViewAction, ageMs: this.lastViewAt ? this.now() - this.lastViewAt : -1 },
      runs: this.runs,
      recent: this.audit ? this.audit.tail(tail) : [],
      doctorRequested: doctor,
    }
  }

  /** The engine's self-diagnostics, routed through the kernel (old `click_matrix_doctor`). */
  async doctor() {
    const pixel = this.backends.pixel
    if (!pixel || !pixel.ok || typeof pixel.doctor !== 'function') {
      return '⛔ 没有可用的诊断后端（legacy-pixel 不可用）。'
    }
    const result = await pixel.doctor()
    this.#row({ tool: 'hands_status', capability: 'doctor', backend: 'legacy-pixel', decision: 'view', approval: 'none', result: result.ok ? 'ok' : 'failed' })
    return result.text
  }
}
