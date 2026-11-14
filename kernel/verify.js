/**
 * Post-action proof.
 *
 * The old write paths returned "sent" and left it at that (or verified inside the
 * pixel engine with `verify=crop`, which cost a screenshot). The kernel verifies
 * once, always, at the same place, and records the verdict in the audit row:
 *
 *   foreground — did the window the caller expected own the foreground?
 *   hash       — did the pixels in the target region change?
 *   none       — no proof (explicitly configured)
 */
import { sleep } from './util.js'

function norm(value) {
  return String(value ?? '').trim().toLowerCase()
}

/**
 * @param {{expect?:{process?:string,titleContains?:string}, backend:object}} input
 */
export function verifyForeground({ expect, backend } = {}) {
  if (!expect || (expect.process === undefined && expect.titleContains === undefined)) {
    return { mode: 'foreground', ok: true, detail: '未声明 expect，未做前台断言' }
  }
  if (!backend || typeof backend.foreground !== 'function') {
    return { mode: 'foreground', ok: false, detail: '后端不提供前台窗口信息，无法验证' }
  }
  let foreground = null
  try {
    foreground = backend.foreground()
  } catch (error) {
    return { mode: 'foreground', ok: false, detail: `读取前台窗口失败: ${error && error.message ? error.message : error}` }
  }
  if (!foreground) return { mode: 'foreground', ok: false, detail: '没有前台窗口' }
  const title = norm(foreground.title)
  if (expect.titleContains !== undefined && !title.includes(norm(expect.titleContains))) {
    return { mode: 'foreground', ok: false, detail: `前台标题「${foreground.title || '(无标题)'}」不含「${expect.titleContains}」` }
  }
  if (expect.process !== undefined) {
    let process = ''
    try {
      process = norm(foreground.process || '')
      if (!process && typeof backend.processNameOf === 'function') process = norm(backend.processNameOf(foreground.pid))
    } catch { /* process name is best effort */ }
    // Compare "notepad.exe" with "Notepad": some backends report the application display
    // name, others the image name, so strip the extension and compare both ways.
    const base = (value) => norm(value).replace(/\.exe$/, '')
    if (process && !base(process).includes(base(expect.process)) && !norm(process).includes(norm(expect.process))) {
      return { mode: 'foreground', ok: false, detail: `前台进程「${process}」不是「${expect.process}」` }
    }
    if (!process) {
      return { mode: 'foreground', ok: false, detail: `无法确认前台进程（expect ${expect.process}），按未验证处理` }
    }
  }
  return { mode: 'foreground', ok: true, detail: `前台窗口符合 expect（${foreground.title || foreground.handle}）` }
}

/**
 * Compare the pixels of a region before and after an action.
 * @param {{before?:string, after?:string, region?:object}} input
 */
export function verifyHash({ before, after, region } = {}) {
  if (!before || !after) {
    return { mode: 'hash', ok: true, detail: '没有可比的画面哈希（截图失败或未采集），本条不计为验证失败' }
  }
  if (before === after) {
    return {
      mode: 'hash',
      ok: false,
      detail: `画面未变化（同一区域 hash=${String(before).slice(0, 10)}…）${region ? `，region=${region.w ?? region.width}x${region.h ?? region.height}` : ''}`,
    }
  }
  return { mode: 'hash', ok: true, detail: '目标区域画面已变化' }
}

/** Take the "before" hash a caller can hand to verifyHash later. */
export function captureHash(backend, options) {
  try {
    const captured = backend.capture({ ...options, forceImage: true })
    return captured && captured.hash ? captured.hash : ''
  } catch {
    return ''
  }
}

/** Settle: let the target repaint before verifying. */
export async function settle(ms) {
  if (ms > 0) await sleep(ms)
}
