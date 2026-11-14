/**
 * dsh-click-matrix — append-only JSONL audit trail for every mutating attempt.
 *
 * One line per mouse move/click/drag/scroll/abort attempt (allowed or denied):
 * {ts, iso, tool, decision, reason, args, window, target, arm, outcome, agent}.
 * Rotation: when audit.jsonl reaches auditMaxBytes it is renamed to
 * audit.1.jsonl (previous .1 overwritten) and a fresh file starts.
 *
 * All methods are fail-soft: an audit failure never turns into a tool crash, it
 * is reported through the optional logger.
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

export class AuditLog {
  /**
   * @param {object} options
   * @param {string} options.dir data dir (created lazily)
   * @param {number} options.maxBytes rotation threshold
   * @param {(msg:string) => void} [options.logger]
   * @param {() => Date} [options.clock]
   */
  constructor(options = {}) {
    this.dir = options.dir || ''
    this.maxBytes = Math.max(65536, Number(options.maxBytes) || 2097152)
    this.logger = typeof options.logger === 'function' ? options.logger : () => {}
    this.clock = typeof options.clock === 'function' ? options.clock : () => new Date()
    this.file = this.dir ? join(this.dir, 'audit.jsonl') : ''
    this.rotateFile = this.dir ? join(this.dir, 'audit.1.jsonl') : ''
    this.lastError = ''
    this.writes = 0
    // v1.4 (audit retention): keep N rotated generations instead of one, so a
    // long incident does not destroy the start of the evidence trail.
    this.retention = Math.max(1, Math.min(20, Math.round(Number(options.retention) || 5)))
    // v2 (② 审计 schema v2)：每个引擎在共用审计里写自己的 engine；click-matrix 默认 pixel。
    this.engine = ['pixel', 'control', 'stroke'].includes(options.engine) ? options.engine : 'pixel'
    // v1.2 (D-10): sticky flag - once a write fails the trail is incomplete and
    // the host refuses to inject until the log is writable again.
    this.broken = false
    // v0.9.1: tamper-evident hash chain (key-less on purpose: no key
    // management, but silent edits/insertions become detectable).
    this.chainHead = ''
    this.chainSeq = 0
    this.chainLoaded = false
  }

  #ensureDir() {
    if (!this.dir) return false
    try {
      mkdirSync(this.dir, { recursive: true })
      return true
    } catch (error) {
      this.lastError = `无法创建数据目录 ${this.dir}: ${error && error.message ? error.message : error}`
      return false
    }
  }

  /** Path of the i-th rotated generation (1 = newest). */
  #genPath(i) {
    if (!this.dir) return ''
    return join(this.dir, i === 1 ? 'audit.1.jsonl' : `audit.${i}.jsonl`)
  }

  #rotateIfNeeded() {
    try {
      if (!existsSync(this.file)) return
      const size = statSync(this.file).size
      if (size < this.maxBytes) return
      // Shift the chain: N <- N-1 <- ... <- 1 <- current. The oldest generation
      // is dropped, so total audit disk is bounded by maxBytes * (retention + 1).
      try {
        rmSync(this.#genPath(this.retention), { force: true })
      } catch {
        /* ignore */
      }
      for (let i = this.retention - 1; i >= 1; i--) {
        const from = this.#genPath(i)
        if (!existsSync(from)) continue
        try {
          renameSync(from, this.#genPath(i + 1))
        } catch {
          /* a stuck generation must not block rotation forever */
        }
      }
      renameSync(this.file, this.#genPath(1))
      this.rotateFile = this.#genPath(1)
    } catch (error) {
      this.lastError = `审计文件轮转失败: ${error && error.message ? error.message : error}`
    }
  }

  /** Append one audit entry. Never throws. Returns true when written. */
  append(entry) {
    if (!this.file) return false
    if (!this.#ensureDir()) return false
    this.#rotateIfNeeded()
    const now = this.clock()
    this.#loadChain()
    const cleaned = sanitizeEntry(entry)
    // v2 (②): 缺省时补 engine（click-matrix 默认 pixel），旧调用点无需改动。
    if (!cleaned.engine) cleaned.engine = this.engine
    const row = {
      ts: now.getTime(),
      iso: now.toISOString(),
      ...cleaned,
    }
    row.seq = this.chainSeq + 1
    row.prev = this.chainHead
    row.h = hashRow(row)
    let line
    try {
      line = JSON.stringify(row)
    } catch {
      line = JSON.stringify({ ts: row.ts, iso: row.iso, tool: row.tool || '', note: 'unserializable entry' })
    }
    try {
      appendFileSync(this.file, line + '\n', 'utf8')
      this.writes++
      this.chainSeq = row.seq
      this.chainHead = row.h
      return true
    } catch (error) {
      this.lastError = `写审计日志失败: ${error && error.message ? error.message : error}`
      this.broken = true
      this.logger(this.lastError)
      return false
    }
  }

  /** v0.9.1: restore chain head/seq from the current file (once). */
  #loadChain() {
    if (this.chainLoaded) return
    this.chainLoaded = true
    try {
      if (!existsSync(this.file)) return
      const lines = readFileSync(this.file, 'utf8').split('\n').filter((l) => l.trim() !== '')
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const row = JSON.parse(lines[i])
          if (row && typeof row.h === 'string' && typeof row.seq === 'number') {
            this.chainHead = row.h
            this.chainSeq = row.seq
            return
          }
        } catch {
          /* keep looking backwards */
        }
      }
    } catch {
      /* unreadable: start a fresh chain on the next append */
    }
  }

  /**
   * v0.9.1: verify the hash chain across all retained generations.
   * Fail-soft (never throws). A chain break means the file was edited,
   * reordered or truncated; it cannot detect a full delete+rewrite (same-user
   * attacker), so results are reported, not enforced.
   * @returns {{ok:boolean, checked:number, legacy:number, gens:number, head:string, broken:null|{file:string,line:number,reason:string}}}
   */
  verify() {
    const result = { ok: true, checked: 0, legacy: 0, gens: 0, head: '', broken: null }
    const paths = []
    for (let i = this.retention; i >= 1; i--) paths.push(this.#genPath(i))
    paths.push(this.file)
    let head = ''
    let anchored = false
    let prevRow = null
    for (const path of paths) {
      if (!existsSync(path)) continue
      result.gens++
      let text
      try {
        text = readFileSync(path, 'utf8')
      } catch {
        result.ok = false
        result.broken = { file: path, line: 0, reason: 'unreadable' }
        return result
      }
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === '') continue
        let row
        try {
          row = JSON.parse(lines[i])
        } catch {
          result.ok = false
          result.broken = { file: path, line: i + 1, reason: 'bad-json' }
          return result
        }
        if (typeof row.h !== 'string' || typeof row.prev !== 'string') {
          result.legacy++
          continue
        }
        if (!anchored) {
          // The oldest retained generation starts mid-chain: accept its prev.
          anchored = true
          head = row.prev
        }
        if (row.prev !== head) {
          // 两个实例同时往同一个文件追加时，会读到同一个链头 → 同 seq / 同 prev 的分叉。
          // 这跟「文件被改过」不是一回事，分开报，避免把并发写误判成篡改。
          const forked = prevRow != null && (row.seq === prevRow.seq || row.prev === prevRow.prev)
          result.ok = false
          result.broken = { file: path, line: i + 1, reason: forked ? 'concurrent-writer' : 'chain-break' }
          return result
        }
        if (hashRow(row) !== row.h) {
          result.ok = false
          result.broken = { file: path, line: i + 1, reason: 'hash-mismatch' }
          return result
        }
        head = row.h
        prevRow = row
        result.checked++
      }
    }
    result.head = head
    return result
  }

  /**
   * v1.2 (D-10): can we still write the audit trail? Probes the file with a
   * zero-byte append (no newline, so the JSONL stays valid). Never throws.
   */
  writable() {
    if (!this.file) return false
    // A directory named audit.jsonl is writable-looking on Windows for a
    // zero-byte append, so reject it explicitly.
    try {
      if (statSync(this.file).isDirectory()) {
        this.lastError = '审计日志路径是目录（audit.jsonl）'
        this.broken = true
        return false
      }
    } catch {
      /* missing file is fine: append() will create it */
    }
    if (!this.#ensureDir()) return false
    // Real probe: write one byte to a sibling temp file and remove it. This
    // catches read-only dirs, full disks and ACL denials.
    const probe = join(this.dir, `.audit-probe-${process.pid}`)
    try {
      appendFileSync(probe, 'x', 'utf8')
      rmSync(probe, { force: true })
      this.broken = false
      return true
    } catch (error) {
      this.lastError = `审计日志不可写: ${error && error.message ? error.message : error}`
      this.broken = true
      return false
    }
  }

  /** Last `n` parsed entries (oldest first). Never throws. */
  tail(n = 20) {
    const count = Math.max(1, Math.min(100, Math.round(Number(n) || 20)))
    const lines = []
    try {
      if (!this.file || !existsSync(this.file)) return { entries: [], totalLines: 0, size: 0, file: this.file }
      const size = statSync(this.file).size
      // Audit files are capped at a few MB; reading the whole file keeps this simple.
      const text = readFileSync(this.file, 'utf8')
      const all = text.split(/\r?\n/).filter((l) => l.trim() !== '')
      const slice = all.slice(-count)
      for (const line of slice) {
        try {
          lines.push(JSON.parse(line))
        } catch {
          lines.push({ note: 'unparsable line', raw: line.slice(0, 200) })
        }
      }
      return { entries: lines, totalLines: all.length, size, file: this.file }
    } catch (error) {
      this.lastError = `读取审计日志失败: ${error && error.message ? error.message : error}`
      return { entries: lines, totalLines: 0, size: 0, file: this.file, error: this.lastError }
    }
  }

  /**
   * v2 (②): 封印当前活动链 —— 把 audit.jsonl 改名为 audit.sealed-<日期>.jsonl（只读历史），
   * 活动链从空开始（下一行 genesis：seq 1、prev ''）。
   * 这是一次性迁移动作，不是每次启动都做。返回 { sealed, note }。
   */
  seal() {
    if (!this.file) return { sealed: null, note: 'no data dir' }
    try {
      if (!existsSync(this.file)) return { sealed: null, note: 'no active file' }
      const now = this.clock()
      const date = now.toISOString().slice(0, 10)
      let target = join(this.dir, `audit.sealed-${date}.jsonl`)
      if (existsSync(target)) {
        // 同一天已封印过：加时分秒后缀，绝不覆盖既有封印档案。
        target = join(this.dir, `audit.sealed-${date}-${now.toISOString().slice(11, 19).replace(/:/g, '')}.jsonl`)
      }
      renameSync(this.file, target)
      this.chainHead = ''
      this.chainSeq = 0
      this.chainLoaded = false
      return { sealed: target }
    } catch (error) {
      this.lastError = `审计封印失败: ${error && error.message ? error.message : error}`
      return { sealed: null, note: this.lastError }
    }
  }

  /** v2 (②): 列出封印历史文件（旧格式只读档案），按文件名排序。 */
  sealedFiles() {
    if (!this.dir) return []
    try {
      return readdirSync(this.dir).filter((f) => f.startsWith('audit.sealed-') && f.endsWith('.jsonl')).sort()
    } catch {
      return []
    }
  }

  /** v2 (②): 逐个校验封印文件的链（frozen history，供取证；断点只报告、不作为活动链失败）。 */
  verifySealed() {
    const out = []
    for (const f of this.sealedFiles()) {
      const path = join(this.dir, f)
      try {
        out.push({ file: f, ...verifyChainText(readFileSync(path, 'utf8')) })
      } catch {
        out.push({ file: f, ok: false, checked: 0, legacy: 0, lines: 0, broken: { line: 0, reason: 'unreadable' } })
      }
    }
    return out
  }
}

