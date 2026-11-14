/**
 * dsh-screen — desktop eyes and hands for DSH.
 *
 * Gives the agent the four things a human has when sitting at this PC: see the
 * screen, list and raise windows, read the UI Automation tree of an app, and
 * inject real mouse/keyboard input. No floating ball, no separate window — the
 * commands stay in DSH.
 */
import { z, hasHostRuntime } from './runtime.js'
import { createTools } from './tools.js'
import { startHotkeys } from './hotkey.js'
import { mergeConfig, readFileConfig, watchFileConfig } from './config.js'
import { screenMetrics } from './win32.js'
import { shotDir } from './capture.js'
import { stopUiaWorker } from './uia.js'
import { stopOverlay, warmOverlay } from './overlay.js'

export const name = 'dsh-x2'

/** The tools service is all this plugin needs. */
export const inject = ['tools']

const DEFAULTS = {
  readOnly: false,
  allowRisky: false,
  shotDir: '',
  observeMaxWidth: 1280,
  observeMaxHeight: 900,
  typeDelayMs: 0,
  requireFreshLookSeconds: 120,
  settleMs: 180,
  maxSequenceSteps: 24,
  uiaMinControls: 3,
  overlay: true,
  overlayIdleMs: 1600,
  overlayWarm: false,
  cancelOnEsc: true,
  armRequired: true,
  armSeconds: 1200,
  audit: true,
  hotkeyArm: true,
  typeChunkChars: 240,
  typeChunkDelayMs: 25,
  typeVerifyMinChars: 400,
  typePasteThreshold: 2000,
  imageBudget: 0,
}

export const Config = hasHostRuntime
  ? z.object({
    readOnly: z.boolean().default(false).description('只读模式：能看不能动手'),
    allowRisky: z.boolean().default(false).description('危险动作（开程序/关窗口/系统快捷键）免确认；默认关'),
    shotDir: z.string().description('截图存哪儿，默认系统临时目录下的 dsh-x2/shots'),
    observeMaxWidth: z.number().default(1280).description('动作后自动截图的最大宽度'),
    observeMaxHeight: z.number().default(900).description('动作后自动截图的最大高度'),
    typeDelayMs: z.number().default(0).description('逐字输入时每个字符之间的间隔毫秒数'),
    requireFreshLookSeconds: z.number().default(120).description('动手前多久内必须看过屏幕，0 = 不检查'),
    settleMs: z.number().default(180).description('动作后等画面重绘多久再截图，默认 180 毫秒'),
    maxSequenceSteps: z.number().default(24).description('screen_sequence 一批最多几步'),
    uiaMinControls: z.number().default(3).description('screen_look 的 auto 模式里，UIA 至少给出几个可操作控件才不截图'),
    overlay: z.boolean().default(true).description('动手时在屏幕顶部显示「DSH 正在操作你的电脑」状态条'),
    overlayIdleMs: z.number().default(1600).description('最后一次动作之后，状态条再停留多久才消失'),
    armRequired: z.boolean().default(true).description('人类授权闸门：写操作默认拒绝，要主人本机跑 tools/arm-x2.cmd 开窗口'),
    armSeconds: z.number().default(1200).description('授权窗口默认秒数，1200 = 20 分钟'),
    hotkeyArm: z.boolean().default(true).description('人类热键：Ctrl+Alt+F9 开授权窗口（默认 armSeconds），Ctrl+Alt+F10 立即关，Ctrl+Alt+F8 取消当前批次'),
    audit: z.boolean().default(true).description('每次动作写 hash 链审计到临时目录 dsh-x2/audit.jsonl'),
    typeChunkChars: z.number().default(240).description('长文本每批输入多少个字符（0 = 不分批）'),
    typeChunkDelayMs: z.number().default(25).description('批与批之间停多少毫秒，给目标程序消化输入'),
    typeVerifyMinChars: z.number().default(400).description('超过多少字符自动读回校验（复制回读比对），0 = 每次都校验'),
    typePasteThreshold: z.number().default(2000).description('超过多少字符改用剪贴板粘贴（更快不丢字），0 = 不启用'),
    imageBudget: z.number().default(0).description('图片软预算：每轮最多几张，只统计提示、不拦截（0 = 不提示）'),
    overlayWarm: z.boolean().default(false).description('启动时预热状态条（省第一次动作约 1 秒，代价是开机多拉一个 PowerShell；默认关）'),
    cancelOnEsc: z.boolean().default(true).description('额外保险：按 Esc 中断正在跑的动作/批次（默认开）'),
  })
  : undefined

