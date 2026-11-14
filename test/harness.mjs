/**
 * Test harness: boot the plugin the way the host does, but with stand-ins for the
 * services a bare Node run does not have (approval, attachments) and an isolated
 * data root so a test can never append to the real audit trail.
 *
 * Two boot modes:
 *   bootPlugin()   real index.js + real legacy engines (wiring, surface, injections)
 *   bootKernel()   kernel + fake backends (pure state-machine invariants, no input)
 *
 * bootKernel's clock and fake window table are controllable, so authorization
 * expiry, rate limits and target policy can be tested without sleeping or touching a
 * real desktop.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO = resolve(import.meta.dirname, '..')

export function makeMockContext({ approvalOutcome = 'allowed-once', approvalCalls = [], approvalService = true } = {}) {
  const tools = []
  const commands = []
  const logs = []
  const edits = []
  let approvalHandler = () => approvalOutcome
  const ctx = {
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {
          const index = tools.indexOf(definition)
          if (index >= 0) tools.splice(index, 1)
        }
      },
      get(name) {
        return tools.find((tool) => tool.name === name)
      },
      schemas() {
        return tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
      },
      guard() {
        return () => {}
      },
      restrict() {
        return () => {}
      },
    },
    logger: {
      info: (message) => logs.push(`info ${message}`),
      warn: (message) => logs.push(`warn ${message}`),
      error: (message) => logs.push(`error ${message}`),
    },
    get(name) {
      if (name === 'tools') return ctx.tools
      if (name === 'commands') return ctx.commands
      if (name === 'logger') return ctx.logger
      if (name === 'approval') {
        if (!approvalService) return undefined
        return {
          request: async (request) => {
            approvalCalls.push(request)
            const outcome = approvalHandler(request)
            return typeof outcome === 'function' ? outcome(request) : outcome
          },
        }
      }
      if (name === 'attachments') {
        return {
          saveImage: async ({ name: imageName }) => ({ id: `test-${imageName || 'image'}`, mediaType: 'image/png' }),
        }
      }
      // The host's config editor: /dexter set persists through it. The stub records the
      // candidate so a test can assert what would be written to the profile patch.
      if (name === 'configEditor') {
        return {
          edit: async (entry, mutate) => {
            const candidate = mutate({})
            edits.push({ entry, candidate })
            return candidate
          },
        }
      }
      return undefined
    },
    fiber: { entry: { id: 'dsh-dexter' } },
    _edits: edits,
    inject(_names, callback) {
      callback(ctx)
      return () => {}
    },
    effect(handler) {
      const dispose = handler()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    on() {
      return () => {}
    },
    emit() {},
  }
  ctx.commands = {
    register(command) {
      commands.push(command)
      return () => {
        const index = commands.indexOf(command)
        if (index >= 0) commands.splice(index, 1)
      }
    },
  }
  return {
    ctx,
    tools,
    commands,
    logs,
    approvalCalls,
    edits,
    setApproval(outcome) {
      approvalHandler = typeof outcome === 'function' ? outcome : () => outcome
    },
  }
}

function makeScratch() {
  const dir = mkdtempSync(join(tmpdir(), 'dexter-test-'))
  return {
    dir,
    dispose() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** Boot the real plugin entry with a mock host. */
export async function bootPlugin({ config = {}, approvalOutcome = 'allowed-once', approvalService = true } = {}) {
  const scratch = makeScratch()
  const previous = { ...process.env }
  process.env.DSH_HOME = join(scratch.dir, 'dsh-home')
  process.env.DSH_DEXTER_DATA_DIR = join(scratch.dir, 'dexter')
  process.env.DSH_HANDS_DATA_DIR = join(scratch.dir, 'hands')
  const mock = makeMockContext({ approvalOutcome, approvalService })
  const module = await import(pathToFileURL(join(REPO, 'index.js')).href)
  module.apply(mock.ctx, config)
  // Registration is async: backends are dynamic imports.
  const deadline = Date.now() + 8000
  while (Date.now() < deadline && mock.tools.length === 0) {
    await new Promise((done) => setTimeout(done, 25))
  }
  await new Promise((done) => setTimeout(done, 100))
  const byName = new Map(mock.tools.map((tool) => [tool.name, tool]))
  return {
    repo: REPO,
    module,
    mock,
    tools: mock.tools,
    byName,
    dataDir: process.env.DSH_DEXTER_DATA_DIR,
    async call(name, args, exec = {}) {
      const tool = byName.get(name)
      if (!tool) throw new Error(`tool ${name} not registered`)
      return tool.execute(args, { agent: { id: 'test-agent' }, callId: `${name}-${Date.now()}`, signal: new AbortController().signal, ...exec })
    },
    close() {
      for (const key of Object.keys(process.env)) {
        if (!(key in previous)) delete process.env[key]
      }
      Object.assign(process.env, previous)
      scratch.dispose()
    },
  }
}

