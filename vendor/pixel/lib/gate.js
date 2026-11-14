// lib/gate.js —— ④ 授权 fan-out + ⑤ StopBus 触发：click-matrix 写共享 gate.json / stop.signal。
// 数据文件：~/.dsh/dsh-desktop-hands/{gate.json, stop.signal}（x2 读 scopes.control、stroke 读 scopes.stroke）。
// 与 dsh-desktop-hands/core/*.mjs 共用同一文件格式；这里只实现写（fan-out / stop 触发）。
import { writeFileSync, mkdirSync, renameSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// 2026-11-08（测试隔离）：DSH_HANDS_DATA_DIR 可以把这两个文件重定向到别处。
// 起因：`node tools/verify.mjs` 里的 host-smoke 会真的走一次 `/click-matrix arm` 命令，
// 而这里原来是写死 homedir → 每次跑回归都会用一次 60 秒 fan-out **覆盖真人授权文件**
// （实测：2026-11-08 01:57 一次 verify 把此前的常开授权覆盖掉了）。测试必须与真授权文件隔离。
const DATA_DIR = () => process.env.DSH_HANDS_DATA_DIR || join(homedir(), '.dsh', 'dsh-desktop-hands')

function write(armedUntil, by, note) {
  const j = {
    version: 1,
    armedUntil,
    by,
    note,
    scopes: {
      pixel: { armed: armedUntil > Date.now() },
      control: { armed: armedUntil > Date.now() },
      stroke: { armed: armedUntil > Date.now() },
    },
  }
  const dataDir = DATA_DIR()
  mkdirSync(dataDir, { recursive: true })
  const target = join(dataDir, 'gate.json')
  const tmp = target + '.tmp-' + process.pid
  writeFileSync(tmp, JSON.stringify(j, null, 2) + '\n', 'utf8')
  renameSync(tmp, target)
  return j
}

/** 一次人类 arm → 给三引擎各开一个 scope（fan-out），并清掉 stop token（重新授权=恢复）。 */
export function fanOutArm({ seconds = 600, by = 'command', note = '' } = {}) {
  clearStop()
  const armedUntil = Date.now() + Math.max(1, Number(seconds) || 600) * 1000
  return write(armedUntil, by, note)
}

/** 常开（latch）→ 用一个极远过期时间近似"直到 stop"。 */
export function fanOutLatch({ by = 'command', note = '' } = {}) {
  clearStop()
  return write(Date.now() + 10 * 365 * 24 * 3600 * 1000, by, note || 'latched')
}

/** 关闭全部授权。 */
export function fanOutDisarm({ by = 'command', note = '' } = {}) {
  return write(0, by, note)
}

/** ⑤ StopBus：写 stop.signal token（hard/soft）。 */
export function writeStop({ level = 'hard', by = 'command', reason = '' } = {}) {
  const dataDir = DATA_DIR()
  mkdirSync(dataDir, { recursive: true })
  const j = { level: level === 'soft' ? 'soft' : 'hard', at: Date.now(), by, reason: String(reason || '').slice(0, 200) }
  const target = join(dataDir, 'stop.signal')
  const tmp = target + '.tmp-' + process.pid
  writeFileSync(tmp, JSON.stringify(j) + '\n', 'utf8')
  renameSync(tmp, target)
  return j
}

/** ⑤ StopBus：清 stop token。 */
export function clearStop() {
  try { rmSync(join(DATA_DIR(), 'stop.signal'), { force: true }); return true } catch { return false }
}

/** ⑤ StopBus：读 stop.signal token；缺失/损坏返回 null。 */
export function readStop() {
  try {
    const p = join(DATA_DIR(), 'stop.signal')
    if (!existsSync(p)) return null
    const j = JSON.parse(readFileSync(p, 'utf8'))
    return { level: j.level === 'soft' ? 'soft' : 'hard', at: Number(j.at) || 0, by: j.by || '', reason: j.reason || '' }
  } catch {
    return null
  }
}
