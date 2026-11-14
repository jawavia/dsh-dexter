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
import { buildSchema, DEFAULTS, describeConfig, normalizeConfig, fieldSpec, EDITABLE_KEYS, liveConfig } from './kernel/config.js'
import { dataDir, shortText } from './kernel/util.js'
import { createPixelBackend } from './backends/legacy-pixel.js'
import { createToyDrawer } from './backends/toy-draw.js'
import { createButtonProbe } from './backends/win-probe.js'
import { createHotkeyProbe } from './backends/hotkey-probe.js'
import { buildHotkeys, cscPath, startHotkeys } from './kernel/hotkeys.js'
import { createPanel } from './kernel/panel.js'
import { combosFromConfig, comboLabel } from './kernel/keys.js'
import { loadOverrides, saveOverrides, clampOverride, OVERRIDE_KEYS } from './kernel/overrides.js'
import { createUiaBackend } from './backends/legacy-uia.js'
import { describeEngines } from './backends/resolve.js'
import { buildDefinitions } from './tools/definitions.js'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Schemastery builds the settings page. Resolve it in this order:
 *   1. the host's own copy (a bare specifier, what a real profile provides);
 *   2. the vendored copy that ships with the pixel engine (`vendor/pixel/node_modules`),
 *      so a linked checkout without a node_modules at its root still gets a settings page.
 * Without either, Config stays undefined and DSH shows no settings UI at all — which is
 * why it looked like "there is no settings page".
 */
let Config
{
  const candidates = [
    '@deepseek-ai/schemastery',
    './vendor/pixel/node_modules/@deepseek-ai/schemastery/lib/index.mjs',
  ]
  for (const candidate of candidates) {
    try {
      const loaded = candidate.startsWith('.')
        ? await import(new URL(candidate, import.meta.url).href)
        : await import(candidate)
      const z = loaded.default ?? loaded
      if (z && typeof z.object === 'function') {
        Config = buildSchema(z)
        break
      }
    } catch { /* try the next candidate */ }
  }
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
    snapshot.panelNote || '面板：未启用',
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
    '  panel exit              关掉面板（重启插件会再出现）',
    '  set <键> <值>            改持久配置（写 profile patch 并重载）；DSH 设置页只显示热更新字段',
    '  例：/dexter set armMinutes 30 · /dexter set armActions 200 · /dexter set maxActionsPerMinute 60',
    '  数值长期改法：插件设置里的 armMinutes / armActions / maxActionsPerMinute',
  ].join('\n')
}

/**
 * Parse `/dexter arm [45m] [300]`.
 *   "45m" → 45 minutes      "300" / "300x" → 300 actions
 *   a bare number ≤ 480 is minutes (the armMinutes range), anything larger is actions
 * Anything omitted or unparseable falls back to the configured defaults.
 */
/**
 * Parse one value for `/dexter set <key> <value>` against its FIELD_SPEC entry.
 * Returns `{ value }` or `{ error }`; the caller persists the value through the host's
 * config editor, so the validation here is what keeps a bad number out of the profile patch.
 */
function parseConfigValue(spec, raw) {
  const text = String(raw ?? '').trim()
  if (spec.type === 'bool') {
    if (/^(true|1|on|yes|是|开)$/i.test(text)) return { value: true }
    if (/^(false|0|off|no|否|关)$/i.test(text)) return { value: false }
    return { error: `要 true 或 false（收到「${text}」）` }
  }
  if (spec.type === 'int') {
    if (!/^-?\d+$/.test(text)) return { error: `要整数（收到「${text}」）` }
    const value = Number(text)
    const min = spec.min ?? 0
    const max = spec.max ?? Number.MAX_SAFE_INTEGER
    if (value < min || value > max) return { error: `范围是 ${min}..${max}（收到 ${value}）` }
    return { value }
  }
  if (spec.type === 'enum') {
    const values = Array.isArray(spec.values) ? spec.values : []
    if (!values.includes(text)) return { error: `只能是 ${values.join(' / ')}（收到「${text}」）` }
    return { value: text }
  }
  if (text === '') return { error: '空字符串没有意义；要清空请直接改 patch' }
  return { value: text }
}

/**
 * Parse `/dexter arm [45m] [300]`.
 * `live` is optional so this module-level helper never reaches into the plugin scope (a
 * ReferenceError there broke `/dexter arm` with no arguments): callers pass the live accessor
 * for the volatile numbers, or the snapshot is used as the fallback.
 */
