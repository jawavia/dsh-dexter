/**
 * legacy-pixel backend — dsh-click-matrix (the proven pixel path).
 *
 * Not re-implemented, only re-hosted:
 *   - the module is loaded from its own directory by absolute URL;
 *   - its runtime is built with `__createRuntime` and its tool handlers come from
 *     `__buildToolDefinitions`, so the exact injection code, lattice snapping,
 *     window deny list, coordinate resolution, dryRun and verify paths still run;
 *   - its own approval gate is *armed per action by the kernel* instead of asking
 *     again (the kernel has already asked the human), which is what keeps one
 *     authorization decision per call;
 *   - its audit writer is detached: every row the engine appends is forwarded into
 *     the kernel's single `hands.jsonl` with `backend:"legacy-pixel"`.
 *
 * The engine writes one `loaded` marker into its own trail while its runtime is
 * being constructed; that is the only row that can never be intercepted. No action
 * record is written there — see evidence/P3.md for the measured counts.
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveEngine } from './resolve.js'

/** Capability → legacy tool + argument translation. */
const ACTIONS = Object.freeze({
  move: { tool: 'mouse_move' },
  click: { tool: 'mouse_click' },
  drag: { tool: 'mouse_drag' },
  scroll: { tool: 'mouse_scroll' },
  type: { tool: 'type_text' },
  key: { tool: 'press_keys' },
  hotkey: { tool: 'press_keys' },
  // Clipboard is shared system state: the old engine gated both directions, and so does
  // the kernel (both are writes to something other programs can read).
  clipboard_set: { tool: 'clipboard_set' },
})

const READ_ACTIONS = new Set(['info', 'list', 'focus', 'capture', 'read', 'text', 'wait', 'zoom', 'locate', 'wait_window'])

function splitKeys(value) {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return []
  return value.split('+').map((part) => part.trim()).filter(Boolean)
}

/** The engine's own guidance still names its old tools; point it at ours. */
const TOOL_MENTION_REWRITES = [
  [/screen_view\(action=([a-z_]+)\)/g, "hands_view { action: '$1' }"],
  [/screen_view/g, 'hands_view'],
  [/mouse_batch/g, 'hands_run'],
  [/mouse_click/g, "hands_act { action: 'click' }"],
  [/mouse_drag/g, "hands_act { action: 'drag' }"],
  [/mouse_scroll/g, "hands_act { action: 'scroll' }"],
  [/mouse_move/g, "hands_act { action: 'move' }"],
  [/type_text/g, "hands_act { action: 'type' }"],
  [/press_keys/g, "hands_act { action: 'key' }"],
  [/screen_info/g, "hands_view { action: 'info' }"],
  [/screen_read/g, "hands_view { action: 'read' }"],
  [/screen_text/g, "hands_view { action: 'text' }"],
  [/screen_capture/g, "hands_view { action: 'capture' }"],
  [/mouse_abort/g, "hands_act { action: 'stop' }"],
]

function rewriteToolMentions(text) {
  let out = String(text ?? '')
  for (const [pattern, replacement] of TOOL_MENTION_REWRITES) out = out.replace(pattern, replacement)
  return out
}