function resolveConfig(config) {
  // 本地配置文件（~/.dsh-x2/config.json）优先于 profile 里的配置，改动不用重启。
  const merged = { ...DEFAULTS, ...mergeConfig(config ?? {}) }
  merged.shotDir = merged.shotDir ? shotDir(merged.shotDir) : shotDir()
  return merged
}

export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const disposers = []

  try {
    // Fail loudly at apply time rather than at the first click: if the FFI layer is
    // unavailable the plugin is useless, and a silent half-registration is worse.
    const metrics = screenMetrics()
    ctx.logger?.info?.(`[dsh-x2] ready: ${metrics.width}x${metrics.height}, ${metrics.monitors} monitor(s), shots in ${resolved.shotDir}`)
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-x2] Win32 unavailable, tools will report the failure: ${error?.message ?? error}`)
  }

  if (resolved.overlay !== false && resolved.overlayWarm === true) {
    // 预热是可选项：它要在启动时拉起 PowerShell 并编译 WinForms（约 1-3 秒 CPU，
    // 开机会跟 DSH 抢资源）。默认不预热，第一次动手时再起，代价是第一次动作的状态条晚约 1 秒出现。
    try {
      warmOverlay()
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-x2] overlay unavailable, actions still work: ${error?.message ?? error}`)
    }
  }

  for (const tool of createTools(ctx, resolved)) {
    // One colliding name must cost that one tool, never the rest of the set.
    try {
      const dispose = ctx.tools.register(tool)
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-x2] could not register ${tool.name}: ${error?.message ?? error}`)
    }
  }

  let cleanup = () => {
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch { /* already gone with the plugin scope */ }
    }
    disposers.length = 0
    // Leave no stray PowerShell behind when the plugin goes away.
    try { stopUiaWorker() } catch { /* nothing warm to stop */ }
    try { stopOverlay() } catch { /* the pill was never shown */ }
    try { stopCfgWatch() } catch { /* watcher was never started */ }
  }
  // 本地配置文件热更新：面板改完不用重启，下一次工具调用就生效。
  let stopCfgWatch = () => {}
  try {
    stopCfgWatch = watchFileConfig(() => {
      try { Object.assign(resolved, readFileConfig()) } catch { /* ignore */ }
    })
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-x2] 配置热更新不可用（改配置需重启）: ${error?.message ?? error}`)
  }
  let stopHotkeys = () => {}
  if (config.hotkeyArm !== false) {
    try {
      stopHotkeys = startHotkeys({
        config,
        onArm: (seconds) => ctx.logger?.info?.(`[dsh-x2] 授权窗口已开启 ${seconds}s（Ctrl+Alt+F10 可随时关）`),
        onDisarm: () => ctx.logger?.info?.('[dsh-x2] 授权窗口已关闭'),
        onCancel: () => ctx.logger?.warn?.('[dsh-x2] 已取消当前动作（Ctrl+Alt+F8）'),
      })
      ctx.logger?.info?.('[dsh-x2] 热键就绪：Ctrl+Alt+F9 授权 / F10 关闭 / F8 取消')
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-x2] 热键启动失败（仍可用 tools/arm-x2.cmd）: ${error?.message ?? error}`)
    }
  }

  const originalCleanup = cleanup
  cleanup = () => { try { stopHotkeys() } catch { } originalCleanup() }
  try { ctx.on('dispose', cleanup) } catch { /* older host without a dispose event */ }
  return cleanup
}