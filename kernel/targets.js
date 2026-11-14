/**
 * Target policy — what authorization can never cover.
 *
 * Two permanent categories, decided by the *target*, not by the caller:
 *
 *   system    never injected into, at all, whatever grant is open. Security software
 *             panels, credential managers, system configuration tools, and anything
 *             running elevated. This list is deliberately NOT configurable: it is the
 *             one place where "make it easier next time" must not win.
 *   sensitive step-by-step asking. Chat, mail, payment/banking screens and anything
 *             whose title looks like credentials. A session grant does not cover these:
 *             each write asks again.
 *
 * Matching is by process base name and window-title substring, case-insensitive. It is
 * a heuristic, not a guarantee — SECURITY.md says so, and the engine's own deny list
 * still applies on top.
 */

const SYSTEM_PROCESSES = [
  // security software
  'hipsmain.exe', 'hipsdaemon.exe', 'hipstray.exe', 'hipstray64.exe',
  '360safe.exe', '360tray.exe', '360rp.exe', 'qqpctray.exe', 'qqpcmgr.exe',
  'securityhealthsystray.exe', 'securityhealthui.exe', 'msmpeng.exe', 'mpcmdrun.exe',
  // credential managers
  'keepass.exe', 'keepassxc.exe', '1password.exe', 'bitwarden.exe', 'dashlane.exe',
  'enpass.exe', 'keeper.exe', 'authy.exe', 'roboform.exe',
  // system configuration tools
  'regedit.exe', 'taskmgr.exe', 'mmc.exe', 'compmgmtlauncher.exe', 'gpedit.msc',
  'secpol.msc', 'services.msc', 'devmgmt.msc', 'diskmgmt.msc', 'virtmgmt.msc',
  'eventvwr.msc', 'taskschd.msc', 'msconfig.exe', 'control.exe', 'systemsettings.exe',
]

const SYSTEM_TITLES = [
  '注册表编辑器', '磁盘管理', '服务', '组策略编辑器', '本地安全策略', '事件查看器',
  '任务计划程序', '系统配置', 'BitLocker', '凭据管理器', 'Windows 安全中心', '火绒安全',
  'Registry Editor', 'Task Manager', 'Services', 'Event Viewer', 'Credential Manager',
  'Windows Security', 'Group Policy', 'Local Security Policy',
]

const SENSITIVE_PROCESSES = [
  // payment / banking
  'bancs', 'ebank', 'alipay', 'wallet',
  // chat / mail — private conversations
  'wechat.exe', 'weixin.exe', 'qq.exe', 'tim.exe', 'dingtalk.exe', 'feishu.exe',
  'telegram.exe', 'whatsapp.exe', 'discord.exe', 'signal.exe',
  'outlook.exe', 'thunderbird.exe', 'foxmail.exe',
]

const SENSITIVE_TITLES = [
  '微信', '支付', '银行', '账单', '收银台', '转账', '密码', '登录', '验证码', '身份证',
  '邮箱', '邮件', '私信', '聊天', '通讯录',
  // A password database opened in any editor is still a password database (seen in
  // practice: Notepad restoring a .kdbx tab on 2026-11-14).
  '.kdbx', 'kdbx', 'keepass',
  'WeChat', 'Payment', 'Bank', 'Password', 'Sign in', 'Sign-in', 'Login', 'Mail', 'Inbox',
]

function baseName(process) {
  const text = String(process || '').trim().toLowerCase()
  if (text === '') return ''
  const parts = text.split(/[\\/]/)
  return parts[parts.length - 1]
}

function includesAny(haystack, needles) {
  const text = String(haystack || '').toLowerCase()
  if (text === '') return ''
  for (const needle of needles) {
    if (text.includes(String(needle).toLowerCase())) return needle
  }
  return ''
}

/**
 * @param {{process?:string, title?:string, elevated?:boolean, handle?:string|number, source?:string}} target
 * @returns {{category:'system'|'sensitive'|'normal', reasons:string[], label:string, source:string}}
 */
export function classifyTarget(target = {}) {
  const process = baseName(target.process)
  const title = String(target.title || '')
  const source = String(target.source || 'unknown')
  const label = [process || '(进程未知)', title ? `「${title}」` : ''].filter(Boolean).join(' ')
  const reasons = []

  if (target.elevated === true) {
    reasons.push('目标进程有管理员权限（UIPI 会拒绝注入，本插件也不尝试跨完整性注入）')
  }
  const systemProcess = includesAny(process, SYSTEM_PROCESSES)
  if (systemProcess) reasons.push(`系统/安全类进程（${systemProcess}）`)
  const systemTitle = includesAny(title, SYSTEM_TITLES)
  if (systemTitle) reasons.push(`系统/安全类窗口（标题含「${systemTitle}」）`)
  if (reasons.length > 0) return { category: 'system', reasons, label, source }

  const sensitiveProcess = includesAny(process, SENSITIVE_PROCESSES)
  if (sensitiveProcess) reasons.push(`私人/支付类进程（${sensitiveProcess}）`)
  const sensitiveTitle = includesAny(title, SENSITIVE_TITLES)
  if (sensitiveTitle) reasons.push(`私人/支付类窗口（标题含「${sensitiveTitle}」）`)
  if (reasons.length > 0) return { category: 'sensitive', reasons, label, source }

  return { category: 'normal', reasons: [], label, source }
}

/** Text shown when a system target is refused. */
export function systemRefusal(target) {
  return `⛔ 永久禁止：${target.label} 属于系统/安全类目标（${target.reasons.join('；')}）。`
    + '任何授权（包括常开）都不覆盖它——请人工操作，或者告诉我换一个目标。'
}

/** Text shown when a sensitive target needs one more confirmation. */
export function sensitiveNote(target) {
  return `私人相关目标（${target.reasons.join('；')}）：即使有常开授权也逐条请示。`
}

export const POLICY_LISTS = Object.freeze({
  systemProcesses: SYSTEM_PROCESSES,
  systemTitles: SYSTEM_TITLES,
  sensitiveProcesses: SENSITIVE_PROCESSES,
  sensitiveTitles: SENSITIVE_TITLES,
})