export async function createPixelBackend({ config, audit, approval = null, attachments = null, requireAbortHotkey = null, logger = () => {} } = {}) {
  const resolved = resolveEngine('pixel', config.legacyPixelPath)
  if (!resolved.ok) return { ok: false, name: 'legacy-pixel', reason: resolved.reason, dir: resolved.dir }

  let mod
  let pixelConfig
  try {
    mod = await import(pathToFileURL(resolved.entry).href)
    const configModule = await import(pathToFileURL(join(resolved.dir, 'lib', 'config.js')).href)
    pixelConfig = configModule.normalizeConfig({
      // The kernel asks the human; the engine must not ask a second time, so it is
      // never left in a mode that prompts. It stays 'ask' so that a stray direct
      // call (there is none) would still refuse rather than inject.
      mode: 'ask',
      mergeReadSide: true,
      // The kernel owns the human pause and the emergency stop for every backend.
      pauseOnHumanInput: false,
      autoResumeHumanActivity: false,
      // No floating pill: the kernel reports state through hands_status instead.
      overlayMode: 'off',
      pillOnArm: false,
      enableKeyboard: true,
      enableClipboard: true,
      minIntervalMs: 120,
      captureLongSide: config.captureLongSide,
      // One budget declaration in the kernel; the engine enforces it on the image
      // path it owns (screenshots), so there is no second knob to keep in sync.
      maxImagesPerTurn: config.imageMaxPerTurn,
      maxImageTokensPerTurn: config.imageMaxTokensPerTurn,
      // Keep the engine's own emergency-hotkey requirement ON in production: a healthy
      // helper registers Ctrl+Alt+F11 and then refuses to arm if that ever fails. The
      // 2026-11-14 install showed the failure it guards against was a *stale helper*
      // from a previous plugin instance holding the combo, so the fix is to kill the
      // leftover, not to disable the check. A benchmark may pass `requireAbortHotkey:
      // false` because a global hotkey owner has nothing to do with click quality.
      ...(requireAbortHotkey === null ? {} : { requireAbortHotkey }),
      waitDefaultTimeoutMs: 5000,
    })
  } catch (error) {
    return {
      ok: false,
      name: 'legacy-pixel',
      reason: `加载 ${resolved.dir} 失败: ${error && error.message ? error.message : error}`,
      dir: resolved.dir,
    }
  }

  if (typeof mod.__createRuntime !== 'function' || typeof mod.__buildToolDefinitions !== 'function') {
    return {
      ok: false,
      name: 'legacy-pixel',
      reason: 'dsh-click-matrix 没有导出 __createRuntime/__buildToolDefinitions（版本不匹配）',
      dir: resolved.dir,
    }
  }

  const fakeCtx = {
    logger: { warn: (m) => logger(`[dexter:pixel] ${m}`), info: () => {} },
    get(name) {
      // The engine's screenshot path hands pixels to the model through the host's
      // attachments service; without it a capture can only report a file path.
      if (name === 'attachments') return attachments
      if (name === 'approval') return approval
      return undefined
    },
  }

  let state
  try {
    state = mod.__createRuntime(fakeCtx, pixelConfig)
  } catch (error) {
    return {
      ok: false,
      name: 'legacy-pixel',
      reason: `初始化 pixel 运行时失败: ${error && error.message ? error.message : error}`,
      dir: resolved.dir,
    }
  }

  // Detach the engine's audit trail: forward everything into the kernel's file.
  const engineAudit = state.audit
  state.audit = {
    append(entry) {
      try {
        const row = audit.append({
          tool: 'legacy',
          capability: typeof entry?.tool === 'string' ? entry.tool : 'unknown',
          backend: 'legacy-pixel',
          engine: 'pixel',
          decision: typeof entry?.decision === 'string' ? entry.decision : 'event',
          reason: typeof entry?.reason === 'string' ? entry.reason : '',
          result: typeof entry?.outcome === 'string' ? entry.outcome : undefined,
          phase: entry?.phase,
          forwarded: true,
        })
        return Boolean(row)
      } catch {
        return false
      }
    },
    get writable() {
      return !(engineAudit && engineAudit.broken)
    },
    get lastError() {
      return (engineAudit && engineAudit.lastError) || ''
    },
    get chainSeq() {
      return audit.seq
    },
    get chainHead() {
      return audit.head
    },
    tail(count = 5) {
      return audit.tail(count)
    },
  }

  let defs = []
  try {
    defs = mod.__buildToolDefinitions(state)
  } catch (error) {
    return {
      ok: false,
      name: 'legacy-pixel',
      reason: `构建 pixel 工具定义失败: ${error && error.message ? error.message : error}`,
      dir: resolved.dir,
    }
  }
  const byName = new Map(defs.map((def) => [def.name, def]))
  for (const required of ['screen_view', 'mouse_click', 'mouse_move', 'mouse_drag', 'mouse_scroll', 'type_text', 'press_keys']) {
    if (!byName.has(required)) {
      return {
        ok: false,
        name: 'legacy-pixel',
        reason: `dsh-click-matrix 缺少工具 ${required}（预期 14 个，实际 ${defs.length} 个）`,
        dir: resolved.dir,
      }
    }
  }

  /** Translate kernel arguments into the legacy tool's argument shape. */
  function translate(capability, args, extra = {}) {
    const out = { ...extra }
    const copy = (keys) => {
      for (const key of keys) if (args[key] !== undefined) out[key] = args[key]
    }
    if (capability === 'click') {
      copy(['x', 'y', 'fx', 'fy', 'window', 'snap'])
      if (args.button) out.button = args.button
      if (args.count) out.count = args.count
      if (args.expect) out.expect = args.expect
      out.verify = 'none'
    } else if (capability === 'move') {
      copy(['x', 'y', 'fx', 'fy', 'window', 'snap', 'durationMs'])
    } else if (capability === 'drag') {
      copy(['from', 'to', 'fromX', 'fromY', 'toX', 'toY', 'button', 'durationMs'])
      // hands_act uses x/y + toX/toY; the engine wants from/to objects.
      if (args.x !== undefined && args.y !== undefined) out.from = { x: args.x, y: args.y }
      if (args.toX !== undefined && args.toY !== undefined) out.to = { x: args.toX, y: args.toY }
    } else if (capability === 'scroll') {
      copy(['x', 'y', 'window', 'deltaX', 'deltaY'])
      if (args.x === undefined && args.fx !== undefined) {
        out.fx = args.fx
        out.fy = args.fy
      }
    } else if (capability === 'type') {
      out.text = String(args.text ?? '')
      if (args.expect) out.expect = args.expect
    } else if (capability === 'key') {
      out.keys = splitKeys(args.key ?? args.keys)
    } else if (capability === 'hotkey') {
      out.keys = splitKeys(args.keys ?? args.key)
    } else if (capability === 'clipboard_set') {
      out.text = String(args.text ?? '')
    }
    for (const key of ['durationMs']) if (args[key] !== undefined) out[key] = args[key]
    return out
  }

  const backend = {
    ok: true,
    name: 'legacy-pixel',
    dir: resolved.dir,
    source: resolved.source,
    engineTools: defs.map((def) => def.name).sort(),
    state,
    /** Arm the legacy gate for exactly one action, decided by the kernel. */
    armOnce() {
      try {
        state.gate.openArm({ owner: 'human', ms: 20000, clicks: 1, source: 'dexter-gate' })
        return true
      } catch {
        return false
      }
    },
    async act({ capability, args, exec = {} }) {
      const spec = ACTIONS[capability]
      if (!spec) return { ok: false, text: `legacy-pixel 不支持 capability=${capability}` }
      const def = byName.get(spec.tool)
      if (!def) return { ok: false, text: `legacy-pixel 缺少工具 ${spec.tool}` }
      if (!this.armOnce()) return { ok: false, text: '无法为本次动作打开 legacy 授权（引擎状态异常）' }
      const payload = translate(capability, args)
      try {
        const value = await def.execute(payload, { agent: exec.agent, callId: exec.callId, signal: exec.signal })
        const text = rewriteToolMentions(value && typeof value.text === 'string' ? value.text : String(value ?? ''))
        const failed = /^(错误|已拒绝|输入未执行|点击未执行|移动失败|⚠️ 未发出|⛔)/.test(text.trim())
        return { ok: !failed, text, imageRef: value && value.imageRef, engineTool: spec.tool }
      } catch (error) {
        return { ok: false, text: `legacy-pixel ${spec.tool} 抛错: ${error && error.message ? error.message : error}`, engineTool: spec.tool }
      }
    },
    /**
     * Which window is under a screen point? The engine's helper answers with
     * {handle,title,pid,process,elevated,denied}; the kernel uses it to decide
     * whether a coordinate target is a system/sensitive window.
     */
    async probeAt(x, y) {
      try {
        const data = await state.helper.rpc('probe_at', { x: Math.round(x), y: Math.round(y) }, { timeoutMs: 5000 })
        return data && data.window ? data.window : null
      } catch {
        return null
      }
    },
    /** Foreground window as the engine sees it (read-only). */
    foregroundWindow() {
      try {
        return state.lastStatus && state.lastStatus.foreground ? state.lastStatus.foreground : null
      } catch {
        return null
      }
    },
    /** Read side: the engine's own `screen_view` (10 actions in one tool). */
    async view({ action, args = {}, exec = {} }) {
      if (!READ_ACTIONS.has(action)) return { ok: false, text: `legacy-pixel 不支持 view action=${action}` }
      const def = byName.get('screen_view')
      const payload = { action, ...args }
      try {
        const value = await def.execute(payload, { agent: exec.agent, callId: exec.callId, signal: exec.signal })
        const text = rewriteToolMentions(value && typeof value.text === 'string' ? value.text : String(value ?? ''))
        return { ok: !/^错误/.test(text.trim()), text, imageRef: value && value.imageRef }
      } catch (error) {
        return { ok: false, text: `legacy-pixel screen_view 抛错: ${error && error.message ? error.message : error}` }
      }
    },
    /** Clipboard read — the engine gates and audits it itself; the kernel gates first. */
    async clipboardGet({ exec = {}, requireText = false } = {}) {
      const def = byName.get('clipboard_get')
      if (!def) return { ok: false, text: 'legacy-pixel 缺少 clipboard_get' }
      // The kernel has already asked the human; arm the engine's own gate for this one
      // read, exactly like act() does, or the engine refuses with "no approval service".
      if (!this.armOnce()) return { ok: false, text: '无法为本次剪贴板读取打开 legacy 授权（引擎状态异常）' }
      try {
        const value = await def.execute(requireText ? { requireText: true } : {}, { agent: exec.agent, callId: exec.callId, signal: exec.signal })
        const text = rewriteToolMentions(value && typeof value.text === 'string' ? value.text : String(value ?? ''))
        return { ok: !/^(读取剪贴板失败|读取剪贴板未执行|错误)/.test(text.trim()), text, engineTool: 'clipboard_get' }
      } catch (error) {
        return { ok: false, text: `legacy-pixel clipboard_get 抛错: ${error && error.message ? error.message : error}` }
      }
    },
    /** The engine's own self-diagnostics (the old `click_matrix_doctor` tool). */
    async doctor() {
      const def = byName.get('click_matrix_doctor')
      if (!def) return { ok: false, text: 'legacy-pixel 缺少 click_matrix_doctor' }
      try {
        const value = await def.execute({}, { agent: { id: 'hands_status' }, callId: `doctor-${Date.now()}` })
        const text = rewriteToolMentions(value && typeof value.text === 'string' ? value.text : String(value ?? ''))
        return { ok: !/^错误/.test(text.trim()), text, engineTool: 'click_matrix_doctor' }
      } catch (error) {
        return { ok: false, text: `legacy-pixel click_matrix_doctor 抛错: ${error && error.message ? error.message : error}` }
      }
    },
    /** Snapshot the engine's own safety state for hands_status. */
    snapshot() {
      try {
        const snap = state.gate && typeof state.gate.snapshot === 'function' ? state.gate.snapshot() : null
        return {
          mode: snap ? snap.mode : 'unknown',
          armed: Boolean(snap && snap.armed),
          paused: Boolean(snap && snap.paused),
          suspended: Boolean(snap && snap.suspended),
          auditWritable: !engineAudit?.broken,
          helper: state.helper && typeof state.helper.status === 'function' ? 'managed' : 'unknown',
        }
      } catch (error) {
        return { error: String(error && error.message ? error.message : error) }
      }
    },
    abort(reason = 'stop') {
      try {
        state.gate.safetyAbort(reason)
      } catch { /* already idle */ }
    },
    dispose() {
      // The engine's helper client "starts (or reuses)" the helper process. When it
      // reuses one, `stop()` has no child to send `quit` to, so the helper — and the
      // global hotkeys it claimed — would outlive the plugin. That is exactly what made
      // clicks fall over after a reload (a stale helper owning Ctrl+Alt+F11, so the next
      // helper cannot register it and the engine refuses to inject). Reap by pid.
      const pid = Number(state.helper && state.helper.readyInfo && state.helper.readyInfo.pid) || 0
      try {
        state.helper && state.helper.stop && state.helper.stop()
      } catch { /* helper already gone */ }
      if (pid > 0) {
        const timer = setTimeout(() => {
          try {
            process.kill(pid)
          } catch { /* already exited */ }
        }, 500)
        if (timer && typeof timer.unref === 'function') timer.unref()
      }
    },
  }
  return backend
}