/** Keep audit rows JSON-safe and bounded. */
function sanitizeEntry(entry) {
  const out = {}
  if (!entry || typeof entry !== 'object') return out
  const scalars = ['tool', 'decision', 'reason', 'outcome', 'agent', 'callId', 'note', 'phase', 'effect']
  for (const key of scalars) {
    if (entry[key] === undefined || entry[key] === null) continue
    out[key] = String(entry[key]).slice(0, 500)
  }
  // v2 (②): engine / approver 只接受枚举值；approver 缺省时按 arm.source 推导。
  if (ENGINES.includes(entry.engine)) out.engine = entry.engine
  const approver = entry.approver ? (APPROVERS.includes(entry.approver) ? entry.approver : '') : deriveApprover(entry.arm)
  if (approver) out.approver = approver
  if (entry.args && typeof entry.args === 'object') out.args = boundValue(entry.args, 0)
  if (entry.window && typeof entry.window === 'object') out.window = boundValue(entry.window, 0)
  // v0.9.1 privacy: window titles can carry private content; keep a short hint
  // only (handles/rects are what the audit actually needs).
  if (out.window && typeof out.window.title === 'string') out.window.title = out.window.title.slice(0, 80)
  if (entry.target && typeof entry.target === 'object') out.target = boundValue(entry.target, 0)
  if (entry.arm && typeof entry.arm === 'object') out.arm = boundValue(entry.arm, 0)
  return out
}

