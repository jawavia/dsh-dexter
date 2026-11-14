/**
 * dsh-click-matrix — schemastery `Config` schema（设置界面用）。
 *
 * 为什么单独一个文件：index.js 刻意只 import Node 内建 + 本包 lib，
 * 这份 schema 是「交给 DSH 设置/配置编辑器渲染」用的声明，和 lib/config.js
 * 的 normalizeConfig（运行时夹取，fail-closed）分工：
 *   - 这里声明「有哪些字段、什么类型、范围、默认值」→ 设置界面据此生成控件；
 *   - normalizeConfig 仍负责真实运行时的兜底夹取，二者范围保持一致。
 *
 * 字段与范围 1:1 对齐 lib/config.js 的 DEFAULTS + intIn()/boolIn()/oneOf()。
 */
import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  // ---- 观察 / 坐标 ----
  mode: z.union([z.const('off'), z.const('ask'), z.const('auto')]).default('ask'),
  lattice: z.union([z.const('coarse'), z.const('standard'), z.const('fine'), z.const('micro')]).default('standard'),
  binning: z.union([z.const('target'), z.const('2'), z.const('4'), z.const('6'), z.const('8')]).default('target'),
  captureLongSide: z.number().min(320).max(4096).step(1).default(1600),
  overlayMode: z.union([z.const('auto'), z.const('on'), z.const('off')]).default('auto'),

  // ---- 授权窗口 ----
  armWindowMs: z.number().min(1000).max(300000).step(1000).default(25000),
  armClicks: z.number().min(1).max(100).step(1).default(10),
  hotkeyArmMs: z.number().min(5000).max(600000).step(5000).default(60000),
  armDefaultSeconds: z.number().min(10).max(86400).step(10).default(60),

  // ---- 成本预算 ----
  maxImagesPerTurn: z.number().min(0).max(60).step(1).default(12),
  maxImageTokensPerTurn: z.number().min(0).max(200000).step(1000).default(6000),
  minIntervalMs: z.number().min(0).max(5000).step(10).default(150),

  // ---- 三层 ACL（放行 / 拒绝 / 申请）----
  denyProcesses: z.array(z.string()).default([]),
  denyTitleContains: z.array(z.string()).default([]),
  allowProcesses: z.array(z.string()).default([]),
  allowTitleContains: z.array(z.string()).default([]),
  askProcesses: z.array(z.string()).default([]),
  askTitleContains: z.array(z.string()).default([]),

  // ---- 审计 ----
  auditMaxBytes: z.number().min(65536).max(67108864).step(65536).default(2097152),
  auditRetentionFiles: z.number().min(1).max(20).step(1).default(5),

  // ---- helper 超时 ----
  helperTimeoutMs: z.number().min(1000).max(120000).step(1000).default(20000),
  uiaTimeoutMs: z.number().min(500).max(30000).step(500).default(4000),

  // ---- 能力开关 ----
  enableKeyboard: z.boolean().default(true),
  enableClipboard: z.boolean().default(true),
  batchMaxActions: z.number().min(1).max(50).step(1).default(20),
  pauseOnHumanInput: z.boolean().default(true),
  pillOnArm: z.boolean().default(true),
  waitDefaultTimeoutMs: z.number().min(200).max(30000).step(100).default(5000),
  waitStableMs: z.number().min(50).max(5000).step(50).default(400),

  // ---- 人类活动自动恢复 ----
  humanIdleResumeMs: z.number().min(2000).max(300000).step(1000).default(20000),
  autoResumeHumanActivity: z.boolean().default(true),
  humanWaitMaxMs: z.number().min(0).max(60000).step(1000).default(30000),

  // ---- 自有窗口例外（allowSelf）----
  allowSelfWindow: z.boolean().default(false),
  allowSelfRect: z.any().default(null),
  allowSelfMaxMs: z.number().min(5000).max(600000).step(1000).default(120000),

  // ---- 安全（D-08）----
  requireAbortHotkey: z.boolean().default(true),
})
