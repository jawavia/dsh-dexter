// config.js — 本地配置文件（面板改的就是它）
//
// 优先级：~/.dsh-x2/config.json  >  profile 里给插件的 config  >  代码默认值
// 为什么文件优先：文件是本机私有偏好，改了不用重启 DSH（下次动作前生效），
// 而 profile 配置是"随 profile 走的"，改起来要动 JSON。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function configPath() {
  return path.join(os.homedir(), '.dsh-x2', 'config.json')
}

export function readFileConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function writeFileConfig(patch) {
  const dir = path.dirname(configPath())
  fs.mkdirSync(dir, { recursive: true })
  const next = { ...readFileConfig(), ...patch }
  for (const [k, v] of Object.entries(next)) {
    if (v === undefined || v === null) delete next[k]
  }
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2) + '\n', 'utf8')
  return next
}

/** 合并：host 配置为准，本地文件覆盖（文件优先）。 */
export function mergeConfig(hostConfig = {}) {
  return { ...hostConfig, ...readFileConfig() }
}

/** 面板里能改的键（顺序即菜单顺序），带默认值与说明。 */
export const EDITABLE_KEYS = [
  { key: 'settleMs', type: 'number', def: 180, desc: '动作后等画面重绘多久再截图（毫秒）' },
  { key: 'armSeconds', type: 'number', def: 1200, desc: 'F9 授权窗口默认时长（秒）' },
  { key: 'hotkeyArm', type: 'boolean', def: false, desc: '是否启用 x2 自己的 Ctrl+Alt+F9/F10/F8 热键（⑥ 后默认关，授权走 fan-out、停止走 Esc/Ctrl+Alt+F11/Ctrl+Shift+F11）' },
  { key: 'overlay', type: 'boolean', def: true, desc: '动手时屏幕顶部状态条' },
  { key: 'overlayIdleMs', type: 'number', def: 1600, desc: '状态条停留多久（毫秒）' },
  { key: 'audit', type: 'boolean', def: true, desc: '动作审计（hash 链）' },
  { key: 'typeChunkChars', type: 'number', def: 240, desc: '长文本每批字符数（分批输入）' },
  { key: 'typeChunkDelayMs', type: 'number', def: 25, desc: '批与批之间停多久（毫秒）' },
  { key: 'typeVerifyMinChars', type: 'number', def: 400, desc: '超过多少字符自动读回校验（0=总校验）' },
  { key: 'typePasteThreshold', type: 'number', def: 2000, desc: '超过多少字符改用剪贴板粘贴（0=不用）' },
  { key: 'imageBudget', type: 'number', def: 0, desc: '图片软预算：每轮最多几张（0=只统计不提示）' },
]

/**
 * 监听配置文件变化：面板/手改之后，下一次工具调用就用新值，不用重启 DSH。
 * 返回 stop 函数（插件 dispose 时调用）。
 */
export function watchFileConfig(onChange) {
  const dir = path.dirname(configPath())
  try { fs.mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
  try {
    const watcher = fs.watch(dir, { persistent: false }, (_event, name) => {
      if (!name || String(name) === 'config.json') {
        try { onChange() } catch { /* ignore */ }
      }
    })
    return () => { try { watcher.close() } catch { /* already closed */ } }
  } catch {
    return () => {}
  }
}
