/**
 * dsh-click-matrix — host wrapper for the UI Automation observation script.
 *
 * Spawns Windows PowerShell 5.1 (`powershell.exe -NoProfile -NonInteractive
 * -ExecutionPolicy Bypass -File lib/uia.ps1 -InputBase64 <b64>`) with a hard
 * timeout, parses the single JSON result line, and always returns a plain
 * {ok:...} object (never throws). Failed/timed-out observation is reported as
 * advice to fall back to screenshots, not as a crash.
 *
 * Test hatch: DSH_CLICK_MATRIX_MOCK_UIA=<json file or inline json> returns that
 * payload instead of touching the real desktop (used by tools/host-smoke.mjs).
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const DEFAULT_SCRIPT_PATH = fileURLToPath(new URL('./uia.ps1', import.meta.url))
const POWERSHELL = process.env.DSH_CLICK_MATRIX_POWERSHELL || 'powershell.exe'

function encodeBase64Utf8(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64')
}

/** Kill a child process tree-ish (PowerShell spawns no grandchildren here). */
function killQuietly(child) {
  try {
    child.kill()
  } catch {
    /* ignore */
  }
}

/** Extract the JSON payload PowerShell printed (last parseable line). */
export function extractJsonPayload(stdout) {
  const text = String(stdout || '').trim()
  if (text === '') return null
  const candidates = [text]
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) candidates.push(lines[i])
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1))
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      /* try next */
    }
  }
  return null
}

/** Read the mock payload when the test hatch is active; null otherwise. */
function mockPayload() {
  const mock = process.env.DSH_CLICK_MATRIX_MOCK_UIA
  if (!mock || mock.trim() === '') return null
  const value = mock.trim()
  try {
    if (value.startsWith('{') || value.startsWith('[')) return JSON.parse(value)
    if (existsSync(value)) return JSON.parse(readFileSync(value, 'utf8'))
  } catch {
    return { ok: false, error: 'mock UIA payload unreadable' }
  }
  return { ok: false, error: 'mock UIA payload missing' }
}

/**
 * Observe UI Automation elements under a window / region (read-only).
 * @param {object} options
 * @param {'foreground'|'handle'|'pid'} [options.mode]
 * @param {number} [options.handle]
 * @param {number} [options.pid]
 * @param {{x:number,y:number,w:number,h:number}|null} [options.region]
 * @param {number} [options.maxElements]
 * @param {number} [options.timeoutMs]
 * @param {string} [options.scriptPath]
 * @returns {Promise<{ok:boolean, error?:string, elements?:object[], window?:object, timedOut?:boolean}>}
 */
export async function observeUi(options = {}) {
  const mock = mockPayload()
  if (mock) {
    if (Array.isArray(mock)) return { ok: true, elements: mock, window: {}, mocked: true }
    return { ...mock, mocked: true }
  }
  const timeoutMs = Math.max(500, Math.min(30000, Math.round(Number(options.timeoutMs) || 4000)))
  const request = {
    mode: options.mode || 'foreground',
    handle: Number(options.handle) || 0,
    pid: Number(options.pid) || 0,
    maxElements: Math.max(1, Math.min(60, Math.round(Number(options.maxElements) || 60))),
  }
  if (options.region && typeof options.region === 'object') {
    request.region = {
      x: Math.round(Number(options.region.x) || 0),
      y: Math.round(Number(options.region.y) || 0),
      w: Math.max(1, Math.round(Number(options.region.w ?? options.region.width) || 1)),
      h: Math.max(1, Math.round(Number(options.region.h ?? options.region.height) || 1)),
    }
  }
  const scriptPath = options.scriptPath || DEFAULT_SCRIPT_PATH
  if (!existsSync(scriptPath)) {
    return { ok: false, error: `缺少 UIA 脚本 lib/uia.ps1（${scriptPath}），请重新安装插件；可改用 screen_capture + screen_locate。` }
  }
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    '-InputBase64',
    encodeBase64Utf8(request),
  ]
  return await new Promise((resolve) => {
    let child
    try {
      child = spawn(POWERSHELL, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      resolve({ ok: false, error: `无法启动 powershell.exe: ${error && error.message ? error.message : error}` })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.stdout.removeAllListeners('data')
        child.stderr.removeAllListeners('data')
      } catch {
        /* ignore */
      }
      resolve(result)
    }
    const timer = setTimeout(() => {
      killQuietly(child)
      finish({ ok: false, timedOut: true, error: `UI Automation 观察超时（${timeoutMs}ms）。可改用 screen_capture / screen_locate 流程。` })
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      finish({ ok: false, error: `powershell.exe 启动失败: ${error && error.message ? error.message : error}` })
    })
    child.on('exit', (code) => {
      if (settled) return
      const payload = extractJsonPayload(stdout)
      if (payload !== null) {
        if (payload.ok === true) {
          const elements = Array.isArray(payload.elements) ? payload.elements : []
          finish({ ...payload, elements, ok: true })
        } else {
          finish({ ok: false, error: String(payload.error || `UIA 脚本失败 (exit ${code})`), window: payload.window })
        }
        return
      }
      const errText = stderr.trim()
      finish({
        ok: false,
        error: `UIA 脚本没有返回 JSON (exit ${code})${errText ? ': ' + errText.slice(0, 300) : ''}。可改用 screen_capture / screen_locate。`,
      })
    })
  })
}
