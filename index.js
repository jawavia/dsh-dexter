/**
 * dsh-dexter — Windows-only desktop hands for DSH.
 *
 * One bundle, one config schema, one audit trail, one authorization gate, and four
 * model-facing tools (`hands_view`, `hands_act`, `hands_run`, `hands_status`) plus
 * an optional single `stroke_toy`. The injection itself is not re-implemented: the
 * legacy engines stay behind adapters (see backends/).
 *
 * The plugin never asks the model to arm anything and never widens its own
 * authority: a human opens a grant with the `/dexter arm` command or the hotkey, or
 * approves a single call through the host approval service.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Audit } from './kernel/audit.js'
import { Gate } from './kernel/gate.js'
import { HumanActivity } from './kernel/human.js'
import { Kernel } from './kernel/kernel.js'
import { StopBus } from './kernel/stopbus.js'
import { buildSchema, DEFAULTS, describeConfig, normalizeConfig } from './kernel/config.js'
import { dataDir, shortText } from './kernel/util.js'
import { createPixelBackend } from './backends/legacy-pixel.js'
import { createToyDrawer } from './backends/toy-draw.js'
import { createButtonProbe } from './backends/win-probe.js'
import { createHotkeyProbe } from './backends/hotkey-probe.js'
import { createPanel } from './kernel/panel.js'
import { combosFromConfig, comboLabel } from './kernel/keys.js'
import { createUiaBackend } from './backends/legacy-uia.js'
import { describeEngines } from './backends/resolve.js'
import { buildDefinitions } from './tools/definitions.js'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Schemastery is part of the host; a bare `node` run of the tests has none. */
let Config
try {
  const schemastery = await import('@deepseek-ai/schemastery')
  const z = schemastery.default ?? schemastery
  if (z && typeof z.object === 'function') Config = buildSchema(z)
} catch {
  Config = undefined
}

