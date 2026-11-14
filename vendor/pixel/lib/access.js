/**
 * dsh-click-matrix — the access/safety gate (highest priority module).
 *
 * Modes:
 *   off   all mouse mutations denied (observation tools still allowed)
 *   ask   (default) every mutation asks the host approval service; an
 *         "allowed-once" answer opens a bounded arm window (armWindowMs /
 *         armClicks, scoped to that agent) so a short click sequence does not
 *         prompt on every pixel.
 *   auto  no per-action prompt, but STILL needs an active arm window. Arms are
 *         human-only: `/click-matrix arm [seconds]` or the global Ctrl+Alt+F12
 *         hotkey. This is deliberate: `auto` = "the human pre-authorized this
 *         window", never "the model decided by itself".
 *
 * Budgets enforced here: min interval between mutations, per-arm action limit,
 * arm expiry. Deny/pre-check helpers live in lib/policy.js; this module only
 * decides WHO may act and HOW MUCH, and it always fails closed.
 *
 * v0.2 pause: a human-takeover signal (helper `escape` / `human-input` event, or
 * an `externalAborted` result) puts the gate in a PAUSED state. While paused no
 * mutation is allowed and no approval is requested — only a fresh human arm
 * (command/hotkey/approval) clears the pause. This is "the human grabbed the
 * mouse, so the model must stop asking", not a retry hint.
 */

import { normalizeRect } from './config.js'
import { agentKey } from './policy.js'

const MODES = ['off', 'ask', 'auto']

/** 人类活动内部等待的轮询间隔（ms）。 */
const HUMAN_WAIT_POLL_MS = 250

function nowMs() {
  return Date.now()
}

function deny(code, message, extra = {}) {
  return { allowed: false, code, message, ...extra }
}

