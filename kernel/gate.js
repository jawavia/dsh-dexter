/**
 * The one authorization gate.
 *
 * Model (2026-11-14, simplified to what a human actually wants to press):
 *
 *   - a human opens a **session grant** with `/dexter arm 30m 200` or Ctrl+Alt+F12.
 *     While it is open, writes do not ask; they consume one action from the grant.
 *   - no grant open → `askOnWrite` (default on) asks the host approval service for
 *     every single write. Turn it off to make the plugin refuse instead of asking.
 *   - a **rate cap** (`maxActionsPerMinute`) applies in every mode: a burst is refused
 *     even inside a session, because nobody can review 300 clicks a minute.
 *   - **system targets never pass** (kernel/targets.js) — no grant covers them.
 *   - **sensitive targets** always take the per-write question (`forceAsk`), even
 *     inside a session.
 *   - stop (Esc / Ctrl+Alt+F11 / /dexter stop / stop.signal) revokes everything.
 *
 * There is no agent-side grant call. `hands_act action=stop` can only revoke.
 */
import { clampInt } from './util.js'

const GRANT_SOURCES = new Set(['hotkey', 'command', 'config', 'test'])
const RATE_WINDOW_MS = 60000

export class Gate {
  /**
   * @param {object} options
   * @param {ReturnType<import('./config.js').normalizeConfig>} options.config
   * @param {import('./audit.js').Audit} options.audit
   * @param {object|null} [options.approval] host approval service
   * @param {() => number} [options.clock]
   */
  constructor({ config, audit, approval = null, live = null, clock = () => Date.now() } = {}) {
    this.config = config
    // Volatile settings (armMinutes / armActions / maxActionsPerMinute) update in place when
    // the human changes them in DSH's Settings page; read them through this accessor so a
    // cached snapshot does not keep the old numbers.
    this.live = typeof live === 'function' ? live : (key) => config[key]
    this.audit = audit
    this.approval = approval
    this.now = clock
    this.grant = null
    this.stopped = null
    this.uses = 0
    this.denials = 0
    this.approvals = 0
    this.actionTimes = []
  }

  setApprovalService(service) {
    this.approval = service || null
  }

  hasApprovalChannel() {
    return Boolean(this.approval && typeof this.approval.request === 'function')
  }