function readVersion() {
  try {
    const manifest = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function getService(ctx, name) {
  try {
    if (typeof ctx.get === 'function') {
      const service = ctx.get(name)
      if (service !== undefined && service !== null) return service
    }
  } catch { /* a context throws for services it was not given */ }
  try {
    return ctx[name] ?? null
  } catch {
    return null
  }
}

/**
 * The pixel engine also honours a shared hard-stop token written by `/click-matrix stop`
 * (the previous bundle's command). Ours is separate; if that one is stale it silently
 * refuses every injection, which is exactly the "clicks stopped working" trap, so the
 * status names it explicitly.
 */
function engineStopNote() {
  const dir = process.env.DSH_HANDS_DATA_DIR || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'dsh-desktop-hands')
  const file = join(dir, 'stop.signal')
  try {
    if (!existsSync(file)) return ''
    const payload = JSON.parse(readFileSync(file, 'utf8'))
    const ageMin = Math.max(0, Math.round((Date.now() - (Number(payload.at) || Date.now())) / 60000))
    return `引擎急停 token：存在（${ageMin} 分钟前，by=${payload.by || '?'}${payload.reason ? `，${payload.reason}` : ''}）——pixel 引擎会拒绝注入；`
      + `删掉 ${file} 或让旧插件的 /click-matrix arm 解除`
  } catch {
    return ''
  }
}

function formatStatus(snapshot) {
  const gate = snapshot.gate || {}
  const grant = gate.grant
  const grantText = grant
    ? `会话授权（${grant.source}）剩 ${grant.left}/${grant.actions} 次 · ${Math.round(grant.remainingMs / 1000)}s 后到期`
      + `（到期约 ${new Date(grant.expiresAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}）`
    : gate.askOnWrite
      ? '无会话授权（每次写动作逐条请示）'
      : '无会话授权（写动作一律拒绝：需要 /dexter arm）'
  const rate = gate.rate || {}
  const stopped = gate.stopped ? `急停中（${gate.stopped.level}，by=${gate.stopped.by}）` : '未急停'
  const human = snapshot.human || {}
  const humanText = human.enabled === false
    ? '人类暂停检测已关闭'
    : human.suspended
      ? `人类正在操作（${Math.round((human.suspended.idleMs || 0) / 1000)}s 前有输入，${Math.round((human.idleResumeMs || 0) / 1000)}s 空闲后恢复）`
      : '人类未在操作'
  const stopbus = snapshot.stop || {}
  const lastView = snapshot.lastView || {}
  const audit = snapshot.audit || {}
  const lines = [
    `dsh-dexter · ${stopped}`,
    `写动作：${grantText}`,
    `频率：最近 60s ${rate.lastMinute ?? 0}/${rate.limitPerMinute ?? '∞'} 次${rate.limitPerMinute ? `（上限 ${rate.limitPerMinute}/分）` : ''}`,
    `永久禁止：系统/安全类目标（注册表、任务管理器、安全软件、凭据管理器、管理员窗口）——任何授权都不覆盖`,
    `私人相关：聊天/邮件/支付/密码类目标逐条请示${snapshot.config && String(snapshot.config).includes('sensitiveAsk=false') ? '（已被配置关闭）' : ''}`,
    `暂停：${humanText}`,
    `热键：${snapshot.hotkeyLabels ? snapshot.hotkeyLabels.arm : 'Ctrl+Alt+F12'} 开授权 · ${snapshot.hotkeyLabels ? snapshot.hotkeyLabels.extend : 'Ctrl+Alt+F10'} 续期 · ${snapshot.hotkeyLabels ? snapshot.hotkeyLabels.softStop : 'Ctrl+Shift+F11'} 软停 · ${snapshot.hotkeyLabels ? snapshot.hotkeyLabels.stop : 'Ctrl+Alt+F11'} 或 Esc 急停`,
    snapshot.hotkeys || '热键：未检测',
    ...(snapshot.engineStop ? [snapshot.engineStop] : []),
    `后端：pixel=${snapshot.backends.pixel} · uia=${snapshot.backends.uia} · toy=${snapshot.backends.toy}`,
    `配置：${snapshot.config}`,
    `观察新鲜度：${lastView.ageMs >= 0 ? `${Math.round(lastView.ageMs / 1000)}s 前 ${lastView.action}` : '还没看过屏幕'}（写动作要求 ${snapshot.lastView.requireFreshSeconds ?? ''}）`,
    `审计：${audit.file || '(未初始化)'} · seq=${audit.seq ?? 0} · ${audit.broken ? '⚠️ 写入曾失败' : '正常'}`,
  ]
  if (Array.isArray(snapshot.recent) && snapshot.recent.length > 0) {
    lines.push('最近审计：')
    for (const row of snapshot.recent) {
      const parts = [row.iso, row.tool, row.capability, row.decision, row.approval ? `approval=${row.approval}` : '', row.result ? `result=${row.result}` : '', row.verify ? `verify=${row.verify}` : '']
      lines.push(`  ${parts.filter(Boolean).join(' · ')}`)
    }
  }
  return lines.join('\n')
}

function commandHelp() {
  return [
    '/dexter 命令（人类专用，模型不可调用）：',
    '  status                  看授权/到期/频率/急停/暂停/后端/审计',
    '  arm                     开会话授权（用设置里的分钟数/次数）',
    '  arm 45m 300             本次用 45 分钟 / 300 次（分钟和次数可单独给）',
    '  extend                  给已开的会话续期（+设置里的分钟数/次数）',
    '  stop                    急停：撤销授权，下一次写动作一律拒绝',
    '  clear                   解除急停标记（不恢复授权）',
    '  panel                   桌面面板：显示/唤回',
    '  panel hide|reset        缩成屏幕边条 / 复位到右上角',
    '  panel through           开关注入穿透（穿透后右键点不到面板，用托盘图标或这条命令恢复）',
    '  panel off|on            明确关闭/打开穿透',
    '  数值长期改法：插件设置里的 armMinutes / armActions / maxActionsPerMinute',
  ].join('\n')
}

/**
 * Parse `/dexter arm [45m] [300]`.
 *   "45m" → 45 minutes      "300" / "300x" → 300 actions
 *   a bare number ≤ 480 is minutes (the armMinutes range), anything larger is actions
 * Anything omitted or unparseable falls back to the configured defaults.
 */
function parseArmArgs(first, second, config) {
  const read = (token, kind) => {
    if (token === undefined || token === '') return null
    const text = String(token).trim().toLowerCase()
    const match = text.match(/^(\d+(?:\.\d+)?)\s*(m|min|分钟|x|次|个)?$/)
    if (!match) return null
    const value = Math.round(Number(match[1]))
    if (!Number.isFinite(value) || value <= 0) return null
    const unit = match[2] || ''
    if (unit === 'm' || unit === 'min' || unit === '分钟') return { minutes: value }
    if (unit === 'x' || unit === '次' || unit === '个') return { actions: value }
    if (kind === 'minutes' && value <= 480) return { minutes: value }
    if (kind === 'actions') return { actions: value }
    return value <= 480 ? { minutes: value } : { actions: value }
  }
  const parsedFirst = read(first, 'minutes')
  const parsedSecond = read(second, 'actions')
  const minutes = (parsedFirst && parsedFirst.minutes) || (parsedSecond && parsedSecond.minutes) || config.armMinutes
  const actions = (parsedSecond && parsedSecond.actions) || (parsedFirst && parsedFirst.actions) || config.armActions
  if (minutes < 1 || actions < 1) return { error: '时长和次数都要 > 0。' }
  return { minutes, actions }
}

export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const version = readVersion()
  const logger = (message) => {
    try {
      ctx?.logger?.warn?.(`[dexter] ${message}`)
    } catch { /* logging must never break the plugin */ }
  }

  const audit = new Audit({
    dir: dataDir(),
    maxBytes: config.auditMaxBytes,
    retention: config.auditRetention,
    onError: (message) => logger(`⚠️ ${message}`),
  })
  audit.append({
    tool: 'plugin',
    capability: 'lifecycle',
    decision: 'loaded',
    result: `v${version}`,
    approval: 'none',
    engine: 'dexter',
    config: describeConfig(config),
  })

  const approval = getService(ctx, 'approval')
  const gate = new Gate({ config, audit, approval })
  const attachments = getService(ctx, 'attachments')

  const disposers = []
  let disposed = false

  const backends = { pixel: null, uia: null, toy: null }
  let hotkeys = null
  let panel = null
  let panelTimer = null
  const kernel = new Kernel({ config, audit, gate, stopbus: null, human: null, backends, attachments, buttons: null, docsPath: join(HERE, 'docs', 'HANDS.md'), logger })

  const combos = combosFromConfig(config)
  const stopbus = new StopBus({
    dataDir: dataDir(),
    probe: null,
    combos,
    onStop: ({ level, by, reason }) => {
      kernel.stop({ level, by, reason })
      logger(`急停：${level}（${by}）${reason ? ` · ${reason}` : ''}`)
    },
    // Ctrl+Alt+F12: open a session with the configured numbers; Ctrl+Alt+F10: extend it.
    onArm: () => {
      const result = gate.openGrant({ minutes: config.armMinutes, actions: config.armActions, source: 'hotkey' })
      if (result.ok) {
        gate.clearStop('human')
        logger(`${comboLabel(combos.arm)} 授权：${config.armMinutes} 分钟 / ${config.armActions} 次（频率 ${config.maxActionsPerMinute}/分）`)
      } else {
        logger(`${comboLabel(combos.arm)} 授权失败：${result.error}`)
      }
    },
    onExtend: () => {
      const result = gate.extendGrant({ minutes: config.armMinutes, actions: config.armActions, source: 'hotkey' })
      if (result.ok) {
        const grant = result.grant
        logger(`${comboLabel(combos.extend)} 续期：现在 ${grant.actions} 次 / 剩 ${Math.round(grant.remainingMs / 1000)}s`)
      } else {
        logger(`${comboLabel(combos.extend)} 续期失败：${result.error}`)
      }
    },
  })
  const human = new HumanActivity({
    config,
    probe: null,
    onEvent: (event) => {
      audit.append({
        tool: 'human',
        capability: event.kind,
        decision: event.kind,
        approval: 'none',
        reason: shortText(event.reason, 200),
        result: event.idleMs ? `idleMs=${Math.round(event.idleMs)}` : undefined,
      })
    },
  })
  kernel.stopbus = stopbus
  kernel.human = human

  // ---- backends (async, but registration can wait a tick) -------------------
  const ready = (async () => {
    const engines = describeEngines(config)
    backends.uia = await createUiaBackend({ config, logger })
    backends.pixel = await createPixelBackend({ config, audit, approval, attachments, logger })
    if (config.toyStrokeEnabled) backends.toy = await createToyDrawer({ uia: backends.uia, logger })
    if (backends.uia && backends.uia.ok) {
      stopbus.probe = backends.uia.probe
      human.probe = backends.uia.probe
      stopbus.start()
      human.start()
      kernel.buttons = await createButtonProbe({ uia: backends.uia })
      if (!kernel.buttons.ok) logger(`鼠标键探测不可用（悬停将按普通写动作处理）：${kernel.buttons.reason}`)
      hotkeys = await createHotkeyProbe({ combos })
      if (hotkeys.ok) {
        const taken = hotkeys.check().filter((combo) => !combo.available)
        if (taken.length > 0) {
          logger(`热键占用：${taken.map((combo) => combo.label).join('、')}`
            + (taken.some((combo) => combo.name === 'stop') ? '（急停热键被占时 pixel 引擎会拒绝注入——先关掉占用它的程序，或重启 DSH 让 helper 重新注册）' : ''))
        } else {
          logger('热键就绪：Ctrl+Alt+F12 / F10 / F11 / Ctrl+Shift+F11 均可用')
        }
      }
    } else {
      logger(`legacy-uia 不可用，热键/人类暂停检测关闭：${backends.uia ? backends.uia.reason : '未加载'}`)
    }
    // Desktop panel: the page cannot help once another app covers the DSH window, so the
    // state lives in a topmost native strip fed by a two-line file.
    if (config.panelEnabled) {
      panel = createPanel({ dataDir: dataDir(), logger })
      const started = panel.start()
      if (started.ok) {
        const paint = () => {
          try {
            const snapshot = kernel.status({ tail: 1 })
            const grant = snapshot.gate && snapshot.gate.grant
            const head = grant && grant.active
              ? `● hands · 授权 ${Math.max(0, Math.round(grant.remainingMs / 60000))} 分钟 / ${Math.max(0, grant.actions - grant.used)} 次`
              : '● hands · 未授权（逐次请示）'
            const last = Array.isArray(snapshot.recent) && snapshot.recent.length > 0 ? snapshot.recent[snapshot.recent.length - 1] : null
            const detail = last
              ? `${last.tool || ''} ${last.capability || ''} → ${last.decision || ''}${last.result ? ` (${last.result})` : ''}`
              : '双击展开 · 右键菜单 · 拖动移动'
            panel.writeState(head, detail)
          } catch { /* the panel keeps its last text */ }
        }
        paint()
        panelTimer = setInterval(paint, 1000)
        if (panelTimer && typeof panelTimer.unref === 'function') panelTimer.unref()
      }
    }
    audit.append({
      tool: 'plugin',
      capability: 'backends',
      decision: 'ready',
      approval: 'none',
      result: `pixel=${backends.pixel && backends.pixel.ok ? 'ok' : 'unavailable'} uia=${backends.uia && backends.uia.ok ? 'ok' : 'unavailable'} toy=${config.toyStrokeEnabled ? (backends.toy && backends.toy.ok ? 'ok' : 'unavailable') : 'toy-off'}`,
      reason: [engines.pixel.source, engines.uia.source].join(','),
    })
    return backends
  })().catch((error) => {
    logger(`后端初始化失败: ${error && error.message ? error.message : error}`)
    return backends
  })

  // ---- tools ---------------------------------------------------------------
  const statusText = ({ tail } = {}) => formatStatus({
    ...kernel.status({ tail: typeof tail === 'number' ? Math.max(1, Math.min(40, tail)) : 8 }),
    lastView: { ...kernel.status({ tail: 0 }).lastView, requireFreshSeconds: config.requireFreshLookSeconds },
    hotkeys: hotkeys && hotkeys.ok ? hotkeys.summary() : '热键：未检测（uia 后端不可用）',
    engineStop: engineStopNote(),
    hotkeyLabels: {
      arm: comboLabel(combos.arm),
      extend: comboLabel(combos.extend),
      stop: comboLabel(combos.stop),
      softStop: comboLabel(combos.softStop),
    },
  })
  const definitions = buildDefinitions({ kernel, config, statusText })
  let registered = []

  const registerTools = async () => {
    await ready
    if (disposed) return
    const tools = getService(ctx, 'tools')
    if (!tools || typeof tools.register !== 'function') {
      logger('tools 服务不可用：没有注册任何工具')
      return
    }
    for (const definition of definitions) {
      try {
        const dispose = tools.register(definition)
        if (typeof dispose === 'function') disposers.push(dispose)
        registered.push(definition.name)
      } catch (error) {
        logger(`工具 ${definition.name} 注册失败: ${error && error.message ? error.message : error}`)
      }
    }
    audit.append({
      tool: 'plugin',
      capability: 'surface',
      decision: 'registered',
      approval: 'none',
      result: registered.join(','),
      engine: 'dexter',
    })
    // One line the operator (and the evidence run) can grep for.
    logger(`ready: ${registered.length} tools [${registered.join(', ')}] · ${describeConfig(config)}`)
  }

  if (typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => {
        registerTools()
        return () => {
          disposed = true
          for (const dispose of disposers.splice(0)) {
            try {
              dispose()
            } catch { /* already gone with the scope */ }
          }
          stopbus.stop()
          human.dispose()
          if (panelTimer) {
            clearInterval(panelTimer)
            panelTimer = null
          }
          if (panel) {
            try {
              panel.stop()
            } catch { /* panel already gone */ }
            panel = null
          }
          // Order matters: the pixel helper is a detached GUI process that holds the
          // global hotkeys. Leaving it behind is what made "clicks stopped working"
          // after a plugin reload (it owns Ctrl+Alt+F11, so the next helper cannot
          // register it and the engine then refuses to inject).
          try {
            backends.pixel?.dispose?.()
          } catch { /* helper already gone */ }
          backends.uia?.dispose?.()
          backends.toy?.dispose?.()
        }
      }, 'dsh-dexter: install')
    } catch (error) {
      logger(`ctx.effect 注册失败，改为立即注册: ${error && error.message ? error.message : error}`)
      registerTools()
    }
  } else {
    registerTools()
  }

  // ---- human-only command --------------------------------------------------
  const registerCommand = () => {
    const candidates = [
      (() => { try { return getService(ctx, 'commands') } catch { return null } })(),
      (() => { try { return ctx.commands } catch { return null } })(),
    ]
    const commands = candidates.find((candidate) => candidate && typeof candidate.register === 'function')
    if (!commands) return false
    try {
      const dispose = commands.register({
        name: 'dexter',
        description: '桌面 hands（人类专用）：状态、开会话授权、续期、急停',
        input: { hint: 'status | arm [30m] [200] | extend | stop | clear | panel [show|hide|reset|through|off|exit]' },
        handler: (invocation) => {
          const raw = String((invocation && (invocation.input ?? invocation.args ?? invocation.text)) ?? '').trim()
          const [verb, a, b] = raw.split(/\s+/)
          const verbName = (verb || 'status').toLowerCase()
          if (verbName === 'status' || verbName === '') {
            return commandStatus()
          }
          if (verbName === 'arm' || verbName === 'latch') {
            const parsed = parseArmArgs(a, b, config)
            if (parsed.error) return parsed.error
            const result = gate.openGrant({ minutes: parsed.minutes, actions: parsed.actions, source: 'command' })
            if (!result.ok) return `授权失败：${result.error}`
            gate.clearStop('human')
            return `已开授权：${parsed.minutes} 分钟内最多 ${parsed.actions} 次写动作（频率上限 ${config.maxActionsPerMinute}/分）。`
              + `\n系统/安全类目标仍然永久禁止；聊天/邮件/支付类仍需逐条批准。到期或按 Esc 即失效。`
          }
          if (verbName === 'extend') {
            const result = gate.extendGrant({ minutes: Number(a) || 0, actions: Number(b) || 0, source: 'command' })
            if (!result.ok) return `续期失败：${result.error}`
            const grant = result.grant
            return `已续期：现在共 ${grant.actions} 次 / 剩 ${Math.round(grant.remainingMs / 1000)}s。`
          }
          if (verbName === 'stop') {
            kernel.stop({ level: 'hard', by: 'human', reason: '/dexter stop' })
            return '已急停：授权已撤销。下一次写动作会被拒绝，直到重新 /dexter arm。'
          }
          if (verbName === 'clear') {
            const cleared = gate.clearStop('human')
            return cleared ? '已解除急停标记（授权仍然是空的，需要 /dexter arm 才能动手）。' : '当前没有急停标记。'
          }
          if (verbName === 'panel') {
            // The keyboard-free way back from click-through, and a way to move/hide the
            // strip when the pointer is busy somewhere else.
            if (!panel) return '桌面面板没有启用（配置 panelEnabled=false，或编译失败——看插件日志）。'
            const what = (a || 'show').toLowerCase()
            const map = {
              show: 'show',
              hide: 'hide',
              reset: 'reset',
              exit: 'exit',
              through: 'through-toggle',
              'through-on': 'through-on',
              on: 'through-on',
              'through-off': 'through-off',
              off: 'through-off',
            }
            const command = map[what]
            if (!command) return `未知的面板操作：${what}（可用 show/hide/reset/through/on/off/exit）`
            const result = panel.command(command)
            return result.ok ? `面板命令已发送：${command}` : `面板命令失败：${result.reason}`
          }
          return commandHelp()
        },
      })
      if (typeof dispose === 'function') disposers.push(dispose)
      audit.append({ tool: 'plugin', capability: 'command', decision: 'registered', approval: 'none', result: '/dexter' })
      return true
    } catch (error) {
      logger(`/dexter 命令注册失败: ${error && error.message ? error.message : error}`)
      return false
    }
  }

  const commandStatus = () => statusText({ tail: 8 })
  registerCommand()

  return () => {
    disposed = true
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch { /* ignore */ }
    }
    stopbus.stop()
    human.dispose()
    if (panelTimer) {
      clearInterval(panelTimer)
      panelTimer = null
    }
    if (panel) {
      try {
        panel.stop()
      } catch { /* panel already gone */ }
      panel = null
    }
    // Same reason as the effect cleanup above: never leave the helper (and its claimed
    // global hotkeys) behind when this plugin goes away.
    try {
      backends.pixel?.dispose?.()
    } catch { /* helper already gone */ }
    try {
      backends.uia?.dispose?.()
    } catch { /* uia worker already gone */ }
    try {
      backends.toy?.dispose?.()
    } catch { /* drawer never started */ }
  }
}

export { Config, DEFAULTS, normalizeConfig }
export const name = 'dsh-dexter'
export const inject = ['tools']