/** v0.9.1: hash of one audit row (the row's own h field is excluded). */
function hashRow(row) {
  const copy = { ...row }
  delete copy.h
  return createHash('sha256').update(JSON.stringify(copy)).digest('hex')
}

/** Bound nested JSON values so one entry cannot balloon the file. */
function boundValue(value, depth) {
  if (depth > 3) return '[deep]'
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return value.slice(0, 300)
  if (Array.isArray(value)) return value.slice(0, 12).map((v) => boundValue(v, depth + 1))
  if (typeof value === 'object') {
    const out = {}
    let i = 0
    for (const key of Object.keys(value)) {
      if (i++ >= 24) break
      out[String(key).slice(0, 60)] = boundValue(value[key], depth + 1)
    }
    return out
  }
  return String(value).slice(0, 120)
}

// ---- v2 (② 审计 schema v2) 辅助 ----
const ENGINES = ['pixel', 'control', 'stroke']
const APPROVERS = ['human-command', 'hotkey', 'host-approval']

/**
 * 从授权快照 arm 推导 approver：
 * - arm.source === 'hotkey'     → hotkey（Ctrl+Alt+F12 常开/热键）
 * - arm.source === 'approval'   → host-approval（主机代为批准）
 * - 其余（'human' / 'arm' / 'command' / 未知但已 armed）→ human-command
 * - 没有 arm / 未 armed（观察类、拒绝类）→ ''（不需要批准，不写 approver）
 */
