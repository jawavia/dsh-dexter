/**
 * dsh-click-matrix — window safety policy + argument/target resolution.
 *
 * Fail-closed rules applied to the window under the target point BEFORE any
 * click/drag/scroll:
 *   - helper-marked denied windows (own DSH process, secure desktop, its deny list)
 *   - elevated windows (UIPI would block/redirect the click anyway)
 *   - secure-desktop / consent / logon / lock classes (double check)
 *   - config.denyProcesses (exe basename, case-insensitive)
 *   - config.denyTitleContains (window title substring, case-insensitive)
 *   - minimized or empty windows
 *
 * Also resolves tool arguments into absolute physical screen points / regions:
 *   {x,y} | {fx,fy} normalised over the virtual screen, optional lattice snap.
 */

import {
  clamp01,
  clampRect,
  isNum,
  latticeSpacingScreen,
  normToScreen,
  pointInVirtual,
  screenScaleAt,
  snapToLattice,
} from './grid.js'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const SECURE_CLASSES = ['consentui', 'logonui', 'lockapp', 'windows security', 'useraccountcontrol', 'securedesktop']
const SECURE_PROCESSES = ['logonui.exe', 'lockapp.exe', 'consent.exe', 'winlogon.exe']
// v1.4 (built-in deny profiles): hard-coded, tool-level deny list. Not configurable
// from config.json — enforced before user deny lists, and not relaxable by allowSelf.
const DEFAULT_DENY_PROFILES = {
  security: {
    label: '安全软件面板',
    processes: ['hipsmain.exe', 'hipstray.exe', 'hipstray64.exe', '360safe.exe', '360tray.exe', 'qqpctray.exe', 'securityhealthsystray.exe', 'securityhealthui.exe'],
    titleExact: [],
    titleNeedles: ['windows 安全中心', '火绒安全软件'],
  },
  credential: {
    label: '凭据管理器',
    processes: ['1password.exe', 'bitwarden.exe', 'keepass.exe', 'keepassxc.exe', 'dashlane.exe', 'enpass.exe', 'keeper.exe'],
    titleExact: [],
    titleNeedles: [],
  },
  'system-config': {
    label: '系统配置工具',
    processes: ['regedit.exe', 'taskmgr.exe', 'compmgmtlauncher.exe', 'virtmgmt.msc'],
    titleExact: ['注册表编辑器', '磁盘管理', '服务', '组策略编辑器', '本地安全策略', '事件查看器', '任务计划程序', '系统配置', 'BitLocker 驱动器加密'],
    titleNeedles: [],
  },
}

/** All built-in deny groups (read-only; used by doctor / docs). */
export function defaultDenyProfiles() {
  return Object.entries(DEFAULT_DENY_PROFILES).map(([id, p]) => ({
    id,
    label: p.label,
    processes: [...p.processes],
    titleExact: [...p.titleExact],
    titleNeedles: [...p.titleNeedles],
  }))
}

// v2 (③ 拒绝清单下沉): 三引擎读同一份共享文件；缺失/损坏回退内置（各自读旧配置）。
const SHARED_DENY_PATH = () => join(homedir(), '.dsh', 'dsh-desktop-hands', 'deny-list.json')

function loadSharedDenyProfiles() {
  try {
    if (!existsSync(SHARED_DENY_PATH())) return null
    const j = JSON.parse(readFileSync(SHARED_DENY_PATH(), 'utf8'))
    const groups = j && j.groups
    if (!groups || typeof groups !== 'object') return null
    const out = {}
    for (const [id, g] of Object.entries(groups)) {
      if (!g || typeof g !== 'object') continue
      out[id] = {
        label: typeof g.label === 'string' ? g.label : id,
        processes: Array.isArray(g.processes) ? g.processes : [],
        titleExact: Array.isArray(g.titleExact) ? g.titleExact : [],
        titleNeedles: Array.isArray(g.titleNeedles) ? g.titleNeedles : [],
      }
    }
    return Object.keys(out).length > 0 ? out : null
  } catch {
    return null
  }
}

/**
 * Match built-in deny profiles.
 * @returns {{group:string,label:string,rule:string}|null}
 */