  #auditRow(entry) {
    try {
      this.audit?.append(entry)
    } catch { /* the gate never throws on audit */ }
  }

  /** Drop expired grants and remember the grant has no actions left. */
  #prune() {
    if (!this.grant) return null
    const now = this.now()
    if (now >= this.grant.expiresAt) {
      this.#auditRow({ tool: 'gate', capability: 'grant', decision: 'grant-expired', approval: 'session', reason: `session expired (${this.grant.minutes}m)` })
      this.grant = null
      return null
    }
    if (this.grant.used >= this.grant.actions) {
      // Do NOT drop the grant object: `extendGrant` revives an exhausted session (that is
      // what the extend hotkey is for). Authorization still sees "no grant" here.
      this.#auditRow({ tool: 'gate', capability: 'grant', decision: 'grant-exhausted', approval: 'session', reason: `session used ${this.grant.used}/${this.grant.actions} actions` })
      return null
    }
    return this.grant
  }

  /** Sliding-window rate cap. Returns 0 when allowed, else ms to wait. */
  #rateWait(need = 1) {
    const limit = this.live('maxActionsPerMinute')
    if (!limit || limit <= 0) return 0
    const now = this.now()
    this.actionTimes = this.actionTimes.filter((at) => now - at < RATE_WINDOW_MS)
    if (this.actionTimes.length + need <= limit) return 0
    const oldest = this.actionTimes[0] || now
    return Math.max(1, RATE_WINDOW_MS - (now - oldest))
  }

  #recordAction() {
    this.actionTimes.push(this.now())
    // Keep the array bounded even if the limit is huge.
    if (this.actionTimes.length > 2000) this.actionTimes = this.actionTimes.slice(-1000)
  }

  /**
   * Open a session grant. Human-only (`hotkey` / `command` / `test`).
   * Both bounds are always present: they come from the config defaults unless the
   * human typed their own numbers.
   */
  openGrant({ minutes = 0, actions = 0, source = 'command' } = {}) {
    if (!GRANT_SOURCES.has(source)) {
      return { ok: false, error: `未知授权来源 "${source}"：只有人手（热键/命令）能开授权。` }
    }
    const minutesValue = clampInt(minutes, 1, 480, this.live('armMinutes'))
    const actionLimit = clampInt(actions, 1, 5000, this.live('armActions'))
    this.stopped = null
    this.grant = {
      minutes: minutesValue,
      actions: actionLimit,
      used: 0,
      source,
      openedAt: this.now(),
      expiresAt: this.now() + minutesValue * 60000,
    }
    this.#auditRow({
      tool: 'gate',
      capability: 'grant',
      decision: 'grant-opened',
      approval: 'session',
      source,
      result: `minutes=${minutesValue} actions=${actionLimit} rate=${this.live('maxActionsPerMinute')}/min`,
    })
    return { ok: true, grant: this.snapshot().grant }
  }

  /** Add time/actions to the open grant (the "extend" hotkey). */
  extendGrant({ minutes = 0, actions = 0, source = 'hotkey' } = {}) {
    if (!GRANT_SOURCES.has(source)) return { ok: false, error: '只有人手能续授权。' }
    const now = this.now()
    // An *exhausted* grant is still extendable (that is the point of the key); only an
    // expired one starts over.
    if (!this.grant || now >= this.grant.expiresAt) {
      if (this.grant) {
        this.#auditRow({ tool: 'gate', capability: 'grant', decision: 'grant-expired', approval: 'session', reason: `session expired (${this.grant.minutes}m)` })
        this.grant = null
      }
      return this.openGrant({ minutes, actions, source })
    }
    const extraMinutes = clampInt(minutes, 1, 480, this.live('armMinutes'))
    const extraActions = clampInt(actions, 1, 5000, this.live('armActions'))
    this.grant.minutes += extraMinutes
    this.grant.actions += extraActions
    this.grant.expiresAt += extraMinutes * 60000
    this.#auditRow({
      tool: 'gate',
      capability: 'grant',
      decision: 'grant-extended',
      approval: 'session',
      source,
      result: `+${extraMinutes}m +${extraActions} actions`,
    })
    return { ok: true, grant: this.snapshot().grant }
  }

  /** Emergency stop: revoke everything and refuse until a human opens a grant again. */
  stop({ level = 'hard', by = 'human', reason = '' } = {}) {
    const hadGrant = Boolean(this.grant)
    this.grant = null
    this.stopped = { level: level === 'soft' ? 'soft' : 'hard', by, reason, at: this.now() }
    this.#auditRow({
      tool: 'gate',
      capability: 'stop',
      decision: 'stop',
      approval: 'revoked',
      result: hadGrant ? 'session revoked' : 'no session was open',
      reason,
      source: by,
    })
    return { ...this.stopped }
  }

  clearStop(by = 'human') {
    if (!this.stopped) return false
    const previous = this.stopped
    this.stopped = null
    this.#auditRow({ tool: 'gate', capability: 'stop', decision: 'stop-cleared', source: by, reason: previous.reason })
    return true
  }

  /**
   * Decide one write.
   * @param {{tool:string, capability:string, exec?:object, reason?:string, dryRun?:boolean,
   *          forceAsk?:boolean, hoverFree?:boolean, target?:string}} input
   * @returns {Promise<{allowed:boolean, approval:string, reason:string, retryAfterMs?:number}>}
   */
  async authorize({ tool, capability, exec = {}, reason = '', dryRun = false, forceAsk = false, hoverFree = false, target = '', actions = 1 } = {}) {
    // One decision may cover a whole batch, so it must be charged for every step it covers:
    // otherwise 25 injections cost one grant credit and one rate tick.
    const charge = clampInt(actions, 1, 25, 1)
    if (dryRun) return { allowed: true, approval: 'dry-run', reason: 'rehearsal: no approval consumed' }
    if (this.config.readOnly) {
      this.denials += 1
      return { allowed: false, approval: 'none', reason: '⛔ readOnly=true：只能看，不能动手。' }
    }
    // No evidence, no injection: a broken audit trail is a refusal, not a warning.
    if (this.audit && this.audit.broken) {
      this.denials += 1
      return {
        allowed: false,
        approval: 'none',
        reason: '⛔ 审计不可写（audit.broken）：没有审计就不注入。请检查 ~/.dsh/dexter/audit 的权限与磁盘空间。',
      }
    }
    if (this.stopped) {
      this.denials += 1
      return {
        allowed: false,
        approval: 'none',
        reason: `⛔ 急停状态（${this.stopped.level}，by=${this.stopped.by}${this.stopped.reason ? `，${this.stopped.reason}` : ''}）：`
          + '当前没有任何授权，下一次写动作一律拒绝。需要继续时由人手执行 /dexter arm 或按 Ctrl+Alt+F12 重新授权。',
      }
    }
    const wait = this.#rateWait(charge)
    if (wait > 0) {
      this.denials += 1
      return {
        allowed: false,
        approval: 'none',
        retryAfterMs: wait,
        reason: `⛔ 频率上限：最近 60 秒已经执行 ${this.live('maxActionsPerMinute')} 次写动作，这一批需要 ${charge} 次，请等 ${Math.ceil(wait / 1000)} 秒（或调高 maxActionsPerMinute）。`,
      }
    }

    // A bare hover: authorized by policy (config.hoverFree), still rate-capped and still
    // audited, and it does NOT consume a session credit.
    if (hoverFree) {
      for (let i = 0; i < charge; i += 1) this.#recordAction()
      return {
        allowed: true,
        approval: 'hover(free)',
        reason: `free hover${target ? ` · ${target}` : ''}`,
      }
    }

    const grant = this.#prune()
    if (grant && !forceAsk) {
      const left = Math.max(0, grant.actions - grant.used)
      if (left < charge) {
        this.denials += 1
        return {
          allowed: false,
          approval: 'none',
          reason: `⛔ 会话授权余额不足：这一批需要 ${charge} 次，会话只剩 ${left} 次。请 /dexter arm 或 /dexter extend 加额度后重试。`,
        }
      }
      grant.used += charge
      this.uses += charge
      for (let i = 0; i < charge; i += 1) this.#recordAction()
      return {
        allowed: true,
        approval: `session:${grant.used}/${grant.actions}`,
        reason: `${grant.source} session grant${target ? ` · ${target}` : ''}`,
      }
    }

    if (this.config.askOnWrite && this.hasApprovalChannel()) {
      const asked = await this.#askHuman({ tool, capability, exec, reason, target, forceAsk })
      if (asked.allowed) {
        this.approvals += 1
        for (let i = 0; i < charge; i += 1) this.#recordAction()
        return asked
      }
      this.denials += 1
      return asked
    }

    this.denials += 1
    if (grant && forceAsk) {
      return {
        allowed: false,
        approval: 'none',
        reason: `⛔ ${target || '这个目标'} 属于私人相关：常开授权不覆盖它，需要逐条批准，但当前没有可用的审批通道。`
          + '请人类执行 /dexter arm 后重试，或在设置里确认审批服务可用。',
      }
    }
    return {
      allowed: false,
      approval: 'none',
      reason: '⛔ 没有授权：当前部署没有提供 approval 服务，也没有人手开的会话授权。'
        + '请主人执行 /dexter arm [15m] [100]（或按 Ctrl+Alt+F12）后再试；只想预演就带 dryRun: true。',
    }
  }

  async #askHuman({ tool, capability, exec, reason, target, forceAsk }) {
    const text = String(reason || capability).slice(0, 400)
    const note = target ? `目标：${target}` : ''
    try {
      this.#auditRow({ tool, capability, decision: 'approval-requested', approval: forceAsk ? 'ask:sensitive' : 'ask', reason: [note, text].filter(Boolean).join(' · ').slice(0, 300) })
      let outcome = await this.approval.request({
        agent: exec?.agent,
        toolName: tool,
        callId: exec?.callId,
        reason: text,
        displayReason: {
          en: `dexter requests one desktop ${capability} action${target ? ` on ${target}` : ''}: ${text}`,
          zh: `dexter 请求执行一次桌面动作（${capability}${target ? `，目标 ${target}` : ''}）：${text}`,
        },
        signal: exec?.signal,
      })
      if (outcome && typeof outcome === 'object') outcome = outcome.result ?? outcome.outcome ?? outcome.kind ?? outcome
      const verdict = String(outcome ?? '')
      const allowed = verdict === 'allowed-once' || verdict === 'allowed'
      this.#auditRow({ tool, capability, decision: allowed ? 'approval-granted' : 'approval-denied', approval: forceAsk ? 'ask:sensitive' : 'ask', result: verdict.slice(0, 80) })
      if (allowed) return { allowed: true, approval: forceAsk ? 'ask:sensitive' : 'ask', reason: 'human approved once' }
      return { allowed: false, approval: 'none', reason: `⛔ 人类没有同意（${verdict || 'unknown'}）：这一次什么都没有注入。` }
    } catch (error) {
      this.#auditRow({ tool, capability, decision: 'approval-error', approval: 'ask', result: String(error && error.message ? error.message : error).slice(0, 200) })
      return { allowed: false, approval: 'none', reason: `⛔ 审批通道出错，按拒绝处理：${error && error.message ? error.message : error}` }
    }
  }

  snapshot() {
    const active = this.#prune()
    const now = this.now()
    return {
      askOnWrite: this.config.askOnWrite,
      readOnly: this.config.readOnly,
      stopped: this.stopped ? { ...this.stopped } : null,
      grant: active
        ? {
          // `active` is what the panel and status read: a grant object may exist while it
          // has no credits or has just expired, and that is NOT an open session.
          active: Math.max(0, active.actions - active.used) > 0 && active.expiresAt > now,
          minutes: active.minutes,
          actions: active.actions,
          used: active.used,
          left: Math.max(0, active.actions - active.used),
          remainingMs: Math.max(0, active.expiresAt - now),
          expiresAt: active.expiresAt,
          source: active.source,
        }
        : null,
      rate: {
        limitPerMinute: this.live('maxActionsPerMinute'),
        lastMinute: this.actionTimes.filter((at) => now - at < RATE_WINDOW_MS).length,
      },
      approvalChannel: this.hasApprovalChannel() ? 'platform' : 'none',
      uses: this.uses,
      denials: this.denials,
      approvals: this.approvals,
    }
  }
}
