/**
 * The single audit trail.
 *
 * One file per data root: `<data>/audit/hands.jsonl`, append-only JSONL, every row
 * hash-chained to its predecessor (`seq`/`prev`/`h`). Nothing else in this plugin
 * writes an audit file — the legacy backends' own writers are detached in
 * `backends/legacy-pixel.js` and never touched for the UIA/stroke paths.
 *
 * Honest limit (stated in SECURITY.md): the chain is key-less. It detects silent
 * edits and insertions, not an attacker who rewrites the whole file.
 */
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { sha256Hex, stableStringify } from './util.js'

function cleanValue(value, depth = 0) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (value === undefined) return null
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}…` : value
  if (Array.isArray(value)) return depth >= 2 ? `[${value.length}]` : value.slice(0, 50).map((item) => cleanValue(item, depth + 1))
  if (typeof value === 'object') {
    if (depth >= 3) return '[object]'
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      // Absent fields stay absent: a literal "undefined" in the trail is noise that reads
      // like a value.
      if (item === undefined) continue
      out[key] = cleanValue(item, depth + 1)
    }
    return out
  }
  return String(value)
}

export class Audit {
  /**
   * @param {object} options
   * @param {string} options.dir data root (`<data>/audit/hands.jsonl`)
   * @param {number} [options.maxBytes] rotation threshold
   * @param {number} [options.retention] rotated generations to keep
   * @param {(message:string) => void} [options.onError] called when a write fails
   * @param {() => number} [options.clock]
   */
  constructor({ dir, maxBytes = 8388608, retention = 3, onError = () => {}, clock = () => Date.now() } = {}) {
    this.dir = dir
    this.file = join(dir, 'audit', 'hands.jsonl')
    this.maxBytes = Math.max(65536, Math.round(Number(maxBytes) || 8388608))
    this.retention = Math.max(1, Math.min(20, Math.round(Number(retention) || 3)))
    this.onError = typeof onError === 'function' ? onError : () => {}
    this.clock = clock
    this.seq = 0
    this.head = ''
    this.loaded = false
    this.broken = false
    this.lastError = ''
    this.writes = 0
  }

  #ensureDir() {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      return true
    } catch (error) {
      this.lastError = `数据目录不可写: ${error && error.message ? error.message : error}`
      this.broken = true
      this.onError(this.lastError)
      return false
    }
  }

  #generationPath(index) {
    return join(this.dir, 'audit', index === 1 ? 'hands.1.jsonl' : `hands.${index}.jsonl`)
  }

  #rotateIfNeeded() {
    try {
      if (!existsSync(this.file)) return
      if (statSync(this.file).size < this.maxBytes) return
      rmSync(this.#generationPath(this.retention), { force: true })
      for (let i = this.retention - 1; i >= 1; i -= 1) {
        const from = this.#generationPath(i)
        if (!existsSync(from)) continue
        try {
          renameSync(from, this.#generationPath(i + 1))
        } catch { /* a stuck generation must not block the trail */ }
      }
      renameSync(this.file, this.#generationPath(1))
      this.seq = 0
      this.head = ''
      this.loaded = true
    } catch (error) {
      this.lastError = `审计轮转失败: ${error && error.message ? error.message : error}`
    }
  }

  /** Read the tail once so a restart continues the chain instead of restarting it. */
  #loadChain() {
    if (this.loaded) return
    this.loaded = true
    if (!existsSync(this.file)) return
    try {
      const size = statSync(this.file).size
      const window = Math.min(size, 64 * 1024)
      const fd = openSync(this.file, 'r')
      try {
        const buffer = Buffer.alloc(window)
        readSync(fd, buffer, 0, window, size - window)
        const text = buffer.toString('utf8')
        const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '')
        const last = lines[lines.length - 1]
        if (!last) return
        const row = JSON.parse(last)
        this.seq = Number(row.seq) || 0
        this.head = typeof row.h === 'string' ? row.h : ''
      } finally {
        closeSync(fd)
      }
    } catch (error) {
      this.lastError = `审计尾部读取失败（将从 seq=0 重新开始）: ${error && error.message ? error.message : error}`
      this.onError(this.lastError)
    }
  }

  /**
   * Append one row. Never throws: a broken trail is reported, and `Audit.broken`
   * stays set so callers can refuse to inject without evidence.
   */
  append(entry) {
    if (!this.#ensureDir()) return null
    this.#rotateIfNeeded()
    this.#loadChain()
    const now = this.clock()
    const body = cleanValue(entry)
    const row = {
      ts: now,
      iso: new Date(now).toISOString(),
      ...body,
      seq: this.seq + 1,
      prev: this.head,
    }
    row.h = sha256Hex(stableStringify(row))
    try {
      appendFileSync(this.file, `${JSON.stringify(row)}\n`, 'utf8')
      this.seq = row.seq
      this.head = row.h
      this.writes += 1
      this.broken = false
      this.lastError = ''
      return row
    } catch (error) {
      this.lastError = `审计写入失败（这一笔没有留痕）: ${error && error.message ? error.message : error}`
      this.broken = true
      this.onError(this.lastError)
      return null
    }
  }

  /** Last `count` rows, oldest first. Used by hands_status; never dumps the file. */
  tail(count = 10) {
    // `slice(-0)` is `slice(0)`: asking for 0 rows must return none, not everything.
    if (!Number.isFinite(count) || count <= 0) return []
    if (!existsSync(this.file)) return []
    try {
      const size = statSync(this.file).size
      const window = Math.min(size, Math.max(4096, count * 900))
      const fd = openSync(this.file, 'r')
      let text = ''
      try {
        const buffer = Buffer.alloc(window)
        readSync(fd, buffer, 0, window, size - window)
        text = buffer.toString('utf8')
      } finally {
        closeSync(fd)
      }
      const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '')
      // The first line may be a partial row when the window cut it; drop it.
      const rows = []
      for (const line of lines) {
        try {
          rows.push(JSON.parse(line))
        } catch { /* partial line at the window edge */ }
      }
      return rows.slice(-count)
    } catch (error) {
      this.lastError = `审计读取失败: ${error && error.message ? error.message : error}`
      return []
    }
  }

  stats() {
    const rows = this.tail(500)
    return { file: this.file, seq: this.seq, writes: this.writes, broken: this.broken, lastError: this.lastError, recent: rows.length }
  }

  /** Whole-file reader for the reconciler in tools/ and tests. */
  readAll() {
    if (!existsSync(this.file)) return []
    return readFileSync(this.file, 'utf8').split(/\r?\n/).filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
  }
}