export function matchDefaultDeny(window) {
  if (!window || typeof window !== 'object') return null
  // v2 (③): 优先共享 deny-list.json，回退内置（各自读旧配置 = 回滚分支）。
  const profiles = loadSharedDenyProfiles() || DEFAULT_DENY_PROFILES
  const proc = processBase(window.process)
  const title = typeof window.title === 'string' ? window.title.trim() : ''
  const titleLower = title.toLowerCase()
  for (const [group, p] of Object.entries(profiles)) {
    if (proc && p.processes.includes(proc)) {
      return { group, label: p.label, rule: `process:${proc}` }
    }
    if (title && p.titleExact.some((t) => title === t)) {
      return { group, label: p.label, rule: `title:${title}` }
    }
    if (title && p.titleNeedles.some((t) => titleLower.includes(t.toLowerCase()))) {
      return { group, label: p.label, rule: `title-contains:${title}` }
    }
  }
  return null
}

// v1.3 (self-window deny): any window whose title carries our own product name
// is the DSH UI. This catches the Web GUI opened in a *browser*, where the
// process name is not one of ours (the old name-only check let the agent click
// its own approval buttons).
const INTRINSIC_OWN_TITLE_NEEDLES = ['DeepSeek Harness']

// ---------------------------------------------------------------------------
// 三层 ACL（放行 / 拒绝 / 申请）
// 优先级：拒绝（内置或自定义）> 放行 > 申请 > 默认。
//   - 内置安全清单永远最高优先，放行盖不过它；
//   - 放行只豁免「申请」，不能豁免拒绝；
//   - 申请 = 需人类确认（evaluateWindowDeny 把它变成一条拒绝原因，工具层拦下）。
// ---------------------------------------------------------------------------
export function aclTierFor(window, config) {
  if (!window || typeof window !== 'object') return { tier: 'default', rule: '' }
  const proc = processBase(window.process)
  const title = typeof window.title === 'string' ? window.title : ''
  const titleLower = title.toLowerCase()
  const cfg = config && typeof config === 'object' ? config : {}
  const list = (v) => (Array.isArray(v) ? v : [])
  const procs = (v) => list(v).map(processBase).filter(Boolean)
  const titleHit = (v) => list(v).find((needle) => typeof needle === 'string' && needle !== '' && titleLower.includes(needle.toLowerCase()))

  // 1) 内置拒绝（永远最高）
  const builtin = matchDefaultDeny(window)
  if (builtin) return { tier: 'deny', rule: `内置 ${builtin.group}/${builtin.label} ${builtin.rule}` }
  // 2) 自定义拒绝
  const denyProc = procs(cfg.denyProcesses)
  if (proc && denyProc.includes(proc)) return { tier: 'deny', rule: `拒绝进程 ${proc}` }
  const denyTitle = titleHit(cfg.denyTitleContains)
  if (denyTitle) return { tier: 'deny', rule: `拒绝标题 ${denyTitle}` }
  // 3) 放行（豁免申请）
  const allowProc = procs(cfg.allowProcesses)
  if (proc && allowProc.includes(proc)) return { tier: 'allow', rule: `放行进程 ${proc}` }
  const allowTitle = titleHit(cfg.allowTitleContains)
  if (allowTitle) return { tier: 'allow', rule: `放行标题 ${allowTitle}` }
  // 4) 申请（需人类确认）
  const askProc = procs(cfg.askProcesses)
  if (proc && askProc.includes(proc)) return { tier: 'ask', rule: `申请进程 ${proc}` }
  const askTitle = titleHit(cfg.askTitleContains)
  if (askTitle) return { tier: 'ask', rule: `申请标题 ${askTitle}` }
  return { tier: 'default', rule: '' }
}

/** Stable per-agent key used to scope arm windows. */
export function agentKey(exec) {
  try {
    const agent = exec && exec.agent
    if (!agent || typeof agent !== 'object') return 'unknown'
    const session = agent.session && agent.session.id
    if (typeof session === 'string' && session !== '') return session
    if (typeof agent.sessionId === 'string' && agent.sessionId !== '') return agent.sessionId
    if (typeof agent.id === 'string' && agent.id !== '') return agent.id
  } catch {
    /* fall through */
  }
  return 'unknown'
}