function parseArmArgs(first, second, config, live = null) {
  const current = (key, fallback) => (typeof live === 'function' ? live(key) : fallback)
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
  // A typo must not silently arm with the defaults: if a token was given and could not be
  // understood, say so instead of guessing ("arm nonsense" armed 15m/100 before this).
  const given = [first, second].filter((token) => token !== undefined && String(token).trim() !== '')
  if (given.length > 0 && parsedFirst === null && parsedSecond === null) {
    return { error: `看不懂的参数：${given.join(' ')}。用法：/dexter arm [45m] [300]` }
  }
  const minutes = (parsedFirst && parsedFirst.minutes) || (parsedSecond && parsedSecond.minutes) || current('armMinutes', config.armMinutes)
  const actions = (parsedSecond && parsedSecond.actions) || (parsedFirst && parsedFirst.actions) || current('armActions', config.armActions)
  if (minutes < 1 || actions < 1) return { error: '时长和次数都要 > 0。' }
  return { minutes, actions }
}

export function apply(ctx, rawConfig = {}) {
  // The pixel engine's helper must release the arm combo *before* it starts, or it keeps owning
  // Ctrl+Alt+F12 and the plugin's own listener loses the registration.
  process.env.DSH_DEXTER_HOTKEYS = 'arm'
  const config = normalizeConfig(rawConfig)
  // Volatile fields (armMinutes / armActions / maxActionsPerMinute) update in place when the
  // human edits them in DSH's Settings page; everything that uses them reads through this.
  // Third layer: values adjusted from the desktop panel (DSH's editor refuses nested includes).
  let runtimeOverrides = loadOverrides(dataDir())
  const live = (key) => runtimeOverrides[key] !== undefined ? runtimeOverrides[key] : liveConfig(rawConfig, config, key)
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
  const gate = new Gate({ config, audit, approval, live })
  const attachments = getService(ctx, 'attachments')
  // Parsed once: the stop bus, the hotkey probe and the kernel's reserved-combo check all
  // read the same values, and the kernel is constructed before the bus.
  const combos = combosFromConfig(config)

  const disposers = []
  let disposed = false

  const backends = { pixel: null, uia: null, toy: null }
  let hotkeys = null
  let hotkeyListener = null
  let panel = null
  let panelTimer = null
  const kernel = new Kernel({ config, audit, gate, stopbus: null, human: null, backends, attachments, buttons: null, docsPath: join(HERE, 'docs', 'HANDS.md'), combos, logger })

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
      const result = gate.openGrant({ minutes: live('armMinutes'), actions: live('armActions'), source: 'hotkey' })
      if (result.ok) {
        gate.clearStop('human')
        stopbus.clear()
        logger(`${comboLabel(combos.arm)} 授权：${live('armMinutes')} 分钟 / ${live('armActions')} 次（频率 ${live('maxActionsPerMinute')}/分）`)
      } else {
        logger(`${comboLabel(combos.arm)} 授权失败：${result.error}`)
      }
    },
    onExtend: () => {
      const result = gate.extendGrant({ minutes: live('armMinutes'), actions: live('armActions'), source: 'hotkey' })
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
      // The config key exists to turn the human hotkeys off; honour it instead of ignoring it.
      if (config.hotkeysEnabled) {
        stopbus.start()
      } else {
        logger('热键已按配置关闭（hotkeysEnabled=false）：只能用 /dexter 命令。')
      }
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
      // The engine's helper otherwise owns Ctrl+Alt+F12 for a gate this plugin bypasses, so
      // the key did nothing here. Own it: the helper releases the arm combo (its emergency
      // stop stays), and this listener turns presses into the same actions as the buttons.
      // No desktop session in CI: registering global hotkeys there is meaningless, and the
      // compiled listener would keep its .exe locked while a tool cleans its temp dir.
      const hotkeysAllowed = config.hotkeysEnabled
        && process.env.DSH_DEXTER_NO_HOTKEYS !== '1'
        && process.env.CI !== 'true'
      if (hotkeysAllowed) {
        const built = buildHotkeys({ layout: HERE, dataDir: dataDir(), csc: cscPath(), logger })
        if (!built.ok) {
          logger(`热键监听不可用（热键不生效，按钮和命令仍可用）：${built.reason}`)
        } else {
          hotkeyListener = startHotkeys({
            exe: built.exe,
            // Only the two combos the engine cannot serve for us: it keeps its own emergency
            // stop (Ctrl+Alt+F11) and soft stop (Ctrl+Shift+F11), so a listener crash still
            // leaves a working stop at the injection level.
            combos: {
              arm: comboLabel(combos.arm),
              extend: comboLabel(combos.extend),
            },
            onEvent: (name) => {
              const handled = stopbus.hotkey(name)
              if (handled) {
                audit.append({ tool: 'hotkey', capability: 'input', decision: name, approval: 'human', engine: 'dexter', result: `key=${name}` })
              }
            },
            onReady: (registered) => {
              const missing = Object.entries(registered).filter(([, ok]) => !ok).map(([key]) => key)
              logger(missing.length === 0
                ? '热键监听就绪：F12 授权 · F10 续期 · Shift+F11 软停 · F11 急停'
                : `热键监听就绪，但未拿到：${missing.join('、')}（被其它程序占用）`)
            },
            onFailed: (name) => logger(`热键 ${name} 注册失败（被占用）`),
            onExit: ({ code }) => logger(`热键监听退出（code=${code}），热键不再生效；按钮与 /dexter 命令仍可用`),
            logger,
          })
          if (!hotkeyListener.ok) logger(`热键监听启动失败：${hotkeyListener.reason}`)
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
            const stopped = Boolean(snapshot.gate && snapshot.gate.stopped)
            const head = stopped
              ? '● hands · 已急停（需重新授权）'
              : grant && grant.active
                ? `● hands · 授权 ${Math.max(0, Math.round(grant.remainingMs / 60000))} 分钟 / ${Math.max(0, grant.actions - grant.used)} 次`
                : config.askOnWrite
                  ? '● hands · 未授权（逐次请示）'
                  : '● hands · 未授权（askOnWrite=false，需先 /dexter arm）'
            // Second line answers "what is it doing with the mouse right now"; when it is
            // idle and unauthorized it says how to authorize, in the panel itself, so the
            // human does not have to remember a command or find a page button.
            const idle = snapshot.activity && snapshot.activity !== '空闲'
              ? snapshot.activity
              : (grant && grant.active ? '空闲' : stopped ? '已急停 · /dexter clear 解除' : `未授权 · 按 ${comboLabel(combos.arm)} 授权`)
            // Third line: the three numbers. The panel can adjust them from its menu (it cannot
            // write configuration itself), so this is also the feedback for that request.
            const settingsLine = `时长 ${live('armMinutes')} 分 · 次数 ${live('armActions')} · 频率 ${live('maxActionsPerMinute')}/分`
            panel.writeState(head, idle, settingsLine)
          } catch { /* the panel keeps its last text */ }
        }

        /**
         * Apply configuration requests the panel left behind. The panel is a separate process,
         * so it cannot call the config editor: it writes `cfg <key> <±n>` and this loop does
         * the validated write, one request per tick.
         */
        let applyingPanelRequest = false
        const applyPanelRequests = async () => {
          if (applyingPanelRequest || !panel || typeof panel.readRequests !== 'function') return
          let requests = []
          try {
            requests = panel.readRequests()
          } catch {
            return
          }
          if (requests.length === 0) return
          applyingPanelRequest = true
          try {
            for (const line of requests) {
              const request = panel.parseRequest(line)
              if (!request) continue
              const changes = request.reset
                ? [['armMinutes', DEFAULTS.armMinutes], ['armActions', DEFAULTS.armActions], ['maxActionsPerMinute', DEFAULTS.maxActionsPerMinute]]
                : [[request.key, panel.nextValue(live(request.key), request.delta, fieldSpec(request.key))]]
              // The three numbers live in the runtime-override layer: the host config editor
              // refuses a nested include ("HMR transactions cannot be nested"), and these
              // values only need to take effect here.
              const applied = []
              const rejected = []
              for (const [key, value] of changes) {
                const clamped = clampOverride(key, value)
                if (clamped === null) {
                  rejected.push(key)
                  continue
                }
                runtimeOverrides = { ...runtimeOverrides, [key]: clamped }
                applied.push(`${key}=${clamped}`)
              }
              const saved = applied.length > 0 ? saveOverrides(dataDir(), runtimeOverrides) : { ok: true }
              audit.append({
                tool: 'panel',
                capability: 'config',
                decision: applied.length > 0 && saved.ok ? 'set' : 'denied',
                approval: 'none',
                result: applied.join(' '),
                reason: rejected.length > 0 ? `not-overridable: ${rejected.join(',')}` : (saved.ok ? '' : saved.reason),
              })
            }
          } finally {
            applyingPanelRequest = false
            paint()
          }
        }
        paint()
        panelTimer = setInterval(() => {
          paint()
          void applyPanelRequests()
        }, 1000)
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
    // The three tunable numbers are volatile: show what they are *now*, not what they were
    // when the plugin was applied (the Settings page can change them without a reload).
    config: describeConfig({
      ...config,
      armMinutes: live('armMinutes'),
      armActions: live('armActions'),
      maxActionsPerMinute: live('maxActionsPerMinute'),
    }),
    lastView: { ...kernel.status({ tail: 0 }).lastView, requireFreshSeconds: config.requireFreshLookSeconds },
    // The listener owns the combos, so its registration result is the truth. The probe is
    // only a fallback for the case where the listener could not be built or started.
    hotkeys: hotkeyListener && hotkeyListener.ok
      ? (() => {
        const summary = hotkeyListener.summary()
        const registered = summary.registered
        if (!registered) return '热键：监听进程已启动，等待注册结果'
        const mine = Object.entries(registered).filter(([, ok]) => ok).map(([name]) => name)
        const missing = Object.entries(registered).filter(([, ok]) => !ok).map(([name]) => name)
        return missing.length === 0
          ? '热键：F12 授权 / F10 续期由本插件持有；F11 急停 / Shift+F11 软停由引擎持有（四条都有效）'
          : `热键：本插件拿到 ${mine.join('、') || '无'}；未拿到 ${missing.join('、')}（被其它程序占用）；F11/Shift+F11 仍由引擎持有`
      })()
      : (hotkeys && hotkeys.ok
        ? (() => { try { hotkeys.check() } catch { /* keep the old answer */ } return hotkeys.summary() })()
        : '热键：未检测（uia 后端不可用）'),
    panelNote: panel
      ? `面板：${panel.running ? '运行中' : '未运行（/dexter panel show 重新打开）'}`
      : (config.panelEnabled ? '面板：不可用（看插件日志）' : '面板：已关闭（配置 panelEnabled=false）'),
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
          try { hotkeyListener?.stop?.() } catch { /* listener already gone */ }
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
        input: { hint: 'status | arm [15m] [100] | extend | stop | clear | panel [show|hide|reset|exit]' },
        handler: async (invocation) => {
          // The gateway requires a CommandResult: { kind: 'success'|'error', text }.
          // A bare string is rejected with "command handler must return a CommandResult".
          const ok = (text) => ({ kind: 'success', text: String(text) })
          const bad = (text) => ({ kind: 'error', text: String(text) })
          // The gateway hands the text after the command name as `rawInput`; older shapes
          // carried `input`/`args`/`text`, so keep those as fallbacks.
          const raw = String((invocation && (invocation.rawInput ?? invocation.input ?? invocation.args ?? invocation.text)) ?? '').trim()
          const [verb, a, b] = raw.split(/\s+/)
          const verbName = (verb || 'status').toLowerCase()
          if (verbName === 'status' || verbName === '') {
            return ok(commandStatus())
          }
          if (verbName === 'arm' || verbName === 'latch') {
            const parsed = parseArmArgs(a, b, config, live)
            if (parsed.error) return bad(parsed.error)
            const result = gate.openGrant({ minutes: parsed.minutes, actions: parsed.actions, source: 'command' })
            if (!result.ok) return bad(`授权失败：${result.error}`)
            gate.clearStop('human')
            return ok(`已开授权：${parsed.minutes} 分钟内最多 ${parsed.actions} 次写动作（频率上限 ${live('maxActionsPerMinute')}/分）。`
              + `\n系统/安全类目标仍然永久禁止；聊天/邮件/支付类仍需逐条批准。到期或按 Esc 即失效。`)
          }
          if (verbName === 'extend') {
            const result = gate.extendGrant({ minutes: Number(a) || live('armMinutes'), actions: Number(b) || live('armActions'), source: 'command' })
            if (!result.ok) return bad(`续期失败：${result.error}`)
            const grant = result.grant
            return ok(`已续期：现在共 ${grant.actions} 次 / 剩 ${Math.round(grant.remainingMs / 1000)}s。`)
          }
          if (verbName === 'stop') {
            kernel.stop({ level: 'hard', by: 'human', reason: '/dexter stop' })
            return ok('已急停：授权已撤销。下一次写动作会被拒绝，直到重新 /dexter arm。')
          }
          if (verbName === 'clear') {
            const cleared = gate.clearStop('human')
            if (cleared) stopbus.clear()
            return ok(cleared ? '已解除急停标记（授权仍然是空的，需要 /dexter arm 才能动手）。' : '当前没有急停标记。')
          }
          if (verbName === 'panel') {
            // A keyboard-free way to move/hide the strip; click-through was removed — the
            // strip is small and draggable, so there is no reason to make it unclickable.
            if (!panel) return bad('桌面面板没有启用（配置 panelEnabled=false，或编译失败——看插件日志）。')
            const what = (a || 'show').toLowerCase()
            const map = { show: 'show', hide: 'hide', reset: 'reset', exit: 'exit' }
            const command = map[what]
            if (!command) return bad(`未知的面板操作：${what}（可用 show / hide / reset / exit）`)
            if (command === 'exit') {
              const result = panel.command('exit')
              return result.ok ? ok('面板已关闭（要它回来：/dexter panel show）') : bad(`面板命令失败：${result.reason}`)
            }
            // Closing the window (or the tray's Exit) used to make the panel unopenable until
            // the plugin reloaded. `ensure()` restarts the process before sending the command.
            const up = panel.ensure()
            if (!up.ok) return bad(`面板启动失败：${up.reason}`)
            const result = panel.command(command)
            const restarted = up.reused ? '' : '（已重新启动面板进程）'
            return result.ok ? ok(`面板命令已发送：${command}${restarted}`) : bad(`面板命令失败：${result.reason}`)
          }
          if (verbName === 'set') {
            // DSH's Settings page only renders *volatile* fields; ordinary configuration has
            // no form at all. This command is the human's way to change those numbers: it
            // validates against FIELD_SPEC and persists through the host config editor, which
            // writes the profile patch and reloads the plugin.
            const key = String(a || '').trim()
            const rawValue = b === undefined ? '' : String(b).trim()
            if (key === '') return bad(`用法：/dexter set <键> <值>。可改的键见 /dexter status 的配置行；例如 /dexter set armMinutes 30`)
            const spec = fieldSpec(key)
            if (!spec) return bad(`未知配置键：${key}。可改的键：${EDITABLE_KEYS.join(', ')}`)
            const parsed = parseConfigValue(spec, rawValue)
            if (parsed.error) return bad(`${key}：${parsed.error}`)
            // The three tunable numbers go to the same runtime-override layer the panel uses
            // (the host editor refuses a nested include); every other key goes to the host.
            if (OVERRIDE_KEYS.includes(key)) {
              const clamped = clampOverride(key, parsed.value)
              if (clamped === null) return bad(`${key}：范围 ${spec.min ?? 0}..${spec.max ?? '∞'}（收到 ${parsed.value}）`)
              runtimeOverrides = { ...runtimeOverrides, [key]: clamped }
              const saved = saveOverrides(dataDir(), runtimeOverrides)
              if (!saved.ok) return bad(`保存失败：${saved.reason}`)
              audit.append({ tool: 'command', capability: 'config', decision: 'set', approval: 'none', result: `${key}=${clamped}`, reason: 'runtime override' })
              return ok(`已设置 ${key} = ${clamped}（立即生效；面板菜单改的是同一处）。`)
            }
            const entry = ctx && ctx.fiber ? ctx.fiber.entry : undefined
            const editor = getService(ctx, 'configEditor')
            if (!entry || !editor || typeof editor.edit !== 'function') {
              return bad(`当前 profile 不能通过界面保存配置（缺少 configEditor 或 entry）。请直接改 profile 的 cordis.patch.yml：- id: dsh-dexter / config: { ${key}: ${parsed.value} }`)
            }
            try {
              const next = await editor.edit(entry, (current) => ({ ...(current || {}), [key]: parsed.value }))
              const applied = next && Object.hasOwn(next, key) ? next[key] : parsed.value
              return ok(`已设置 ${key} = ${JSON.stringify(applied)}（写入 profile 的 patch，插件会重新加载生效）。`)
            } catch (error) {
              return bad(`保存失败：${error && error.message ? error.message : error}`)
            }
          }
          return ok(commandHelp())
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
    try { hotkeyListener?.stop?.() } catch { /* listener already gone */ }
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
