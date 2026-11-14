/**
 * StopBus — one place where "stop" comes from.
 *
 * Sources, all of them human or external:
 *   Esc                      hard stop (everyone agrees on it, no configuration)
 *   Ctrl+Alt+F11             hard stop: revoke grants, refuse further writes
 *   Ctrl+Shift+F11           soft stop: finish the current step, then stop
 *   <data>/stop.signal       external stop file ({level, by, reason})
 *
 * Polling (GetAsyncKeyState) rather than RegisterHotKey: the plugin then needs no
 * window handle and no extra native dependency, and a held key is still detected.
 * The trade-off is a ≤160 ms detection latency, which is stated in the docs.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const HARD = ['ctrl', 'alt', 'f11']
const SOFT = ['ctrl', 'shift', 'f11']
const ARM = ['ctrl', 'alt', 'f12']
const EXTEND = ['ctrl', 'alt', 'f10']

/**
 * @typedef {{keyDown:(name:string)=>boolean}} StopProbe
 */

export class StopBus {
  /**
   * @param {object} options
   * @param {string} options.dataDir
   * @param {StopProbe|null} [options.probe] Win32 probe; null disables key watching
   * @param {number} [options.pollMs]
   * @param {(event:{level:'hard'|'soft', by:string, reason:string}) => void} [options.onStop]
   * @param {() => number} [options.clock]
   */
  constructor({ dataDir, probe = null, pollMs = 80, onStop = () => {}, onArm = null, onExtend = null, combos = null, clock = () => Date.now() } = {}) {
    this.combos = combos || { hard: HARD, soft: SOFT, arm: ARM, extend: EXTEND }
    this.suppressUntil = 0
    this.dataDir = dataDir
    this.probe = probe
    this.pollMs = Math.max(40, Math.min(1000, pollMs))
    this.onStop = onStop
    this.onArm = typeof onArm === 'function' ? onArm : null
    this.onExtend = typeof onExtend === 'function' ? onExtend : null
    this.now = clock
    this.timer = null
    this.previous = { esc: false, hard: false, soft: false, arm: false, extend: false }
    this.lastSignalAt = 0
    this.stopped = null
    this.seenSignalMtime = 0
  }

  signalPath() {
    return join(this.dataDir, 'stop.signal')
  }

  start() {
    if (this.timer || !this.probe) return this
    this.timer = setInterval(() => {
      try {
        this.poll()
      } catch { /* a probe failure must never crash the host */ }
    }, this.pollMs)
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref()
    return this
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  #edge(name, down) {
    const was = this.previous[name]
    this.previous[name] = down
    return down && !was
  }

  #combo(keys) {
    let all = true
    for (const key of keys) {
      let down = false
      try {
        down = Boolean(this.probe && this.probe.keyDown(key))
      } catch {
        down = false
      }
      if (!down) {
        all = false
        break
      }
    }
    return all
  }

  /** One polling pass. Exposed so tests can drive it deterministically. */
  poll() {
    // Our own injected keystrokes appear in the global key state. Only the exact combo we
    // injected is ignored (see ignoreCombo); every other stop stays live.
    const escDown = this.probe && !this.#ignored(['esc'])
      ? (() => { try { return Boolean(this.probe.keyDown('esc')) } catch { return false } })()
      : false
    if (this.#edge('esc', escDown)) this.#fire('hard', 'human', '主人在键盘上按了 Esc')
    const hardDown = this.probe && !this.#ignored(this.combos.stop || HARD) ? this.#combo(this.combos.stop || HARD) : false
    if (this.#edge('hard', hardDown)) this.#fire('hard', 'human', '主人按了 Ctrl+Alt+F11')
    const softDown = this.probe && !this.#ignored(this.combos.softStop || SOFT) ? this.#combo(this.combos.softStop || SOFT) : false
    if (this.#edge('soft', softDown)) this.#fire('soft', 'human', '主人按了 Ctrl+Shift+F11')
    // Ctrl+Alt+F12 arms (configured minutes/actions); Ctrl+Alt+F10 extends the open
    // session. Both only ever come from a human's keyboard.
    const armDown = this.probe && !this.#ignored(this.combos.arm || ARM) ? this.#combo(this.combos.arm || ARM) : false
    if (this.#edge('arm', armDown) && this.onArm) {
      try {
        this.onArm()
      } catch { /* the callback owns its failures */ }
    }
    const extendDown = this.probe && !this.#ignored(this.combos.extend || EXTEND) ? this.#combo(this.combos.extend || EXTEND) : false
    if (this.#edge('extend', extendDown) && this.onExtend) {
      try {
        this.onExtend()
      } catch { /* the callback owns its failures */ }
    }
    this.#pollSignalFile()
  }

  #pollSignalFile() {
    const path = this.signalPath()
    if (!existsSync(path)) return
    // A manual external stop may be written faster than we poll: any existing file
    // that we have not consumed counts, not only a fresh one.
    let payload = null
    try {
      payload = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      payload = { level: 'hard', by: 'external', reason: '无法解析的 stop.signal，按硬停处理' }
    }
    try {
      rmSync(path, { force: true })
    } catch { /* the file stays; the next poll repeats the stop, which is safe */ }
    this.#fire(payload.level === 'soft' ? 'soft' : 'hard', String(payload.by || 'external'), String(payload.reason || '外部停止信号'))
  }

  #fire(level, by, reason) {
    this.lastSignalAt = this.now()
    this.stopped = { level, by, reason, at: this.lastSignalAt }
    try {
      this.onStop({ level, by, reason })
    } catch { /* the callback owns its own failures */ }
  }

  /** Request a stop from inside the plugin (test hooks, tools). */
  request(level, by, reason) {
    this.#fire(level, by, reason)
    return this.snapshot()
  }

  clear() {
    this.stopped = null
  }

  /**
   * Stop this bus without firing handlers: kernel.stop() uses it so every stop source
   * (command, tool, hotkey, signal file) leaves the same state behind.
   */
  markStopped(level, by, reason) {
    this.stopped = { level, by, reason, at: this.now() }
  }

  /**
   * Ignore exactly the combo we are about to inject. Blanket suppression would also blind
   * us to a human pressing Esc/F11 during our own action; matching the injected keys keeps
   * every other stop live.
   */
  ignoreCombo(keys, ms = 500) {
    const sig = (keys || []).map((key) => String(key).toLowerCase()).sort().join('+')
    if (!sig) return
    this.ignored = (this.ignored || []).filter((entry) => entry.until > this.now())
    this.ignored.push({ sig, until: this.now() + Math.max(0, ms) })
  }

  #ignored(keys) {
    const sig = (keys || []).map((key) => String(key).toLowerCase()).sort().join('+')
    if (!sig) return false
    const now = this.now()
    this.ignored = (this.ignored || []).filter((entry) => entry.until > now)
    return this.ignored.some((entry) => entry.sig === sig)
  }

  snapshot() {
    return {
      watching: Boolean(this.timer),
      probe: Boolean(this.probe),
      lastSignalAt: this.lastSignalAt,
      stopped: this.stopped ? { ...this.stopped } : null,
      keys: {
        hard: (this.combos.stop || HARD).join('+'),
        soft: (this.combos.softStop || SOFT).join('+'),
        arm: (this.combos.arm || ARM).join('+'),
        extend: (this.combos.extend || EXTEND).join('+'),
        escape: 'hard',
      },
    }
  }
}
