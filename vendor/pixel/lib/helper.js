/**
 * dsh-click-matrix — native helper process manager.
 *
 * Spawns the long-lived Windows helper once, talks NDJSON over stdin/stdout
 * (one JSON object per line, see PROTOCOL.md), serializes RPCs, enforces a
 * per-request timeout, and restarts the process a bounded number of times after
 * a crash/timeout. `abort` bypasses the queue and is written immediately.
 *
 * The helper executable is resolved from `../runtime/bootstrap.mjs`
 * (`ensureHelper() -> absolute exe path`, `HELPER_VERSION`). Two env overrides
 * exist for development/smoke tests only:
 *   DSH_CLICK_MATRIX_HELPER       absolute path to a helper executable
 *   DSH_CLICK_MATRIX_MOCK_HELPER  JS file run as `node <file> --mock-helper`
 * When bootstrap.mjs is absent the error message names the missing file.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PROTOCOL_VERSION = 1
const MAX_AUTO_RESTARTS = 3
const STABLE_RESET_MS = 60000
const STDERR_TAIL_MAX = 16

/** Error carrying a stable code for fail-soft tool messages. */
export class HelperError extends Error {
  constructor(message, code = 'HELPER_ERROR') {
    super(message)
    this.name = 'HelperError'
    this.code = code
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Resolve the helper command.
 * @returns {Promise<{command:string,args:string[],source:string,bootstrapVersion:string,exePath:string}>}
 */
export async function resolveHelperCommand() {
  const mock = process.env.DSH_CLICK_MATRIX_MOCK_HELPER
  if (mock && mock.trim() !== '') {
    const file = mock.trim()
    if (!existsSync(file)) throw new HelperError(`测试用 mock helper 不存在: ${file}`, 'HELPER_MISSING')
    return { command: process.execPath, args: [file, '--mock-helper'], source: 'mock-env', bootstrapVersion: 'mock', exePath: file }
  }
  const override = process.env.DSH_CLICK_MATRIX_HELPER
  if (override && override.trim() !== '') {
    // v1.3 (integrity): pointing the host at an arbitrary exe is a "swap the
    // safety component" primitive. It stays available for tests, but only with
    // the second key, and it is reported as UNVERIFIED everywhere.
    if (process.env.DSH_CLICK_MATRIX_ALLOW_HELPER_OVERRIDE !== '1') {
      throw new HelperError(
        'DSH_CLICK_MATRIX_HELPER 覆盖已被禁用（helper 只允许使用内置构建缓存）。' +
          '如确需测试：同时设置 DSH_CLICK_MATRIX_ALLOW_HELPER_OVERRIDE=1；该模式在 screen_info/doctor 中标记为"未验证"，' +
          '审计与验收报告不得引用它的行为作为安全证据。',
        'HELPER_OVERRIDE_BLOCKED',
      )
    }
    const exe = override.trim()
    if (!existsSync(exe)) throw new HelperError(`DSH_CLICK_MATRIX_HELPER 指向的文件不存在: ${exe}`, 'HELPER_MISSING')
    return { command: exe, args: [], source: 'env-override', bootstrapVersion: '', exePath: exe, integrity: 'unverified' }
  }
  const bootstrapUrl = new URL('../runtime/bootstrap.mjs', import.meta.url)
  const bootstrapPath = fileURLToPath(bootstrapUrl)
  let mod
  try {
    mod = await import(bootstrapUrl.href)
  } catch (error) {
    const hint = existsSync(bootstrapPath)
      ? `runtime/bootstrap.mjs 加载失败: ${error && error.message ? error.message : error}`
      : '缺少 runtime/bootstrap.mjs（原生 helper 尚未构建/安装）。请重装插件，或运行 click_matrix_doctor 查看详情。'
    throw new HelperError(hint, 'HELPER_BOOTSTRAP')
  }
  if (typeof mod.ensureHelper !== 'function') {
    throw new HelperError('runtime/bootstrap.mjs 未导出 ensureHelper()（helper 构建脚本不完整）', 'HELPER_BOOTSTRAP')
  }
  const exe = await mod.ensureHelper()
  if (typeof exe !== 'string' || exe.trim() === '') {
    throw new HelperError('ensureHelper() 未返回 helper 可执行文件路径', 'HELPER_BOOTSTRAP')
  }
  if (!existsSync(exe)) {
    throw new HelperError(`ensureHelper() 返回的 helper 不存在: ${exe}`, 'HELPER_MISSING')
  }
  return {
    command: exe,
    args: [],
    source: 'bootstrap',
    bootstrapVersion: mod.HELPER_VERSION === undefined || mod.HELPER_VERSION === null ? '' : String(mod.HELPER_VERSION),
    exePath: exe,
    // ensureHelper() only returns a cache hit after the sha256 sidecar matches.
    integrity: 'bootstrap-verified',
  }
}

/** Read `HELPER_VERSION` from bootstrap.mjs without requiring it to be buildable. */
export async function readExpectedHelperVersion() {
  try {
    const bootstrapUrl = new URL('../runtime/bootstrap.mjs', import.meta.url)
    const mod = await import(bootstrapUrl.href)
    return mod.HELPER_VERSION === undefined || mod.HELPER_VERSION === null ? '' : String(mod.HELPER_VERSION)
  } catch {
    return ''
  }
}

/**
 * Long-lived helper client. One instance per plugin.
 */
export class HelperClient {
  /**
   * @param {object} [options]
   * @param {object} [options.config] normalized plugin config (helperTimeoutMs used)
   * @param {(name:string, data:any) => void} [options.onEvent] unsolicited event sink
   * @param {(msg:string) => void} [options.logger] log sink (never throws)
   * @param {() => Promise<any>} [options.resolveCommand] override resolver (tests)
   * @param {{processes?: string[], classes?: string[]}} [options.deny] set_deny payload
   */
  constructor(options = {}) {
    this.config = options.config || { helperTimeoutMs: 20000 }
    this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {}
    // v1.1 (D-01/D-09): fire only for UNEXPECTED exits (not stop()/killNow paths
    // that set stopping/disposed). Lets the plugin surface the death to the user.
    this.onUnexpectedExit = typeof options.onUnexpectedExit === 'function' ? options.onUnexpectedExit : () => {}
    this.logger = typeof options.logger === 'function' ? options.logger : () => {}
    this.resolveCommand = typeof options.resolveCommand === 'function' ? options.resolveCommand : resolveHelperCommand
    this.denyConfig = {
      processes: Array.isArray(options.deny && options.deny.processes) ? options.deny.processes.slice() : [],
      classes: Array.isArray(options.deny && options.deny.classes) ? options.deny.classes.slice() : [],
    }
    this.command = null
    this.child = null
    this.readyInfo = null
    this.starting = null
    this.pending = new Map()
    this.nextId = 1
    this.buffer = ''
    this.stderrTail = []
    this.restarts = 0
    this.lastError = ''
    this.lastReadyAt = 0
    this.lastCallAt = 0
    this.queue = Promise.resolve()
    this.stopping = false
    this.disposed = false
    // v1.1 (P2): set before a DELIBERATE kill (timeout/protocol/reset); #onExit
    // must not report those as "unexpected safety-net events".
    this.plannedExit = false
    this.helperVersion = ''
    // v0.2: helper capabilities + Esc/human-input watchdog state. Esc watch is a
    // helper-side polling watchdog; the host only ever toggles it on arm/disarm.
    this.capabilities = {}
    this.escWatch = { enabled: false, supported: null, error: '', calls: 0, intent: false }
    this.escWatchWarned = false
  }

  get started() {
    return !!(this.child && this.readyInfo)
  }

  /** Start (or reuse) the helper; resolves when `ready` arrived. */
  async ensureStarted() {
    if (this.disposed) throw new HelperError('helper 客户端已停止', 'HELPER_STOPPED')
    if (this.started) return this.readyInfo
    if (this.starting) return this.starting
    this.starting = this.#start().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  async #start() {
    if (this.restarts > MAX_AUTO_RESTARTS) {
      throw new HelperError(
        `原生 helper 连续崩溃 ${this.restarts} 次，已停止自动重启。请运行 click_matrix_doctor 排查。最后错误: ${this.lastError || '未知'}`,
        'HELPER_CRASHED',
      )
    }
    const spec = await this.resolveCommand()
    this.command = spec
    this.helperVersion = ''
    let child
    try {
      child = spawn(spec.command, spec.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, DSH_CLICK_MATRIX_HELPER_CHILD: '1' },
      })
    } catch (error) {
      throw new HelperError(`helper 启动失败: ${error && error.message ? error.message : error}`, 'HELPER_SPAWN')
    }
    this.child = child
    this.buffer = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.#onStdout(String(chunk)))
    child.stderr.on('data', (chunk) => this.#onStderr(String(chunk)))
    child.on('error', (error) => {
      this.lastError = `helper 进程错误: ${error && error.message ? error.message : error}`
      this.#rejectAll(new HelperError(this.lastError, 'HELPER_SPAWN'))
    })
    child.on('exit', (code, signal) => this.#onExit(code, signal, child))
    const ready = await this.#waitReady(spec)
    this.lastReadyAt = Date.now()
    this.readyInfo = ready
    this.capabilities = ready && ready.capabilities && typeof ready.capabilities === 'object' ? { ...ready.capabilities } : {}
    this.helperVersion = ready.helperVersion === undefined || ready.helperVersion === null ? '' : String(ready.helperVersion)
    if (typeof ready.protocol === 'number' && ready.protocol !== PROTOCOL_VERSION) {
      await this.killNow('protocol mismatch')
      throw new HelperError(`helper 协议版本 ${ready.protocol} 与宿主 ${PROTOCOL_VERSION} 不匹配，请重新安装插件`, 'HELPER_PROTOCOL')
    }
    // Apply the deny list before the first capture/click is possible.
    try {
      await this.#call('set_deny', this.denyConfig, { timeoutMs: 3000 })
    } catch (error) {
      this.logger(`helper set_deny 失败（忽略，helper 旧版可能不支持）: ${error && error.message ? error.message : error}`)
    }
    // Re-arm the Esc watchdog if an arm window was opened before this process
    // existed (intent survives restarts; the watchdog itself does not).
    if (this.escWatch.intent) {
      this.setEscWatch(true).catch(() => {})
    }
    return ready
  }

  #waitReady(spec) {
    const timeoutMs = Math.max(1000, Number(this.config.helperTimeoutMs) || 20000)
    return new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        this.lastError = `helper 启动超时（${timeoutMs}ms 内未收到 ready）`
        this.restarts++
        this.plannedExit = true
        this.#killChild()
        reject(new HelperError(`${this.lastError}${spec ? `；命令: ${spec.command}` : ''}`, 'HELPER_READY_TIMEOUT'))
      }, timeoutMs)
      this.readyWaiters.push({
        resolve: (info) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(info)
        },
        reject: (error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(error)
        },
      })
    })
  }

  get readyWaiters() {
    if (!this._readyWaiters) this._readyWaiters = []
    return this._readyWaiters
  }

  #onStdout(chunk) {
    this.buffer += chunk
    let idx
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (line === '') continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        this.logger(`helper 输出非 JSON 行: ${line.slice(0, 200)}`)
        continue
      }
      if (msg && typeof msg === 'object' && typeof msg.event === 'string') {
        if (msg.event === 'ready') {
          const info = msg.data && typeof msg.data === 'object' ? msg.data : {}
          const waiters = this._readyWaiters || []
          this._readyWaiters = []
          for (const w of waiters) {
            try {
              w.resolve(info)
            } catch {
              /* ignore */
            }
          }
          continue
        }
        try {
          this.onEvent(msg.event, msg.data && typeof msg.data === 'object' ? msg.data : {})
        } catch (error) {
          this.logger(`helper 事件处理器异常 (${msg.event}): ${error && error.message ? error.message : error}`)
        }
        continue
      }
      if (msg && typeof msg === 'object' && msg.id != null) {
        const entry = this.pending.get(msg.id)
        if (!entry) continue
        this.pending.delete(msg.id)
        clearTimeout(entry.timer)
        this.lastCallAt = Date.now()
        if (msg.ok === true) {
          entry.resolve(msg.data && typeof msg.data === 'object' ? msg.data : {})
        } else {
          const message = typeof msg.error === 'string' && msg.error !== '' ? msg.error : 'helper 返回未知错误'
          const error = new HelperError(message, 'HELPER_RPC')
          error.helperCmd = entry.cmd
          entry.reject(error)
        }
      }
    }
  }

  #onStderr(chunk) {
    const text = chunk.trim()
    if (!text) return
    this.stderrTail.push(text.slice(0, 500))
    if (this.stderrTail.length > STDERR_TAIL_MAX) this.stderrTail.shift()
    this.logger(`[helper stderr] ${text.slice(0, 300)}`)
  }

  #onExit(code, signal, who) {
    // v1.1 (P8): a late exit from an old child must not clear the new child state.
    if (who && this.child && who !== this.child) {
      this.logger('忽略旧 helper 子进程的 exit 事件（已有新实例）')
      return
    }
    const wasReady = !!this.readyInfo
    const uptime = this.lastReadyAt > 0 ? Date.now() - this.lastReadyAt : 0
    this.child = null
    this.readyInfo = null
    // A watchdog dies with its process; never claim it is still enabled.
    this.escWatch.enabled = false
    if (this.stopping || this.disposed) {
      this.#rejectAll(new HelperError('helper 已关闭', 'HELPER_STOPPED'))
      return
    }
    this.lastError = `helper 意外退出 (code=${code}, signal=${signal})`
    if (wasReady) this.restarts++
    if (wasReady && uptime > STABLE_RESET_MS) this.restarts = 1
    const planned = this.plannedExit === true
    this.plannedExit = false
    if (!planned) {
      try {
        this.onUnexpectedExit({ code, signal, restarts: this.restarts, wasReady, uptimeMs: uptime, lastError: this.lastError })
      } catch (error) {
        this.logger(`onUnexpectedExit 异常: ${error && error.message ? error.message : error}`)
      }
    }
    const waiters = this._readyWaiters || []
    this._readyWaiters = []
    for (const w of waiters) {
      try {
        w.reject(new HelperError(this.lastError, 'HELPER_CRASHED'))
      } catch {
        /* ignore */
      }
    }
    this.#rejectAll(new HelperError(this.lastError, 'HELPER_CRASHED'))
  }

  #rejectAll(error) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      try {
        entry.reject(error)
      } catch {
        /* ignore */
      }
    }
    this.pending.clear()
  }

  #killChild() {
    const child = this.child
    this.readyInfo = null
    if (!child) return
    try {
      child.kill()
    } catch {
      /* ignore */
    }
  }

  /**
   * One RPC call (serialized with all other calls).
   * Resolves with the `data` object; rejects with HelperError on failure/timeout.
   */
  rpc(cmd, args = {}, options = {}) {
    const run = async () => {
      await this.ensureStarted()
      return this.#call(cmd, args, options)
    }
    const p = this.queue.then(run, run)
    this.queue = p.then(
      () => undefined,
      () => undefined,
    )
    return p
  }

  #call(cmd, args = {}, options = {}) {
    const child = this.child
    if (!child || !this.readyInfo) return Promise.reject(new HelperError('helper 未就绪', 'HELPER_NOT_READY'))
    const id = this.nextId++
    const timeoutMs = Math.max(500, Math.min(120000, Number(options.timeoutMs) || Number(this.config.helperTimeoutMs) + 3000 || 23000))
    const payload = { id, cmd, ...args }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        this.lastError = `${cmd} RPC 超时（${timeoutMs}ms）`
        this.restarts++
        this.plannedExit = true
        this.#killChild()
        reject(new HelperError(`${this.lastError}；helper 已被重启，操作可能未完成，请先 screen_info 复查`, 'HELPER_TIMEOUT'))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer, cmd })
      try {
        child.stdin.write(JSON.stringify(payload) + '\n')
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new HelperError(`写入 helper stdin 失败: ${error && error.message ? error.message : error}`, 'HELPER_IO'))
      }
    })
  }

  /**
   * Immediate abort — writes the abort line without waiting in the RPC queue so
   * it can interrupt an in-flight move/drag. Returns false when not running.
   */
  abort(reason = 'user-abort', options = {}) {
    const child = this.child
    if (!child || !this.readyInfo) return false
    try {
      // v1.1 (D-13): release:false keeps human-held buttons down (human activity
      // pause must not synthesize UP); explicit STOP/Esc keep release:true.
      const release = !(options && options.release === false)
      child.stdin.write(JSON.stringify({ id: this.nextId++, cmd: 'abort', reason, release }) + '\n')
      return true
    } catch {
      return false
    }
  }

  /**
   * v0.2: toggle the helper's Esc / human-input watchdog. This is a polling
   * watchdog, not a keyboard hook: pressing Esc (or any physical key) while it
   * is enabled aborts the current mouse action and emits `escape` /
   * `human-input`. Fail-soft for older helpers without the command.
   * @param {boolean} enabled
   * @returns {Promise<{enabled:boolean, supported:boolean, error:string}>}
   */
  async setEscWatch(enabled) {
    const want = enabled === true
    this.escWatch.intent = want
    if (this.escWatch.enabled === want && this.escWatch.supported !== false) {
      return { enabled: want, supported: this.escWatch.supported !== false, error: '' }
    }
    if (!this.started) {
      // Nothing to watch before the helper runs; the intent is applied on start.
      this.escWatch.enabled = false
      return { enabled: false, supported: this.escWatch.supported !== false, error: '' }
    }
    this.escWatch.calls += 1
    try {
      const data = await this.rpc('set_esc_watch', { enabled: want }, { timeoutMs: 3000 })
      this.escWatch.enabled = !!(data && typeof data.enabled === 'boolean' ? data.enabled : want)
      this.escWatch.supported = true
      this.escWatch.error = ''
      return { enabled: this.escWatch.enabled, supported: true, error: '' }
    } catch (error) {
      this.escWatch.supported = false
      this.escWatch.error = error && error.message ? error.message : String(error)
      if (!this.escWatchWarned) {
        this.escWatchWarned = true
        this.logger(`helper 不支持 set_esc_watch（旧版 helper？Esc 暂停不可用）: ${this.escWatch.error}`)
      }
      return { enabled: false, supported: false, error: this.escWatch.error }
    }
  }

  /** Kill the helper now (no graceful quit). */
  async killNow(reason = 'kill') {
    this.lastError = reason
    this.plannedExit = true
    this.#killChild()
  }

  /** Graceful stop used by plugin dispose. */
  async stop() {
    this.disposed = true
    this.stopping = true
    const child = this.child
    this.child = null
    this.readyInfo = null
    this.#rejectAll(new HelperError('helper 已停止', 'HELPER_STOPPED'))
    if (!child) return
    try {
      child.stdin.write(JSON.stringify({ id: this.nextId++, cmd: 'quit' }) + '\n')
    } catch {
      /* ignore */
    }
    await Promise.race([
      new Promise((resolve) => {
        try {
          child.once('exit', () => resolve())
        } catch {
          resolve()
        }
      }),
      delay(800),
    ])
    try {
      child.kill()
    } catch {
      /* ignore */
    }
  }

  /**
   * v1.4 (D-06): human-only reset of the crash-loop guard. The bounded
   * auto-restart counter can otherwise lock the plugin until DSH restarts;
   * this clears the counter and the last error so ensureStarted() retries.
   */
  resetRestartState() {
    this.restarts = 0
    this.lastError = ''
    return { restarts: this.restarts, started: this.started }
  }

  /** Helper state for screen_info / doctor. Never throws. */
  state() {
    return {
      started: this.started,
      pid: this.child && typeof this.child.pid === 'number' ? this.child.pid : 0,
      helperVersion: this.helperVersion,
      expectedVersion: '',
      source: this.command ? this.command.source : '',
      integrity: this.command && typeof this.command.integrity === 'string' ? this.command.integrity : '',
      commandPath: this.command ? this.command.exePath : '',
      exeName: this.command ? basename(this.command.exePath) : '',
      protocol: this.readyInfo && typeof this.readyInfo.protocol === 'number' ? this.readyInfo.protocol : 0,
      restarts: this.restarts,
      lastError: this.lastError,
      stderrTail: this.stderrTail.slice(-6),
      readyInfo: this.readyInfo,
      capabilities: { ...this.capabilities },
      escWatch: { ...this.escWatch },
    }
  }
}