/** exe basename lower-case. */
export function processBase(p) {
  if (typeof p !== 'string' || p.trim() === '') return ''
  const parts = p.replaceAll('/', '\\').split('\\')
  return parts[parts.length - 1].trim().toLowerCase()
}

/** 内置的“自身主机”进程名（不含 config.denyProcesses）。 */
export function intrinsicOwnProcesses() {
  const names = ['DeepSeek Harness.exe']
  try {
    const execPath = process.execPath
    const base = processBase(execPath)
    if (base && base !== 'node.exe' && base !== 'node' && base !== 'bun.exe') names.push(base)
  } catch {
    /* ignore */
  }
  return names
}

/** Process names that must always be denied (own host + config extras). */
export function ownProcessNames(config) {
  const names = intrinsicOwnProcesses()
  for (const extra of (config && Array.isArray(config.denyProcesses) ? config.denyProcesses : [])) {
    if (typeof extra === 'string' && extra.trim() !== '') names.push(extra.trim())
  }
  return names
}

/** Compact one-line window label for text output / approval prompts. */
export function windowLabel(w) {
  if (!w || typeof w !== 'object' || !w.handle) return '(无窗口)'
  const title = typeof w.title === 'string' && w.title !== '' ? w.title : '(无标题)'
  const proc = processBase(w.process) || (typeof w.className === 'string' && w.className !== '' ? w.className : '?')
  const r = w.rect
  const rect = r ? ` (${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width ?? r.w)}x${Math.round(r.height ?? r.h)})` : ''
  return `"${title}" [${proc}${w.className ? ' / ' + w.className : ''}] pid=${w.pid ?? '?'}${rect}`
}

/** Same top-level window? (handle first, then pid+title fallback). */
export function sameWindow(a, b) {
  if (!a || !b) return false
  if (a.handle && b.handle) return a.handle === b.handle
  return a.pid === b.pid && a.title === b.title
}

const R_HELPER_DENIED = 'helper 将该窗口标记为禁止（自身窗口/安全窗口/deny 列表）'

/** 是否在矩形内（右侧/下侧边界为开区间）。 */
function pointInRect(point, rect) {
  if (!point || typeof point !== 'object' || !rect || typeof rect !== 'object') return false
  const x = Number(point.x)
  const y = Number(point.y)
  const rx = Number(rect.x)
  const ry = Number(rect.y)
  const rw = Number(rect.w ?? rect.width)
  const rh = Number(rect.h ?? rect.height)
  if (![x, y, rx, ry, rw, rh].every(Number.isFinite)) return false
  if (!(rw > 0) || !(rh > 0)) return false
  return x >= rx && y >= ry && x < rx + rw && y < ry + rh
}

/**
 * v0.4 作用域化 allowSelf：人类用 /click-matrix self-allow 打开的“自身窗口例外”。
 * 三重条件（全部满足才放行）：
 *   1) config.allowSelfWindow === true（模型无法自己打开；人类命令可运行时改写）；
 *   2) extra.selfAllow.point 落在 extra.selfAllow.rect 内；
 *   3) 命中原因全部可归因为“自身进程/自身窗口”（调用方已保证）。
 * extra 缺省/非法时一律返回 false（fail-closed，向后兼容）。
 */
function allowSelfApplies(config, extra) {
  if (!config || config.allowSelfWindow !== true) return false
  if (!extra || typeof extra !== 'object') return false
  if (extra.allowSelfWindow !== undefined && extra.allowSelfWindow !== true) return false
  const self = extra.selfAllow
  if (!self || typeof self !== 'object') return false
  return pointInRect(self.point, self.rect)
}

/**
 * Evaluate the deny policy for the window under a target point.
 * @param {object} window helper window info
 * @param {object} config normalized config
 * @param {string[]} [extraProcesses] own/deny process names (defaults to ownProcessNames(config))
 * @param {{selfAllow?:{point:{x:number,y:number}, rect:{x:number,y:number,w:number,h:number}}, allowSelfWindow?:boolean}} [extra]
 *        v0.4 scoped allowSelf: only relaxes a deny whose reasons are ALL attributable
 *        to the own process/window. Admin/secure/deny-list/other reasons always deny.
 * @returns {{denied:boolean, reasons:string[], selfAllowed?:boolean}}
 */
