/**
 * dsh-click-matrix — self check ("doctor").
 *
 * Combines helper-side `doctor` RPC with host-side checks (bootstrap, csc,
 * services, data dir writability, audit file, PowerShell/UIA script, sandbox
 * mode, image route). Never throws: every check is individually guarded and a
 * broken check becomes a WARN/FAIL line with advice.
 */

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeConfig } from './config.js'
import { defaultDenyProfiles } from './policy.js'
import { observeUi } from './uia.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function safeGet(ctx, name) {
  try {
    if (!ctx) return undefined
    if (typeof ctx.get === 'function') return ctx.get(name)
    return ctx[name]
  } catch {
    return undefined
  }
}

function line(level, name, detail) {
  return { level, name, detail: String(detail ?? '') }
}

// Provider-side rejection modes for tool descriptions:
//   tools[N].description "invalid type: sequence"  -> description was an array
//   lone surrogates / control chars               -> invalid UTF-16/JSON string
function hasLoneSurrogate(text) {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      i += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

function hasControlChar(text) {
  for (const ch of text) {
    const code = ch.codePointAt(0)
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) return true
  }
  return false
}

function cscCandidates() {
  const win = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows'
  const versions = ['v4.0.30319']
  const out = []
  for (const v of versions) {
    out.push(join(win, 'Microsoft.NET', 'Framework64', v, 'csc.exe'))
    out.push(join(win, 'Microsoft.NET', 'Framework', v, 'csc.exe'))
  }
  return out
}

function findCsc() {
  for (const p of cscCandidates()) {
    try {
      if (existsSync(p)) return p
    } catch {
      /* ignore */
    }
  }
  return ''
}

function readPackageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : ''
  } catch {
    return ''
  }
}

/**
 * v0.9.4 (2026-11-08): fail-closed 工具面清单。
 *
 * 注册是「逐个 try/catch + logWarn」，所以缺一个工具以前**完全静默**——医生那行
 * 「工具清单」还是无条件 PASS。合并/改名之后这是最容易漏的地方，所以这里改成硬对照：
 * 少一个 = FAIL，多出一个未知名 = FAIL。改工具面时**必须同步改这张表**（那正是这道闸的目的）。
 *
 * I2（2026-11-08）：mergeReadSide 默认切 true（合并态 = 14 个）。这张表仍列**全部 24 个
 * 声明名**，由 expectedToolsFor() 按当前配置收窄：默认态期望 14、显式 false 期望 24。
 */
const EXPECTED_TOOLS = [
  'audit_tail',
  'click_matrix_doctor',
  'clipboard_get',
  'clipboard_set',
  'matrix_overlay',
  'mouse_abort',
  'mouse_batch',
  'mouse_click',
  'mouse_drag',
  'mouse_move',
  'mouse_scroll',
  'press_keys',
  'screen_capture',
  'screen_info',
  'screen_locate',
  'screen_read',
  'screen_text',
  'screen_view',
  'screen_wait',
  'screen_zoom',
  'type_text',
  'wait_window',
  'window_focus',
  'window_list',
]

/**
 * I2（2026-11-08）：mergeReadSide 默认 true（合并态，14 个工具）。
 * 显式 false 才回退到旧工具面；两种模式都要硬对照，不能只认一种：
 *   - 默认 true → 旧 7 读 + screen_view 里的旧读能力都不单独注册；
 *   - 显式 false → 旧 7 读保留（24 个），doctor 期望也要跟着回到 24。
 */
const READ_SIDE_LEGACY_TOOLS = [
  'screen_capture',
  'screen_info',
  'screen_locate',
  'screen_read',
  'screen_text',
  'screen_wait',
  'screen_zoom',
]

// P6（2026-11-08）：窗口三件也收进 screen_view；合并态（默认）下一起不注册 → 24 - 10 = 14。
// 显式 mergeReadSide=false 时这 10 个照旧注册（回退路径，期望 24 个）。
const WINDOW_SIDE_LEGACY_TOOLS = [
  'wait_window',
  'window_focus',
  'window_list',
]

/** 当前配置下应注册的 pixel 工具名（两种模式都 fail-closed）。 */
function expectedToolsFor(config) {
  const merged = !!(config && config.mergeReadSide === true)
  if (!merged) return EXPECTED_TOOLS
  return EXPECTED_TOOLS.filter((n) => !READ_SIDE_LEGACY_TOOLS.includes(n) && !WINDOW_SIDE_LEGACY_TOOLS.includes(n))
}

/**
 * Run all doctor checks.
 * @param {object} options
 * @param {object} options.ctx plugin context
 * @param {object} options.config normalized config
 * @param {object} options.helper HelperClient
 * @param {object} options.gate AccessGate
 * @param {object} options.audit AuditLog
 * @param {object} [options.budget] ImageBudget
 * @param {string} options.dataDir
 * @param {object} [options.agent] exec.agent for sandbox policy resolution
 * @param {string} [options.expectedHelperVersion]
 * @returns {Promise<{lines:Array<{level:string,name:string,detail:string}>, pass:number, warn:number, fail:number}>}
 */
