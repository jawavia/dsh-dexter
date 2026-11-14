// src/deny.js —— ③ 拒绝清单下沉：读共享 deny-list.json 并匹配（x2 侧）。
// 数据文件：~/.dsh/dsh-desktop-hands/deny-list.json（dsh-desktop-hands 负责播种）。
// 文件缺失/损坏时返回 null（无拒绝清单 = 沿用旧行为，即"各自读旧配置"的回滚分支）。
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const SHARED = () => join(homedir(), '.dsh', 'dsh-desktop-hands', 'deny-list.json')

export function processBase(p) {
  if (typeof p !== 'string' || p.trim() === '') return ''
  const parts = p.replaceAll('/', '\\').split('\\')
  return parts[parts.length - 1].trim().toLowerCase()
}

function loadGroups() {
  try {
    if (!existsSync(SHARED())) return null
    const j = JSON.parse(readFileSync(SHARED(), 'utf8'))
    const g = j && j.groups
    if (!g || typeof g !== 'object') return null
    const out = {}
    for (const [id, p] of Object.entries(g)) {
      if (!p || typeof p !== 'object') continue
      out[id] = {
        label: typeof p.label === 'string' ? p.label : id,
        processes: Array.isArray(p.processes) ? p.processes.map(String) : [],
        titleExact: Array.isArray(p.titleExact) ? p.titleExact.map(String) : [],
        titleNeedles: Array.isArray(p.titleNeedles) ? p.titleNeedles.map(String) : [],
      }
    }
    return Object.keys(out).length > 0 ? out : null
  } catch {
    return null
  }
}

/**
 * 匹配窗口/进程是否命中共享拒绝清单。
 * @param {{process?:string, title?:string}} w
 * @returns {{group:string,label:string,rule:string}|null}
 */
export function matchDeny(w = {}) {
  const groups = loadGroups()
  if (!groups) return null
  const proc = processBase(w && w.process)
  const title = w && typeof w.title === 'string' ? w.title.trim() : ''
  const titleLower = title.toLowerCase()
  for (const [group, p] of Object.entries(groups)) {
    if (proc && p.processes.some((x) => processBase(x) === proc)) {
      return { group, label: p.label, rule: `process:${proc}` }
    }
    if (title && p.titleExact.some((t) => title === t)) {
      return { group, label: p.label, rule: `title:${title}` }
    }
    if (title && p.titleNeedles.some((t) => titleLower.includes(t.toLowerCase()))) {
      return { group, label: p.label, rule: `title-contains:${title}` }
    }
  }
  return null
}
