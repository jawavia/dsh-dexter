/**
 * Human-activity suspension, shared by every backend.
 *
 * Old package: only the pixel engine paused on human input, so a UIA or stroke
 * write could land in the middle of the human typing. Here the suspension lives in
 * the kernel: every write asks `waitForIdle()` first, and both the suspend and the
 * resume are audited.
 *
 * Two probes feed it:
 *   - `probe.cursor()` + `probe.keyDown(name)` from the Win32 backend (optional;
 *     without it the detector stays idle and writes never pause on this account);
 *   - a test signal file (`DSH_DEXTER_HUMAN_SIGNAL`), whose mtime change counts as
 *     human input. That is how the invariant test triggers a suspend without
 *     stealing focus or synthesising input.
 */
import { existsSync, statSync } from 'node:fs'
import { sleep } from './util.js'

const WATCHED_KEYS = ['ctrl', 'alt', 'shift', 'esc']

export class HumanActivity {
  /**
   * @param {object} options
   * @param {ReturnType<import('./config.js').normalizeConfig>} options.config
   * @param {{cursor:()=>{x:number,y:number}, keyDown:(name:string)=>boolean}|null} [options.probe]
   * @param {(event:{kind:'suspend'|'resume'|'activity', reason:string, idleMs?:number}) => void} [options.onEvent]
   * @param {() => number} [options.clock]
   * @param {number} [options.pollMs]
   */
  constructor({ config, probe = null, onEvent = () => {}, clock = () => Date.now(), pollMs = 150 } = {}) {
    this.config = config
    this.probe = probe
    this.onEvent = onEvent
    this.now = clock
    this.pollMs = Math.max(50, Math.min(2000, pollMs))
    this.timer = null
    this.suspended = null
    this.lastActivityAt = 0
    this.lastCursor = null
    this.injecting = 0
    this.ignoreUntil = 0
    this.signalPath = process.env.DSH_DEXTER_HUMAN_SIGNAL || ''
    this.lastSignalStamp = ''
  }

  start() {
    if (this.timer) return this
    if (!this.probe && this.signalPath === '') return this
    if (this.signalPath && existsSync(this.signalPath)) this.lastSignalStamp = this.#stamp()
    this.timer = setInterval(() => {
      try {
        this.poll()
      } catch { /* detectors must never crash the host */ }
    }, this.pollMs)
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref()
    return this
  }

  dispose() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  #stamp() {
    try {
      const stat = statSync(this.signalPath)
      return `${stat.mtimeMs}:${stat.size}`
    } catch {
      return ''
    }
  }

  /** Mark the start/end of our own injection so it is not read as human input. */
  beginInjection() {
    this.injecting += 1
  }

  endInjection() {
    this.injecting = Math.max(0, this.injecting - 1)
    if (this.injecting > 0) return
    // Our own injection moved the cursor (and may have pressed keys). Re-baseline so
    // the next poll cannot read our own movement as human activity, and ignore input
    // for a moment while the pointer settles.
    this.ignoreUntil = this.now() + 400
    try {
      if (this.probe && typeof this.probe.cursor === 'function') this.lastCursor = this.probe.cursor()
    } catch { /* probe unavailable: the ignore window still applies */ }
  }

  #noteActivity(reason) {
    this.lastActivityAt = this.now()
    if (!this.suspended) {
      this.suspended = { at: this.lastActivityAt, reason }
      this.onEvent({ kind: 'suspend', reason })
    }
    return true
  }

  /** One detector pass. Exposed so tests drive it without timers. */
  poll() {
    if (!this.config.pauseOnHumanInput) return false
    const now = this.now()
    if (this.signalPath) {
      const stamp = this.#stamp()
      if (stamp !== '' && stamp !== this.lastSignalStamp) {
        this.lastSignalStamp = stamp
        return this.#noteActivity('测试信号文件变化（模拟真人输入）')
      }
    }
    if (this.probe) {
      if (this.injecting === 0 && now >= this.ignoreUntil) {
        for (const key of WATCHED_KEYS) {
          let down = false
          try {
            down = Boolean(this.probe.keyDown(key))
          } catch {
            down = false
          }
          if (down) return this.#noteActivity(`检测到真人按键（${key}）`)
        }
        let cursor = null
        try {
          cursor = this.probe.cursor()
        } catch {
          cursor = null
        }
        if (cursor) {
          const previous = this.lastCursor
          this.lastCursor = cursor
          if (previous && (Math.abs(cursor.x - previous.x) > 2 || Math.abs(cursor.y - previous.y) > 2)) {
            return this.#noteActivity('光标被移动（非本插件注入）')
          }
        }
      } else if (this.injecting === 0) {
        try {
          this.lastCursor = this.probe.cursor()
        } catch { /* ignore */ }
      }
    }
    if (this.suspended) {
      const idleMs = now - this.lastActivityAt
      if (idleMs >= this.config.humanIdleResumeMs) {
        const previous = this.suspended
        this.suspended = null
        this.onEvent({ kind: 'resume', reason: '人类已停止操作，自动恢复', idleMs })
        return { resumed: true, previous }
      }
    }
    return false
  }

  /** True while the human is (recently) active. */
  isSuspended() {
    if (!this.suspended) return false
    if (this.now() - this.lastActivityAt >= this.config.humanIdleResumeMs) return false
    return true
  }

  /**
   * Wait until human input stops, bounded by `humanWaitMaxMs`.
   * @param {{signal?:AbortSignal, budgetMs?:number}} [options]
   */
  async waitForIdle({ signal = null, budgetMs = null } = {}) {
    const budget = Math.max(0, Math.min(
      this.config.humanWaitMaxMs,
      budgetMs === null ? this.config.humanWaitMaxMs : budgetMs,
    ))
    if (!this.isSuspended()) return { ok: true, waitedMs: 0 }
    if (budget === 0) return { ok: false, waitedMs: 0, reason: '人类正在操作（未配置等待预算）' }
    const startedAt = this.now()
    while (this.now() - startedAt < budget) {
      if (signal && signal.aborted) return { ok: false, waitedMs: this.now() - startedAt, reason: '调用被取消' }
      this.poll()
      if (!this.isSuspended()) return { ok: true, waitedMs: this.now() - startedAt }
      await sleep(200)
    }
    return { ok: false, waitedMs: this.now() - startedAt, reason: `等待真人空闲超过 ${Math.round(budget / 1000)} 秒` }
  }

  snapshot() {
    return {
      enabled: this.config.pauseOnHumanInput,
      watching: Boolean(this.timer),
      probe: Boolean(this.probe),
      suspended: this.suspended ? { ...this.suspended, idleMs: this.now() - this.lastActivityAt } : null,
      idleResumeMs: this.config.humanIdleResumeMs,
      waitMaxMs: this.config.humanWaitMaxMs,
    }
  }
}