export function evaluateWindowDeny(window, config = {}, extraProcesses = null, extra = null) {
  const reasons = []
  // 可归因为“自身窗口”的原因；只有命中原因全部在此集合内才可能 allowSelf。
  const ownReasons = []
  if (!window || typeof window !== 'object' || !window.handle) {
    return { denied: true, reasons: ['目标点下没有可识别的顶层窗口（桌面/覆盖层/捕获失败），拒绝输入'] }
  }
  if (window.denied === true) {
    reasons.push(R_HELPER_DENIED)
    ownReasons.push(R_HELPER_DENIED)
  }
  if (window.elevated === true) reasons.push('目标窗口以管理员权限运行（UIPI 会吞掉普通进程的输入）')
  if (window.minimized === true) reasons.push('目标窗口已最小化')
  const r = window.rect
  const rw = r ? Number(r.width ?? r.w) : 0
  const rh = r ? Number(r.height ?? r.h) : 0
  if (!(rw > 1) || !(rh > 1)) reasons.push('目标窗口尺寸无效')
  const proc = processBase(window.process)
  const own = Array.isArray(extraProcesses) ? extraProcesses : ownProcessNames(config)
  const ownLower = own.map((p) => processBase(p)).filter(Boolean)
  const cfgDenyLower = (Array.isArray(config.denyProcesses) ? config.denyProcesses : []).map((p) => processBase(p)).filter(Boolean)
  const intrinsicLower = intrinsicOwnProcesses().map((p) => processBase(p)).filter(Boolean)
  // 仅“自身主机进程”且不在人类 denyProcesses 中，才可能被作用域放行。
  const selfOwnProcess = proc !== '' && intrinsicLower.includes(proc) && !cfgDenyLower.includes(proc)
  if (proc && ownLower.includes(proc)) {
    const reason = `目标进程 "${proc}" 在禁止列表（自身/配置 denyProcesses）`
    reasons.push(reason)
    if (selfOwnProcess) ownReasons.push(reason)
  }
  const cls = typeof window.className === 'string' ? window.className.toLowerCase() : ''
  if (cls && SECURE_CLASSES.some((c) => cls.includes(c))) reasons.push(`目标窗口类 "${window.className}" 属于系统安全/登录界面`)
  if (proc && SECURE_PROCESSES.includes(proc)) reasons.push(`目标进程 "${proc}" 属于系统安全/登录进程`)
  // v1.4: built-in deny profiles — always on, not part of ownReasons (allowSelf can't bypass).
  const profileHit = matchDefaultDeny(window)
  if (profileHit) {
    reasons.push(`命中内建拒绝清单 [${profileHit.group}/${profileHit.label}] ${profileHit.rule}`)
  }
  const title = typeof window.title === 'string' ? window.title : ''
  for (const needle of (Array.isArray(config.denyTitleContains) ? config.denyTitleContains : [])) {
    if (typeof needle === 'string' && needle !== '' && title.toLowerCase().includes(needle.toLowerCase())) {
      reasons.push(`窗口标题命中 denyTitleContains "${needle}"`)
    }
  }
  // 三层 ACL：命中「申请名单」需人类确认（「放行名单」已在 aclTierFor 里豁免；「拒绝」上面已拦）。
  const acl = aclTierFor(window, config)
  if (acl.tier === 'ask') {
    reasons.push(`目标在申请名单（${acl.rule}）：需人类在设置页「屏幕控制」把它移到放行名单，或本次明确确认后重试`)
  }
  // v1.3 (self-window deny): pid-level protection. The plugin resolves its own
  // process tree (host + renderers + ancestors) via the helper; any target in
  // that tree is our own UI regardless of its image name.
  const ownPids = extra && extra.ownPids instanceof Set ? extra.ownPids : null
  const targetPid = Number(window.pid)
  if (ownPids && Number.isFinite(targetPid) && targetPid > 0 && ownPids.has(targetPid)) {
    const reason = `目标进程 pid=${targetPid} 属于自身/宿主进程树（pid 级保护）`
    reasons.push(reason)
    ownReasons.push(reason)
  }
  for (const needle of INTRINSIC_OWN_TITLE_NEEDLES) {
    if (title.toLowerCase().includes(needle.toLowerCase())) {
      const reason = `窗口标题是 DSH 自身界面（"${needle}"）：拒绝注入（防"自批准环"）`
      reasons.push(reason)
      ownReasons.push(reason)
      break
    }
  }
  const denied = reasons.length > 0
  if (denied && selfOwnProcess && ownReasons.length === reasons.length && allowSelfApplies(config, extra)) {
    // 放行：reasons 置空（下游按 denied 分支消费），真实原因放入 selfAllowedReasons 供审计。
    return { denied: false, selfAllowed: true, reasons: [], selfAllowedReasons: reasons }
  }
  return { denied, reasons }
}

