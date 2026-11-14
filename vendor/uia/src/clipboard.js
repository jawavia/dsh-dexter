// clipboard.js — 剪贴板读写（走 Windows PowerShell 5.1 的 Get-Set-Clipboard，避免 koffi 手写 GDI 内存）
//
// 用途：
//   1) 超长文本改用"写剪贴板 + Ctrl+V"输入（快、不丢字）
//   2) 打完字读回剪贴板做校验（Ctrl+A / Ctrl+C 之后读）
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PS = 'powershell.exe'

function runPs(command, timeout = 8000) {
  return execFileSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf8',
    timeout,
    windowsHide: true,
  })
}

/** 读剪贴板纯文本；读不到返回 null。
 *  必须先把 PowerShell 的 stdout 编码设成 UTF-8，否则中文经管道出来是 GBK 乱码。
 *  Get-Clipboard 读出来会带一个行尾，这里去掉一层，保证写-读往返一致。 */
export function readClipboard() {
  try {
    const raw = runPs('[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-Clipboard -Raw')
    return String(raw).replace(/\r?\n$/, '')
  } catch {
    return null
  }
}

/**
 * 等剪贴板真的换成"新内容"再读回来。
 *
 * 为什么不能固定 sleep：目标程序是**异步**处理注入按键的。Ctrl+C 已经发出去，但它可能还在
 * 消化前面注入的几百个字，几百毫秒后才真正把文本放进剪贴板 —— 固定等 250ms 是赌运气，
 * 赌输就会把"旧剪贴板"当成读回结果，误报校验失败（2026-11-04 真机复现：462 字实际打全，
 * 校验却报"读回 42 字"，读回的正是校验前剪贴板里的那个 42 字标记）。
 *
 * @param {string|null} prev 校验前读到的剪贴板内容；轮询到与它不同才返回
 * @param {{timeoutMs?:number, stepMs?:number}} options
 * @returns {string|null} 当前剪贴板内容（超时也返回最后一次读到的值，交给调用方判断）
 */
export function waitClipboardChange(prev, { timeoutMs = 2500, stepMs = 60 } = {}) {
  const deadline = Date.now() + timeoutMs
  let got = readClipboard()
  while (Date.now() < deadline) {
    if (got !== null && got !== prev) return got
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, stepMs)
    got = readClipboard()
  }
  return got
}

/** 写剪贴板纯文本（经临时文件，避免命令行长度的坑）；成功返回 true。 */
export function writeClipboard(text) {
  const file = path.join(os.tmpdir(), `dsh-x2-clip-${process.pid}-${Date.now()}.txt`)
  try {
    fs.writeFileSync(file, String(text ?? ''), 'utf8')
    const escaped = file.replace(/'/g, "''")
    runPs(`Get-Content -Raw -LiteralPath '${escaped}' -Encoding UTF8 | Set-Clipboard`)
    return true
  } catch {
    return false
  } finally {
    try { fs.unlinkSync(file) } catch { /* 临时文件删不掉也无所谓 */ }
  }
}