/** Boot the kernel with fake backends: no input is ever injected. */
export async function bootKernel({ config = {}, approvalOutcome = 'allowed-once', approvalService = true } = {}) {
  const scratch = makeScratch()
  const previous = { ...process.env }
  process.env.DSH_DEXTER_DATA_DIR = join(scratch.dir, 'dexter')
  const { Audit } = await import(pathToFileURL(join(REPO, 'kernel', 'audit.js')).href)
  const { Gate } = await import(pathToFileURL(join(REPO, 'kernel', 'gate.js')).href)
  const { StopBus } = await import(pathToFileURL(join(REPO, 'kernel', 'stopbus.js')).href)
  const { HumanActivity } = await import(pathToFileURL(join(REPO, 'kernel', 'human.js')).href)
  const { Kernel } = await import(pathToFileURL(join(REPO, 'kernel', 'kernel.js')).href)
  const { normalizeConfig } = await import(pathToFileURL(join(REPO, 'kernel', 'config.js')).href)

  const calls = { act: [], view: [], uia: [] }
  const state = {
    // handle/pid/process/title table the fake Win32 side answers from.
    windows: [
      { handle: 100, pid: 4242, process: 'app.exe', title: 'Fake App', rect: { x: 0, y: 0, width: 800, height: 600 } },
      { handle: 200, pid: 5000, process: 'regedit.exe', title: '注册表编辑器', rect: { x: 1000, y: 0, width: 400, height: 300 } },
      { handle: 300, pid: 6000, process: 'wechat.exe', title: '微信', rect: { x: 1000, y: 400, width: 400, height: 300 } },
    ],
    foregroundHandle: 100,
    cursor: { x: 10, y: 10 },
    keys: new Set(),
    buttonsDown: [],
    hash: 'h0',
    failNext: false,
    nowMs: Date.now(),
  }
  const windowOf = (handle) => state.windows.find((win) => String(win.handle) === String(handle)) || null
  const approvals = { calls: [], outcome: approvalOutcome }
  const approval = {
    request: async (request) => {
      approvals.calls.push(request)
      const outcome = typeof approvals.outcome === 'function' ? approvals.outcome(request) : approvals.outcome
      return outcome
    },
  }

  const pixel = {
    ok: true,
    name: 'legacy-pixel',
    engineTools: ['mouse_click'],
    async act({ capability, args }) {
      calls.act.push({ capability, args })
      if (state.failNext) {
        state.failNext = false
        return { ok: false, text: 'denied by fake engine', engineTool: capability }
      }
      return { ok: true, text: `fake pixel ${capability} ok`, engineTool: capability }
    },
    async probeAt(x, y) {
      // WindowFromPoint answers with the topmost window, so scan from the end.
      const hit = [...state.windows].reverse().find((win) => {
        const r = win.rect
        return x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height
      })
      if (!hit) return null
      return { handle: hit.handle, pid: hit.pid, process: hit.process, title: hit.title, elevated: false }
    },
    async clipboardGet({ requireText } = {}) {
      calls.act.push({ capability: 'clipboard_get', args: { requireText: requireText === true } })
      return { ok: true, text: '剪贴板文本（12 字符）：hello world!', engineTool: 'clipboard_get' }
    },
    async view({ action }) {
      calls.view.push(action)
      return { ok: true, text: `fake view ${action}` }
    },
    capture: () => ({ hash: state.hash }),
    abort() {},
    snapshot: () => ({ mode: 'ask', armed: false }),
  }
  const uia = {
    ok: true,
    name: 'legacy-uia',
    probe: { cursor: () => state.cursor, keyDown: (name) => state.keys.has(name) },
    metrics: () => ({ x: 0, y: 0, width: 1920, height: 1080, monitors: 1 }),
    windows: () => state.windows.map((win) => ({ ...win })),
    processNameOf: (pid) => (state.windows.find((win) => win.pid === pid) || {}).process || '',
    foreground: () => {
      const hit = windowOf(state.foregroundHandle)
      return hit ? { handle: hit.handle, pid: hit.pid, process: hit.process, title: hit.title, rect: hit.rect } : null
    },
    focus: () => ({ ok: true }),
    capture: () => ({ hash: state.hash, path: '/tmp/fake.png' }),
    uia: async (request) => {
      calls.uia.push(request)
      if (request.action === 'rect') return { ok: true, rect: { x: 100, y: 100, width: 40, height: 20 } }
      if (request.action === 'invoke') return { ok: true, invoked: true }
      if (request.action === 'find') return { ok: true, count: 1, matches: [{ name: 'OK', type: 'Button', rect: { x: 100, y: 100, width: 40, height: 20 } }] }
      return { ok: true, root: { name: 'Fake App', type: 'Window' } }
    },
    click(point) {
      calls.act.push({ capability: 'uia-click', args: point })
    },
    type(text) {
      calls.act.push({ capability: 'uia-type', args: { chars: String(text).length } })
    },
    key(name) {
      calls.act.push({ capability: 'uia-key', args: { name } })
    },
    hotkey(keys) {
      calls.act.push({ capability: 'uia-hotkey', args: keys })
    },
    scroll(point, deltas) {
      calls.act.push({ capability: 'uia-scroll', args: deltas })
    },
    move(point) {
      calls.act.push({ capability: 'uia-move', args: point })
      return 'setcursorpos'
    },
    releaseAll() {},
    dispose() {},
  }
  const toy = {
    ok: true,
    name: 'toy-draw',
    shapes: ['circle'],
    async draw({ points }) {
      calls.act.push({ capability: 'toy', args: { points: points.length } })
      return { sent: points.length, elapsed: 120, aborted: false, reason: '' }
    },
    stop() {},
    dispose() {},
  }

  const clock = () => state.nowMs
  const config2 = normalizeConfig(config)
  const audit = new Audit({ dir: process.env.DSH_DEXTER_DATA_DIR, maxBytes: config2.auditMaxBytes, retention: config2.auditRetention })
  const gate = new Gate({ config: config2, audit, approval: approvalService ? approval : null, clock })
  const stopbus = new StopBus({ dataDir: process.env.DSH_DEXTER_DATA_DIR, probe: uia.probe, clock })
  stopbus.onArm = () => {
    const result = gate.openGrant({ minutes: config2.armMinutes, actions: config2.armActions, source: 'hotkey' })
    if (result.ok) gate.clearStop('human')
    return result
  }
  const human = new HumanActivity({
    config: config2,
    probe: uia.probe,
    clock,
    onEvent: (event) => {
      audit.append({
        tool: 'human',
        capability: event.kind,
        decision: event.kind,
        approval: 'none',
        reason: event.reason,
        result: event.idleMs ? `idleMs=${Math.round(event.idleMs)}` : undefined,
      })
    },
  })
  const kernel = new Kernel({
    config: config2,
    audit,
    gate,
    stopbus,
    human,
    backends: { pixel, uia, toy },
    buttons: { ok: true, buttonsDown: () => [...state.buttonsDown] },
    clock,
  })
  kernel.stopbus = stopbus
  kernel.human = human
  stopbus.onStop = ({ level, by, reason }) => kernel.stop({ level, by, reason })

  return {
    kernel,
    gate,
    audit,
    stopbus,
    human,
    config: config2,
    calls,
    approvals,
    state,
    dataDir: process.env.DSH_DEXTER_DATA_DIR,
    advance(ms) {
      state.nowMs += ms
    },
    rows: () => audit.readAll(),
    close() {
      for (const key of Object.keys(process.env)) {
        if (!(key in previous)) delete process.env[key]
      }
      Object.assign(process.env, previous)
      scratch.dispose()
    },
  }
}