/**
 * Check an `expect` argument ({process?, titleContains?}) against the window
 * under the point. `ok:true` when no expectation was given.
 */
export function checkExpect(window, expect) {
  if (!expect || typeof expect !== 'object') return { ok: true, checked: false }
  const checks = []
  const procWant = typeof expect.process === 'string' ? expect.process.trim() : ''
  if (procWant !== '') {
    const haveProc = processBase(window && window.process)
    const wantProc = processBase(procWant)
    const ok = haveProc !== '' && (haveProc === wantProc || haveProc.includes(wantProc) || wantProc.includes(haveProc))
    checks.push({ field: 'process', want: procWant, have: window && window.process, ok })
  }
  const titleWant = typeof expect.titleContains === 'string' ? expect.titleContains.trim() : ''
  if (titleWant !== '') {
    const haveTitle = window && typeof window.title === 'string' ? window.title : ''
    const ok = haveTitle.toLowerCase().includes(titleWant.toLowerCase())
    checks.push({ field: 'titleContains', want: titleWant, have: haveTitle, ok })
  }
  if (checks.length === 0) return { ok: true, checked: false }
  const failed = checks.filter((c) => !c.ok)
  return { ok: failed.length === 0, checked: true, checks, failed }
}

/**
 * Resolve a point target from tool args.
 * @param {object} args {x,y} or {fx,fy}, optional snap:boolean
 * @param {object} opts {virtual, monitors, lattice, snapDefault?, label?}
 * @returns {{ok:true,x,y,source,snapped,spacing,note}|{ok:false,error}}
 */
export function resolvePointTarget(args, opts) {
  const virtual = opts.virtual
  const label = opts.label || '目标'
  const a = args && typeof args === 'object' ? args : {}
  let x
  let y
  let source
  const hasXY = isNum(a.x) && isNum(a.y)
  const hasNorm = isNum(a.fx) && isNum(a.fy)
  if (hasXY) {
    x = a.x
    y = a.y
    source = 'xy'
  } else if (hasNorm) {
    const fx = a.fx
    const fy = a.fy
    const p = normToScreen(clamp01(fx), clamp01(fy), virtual)
    x = p.x
    y = p.y
    source = 'norm'
  } else {
    return { ok: false, error: `${label}需要 {x,y}（屏幕物理像素）或 {fx,fy}（虚拟屏归一化坐标 0..1）之一。` }
  }
  x = Math.round(x)
  y = Math.round(y)
  let note = ''
  if (!pointInVirtual(x, y, virtual)) {
    return {
      ok: false,
      error: `${label} (${x},${y}) 不在虚拟屏幕范围 (${virtual.x},${virtual.y}) ${virtual.w}x${virtual.h} 内；请重新 screen_info 获取边界。`,
    }
  }
  const wantSnap = a.snap === true || (a.snap !== false && opts.snapDefault === true)
  let snapped = false
  let spacing = 0
  if (wantSnap) {
    const tier = opts.lattice || 'standard'
    spacing = latticeSpacingScreen(tier, screenScaleAt(opts.monitors, x, y))
    const s = snapToLattice(x, y, { originX: virtual.x, originY: virtual.y, spacing })
    if (s.x !== x || s.y !== y) {
      snapped = true
      note = `已吸附到 ${tier} 晶格点 (${s.x},${s.y})，偏移 ${s.distance}px（间距 ${spacing}px）`
      x = s.x
      y = s.y
      if (!pointInVirtual(x, y, virtual)) {
        return { ok: false, error: `吸附后的 ${label} (${x},${y}) 超出虚拟屏幕；请改用未吸附坐标或更细晶格。` }
      }
    } else {
      note = `已在 ${tier} 晶格点上（间距 ${spacing}px）`
    }
  }
  return { ok: true, x, y, source, snapped, spacing, note }
}