export async function collectDoctor(options) {
  const lines = []
  const cfg = options.config
  const ctx = options.ctx
  const helper = options.helper
  const gate = options.gate
  const audit = options.audit

  // --- runtime -------------------------------------------------------------
  lines.push(line('PASS', 'Node', `v${process.version} · ${process.platform}/${process.arch}`))
  lines.push(line('PASS', '插件', `${readPackageVersion() || '(版本未知)'} · ${ROOT}`))
  // --- built-in deny profiles (tool-level, always on) -----------------------
  {
    const groups = defaultDenyProfiles()
    const detail = groups.map((g) => `${g.id}(${g.label} · ${g.processes.length} 进程 / ${g.titleExact.length + g.titleNeedles.length} 标题规则)`).join('；')
    lines.push(line('PASS', '内建拒绝清单', `${groups.length} 组、工具层强制执行（不可由配置关闭，allowSelf 也不能放行）：${detail}`))
  }
  // --- tool description boundary -------------------------------------------
  // The model provider rejects the entire request when one tool description is
  // not a plain string (array => "invalid type: sequence") or carries invalid
  // UTF-16. This check lets a user prove in one command that the tools we send
  // are sane - the reported tools[8] failure elsewhere is not ours.
  {
    const toolDefs = Array.isArray(options.toolDefs) ? options.toolDefs : []
    if (toolDefs.length > 0) {
      const bad = []
      let maxLen = 0
      for (const def of toolDefs) {
        const name = def && def.name !== undefined ? String(def.name) : '(unnamed)'
        const desc = def ? def.description : undefined
        if (typeof desc !== 'string') {
          bad.push(`${name}:${Array.isArray(desc) ? 'array' : typeof desc}`)
          continue
        }
        if (desc.length > maxLen) maxLen = desc.length
        if (hasLoneSurrogate(desc)) bad.push(`${name}:lone-surrogate`)
        else if (hasControlChar(desc)) bad.push(`${name}:control-char`)
      }
      if (bad.length === 0) {
        lines.push(line('PASS', '工具描述', `${toolDefs.length} 个工具全部为字符串（最长 ${maxLen} 字符；无数组/孤立代理项/控制字符）`))
      } else {
        lines.push(line('FAIL', '工具描述', `${toolDefs.length} 个工具中 ${bad.length} 个异常: ${bad.slice(0, 6).join('; ')}；这些会让模型服务端拒绝整个请求`))
      }
    }
  }
  // --- client half packaging ----------------------------------------------
  // Static packaging check only: rendering is verified in the browser; a newly
  // added client half is not scanned until the Host restarts (per-specifier
  // client metadata cache), so the PASS text calls that out.
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    const clientDecl = pkg && pkg.dsh && pkg.dsh.client
    const clientFile = join(ROOT, 'client.js')
    const exportsOk = !!(pkg && pkg.exports && pkg.exports['./client'])
    const issues = []
    if (!clientDecl || clientDecl.platform !== 'web') issues.push('package.json 缺少 dsh.client.platform="web"')
    if (!exportsOk) issues.push('package.json exports 缺少 "./client"')
    if (!existsSync(clientFile)) issues.push('client.js 不存在')
    else if (statSync(clientFile).size < 200) issues.push('client.js 过小')
    if (issues.length === 0) {
      lines.push(line('PASS', 'client 半部', 'client.js + dsh.client + exports 齐全（输入框状态芯片；刚新增 client 半部需重启 DSH 才会加载）'))
    } else {
      lines.push(line('WARN', 'client 半部', issues.join('；')))
    }
  } catch (error) {
    lines.push(line('WARN', 'client 半部', `检查失败: ${error && error.message ? error.message : error}`))
  }
  // --- human-only command registration -------------------------------------
  // The commands service can materialize after tools on a cold start; a missed
  // one-shot registration silently disables /click-matrix (arm/stop/doctor).
  if (options.commandRegistered === true) {
    lines.push(line('PASS', '/click-matrix 命令', '已注册（人类专用；arm/stop/ack/helper-reset/hotkeys-retry/mode/overlay/lattice/binning/doctor）'))
  } else {
    const why = options.commandError ? `：${options.commandError}` : ''
    lines.push(line('WARN', '/click-matrix 命令', `未注册${why}；禁用后重新启用插件可触发重试`))
  }
  const bootstrapPath = join(ROOT, 'runtime', 'bootstrap.mjs')
  if (existsSync(bootstrapPath)) {
    lines.push(line('PASS', 'bootstrap.mjs', bootstrapPath))
  } else {
    lines.push(line('FAIL', 'bootstrap.mjs', `缺少 ${bootstrapPath}；原生 helper 无法构建/启动。请重新安装插件。`))
  }
  const csc = findCsc()
  if (csc) lines.push(line('PASS', 'csc', csc))
  else lines.push(line('WARN', 'csc', '未找到 .NET Framework csc.exe；若 helper 已预编译可忽略，否则无法现场编译。'))

  // --- helper --------------------------------------------------------------
  let helperState = helper ? helper.state() : null
  if (helper) {
    try {
      if (options.expectedHelperVersion) {
        helperState.expectedVersion = options.expectedHelperVersion
      }
      const ready = await helper.ensureStarted()
      helperState = helper.state()
      lines.push(line('PASS', 'helper 进程', `pid=${helperState.pid} ready · command=${helperState.commandPath || '?'} · source=${helperState.source}`))
      const protocol = Number(ready && ready.protocol)
      lines.push(
        protocol === 1
          ? line('PASS', 'helper 协议', `protocol=${protocol}`)
          : line('FAIL', 'helper 协议', `期望 1，实际 ${ready && ready.protocol}；请重装插件`),
      )
      const versionRaw = ready && ready.helperVersion !== undefined && ready.helperVersion !== null
        ? String(ready.helperVersion)
        : ''
      const expectedVersion = options.expectedHelperVersion !== undefined && options.expectedHelperVersion !== null
        ? String(options.expectedHelperVersion)
        : ''
      const version = versionRaw
      if (!version) {
        lines.push(line('WARN', 'helper 版本', 'helper 未报告版本号'))
      } else if (!expectedVersion) {
        lines.push(line('PASS', 'helper 版本', version))
      } else if (version === expectedVersion) {
        lines.push(line('PASS', 'helper 版本', `${version}（与插件一致）`))
      } else {
        lines.push(line('WARN', 'helper 版本', `helper=${version} 插件期望=${expectedVersion}；旧进程可能残留，重启 DSH 可刷新`))
      }
      // v0.2 capability matrix reported by the helper.
      const caps = ready && ready.capabilities && typeof ready.capabilities === 'object' ? ready.capabilities : null
      if (caps) {
        const names = ['keyboard', 'clipboard', 'printWindow', 'escWatch', 'humanInputWatch', 'humanMouseWatch', 'focus', 'abortHotkey']
        const text = names.map((k) => `${k}=${caps[k] === true}`).join(' ')
        const missing = names.filter((k) => caps[k] !== true)
        lines.push(missing.length === 0
          ? line('PASS', 'helper 能力', text)
          : line('WARN', 'helper 能力', `${text}（缺失: ${missing.join(',')}；相关工具会明确报错/降级）`))
      } else {
        lines.push(line('WARN', 'helper 能力', 'helper 未报告 capabilities（旧版 helper）；键盘/剪贴板/PrintWindow/Esc 看门狗可能不可用'))
      }
      // v0.8: the emergency abort hotkey is registered independently of arming.
      const abortHotkey = ready && ready.abortHotkey && typeof ready.abortHotkey === 'object' ? ready.abortHotkey : null
      const abortRegistered = abortHotkey && abortHotkey.registered === true
      lines.push(abortRegistered
        ? line('PASS', '急停热键', `${abortHotkey.combo || 'Ctrl+Alt+F11'} 已注册（无需授权，随时硬停）`)
        : line('FAIL', '急停热键', `${(abortHotkey && abortHotkey.combo) || 'Ctrl+Alt+F11'} 未注册` +
            `${abortHotkey && abortHotkey.lastError ? `（${abortHotkey.lastError}）` : '（可能被其他程序占用）'}：` +
            '按 D-08 拒绝 arm/注入；关掉占用程序后跑 /click-matrix hotkeys-retry 或重启 DSH。Esc / 胶囊 STOP / mouse_abort 仍可用'))
      // ⑥ 软停热键（Ctrl+Shift+F11）：注册失败只降级软停，不阻断 hard。
      const softHotkey = ready && ready.softHotkey && typeof ready.softHotkey === 'object' ? ready.softHotkey : null
      const softRegistered = softHotkey && softHotkey.registered === true
      lines.push(softRegistered
        ? line('PASS', '软停热键', `${softHotkey.combo || 'Ctrl+Shift+F11'} 已注册（到原子边界停，继续需人类确认）`)
        : line('INFO', '软停热键', `${(softHotkey && softHotkey.combo) || 'Ctrl+Shift+F11'} 未注册（${softHotkey && softHotkey.lastError ? softHotkey.lastError : '可能被占用'}）；hard 停不受影响`))
      try {
        const doc = await helper.rpc('doctor', {}, { timeoutMs: 10000 })
        const checks = []
        checks.push(`dpiAware=${doc.dpiAware === true}`)
        checks.push(`monitors=${Array.isArray(doc.monitors) ? doc.monitors.length : '?'}`)
        checks.push(`capture=${doc.capture && doc.capture.ok === true ? 'ok' : 'FAIL'}${doc.capture && doc.capture.black ? '(黑屏)' : ''}`)
        checks.push(`hotkey=${doc.hotkeyRegistered === true ? 'registered' : 'NOT-registered'}`)
        checks.push(`overlay=${doc.overlayAvailable === true ? 'available' : 'unavailable'}`)
        checks.push(`captureExcluded=${doc.captureExcluded === true}`)
        // v0.8.5: overlay hit-testability + real (physical) button state. Both
        // were invisible before, which cost extra debugging steps: a visible
        // overlay is click-through (lattice) but the pill is not; and a stuck
        // mouse button silently swallows every injected click.
        // These are DYNAMIC facts, so ask for a live status (the `ready`
        // snapshot is from process start and can be stale).
        let liveStatus = null
        try {
          liveStatus = await helper.rpc('status', {}, { timeoutMs: 5000 })
        } catch {
          liveStatus = null
        }
        const ovStatus = liveStatus && liveStatus.overlay && typeof liveStatus.overlay === 'object'
          ? liveStatus.overlay
          : ready && ready.overlay && typeof ready.overlay === 'object'
            ? ready.overlay
            : null
        if (ovStatus && typeof ovStatus.hitTestable === 'boolean') {
          checks.push(`overlayHitTestable=${ovStatus.hitTestable}${ovStatus.hitTestable === true ? `(${ovStatus.pillHitTestable === true ? 'pill' : 'lattice'})` : '(点击穿透)'}`)
        }
        // v1.1 (D-12): the pill must be click-through and STOP must stay
        // clickable. Both are DYNAMIC (only meaningful while visible).
        if (ovStatus && typeof ovStatus.stopHitTestable === 'boolean') checks.push(`stopHitTestable=${ovStatus.stopHitTestable}`)
        const physMap = liveStatus && liveStatus.physicalButtonsDown && typeof liveStatus.physicalButtonsDown === 'object'
          ? liveStatus.physicalButtonsDown
          : ready && ready.physicalButtonsDown && typeof ready.physicalButtonsDown === 'object'
            ? ready.physicalButtonsDown
            : null
        const physButtons = physMap ? ['left', 'right', 'middle'].filter((k) => physMap[k] === true) : null
        if (physButtons) checks.push(`physicalButtons=${physButtons.length > 0 ? physButtons.join(',') : 'none'}`)
        if (physButtons && physButtons.length > 0) {
          lines.push(line('WARN', '物理按键', `${physButtons.join(',')} 仍处于按下状态（GetAsyncKeyState）：注入点击会被系统忽略；先 mouse_abort 释放按键（默认保留授权）`))
        }
        checks.push(`elevated=${doc.processElevated === true}`)
        if (doc.uipiProbe) checks.push(`uipiProbe=${doc.uipiProbe.ok === true ? 'ok' : 'warn'}${doc.uipiProbe.note ? '(' + String(doc.uipiProbe.note).slice(0, 80) + ')' : ''}`)
        const helperStateForIntegrity = typeof helper.state === 'function' ? helper.state() : null
        const integrity = helperStateForIntegrity && typeof helperStateForIntegrity.integrity === 'string' ? helperStateForIntegrity.integrity : ''
        if (integrity === 'bootstrap-verified') {
          checks.push('integrity=bootstrap-verified')
        } else if (integrity !== '') {
          lines.push(line('WARN', 'helper 来源', `${integrity}：非内置构建，行为未经完整性校验（测试用）；安全结论不得引用`))
        }
        lines.push(line('PASS', 'helper doctor', checks.join(' · ')))
        if (ovStatus && ovStatus.visible === true && ovStatus.pillHitTestable === true) {
          lines.push(line('FAIL', 'pill 命中区', '胶囊（pill）可命中鼠标：它会吞掉窗口标题栏的拖拽（D-12）；先 disarm 再修'))
        }
        if (ovStatus && ovStatus.visible === true && ovStatus.stopHitTestable === false) {
          lines.push(line('FAIL', 'STOP 逃生通道', 'STOP 窗口不可命中：人类无法用 STOP 停止注入（D-12 回归）'))
        }
        if (doc.capture && doc.capture.ok !== true) {
          lines.push(line('FAIL', 'helper 截图', '截图自检失败：DRM/受保护内容或会话不可见桌面，screen_capture 将不可用'))
        }
        if (doc.hotkeyRegistered !== true) {
          lines.push(line('WARN', '全局热键', 'Ctrl+Alt+F12 未能注册（可能被其他程序占用）；仍可用 /click-matrix arm'))
        }
        if (doc.processElevated === true) {
          lines.push(line('WARN', 'helper 权限', 'helper 以管理员权限运行；操作普通窗口正常，但安全策略更严格时应避免'))
        }
      } catch (error) {
        lines.push(line('FAIL', 'helper doctor', `doctor RPC 失败: ${error && error.message ? error.message : error}`))
      }
    } catch (error) {
      lines.push(line('FAIL', 'helper 进程', `helper 无法启动: ${error && error.message ? error.message : error}（若是连续崩溃后停止自动重启（D-06），执行 /click-matrix helper-reset 后重试；仍失败请重启 DSH）`))
      const st = helper.state()
      if (st && st.lastError) lines.push(line('FAIL', 'helper 错误', st.lastError))
      if (st && Array.isArray(st.stderrTail) && st.stderrTail.length > 0) {
        lines.push(line('WARN', 'helper stderr', st.stderrTail.slice(-3).join(' | ').slice(0, 500)))
      }
    }
  } else {
    lines.push(line('FAIL', 'helper 进程', 'helper 客户端不存在'))
  }

  // --- monitors / scale ----------------------------------------------------
  try {
    if (helperState && helperState.readyInfo) {
      const info = helperState.readyInfo
      const monitors = Array.isArray(info.monitors) ? info.monitors : []
      const desc = monitors
        .map((m) => `${m.device || 'display'} ${m.w || m.width}x${m.h || m.height}@${m.scale || '?'}x (${m.x},${m.y})${m.primary ? ' primary' : ''}`)
        .join('；')
      const vs = info.virtual || {}
      lines.push(line('PASS', '显示器', `${monitors.length} 个 · 虚拟屏 ${vs.w || vs.width}x${vs.h || vs.height} @(${vs.x},${vs.y}) · ${desc || '?'}`))
    }
  } catch {
    /* ignore */
  }

  // --- services ------------------------------------------------------------
  const attachments = safeGet(ctx, 'attachments')
  const llm = safeGet(ctx, 'llm')
  const approval = safeGet(ctx, 'approval')
  const skills = safeGet(ctx, 'skills')
  const commands = safeGet(ctx, 'commands') || (ctx && ctx.commands)
  const agentDefaultModel = safeGet(ctx, 'agentDefaultModel')
  const serviceLines = [
    ['attachments', !!attachments && typeof attachments.saveImage === 'function', '图片无法返回给模型（工具仍返回文本+保存路径）'],
    ['approval', !!approval && typeof approval.request === 'function', 'ask 模式无法逐次请示；mouse_click 将拒绝并提示人类 arm'],
    ['llm.imageRequestPricing', !!llm && typeof llm.imageRequestPricing === 'function', '图片 token 只能用估算公式（不影响功能）'],
    ['skills', !!skills && typeof skills.register === 'function', '不注册 click-matrix 技能（工具仍可用）'],
    ['commands', !!commands && typeof commands.register === 'function', '无法注册 /click-matrix 命令（工具仍可用）'],
  ]
  for (const [name, ok, advice] of serviceLines) {
    lines.push(ok ? line('PASS', `服务 ${name}`, '可用') : line('WARN', `服务 ${name}`, `不可用：${advice}`))
  }
  try {
    const selection = agentDefaultModel && typeof agentDefaultModel.currentSelection === 'function' ? agentDefaultModel.currentSelection() : null
    if (selection && selection.provider && selection.model) {
      lines.push(line('PASS', '当前模型路由', `${selection.provider}/${selection.model}`))
    } else {
      lines.push(line('WARN', '当前模型路由', '无法读取 agentDefaultModel.currentSelection()；图片 token 估算可能不准'))
    }
  } catch {
    lines.push(line('WARN', '当前模型路由', '读取当前模型失败'))
  }

  // --- data dir / audit ----------------------------------------------------
  const dataDir = options.dataDir
  try {
    mkdirSync(dataDir, { recursive: true })
    const probe = join(dataDir, '.doctor-probe')
    writeFileSync(probe, String(Date.now()), 'utf8')
    unlinkSync(probe)
    lines.push(line('PASS', '数据目录', `${dataDir}（可写）`))
  } catch (error) {
    lines.push(line('FAIL', '数据目录', `${dataDir} 不可写: ${error && error.message ? error.message : error}`))
  }
  try {
    if (audit && audit.file) {
      if (existsSync(audit.file)) {
        const size = statSync(audit.file).size
        let count = 0
        try {
          count = readFileSync(audit.file, 'utf8').split(/\r?\n/).filter(Boolean).length
        } catch {
          /* ignore */
        }
        lines.push(line('PASS', '审计日志', `${audit.file} · ${count} 条 · ${(size / 1024).toFixed(1)}KB / 上限 ${(cfg.auditMaxBytes / 1024).toFixed(0)}KB`))
      } else {
        lines.push(line('PASS', '审计日志', `${audit.file}（尚未写入）`))
      }
      // v0.9.1: tamper-evident hash chain check.
      try {
        const chain = audit.verify()
        if (!chain.ok) {
          const reason = chain.broken && chain.broken.reason
          if (reason === 'concurrent-writer') {
            // 多实例/并发写导致的分叉：不是篡改。归档 audit.jsonl 后链会从新文件重建。
            lines.push(line('WARN', '审计链', `第 ${chain.broken.line} 行出现同 seq/同 prev 的分叉（多实例并发写，非篡改）：${chain.broken.file}；把 audit.jsonl 改名归档后链会重建`))
          } else {
            lines.push(line('FAIL', '审计链', `第 ${chain.broken && chain.broken.line} 行断链（${reason}）：${chain.broken && chain.broken.file}`))
          }
        } else if (chain.checked === 0) {
          lines.push(line('WARN', '审计链', chain.legacy > 0 ? `旧格式 ${chain.legacy} 行无哈希链（升级前记录，无法回溯校验）` : '暂无记录'))
        } else {
          lines.push(line('PASS', '审计链', `${chain.checked} 条已校验 · 链头 ${String(chain.head || '').slice(0, 12) || '(空)'}${chain.legacy ? ` · 旧行 ${chain.legacy}` : ''}`))
        }
      } catch (error) {
        lines.push(line('WARN', '审计链', String(error && error.message ? error.message : error)))
      }
    }
  } catch {
    lines.push(line('WARN', '审计日志', '审计文件状态读取失败'))
  }

  // --- UIA / PowerShell ----------------------------------------------------
  const uiaScript = join(ROOT, 'lib', 'uia.ps1')
  const psPath = process.env.DSH_CLICK_MATRIX_POWERSHELL || 'powershell.exe'
  const psDefault = join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (existsSync(uiaScript)) lines.push(line('PASS', 'UIA 脚本', uiaScript))
  else lines.push(line('FAIL', 'UIA 脚本', `缺少 ${uiaScript}；screen_text 不可用`))
  if (existsSync(uiaScript)) {
    // Live regression self-check: this script used to fail entirely because
    // Add-Type -PassThru returned an array (screen_text: "GetForegroundWindow
    // method missing"). Probe foreground mode once so a regression shows here.
    try {
      const probe = await observeUi({ mode: 'foreground', maxElements: 1, timeoutMs: 4000 })
      if (probe && probe.ok === true) {
        const title = probe.window && probe.window.title ? String(probe.window.title).slice(0, 60) : '(无标题)'
        lines.push(line('PASS', 'UIA 自检', `foreground 模式可用（窗口 "${title}"，扫描 ${probe.scanned ?? '?'} 元素）`))
      } else {
        const why = probe && probe.error ? String(probe.error).slice(0, 180) : '未知错误'
        lines.push(line('WARN', 'UIA 自检', `screen_text 可能不可用: ${why}`))
      }
    } catch (error) {
      lines.push(line('WARN', 'UIA 自检', `screen_text 可能不可用: ${error && error.message ? error.message : error}`))
    }
  }
  if (existsSync(psDefault) || psPath !== 'powershell.exe') lines.push(line('PASS', 'PowerShell', psDefault))
  else lines.push(line('WARN', 'PowerShell', '未找到 Windows PowerShell 5.1 默认路径；screen_text 可能不可用'))

  // --- sandbox / permission ------------------------------------------------
  try {
    const sandboxPolicy = safeGet(ctx, 'sandboxPolicy')
    const agent = options.agent
    if (sandboxPolicy && typeof sandboxPolicy.resolve === 'function' && agent && agent.session) {
      const policy = sandboxPolicy.resolve({ session: agent.session })
      if (policy && policy.mode) {
        lines.push(line('PASS', '会话权限模式', `${policy.mode}${policy.workspaceRoot ? ' · workspace=' + policy.workspaceRoot : ''}`))
      } else {
        lines.push(line('WARN', '会话权限模式', 'sandboxPolicy.resolve() 未返回模式'))
      }
    } else {
      lines.push(line('WARN', '会话权限模式', '无法解析 sandboxPolicy（不影响鼠标工具，仅供排查）'))
    }
  } catch {
    lines.push(line('WARN', '会话权限模式', '读取 sandboxPolicy 失败'))
  }

  // --- access gate / config ------------------------------------------------
  if (gate) {
    const snap = gate.snapshot()
    lines.push(
      line(
        'PASS',
        '访问闸门',
        `mode=${snap.mode} armed=${snap.armed}${snap.armed ? ` ${Math.round(snap.remainingMs / 1000)}s/${snap.clicksLimit}clicks owner=${snap.owner} source=${snap.source}` : ''} minInterval=${snap.minIntervalMs}ms`,
      ),
    )
    if (snap.mode === 'off') lines.push(line('WARN', '鼠标控制', 'mode=off：所有鼠标变更操作都会被拒绝'))
  }
  lines.push(line('PASS', '配置', describeConfig(cfg)))
  // --- v0.2: keyboard / clipboard / Esc watchdog / batch / status route -----
  const caps = helperState && helperState.capabilities ? helperState.capabilities : null
  const capabilityLine = (name, enabled, configName) => {
    const helperOk = caps ? caps[name] === true : null
    if (helperOk === null) {
      return line('WARN', `${name} 能力`, `helper 未报告 capabilities；配置 ${configName}=${enabled}（旧版 helper 下相关工具会失败软降级）`)
    }
    if (!helperOk) return line('WARN', `${name} 能力`, `helper 不支持 capabilities.${name}=false；相关工具不可用`)
    if (!enabled) return line('PASS', `${name} 能力`, `helper 支持；配置 ${configName}=false（工具会明确拒绝，符合预期）`)
    return line('PASS', `${name} 能力`, `helper 支持 · 配置 ${configName}=true · 仍需人类授权窗口`)
  }
  lines.push(capabilityLine('keyboard', cfg.enableKeyboard, 'enableKeyboard'))
  lines.push(capabilityLine('clipboard', cfg.enableClipboard, 'enableClipboard'))
  const escCaps = caps ? caps.escWatch === true : null
  const escState = helperState && helperState.escWatch ? helperState.escWatch : {}
  if (escCaps === null) {
    lines.push(line('WARN', 'Esc 看门狗', 'helper 未报告 escWatch 能力（旧版 helper）；Esc 暂停不可用，请用 STOP/命令停止'))
  } else if (!escCaps) {
    lines.push(line('WARN', 'Esc 看门狗', 'helper 不支持 escWatch；Esc 暂停不可用，请用 STOP/命令停止'))
  } else {
    lines.push(line('PASS', 'Esc 看门狗', `${escState.enabled ? 'enabled' : 'disabled（仅在授权窗口内启用）'}${escState.supported === false ? ` · 运行时不可用: ${String(escState.error || '').slice(0, 120)}` : ''}`))
  }
  // v0.3: keep-on latch + human-activity auto-resume.
  const mouseWatch = caps ? caps.humanMouseWatch === true : null
  if (mouseWatch === null) {
    lines.push(line('WARN', '人类活动看门狗', 'helper 未报告 humanMouseWatch（旧版 helper）；鼠标活动自动暂停不可用，请重启 DSH 触发重编译'))
  } else if (!mouseWatch) {
    lines.push(line('WARN', '人类活动看门狗', 'helper 不支持 humanMouseWatch；鼠标活动自动暂停不可用'))
  } else {
    lines.push(line('PASS', '人类活动看门狗', `鼠标移动/键盘输入 → 暂停注入；空闲 ${Math.round(cfg.humanIdleResumeMs / 1000)} 秒后自动恢复（autoResumeHumanActivity=${cfg.autoResumeHumanActivity}）`))
  }
  const snapNow = gate && gate.snapshot ? gate.snapshot() : null
  if (snapNow && snapNow.suspended) {
    lines.push(line('PASS', '注入暂停状态', `人类操作中（${snapNow.suspended.reason}）；空闲 ${Math.round((snapNow.suspended.idleResumeMs || cfg.humanIdleResumeMs) / 1000)} 秒后自动恢复`))
  }
  lines.push(line('PASS', '常开授权', `热键 Ctrl+Alt+F12 = 常开/关切换；/click-matrix arm <秒|on>；armDefaultSeconds=${cfg.armDefaultSeconds}`))
  // 2026-11-08（用户报障后补）：**停止信号**必须可见 —— 之前 /click-matrix stop 写下的
  // hard stop token 一直挂着，三引擎注入全被拒，但 doctor 依旧 PASS 45 全绿，用户看不出原因。
  // 这里只报状态与解除方法，不自动清（停止归人类）。
  try {
    const sharedDir2 = process.env.DSH_HANDS_DATA_DIR
      ? String(process.env.DSH_HANDS_DATA_DIR)
      : join(dataDir, '..', 'dsh-desktop-hands')
    const stopPath = join(sharedDir2, 'stop.signal')
    if (existsSync(stopPath)) {
      let level = '?'
      let at = 0
      let by = ''
      let reason = ''
      try {
        const j = JSON.parse(readFileSync(stopPath, 'utf8'))
        level = j && j.level ? String(j.level) : 'hard'
        at = Number(j && j.at) || 0
        by = (j && j.by) || ''
        reason = (j && j.reason) || ''
      } catch { /* 坏文件也按"存在"报 */ }
      const ageText = at > 0 ? `${Math.round((Date.now() - at) / 60000)} 分钟前` : '时间未知'
      lines.push(line('WARN', '停止信号', `硬停 token 存在（level=${level}，${ageText}，by=${by}${reason ? `，reason=${reason}` : ''}）—— 三引擎注入会被拒；人类执行 /click-matrix arm <秒|on> 或 Ctrl+Alt+F12 即可解除（重新授权会自动 clearStop）`))
    } else {
      lines.push(line('PASS', '停止信号', '无 stop.signal（三引擎注入未被硬停拦截）'))
    }
  } catch (error) {
    lines.push(line('WARN', '停止信号', `读取 stop.signal 失败（忽略）：${error && error.message ? error.message : error}`))
  }

  // 2026-11-08（用户批准）：常开授权如果"很久之后才到期"，必须显式提醒 —— 之前出现过
  // /click-matrix arm on 写下的 +3650 天 latch 被遗忘、三引擎一直"一调即放行"的情况。
  // 只提醒不清理（授权归人类，R2）：>24h 判 WARN，>30 天再加一句"建议确认是否故意常开"。
  // 注意：pixel 自己的 AccessGate.snapshot() 只看内存 arm（逐次授权），**看不到**共享 gate.json
  // 里的常开 latch（那是 fan-out 给 control/stroke 的），所以这里直接读共享文件。
  try {
    const sharedDir = process.env.DSH_HANDS_DATA_DIR
      ? String(process.env.DSH_HANDS_DATA_DIR)
      : join(dataDir, '..', 'dsh-desktop-hands')
    const gatePath = join(sharedDir, 'gate.json')
    let until = 0
    let by = ''
    let note = ''
    if (existsSync(gatePath)) {
      const j = JSON.parse(readFileSync(gatePath, 'utf8'))
      until = Number(j && j.armedUntil) || 0
      by = (j && j.by) || ''
      note = (j && j.note) || ''
    }
    if (until > Date.now()) {
      const leftMs = until - Date.now()
      const leftDays = leftMs / 86400000
      const leftText = leftDays >= 1 ? `${leftDays.toFixed(1)} 天` : `${Math.round(leftMs / 1000)} 秒`
      const who = by ? `（by=${by}${note ? `，note=${note}` : ''}）` : ''
      if (leftDays > 30) {
        lines.push(line('WARN', '常开提醒', `共享 gate.json 常开授权生效中：剩余 ${leftText}（到期 ${new Date(until).toISOString()}）${who} —— control/stroke 写动作当前免逐次确认；若非常开本意，请人类执行 /click-matrix stop`))
      } else if (leftDays > 1) {
        lines.push(line('WARN', '常开提醒', `授权窗口较长：剩余 ${leftText}${who}；请确认是否符合本意`))
      } else {
        lines.push(line('PASS', '常开提醒', `共享授权窗口剩余 ${leftText}（正常范围）${who}`))
      }
    } else {
      lines.push(line('PASS', '常开提醒', '共享 gate.json 无长时授权（按次授权模式）'))
    }
  } catch (error) {
    lines.push(line('WARN', '常开提醒', `读取共享 gate.json 失败（忽略）：${error && error.message ? error.message : error}`))
  }

  const selfRect = cfg.allowSelfRect
    ? `${cfg.allowSelfRect.x},${cfg.allowSelfRect.y} ${cfg.allowSelfRect.w}x${cfg.allowSelfRect.h}`
    : 'null'
  lines.push(line('PASS', 'v0.4 配置', `humanWaitMaxMs=${cfg.humanWaitMaxMs} allowSelfWindow=${cfg.allowSelfWindow} allowSelfMaxMs=${cfg.allowSelfMaxMs} allowSelfRect=${selfRect}`))
  if (snapNow && snapNow.selfAllow && snapNow.selfAllow.active) {
    const r = snapNow.selfAllow.rect
    lines.push(line('PASS', '作用域 allowSelf', `仅自身窗口内 ${r.x},${r.y} ${r.w}x${r.h} 的单击放行 · 剩余 ${Math.round(snapNow.selfAllow.remainingMs / 1000)}s`))
  }
  const toolNames = Array.isArray(options.toolNames) ? options.toolNames : []
  if (toolNames.length > 0) {
    if (toolNames.includes('mouse_batch')) {
      lines.push(line('PASS', '批量工具', `mouse_batch 已注册（batchMaxActions=${cfg.batchMaxActions}，一次授权最多执行 ${cfg.batchMaxActions} 个动作）`))
    } else {
      lines.push(line('WARN', '批量工具', 'mouse_batch 未注册（工具注册失败？）'))
    }
    // v0.9.4: fail-closed —— 少一个工具就是 FAIL，不再是无条件 PASS。
    // v0.9.5 (P4) / I2: 期望清单随 mergeReadSide 变（默认 true=14 / 显式 false=24），两种模式都硬对照。
    const expectedTools = expectedToolsFor(cfg)
    const mergedReadSide = cfg.mergeReadSide === true
    const missingTools = expectedTools.filter((name) => !toolNames.includes(name))
    const extraTools = toolNames.filter((name) => !expectedTools.includes(name))
    if (missingTools.length === 0 && extraTools.length === 0) {
      lines.push(line('PASS', '工具清单', `${toolNames.length} 个: ${toolNames.slice().sort().join(' ')}（mergeReadSide=${mergedReadSide}）`))
    } else {
      const parts = []
      if (missingTools.length) parts.push(`缺 ${missingTools.length} 个: ${missingTools.join(' ')}`)
      if (extraTools.length) parts.push(`多 ${extraTools.length} 个未知名: ${extraTools.join(' ')}`)
      lines.push(line('FAIL', '工具清单', `期望 ${expectedTools.length} 个（mergeReadSide=${mergedReadSide}），实注册 ${toolNames.length} 个；${parts.join('；')}（注册是逐个 try/catch + logWarn，失败会静默 —— 先看日志里的「工具 X 注册失败」）`))
    }
    // 2026-11-08（P6 + mergeReadSide=true）：窗口三件已并入 screen_view（action=list/focus/wait_window），
    // 合并态下 window_focus / wait_window 本来就不注册 —— 不能当"注册失败"报 WARN。
    const v04Tools = ['window_focus', 'wait_window'].filter((name) => !toolNames.includes(name))
    if (mergedReadSide) {
      lines.push(toolNames.includes('screen_view')
        ? line('PASS', 'v0.4 工具', 'window_focus / wait_window 已并入 screen_view（action=list/focus/wait_window），合并态不单独注册')
        : line('FAIL', 'v0.4 工具', 'mergeReadSide=true 但 screen_view 未注册 → 窗口/读屏能力全缺'))
    } else {
      lines.push(v04Tools.length === 0
        ? line('PASS', 'v0.4 工具', 'window_focus / wait_window 已注册')
        : line('WARN', 'v0.4 工具', `未注册: ${v04Tools.join(', ')}（工具注册失败？）`))
    }
  }
  lines.push(options.statusRoute === true
    ? line('PASS', '状态路由', 'GET /api/click-matrix/status 已注册（仅回环 + 同源，只读）')
    : line('WARN', '状态路由', '未注册：webServer 服务不可用或注册失败（不影响工具）'))
  lines.push(line('PASS', 'v0.2 配置', `enableKeyboard=${cfg.enableKeyboard} enableClipboard=${cfg.enableClipboard} batchMaxActions=${cfg.batchMaxActions} pauseOnHumanInput=${cfg.pauseOnHumanInput} pillOnArm=${cfg.pillOnArm} waitDefaultTimeoutMs=${cfg.waitDefaultTimeoutMs} waitStableMs=${cfg.waitStableMs}`))
  lines.push(line('PASS', 'v0.3 配置', `armDefaultSeconds=${cfg.armDefaultSeconds} autoResumeHumanActivity=${cfg.autoResumeHumanActivity} humanIdleResumeMs=${cfg.humanIdleResumeMs}`))
  const paused = options.paused || (gate && gate.snapshot ? gate.snapshot().paused : null)
  if (paused) {
    lines.push(line('WARN', '暂停状态', `已暂停（${paused.reason || 'human-takeover'}）；恢复需人类 /click-matrix arm 或 Ctrl+Alt+F12`))
  }
  if (options.budget && typeof options.budget.snapshot === 'function') {
    try {
      const b = options.budget.snapshot('doctor')
      lines.push(line('PASS', '图片预算', `120s 窗口 ${b.images}/${b.maxImages} 张 · ${b.tokens}/${b.maxTokens} tokens`))
    } catch {
      /* ignore */
    }
  }

  const pass = lines.filter((l) => l.level === 'PASS').length
  const warn = lines.filter((l) => l.level === 'WARN').length
  const fail = lines.filter((l) => l.level === 'FAIL').length
  return { lines, pass, warn, fail }
}

/** Render doctor lines as one text block. */
export function renderDoctor(result) {
  const icon = { PASS: 'PASS', WARN: 'WARN', FAIL: 'FAIL' }
  const head = `click-matrix doctor: ${result.fail === 0 ? 'PASS' : 'FAIL'}（PASS ${result.pass} · WARN ${result.warn} · FAIL ${result.fail}）`
  const body = result.lines.map((l) => `[${icon[l.level] || l.level}] ${l.name}: ${l.detail}`).join('\n')
  const advice = result.fail > 0 ? '\n建议：先修复 FAIL 项；helper 不可用时鼠标工具全部拒绝，观察类工具会给出明确错误。' : ''
  return `${head}\n${body}${advice}`
}