function deriveApprover(arm) {
  if (!arm || typeof arm !== 'object' || arm.armed !== true) return ''
  const s = String(arm.source || '')
  if (s === 'hotkey') return 'hotkey'
  if (s === 'approval') return 'host-approval'
  return 'human-command'
}

/**
 * v2 (②): 单文件链校验（复刻 verify() 的逐行逻辑，供封印文件取证用）。
 * 与 verify() 独立，避免改动活动链的跨代锚定逻辑。
 */
function verifyChainText(text) {
  const result = { ok: true, checked: 0, legacy: 0, lines: 0, broken: null }
  const lines = text.split('\n')
  let head = ''
  let anchored = false
  let prevRow = null
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') continue
    let row
    try {
      row = JSON.parse(lines[i])
    } catch {
      result.ok = false
      result.broken = { line: i + 1, reason: 'bad-json' }
      return result
    }
    result.lines++
    if (typeof row.h !== 'string' || typeof row.prev !== 'string') {
      result.legacy++
      continue
    }
    if (!anchored) {
      anchored = true
      head = row.prev
    }
    if (row.prev !== head) {
      const forked = prevRow != null && (row.seq === prevRow.seq || row.prev === prevRow.prev)
      result.ok = false
      result.broken = { line: i + 1, reason: forked ? 'concurrent-writer' : 'chain-break' }
      return result
    }
    if (hashRow(row) !== row.h) {
      result.ok = false
      result.broken = { line: i + 1, reason: 'hash-mismatch' }
      return result
    }
    head = row.h
    prevRow = row
    result.checked++
  }
  return result
}