/**
 * Resolve the capture `region` argument.
 * @param {unknown} region "full" | "foreground" | {x,y,w,h}
 * @param {object} ctx {virtual, foreground}
 * @returns {{ok:true, region, kind, note}|{ok:false,error}}
 */
export function resolveCaptureRegion(region, ctx) {
  const virtual = ctx.virtual
  if (region === undefined || region === null || region === 'full' || region === 'virtual') {
    return { ok: true, region: { ...virtual }, kind: 'full', note: '' }
  }
  if (region === 'foreground') {
    const fg = ctx.foreground
    if (!fg || typeof fg !== 'object' || !fg.rect) {
      return { ok: false, error: '无法获取前台窗口矩形（helper 未返回 foreground.rect）；可改用 region:"full" 或显式 {x,y,w,h}。' }
    }
    const rect = clampRect({ x: fg.rect.x, y: fg.rect.y, w: fg.rect.width ?? fg.rect.w, h: fg.rect.height ?? fg.rect.h }, virtual)
    if (!rect) return { ok: false, error: '前台窗口没有与虚拟屏幕重叠的区域。' }
    return { ok: true, region: rect, kind: 'foreground', note: `前台窗口: ${windowLabel(fg)}` }
  }
  if (typeof region === 'object' && region !== null) {
    // Object regions must be explicit, fully inside the virtual screen, and
    // numeric: silently clipping a caller's bad rect taught the model the wrong
    // coordinates (round-2 report). "full"/"foreground" keep their old behavior.
    const rx = Number(region.x)
    const ry = Number(region.y)
    const rw = Number(region.w ?? region.width)
    const rh = Number(region.h ?? region.height)
    if (![rx, ry, rw, rh].every((v) => Number.isFinite(v))) {
      return {
        ok: false,
        error: `region 需要数字 x,y,w,h（收到 x=${shortText(region.x, 20)} y=${shortText(region.y, 20)} w=${shortText(region.w ?? region.width, 20)} h=${shortText(region.h ?? region.height, 20)}）。`,
      }
    }
    if (rw < 1 || rh < 1) {
      return { ok: false, error: `region 宽高必须 ≥1（收到 ${Math.round(rw)}x${Math.round(rh)}）。` }
    }
    const rect = { x: Math.round(rx), y: Math.round(ry), w: Math.round(rw), h: Math.round(rh) }
    const inside =
      rect.x >= virtual.x
      && rect.y >= virtual.y
      && rect.x + rect.w <= virtual.x + virtual.w
      && rect.y + rect.h <= virtual.y + virtual.h
    if (!inside) {
      return {
        ok: false,
        error: `区域超出虚拟屏幕 (${virtual.x},${virtual.y} ${virtual.w}x${virtual.h})：请求 (${rect.x},${rect.y} ${rect.w}x${rect.h})。请夹取到屏幕内，或改用 region:"foreground"/"full"。`,
      }
    }
    return { ok: true, region: rect, kind: 'rect', note: '' }
  }
  return { ok: false, error: 'region 只能是 "full"、"foreground" 或 {x,y,w,h} 对象。' }
}

/** Human-readable description of a mutating action for approval/audit. */
export function buildActionText(toolName, point, window, extra = '') {
  const at = point ? `(${point.x},${point.y})` : ''
  const win = window ? `；目标窗口 ${windowLabel(window)}` : ''
  const base = `${toolName} @ ${at}${win}`
  return extra ? `${base}；${extra}` : base
}

/** Bounded short string for tool output. */
export function shortText(v, max = 200) {
  const s = typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v)
  return s.length > max ? s.slice(0, max) + '…' : s
}
