// src/gate.js —— ④ 授权 fan-out：读 core gate.json 的 control scope（x2 侧）。
// 数据文件：~/.dsh/dsh-desktop-hands/gate.json（dsh-desktop-hands 负责写）。
// 返回 null 表示 gate.json 缺失/损坏 → 调用方回退旧 arm.json（回滚分支）。
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const GATE = (dir) => join(dir || join(homedir(), '.dsh', 'dsh-desktop-hands'), 'gate.json')

/** @param {string} [dataDir] 覆盖数据目录（测试用）；缺省 ~/.dsh/dsh-desktop-hands */
export function readControlScope(dataDir) {
  try {
    const p = GATE(dataDir)
    if (!existsSync(p)) return null
    const j = JSON.parse(readFileSync(p, 'utf8'))
    const armedUntil = Number(j.armedUntil) || 0
    const control = j && j.scopes && j.scopes.control
    const armed = armedUntil > Date.now() && !!(control && control.armed === true)
    return { armed, armedUntil, by: (j && j.by) || '' }
  } catch {
    return null
  }
}

/** ⑤ StopBus：读 stop.signal token；缺失/损坏返回 null。 */
export function readStop(dataDir) {
  try {
    const p = join(dataDir || join(homedir(), '.dsh', 'dsh-desktop-hands'), 'stop.signal')
    if (!existsSync(p)) return null
    const j = JSON.parse(readFileSync(p, 'utf8'))
    return { level: j.level === 'soft' ? 'soft' : 'hard', at: Number(j.at) || 0, by: j.by || '', reason: j.reason || '' }
  } catch {
    return null
  }
}