/** 秒数文案（最多 1 位小数，模型可读）。 */
function waitSecondsText(ms) {
  const s = Math.max(0, Number(ms) || 0) / 1000
  const rounded = Math.round(s * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

/** Public helper text: the human-only ways to open an arm window. */
export function humanArmAdvice(config) {
  return (
    '人类可用三种方式授权：① 输入 /click-matrix arm <秒|on>（秒=定时授权，on=常开直至关闭）'
    + '；② 按全局热键 Ctrl+Alt+F12（常开/关闭切换）'
    + '；③ /click-matrix mode auto（之后仍需 arm）。模型无法自行开启授权窗口。'
  )
}

export class AccessGate {
  /**
   * @param {object} options
   * @param {object} options.ctx plugin context (approval service read via ctx.get)
   * @param {object} options.config normalized config
   * @param {object} [options.audit] AuditLog (may be null)
   * @param {() => number} [options.now] injectable clock
   * @param {(reason:string) => (void|Promise<void>)} [options.onAbortRequested] abort helper + release buttons
   * @param {(armed:boolean, info:object) => void} [options.onArmChanged] overlay/status hook
   */
  constructor(options = {}) {
    this.ctx = options.ctx
    this.config = options.config
    this.audit = options.audit || null
    this.now = typeof options.now === 'function' ? options.now : nowMs
    this.onAbortRequested = typeof options.onAbortRequested === 'function' ? options.onAbortRequested : () => {}
    this.onArmChanged = typeof options.onArmChanged === 'function' ? options.onArmChanged : () => {}
    this.mode = MODES.includes(options.config.mode) ? options.config.mode : 'ask'
    this.arm = null
    this.paused = null
    this.suspended = null
    // v0.4 作用域化 allowSelf：{rect,until,source} 或 null（人类命令/配置启用）。
    this.selfAllow = null
    this.lastMutationAt = 0
    this.helperHotkeyArmed = false
    this.lastDeny = ''
  }

  /** Enter the auto-clearing human-activity suspension (not a full pause). */
  setSuspended(info = {}) {
    const reason = String(info.reason || 'human-activity').slice(0, 200)
    this.suspended = {
      reason,
      at: Number.isFinite(info.at) ? info.at : this.now(),
      tool: String(info.tool || '').slice(0, 40),
      idleResumeMs: Number.isFinite(info.idleResumeMs) ? info.idleResumeMs : 20000,
    }
    return this.suspended
  }

  clearSuspended() {
    if (!this.suspended) return false
    this.suspended = null
    return true
  }

  isSuspended() {
    return this.suspended !== null
  }

  /** 人类活动暂停的立即拒绝文案（原有语义：不传 wait 时立刻 deny）。 */
  #suspendedDeny(extra = {}) {
    const secs = Math.round((this.suspended.idleResumeMs || 20000) / 1000)
    const waitMax = Math.round(Number(this.config.humanWaitMaxMs) / 1000)
    return deny(
      'suspended',
      `人类正在操作（${this.suspended.reason}）：注入已暂停，停止操作约 ${secs} 秒后自动恢复${this.arm ? '（当前授权仍有效）' : ''}。请先等待，不要重试。`
        + (waitMax > 0 ? `如需工具内部等待，可传 waitForHumanIdleMs（上限 ${waitMax} 秒）。` : ''),
      { suspended: { ...this.suspended }, ...extra },
    )
  }

  /** 已暂停（人类接管）的拒绝文案；extra 可带 waitedMs/waitNote。 */
  #pausedDeny(extra = {}) {
    this.lastDeny = 'paused'
    return deny(
      'paused',
      `已暂停：${this.paused.reason}。人类接管/外部输入后模型必须停下；恢复需人类执行 /click-matrix arm <秒|on> 或按 Ctrl+Alt+F12（模型无法自行恢复）。`,
      { paused: { ...this.paused }, ...extra },
    )
  }

  /** Enter the human-takeover pause state (idempotent). */
  setPaused(info = {}) {
    const reason = String(info.reason || 'human-input').slice(0, 200)
    this.paused = {
      reason,
      at: Number.isFinite(info.at) ? info.at : this.now(),
      tool: String(info.tool || '').slice(0, 40),
    }
    return this.paused
  }

  /** Clear the pause (a successful human arm does this). */
  clearPaused() {
    if (!this.paused) return false
    this.paused = null
    return true
  }

  isPaused() {
    return this.paused !== null
  }

  // --- v0.4 作用域化 allowSelf（自身窗口例外，单次矩形 + 到期时间，可审计） ---

  /**
   * 人类命令调用：在给定矩形内临时允许对“自身窗口”操作。
   * 只放宽窗口 deny 判定的“自身进程”这一类原因，仍需有效 arm/审批。
   * rect 缺省时回退到 config.allowSelfRect（人类在配置文件里预置的矩形）。
   * @param {{rect?:object, seconds?:number, source?:string}} options
   * @returns {{ok:boolean, active:boolean, rect:object|null, remainingMs:number, source?:string, until?:number, error?:string}}
   */
  selfAllowArm(options = {}) {
    const opts = options && typeof options === 'object' ? options : {}
    const rectInput = opts.rect === undefined || opts.rect === null ? this.config.allowSelfRect : opts.rect
    const rect = normalizeRect(rectInput)
    if (!rect) {
      return {
        ok: false,
        active: false,
        armed: false,
        rect: null,
        remainingMs: 0,
        seconds: 0,
        source: '',
        error: 'selfAllowArm 需要合法 rect：{x,y,w,h}（x/y 非负整数，w/h 正整数）；本次未开启作用域授权。',
      }
    }
    const maxMs = Number.isFinite(this.config.allowSelfMaxMs) ? this.config.allowSelfMaxMs : 120000
    const fallbackSecs = Number.isFinite(this.config.armDefaultSeconds) ? this.config.armDefaultSeconds : 60
    const secs = Number(opts.seconds)
    const wantMs = Number.isFinite(secs) && secs > 0 ? secs * 1000 : fallbackSecs * 1000
    const ms = Math.max(1000, Math.min(maxMs, Math.round(wantMs)))
    const until = this.now() + ms
    this.selfAllow = { rect, until, source: String(opts.source || 'human').slice(0, 40) }
    return { ok: true, ...this.selfAllowSnapshot(), source: this.selfAllow.source, until }
  }

  /** 清除作用域授权（人类命令/STOP）。 */
  selfAllowOff() {
    const wasActive = this.selfAllowSnapshot().active
    this.selfAllow = null
    return { ok: true, wasActive, ...this.selfAllowSnapshot() }
  }

  /** 当前作用域授权快照；过期即清（lazy）。active 与 armed 是同一状态的两个别名。 */
  selfAllowSnapshot() {
    const now = this.now()
    if (this.selfAllow && now >= this.selfAllow.until) this.selfAllow = null
    if (!this.selfAllow) return { active: false, armed: false, rect: null, remainingMs: 0, seconds: 0, source: '' }
    const remainingMs = Math.max(0, this.selfAllow.until - now)
    return {
      active: true,
      armed: true,
      rect: { ...this.selfAllow.rect },
      remainingMs,
      seconds: Math.round(remainingMs / 1000),
      source: this.selfAllow.source,
    }
  }

  /** 该点是否在当前作用域授权矩形内（右上/下边界为开区间）。 */
  selfAllows(point) {
    const snap = this.selfAllowSnapshot()
    if (!snap.active || !snap.rect) return false
    const p = point && typeof point === 'object' ? point : null
    if (!p) return false
    const x = Number(p.x)
    const y = Number(p.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false
    return x >= snap.rect.x && y >= snap.rect.y && x < snap.rect.x + snap.rect.w && y < snap.rect.y + snap.rect.h
  }

  /** 人类活动内部等待预算：0 = 不等待（保持原有立即拒绝语义）。 */
  #humanWaitBudget(requested) {
    const max = Number(this.config.humanWaitMaxMs)
    if (!Number.isFinite(max) || max <= 0) return 0
    const n = Number(requested)
    if (!Number.isFinite(n) || n <= 0) return 0
    return Math.max(1, Math.min(max, Math.round(n)))
  }

  /** await ms；被 abort 时提前唤醒（不 reject，由调用方复查 abort）。 */
  #sleep(ms, signal) {
    return new Promise((resolve) => {
      if (signal && signal.aborted === true) {
        resolve()
        return
      }
      let timer = null
      const done = () => {
        if (timer) clearTimeout(timer)
        timer = null
        if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', done)
        resolve()
      }
      timer = setTimeout(done, Math.max(0, Math.round(ms)))
      if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', done, { once: true })
    })
  }

  /**
   * 人类活动期间内部等待：每 250ms 轮询，直到解除 / 超时 / abort / 人类接管暂停。
   * @returns {Promise<{ok:true, waitedMs:number}|{ok:false, decision:object}>}
   */
  async #waitForHumanIdle(budgetMs, exec, tool) {
    const started = this.now()
    const deadline = started + budgetMs
    const signal = exec && exec.signal
    for (;;) {
      if (this.paused) {
        this.lastDeny = 'paused'
        const waitedMs = Math.max(0, this.now() - started)
        return {
          ok: false,
          decision: deny(
            'paused',
            `已暂停（${this.paused.reason}）：内部等待被打断，已内部等待 ${waitSecondsText(waitedMs)} 秒后停止，本次鼠标操作未执行。恢复需人类执行 /click-matrix arm <秒|on> 或按 Ctrl+Alt+F12（模型无法自行恢复）。`,
            { paused: { ...this.paused }, waitedMs, tool },
          ),
        }
      }
      if (!this.suspended) return { ok: true, waitedMs: Math.max(0, this.now() - started) }
      if (signal && signal.aborted === true) {
        this.lastDeny = 'aborted'
        const waitedMs = Math.max(0, this.now() - started)
        return {
          ok: false,
          decision: deny(
            'aborted',
            `内部等待已被取消（工具调用已 abort）：已内部等待 ${waitSecondsText(waitedMs)} 秒后停止，本次鼠标操作未执行。`,
            { waitedMs, tool },
          ),
        }
      }
      const remain = deadline - this.now()
      if (remain <= 0) {
        this.lastDeny = 'suspended-timeout'
        const waitedMs = Math.max(0, this.now() - started)
        const susp = this.suspended || {}
        const idle = Number.isFinite(susp.idleResumeMs) && susp.idleResumeMs > 0 ? susp.idleResumeMs : 20000
        const since = Number.isFinite(susp.at) ? susp.at : started
        const retryAfterMs = Math.max(0, Math.round(idle - Math.max(0, this.now() - since)))
        return {
          ok: false,
          decision: deny(
            'suspended-timeout',
            `等待人类空闲超时，可稍后重试：已内部等待 ${waitSecondsText(waitedMs)} 秒后人类仍在操作（${susp.reason || 'human-activity'}），预计约 ${waitSecondsText(retryAfterMs)} 秒后空闲自动恢复。本次鼠标操作未执行。`,
            { retryAfterMs, waitedMs, waitBudgetMs: budgetMs, suspended: { ...susp }, tool },
          ),
        }
      }
      await this.#sleep(Math.min(HUMAN_WAIT_POLL_MS, remain), signal)
    }
  }

  /** Effective mode (runtime command overrides are stored here). */
  getMode() {
    return this.mode
  }

  setMode(mode) {
    const v = String(mode || '').trim().toLowerCase()
    if (!MODES.includes(v)) return { ok: false, error: `未知模式 "${mode}"，可选: off|ask|auto` }
    const previous = this.mode
    this.mode = v
    if (v === 'off') this.disarm('mode switched to off')
    return { ok: true, previous, mode: this.mode }
  }

  #pruneExpired(now) {
    if (!this.arm) return false
    if (this.arm.latched) return false
    if (now >= this.arm.until || this.arm.clicksUsed >= this.arm.limit) {
      this.arm = null
      this.#emitArm(false, 'expired')
      return true
    }
    return false
  }

  /** Current non-expired arm or null. */
  activeArm() {
    this.#pruneExpired(this.now())
    return this.arm
  }

  #emitArm(armed, source, extra = {}) {
    try {
      this.onArmChanged(armed, { source, ...this.snapshot() , ...extra })
    } catch {
      /* UI hint must never break the gate */
    }
  }

  /**
   * Open a bounded arm window. `owner` is an agent key or 'human' (global).
   * A newer arm always replaces an older one.
   */
  openArm({ owner, ms, clicks, source, latched }) {
    const now = this.now()
    const ttl = Math.max(1000, Math.min(86400000, Math.round(Number(ms) || this.config.armWindowMs)))
    const limit = Math.max(1, Math.min(10000, Math.round(Number(clicks) || this.config.armClicks)))
    this.arm = latched === true
      ? { owner: String(owner || 'human'), until: Infinity, clicksUsed: 0, limit: 0, source: String(source || 'arm'), latched: true }
      : { owner: String(owner || 'human'), until: now + ttl, clicksUsed: 0, limit, source: String(source || 'arm'), latched: false }
    // A successful human arm is also the resume gesture after a pause/suspension.
    this.clearPaused()
    this.clearSuspended()
    this.#emitArm(true, this.arm.source, { until: this.arm.until })
    return this.arm
  }

  /** Human command/hotkey arm: global across agents. */
  humanArm(seconds, source = 'human') {
    const secs = Math.max(1, Math.min(86400, Math.round(Number(seconds) || 60)))
    return this.openArm({ owner: 'human', ms: secs * 1000, clicks: this.config.armClicks, source })
  }

  /** Human "keep on" latch: no expiry, no per-action count, until toggled off. */
  humanLatch(source = 'hotkey') {
    return this.openArm({ owner: 'human', latched: true, source })
  }

  disarm(reason = 'disarm') {
    const was = !!this.arm
    this.arm = null
    this.helperHotkeyArmed = false
    if (was) this.#emitArm(false, reason)
    return { ok: true, wasArmed: was, reason }
  }

  /**
   * Ctrl+Alt+F12 is a KEEP-ON toggle: first press latches authorization on (no
   * expiry, no per-action count), next press turns it off. Esc / STOP still stop
   * immediately. Host arm state remains the authority (helper payload advisory).
   */
  hotkeyChanged(_helperArmed, combo) {
    const comboName = combo || 'Ctrl+Alt+F12'
    if (this.activeArm()) {
      this.disarm('hotkey')
      return { armed: false, combo: comboName }
    }
    this.humanLatch('hotkey')
    this.helperHotkeyArmed = true
    return { armed: true, combo: comboName, latched: true }
  }

  /** Disarm + ask the helper to abort/release immediately (safety failure/stop). */
  safetyAbort(reason) {
    const wasArmed = !!this.arm
    this.disarm(reason)
    try {
      const result = this.onAbortRequested(reason)
      if (result && typeof result.catch === 'function') result.catch(() => {})
    } catch {
      /* abort is best-effort; the helper also releases on its own */
    }
    return { aborted: true, wasArmed, reason }
  }

  snapshot() {
    const now = this.now()
    const arm = this.activeArm()
    return {
      mode: this.mode,
      armed: !!arm,
      latched: !!(arm && arm.latched),
      owner: arm ? arm.owner : '',
      source: arm ? arm.source : '',
      remainingMs: arm ? (arm.latched ? -1 : Math.max(0, arm.until - now)) : 0,
      clicksUsed: arm ? arm.clicksUsed : 0,
      clicksLimit: arm ? (arm.latched ? 0 : arm.limit) : 0,
      hotkeyArmed: this.helperHotkeyArmed,
      lastMutationAgoMs: this.lastMutationAt ? Math.max(0, now - this.lastMutationAt) : -1,
      minIntervalMs: this.config.minIntervalMs,
      paused: this.paused ? { ...this.paused } : null,
      suspended: this.suspended ? { ...this.suspended } : null,
      selfAllow: this.selfAllowSnapshot(),
    }
  }

  #rateLimited(now) {
    if (!this.lastMutationAt) return false
    const delta = now - this.lastMutationAt
    return delta < this.config.minIntervalMs
  }

  #grant(now, arm, extra = {}) {
    if (arm) arm.clicksUsed += 1
    this.lastMutationAt = now
    const latched = !!(arm && arm.latched)
    const remain = arm && !latched ? Math.max(0, arm.limit - arm.clicksUsed) : 0
    if (arm && !latched && arm.clicksUsed >= arm.limit) {
      this.arm = null
      this.#emitArm(false, 'clicks-used-up')
    }
    return { allowed: true, code: 'allowed', arm: this.snapshot(), clicksLeft: latched ? -1 : remain, ...extra }
  }

  /**
   * Gate one mutating action (click/drag/scroll).
   *
   * v0.4 人类活动内部等待：suspended 期间若调用方传 waitForHumanIdleMs > 0，
   * 闸门在内部每 250ms 轮询（总预算受 config.humanWaitMaxMs 限制）而不是立刻
   * 拒绝；暂停（Esc/STOP）或 exec.signal abort 会立即停止等待。成功放行时返回
   * waitedMs 与中文 waitNote（“已内部等待 N 秒后继续”）。不传 wait 时行为不变。
   *
   * @param {object} input
   * @param {string} input.toolName
   * @param {object} [input.exec] tool exec context ({agent, callId, signal})
   * @param {string} input.action short human description of the exact action
   * @param {object} [input.target] {x,y} for the audit/approval text
   * @param {object} [input.window] pre-checked window info (for the approval text)
   * @param {number} [input.waitForHumanIdleMs] 人类活动期间内部等待预算（0=立即拒绝）
   * @returns {Promise<{allowed:boolean, code:string, message?:string, arm?:object, clicksLeft?:number, waitedMs?:number}>}
   */
  async check(input) {
    const req = input && typeof input === 'object' ? input : {}
    const tool = req.toolName || 'unknown'
    const agent = agentKey(req.exec)
    if (this.mode === 'off') {
      this.lastDeny = 'mode=off'
      return deny('mode-off', '鼠标控制已关闭（mode=off）。观察工具可用；需要操作请人类执行 /click-matrix mode ask 并授权。', { mode: 'off' })
    }
    if (this.paused) return this.#pausedDeny()
    let waitedMs = 0
    if (this.suspended) {
      const budget = this.#humanWaitBudget(req.waitForHumanIdleMs)
      if (budget <= 0) {
        this.lastDeny = 'suspended'
        return this.#suspendedDeny()
      }
      const waited = await this.#waitForHumanIdle(budget, req.exec, tool)
      if (!waited.ok) {
        this.lastDeny = waited.decision.code
        return waited.decision
      }
      waitedMs = waited.waitedMs
    }
    return this.#decide(req, agent, waitedMs)
  }

  /**
   * 内部等待结束后的原有检查逻辑：mode/paused/suspended/rate-limit/arm/审批
   * 全部按当前状态重新检查（fail-closed）。拆成私有方法以避免递归调用 check()。
   */
  async #decide(input, agent, waitedMs) {
    const now = this.now()
    const tool = input.toolName || 'unknown'
    const waitExtra = waitedMs > 0
      ? { waitedMs, waitNote: `已内部等待 ${waitSecondsText(waitedMs)} 秒后继续（人类已停止操作）。` }
      : { waitedMs: 0 }
    if (this.mode === 'off') {
      this.lastDeny = 'mode=off'
      return deny('mode-off', '鼠标控制已关闭（mode=off）。观察工具可用；需要操作请人类执行 /click-matrix mode ask 并授权。', { mode: 'off', ...waitExtra })
    }
    if (this.paused) return this.#pausedDeny(waitExtra)
    if (this.suspended) {
      this.lastDeny = 'suspended'
      return this.#suspendedDeny(waitExtra)
    }
    if (this.#rateLimited(now)) {
      this.lastDeny = 'rate-limited'
      return deny('rate-limited', `操作过于频繁：两次鼠标变更动作之间至少间隔 ${this.config.minIntervalMs}ms，请稍等后重试。`, {
        retryAfterMs: Math.max(1, this.config.minIntervalMs - (now - this.lastMutationAt)),
        ...waitExtra,
      })
    }
    const active = this.activeArm()
    if (active && (active.owner === 'human' || active.owner === agent)) {
      return this.#grant(now, active, { source: 'arm', agent, ...waitExtra })
    }
    if (this.mode === 'auto') {
      this.lastDeny = 'arm-required'
      return deny(
        'arm-required',
        'mode=auto 不会逐次弹窗，但仍必须有人类授权窗口。当前没有有效授权：请人类执行 /click-matrix arm <秒> 或按 Ctrl+Alt+F12。',
        { hint: humanArmAdvice(this.config), ...waitExtra },
      )
    }
    // ask mode, no arm yet -> host approval
    const approval = this.#getService('approval')
    if (!approval || typeof approval.request !== 'function') {
      this.lastDeny = 'approval-unavailable'
      return deny(
        'approval-unavailable',
        '宿主没有提供 approval 服务（或在当前会话被禁用），无法逐次请示。' + humanArmAdvice(this.config),
        { hint: humanArmAdvice(this.config), ...waitExtra },
      )
    }
    const reason = String(input.reason || input.action || tool).slice(0, 500)
    let outcome = 'error'
    try {
      outcome = await approval.request({
        agent: input.exec && input.exec.agent,
        toolName: tool,
        callId: input.exec && input.exec.callId,
        reason,
        displayReason: {
          en: `click-matrix requests one desktop mouse action: ${input.action || tool}`,
          zh: `click-matrix 请求执行一次桌面鼠标操作：${input.action || tool}`,
        },
        signal: input.exec && input.exec.signal,
      })
      if (outcome && typeof outcome === 'object') outcome = outcome.result || outcome.outcome || outcome
    } catch (error) {
      this.lastDeny = 'approval-error'
      return deny('approval-error', `审批请求失败: ${error && error.message ? error.message : error}。` + humanArmAdvice(this.config), { ...waitExtra })
    }
    const verdict = String(outcome || '')
    if (verdict === 'allowed-once' || verdict === 'allowed') {
      this.openArm({
        owner: agent,
        ms: this.config.armWindowMs,
        clicks: this.config.armClicks,
        source: 'approval',
      })
      return this.#grant(this.now(), this.activeArm(), { source: 'approval', agent, ...waitExtra })
    }
    this.lastDeny = verdict || 'rejected'
    const label =
      verdict === 'rejected'
        ? '人类拒绝了本次操作'
        : verdict === 'cancelled'
          ? '审批被取消（可能因回合结束/用户中断）'
          : '审批服务不可用'
    return deny('denied', `${label}，本次鼠标操作未执行。` + humanArmAdvice(this.config), { verdict, ...waitExtra })
  }

  /**
   * Non-mutating but rate-limited pointer move. No approval/arm needed, but the
   * gate still refuses while mode=off and enforces the same min interval so a
   * model cannot spin the cursor as a side channel.
   */
  checkMove(toolName = 'mouse_move') {
    const now = this.now()
    if (this.mode === 'off') {
      return deny('mode-off', '鼠标控制已关闭（mode=off），不会移动光标。')
    }
    if (this.paused) {
      return deny('paused', `已暂停：${this.paused.reason}。恢复需人类重新授权（/click-matrix arm 或 Ctrl+Alt+F12）。`)
    }
    if (this.suspended) {
      const secs = Math.round((this.suspended.idleResumeMs || 20000) / 1000)
      return deny('suspended', `人类正在操作（${this.suspended.reason}）：停止操作约 ${secs} 秒后自动恢复，请先等待。`)
    }
    if (this.#rateLimited(now)) {
      return deny('rate-limited', `移动过于频繁：两次操作之间至少间隔 ${this.config.minIntervalMs}ms。`, {
        retryAfterMs: Math.max(1, this.config.minIntervalMs - (now - this.lastMutationAt)),
      })
    }
    return { allowed: true, code: 'allowed' }
  }

  /** Record that an allowed pointer move happened (rate limiting only). */
  noteMove() {
    this.lastMutationAt = this.now()
  }

  #getService(name) {
    try {
      if (this.ctx && typeof this.ctx.get === 'function') return this.ctx.get(name)
      if (this.ctx) return this.ctx[name]
    } catch {
      return undefined
    }
    return undefined
  }
}
