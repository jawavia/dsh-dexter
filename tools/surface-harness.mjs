/**
 * Surface harness — capture the tool definitions a plugin registers.
 *
 * The old package measured its surface by calling each engine's `apply()` with a
 * minimal stand-in for the Cordis context and recording every
 * `ctx.tools.register(def)` call. This module keeps exactly that approach so the
 * old baseline and the new kernel are measured the same way: same stand-in, same
 * byte metric.
 *
 * `-e` mode: nothing here touches the real profile. The stand-in implements only
 * the services the plugins probe (`tools`, `webServer`, `commands`, `skills`,
 * `systemPrompt`, `approval`), and every unknown service resolves to `undefined`,
 * which each engine already treats as "not composed in this deployment".
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Build the fake host context used for surface capture. */
export function makeMockContext({ onRegister, services = {} } = {}) {
  const registered = []
  const disposers = []
  const logs = []
  const ctx = {
    tools: {
      register(def) {
        registered.push(def)
        if (typeof onRegister === 'function') onRegister(def)
        const dispose = () => {
          const index = registered.indexOf(def)
          if (index >= 0) registered.splice(index, 1)
        }
        disposers.push(dispose)
        return dispose
      },
      get(name) {
        return registered.find((def) => def.name === name)
      },
      schemas() {
        return registered.map((def) => ({ name: def.name, description: def.description, parameters: def.parameters }))
      },
      guard() {
        return () => {}
      },
      restrict() {
        return () => {}
      },
    },
    logger: {
      info: (m) => logs.push(`info ${m}`),
      warn: (m) => logs.push(`warn ${m}`),
      error: (m) => logs.push(`error ${m}`),
    },
    get(name) {
      if (name === 'tools') return ctx.tools
      if (name === 'logger') return ctx.logger
      if (Object.hasOwn(services, name)) return services[name]
      return undefined
    },
    inject(_names, callback) {
      try {
        callback(ctx)
      } catch (error) {
        logs.push(`inject-failed ${error && error.message ? error.message : error}`)
      }
      return () => {}
    },
    effect(effect) {
      try {
        const dispose = typeof effect === 'function' ? effect() : undefined
        return typeof dispose === 'function' ? dispose : () => {}
      } catch (error) {
        logs.push(`effect-failed ${error && error.message ? error.message : error}`)
        return () => {}
      }
    },
    on() {
      return () => {}
    },
    emit() {},
  }
  ctx.commands = { register: () => () => {} }
  ctx.webServer = undefined
  return { ctx, registered, logs, dispose: () => disposers.splice(0).forEach((fn) => { try { fn() } catch { /* ignore */ } }) }
}

/** Import a module by absolute directory + entry file. */
export async function importPlugin(dir, entry = 'index.js') {
  return import(pathToFileURL(join(dir, entry)).href)
}

/**
 * Capture one plugin's surface.
 *
 * @param {object} options
 * @param {string} options.dir package directory
 * @param {string} [options.entry] entry file name
 * @param {object} [options.config] plugin config row
 * @returns {Promise<{tools:object[], logs:string[], cleanup:Function}>}
 */
export async function capture({ dir, entry = 'index.js', config = {}, settleMs = 4000 }) {
  const previous = { DSH_HOME: process.env.DSH_HOME, DSH_HANDS_DATA_DIR: process.env.DSH_HANDS_DATA_DIR }
  const scratch = mkdtempSync(join(tmpdir(), 'dexter-surface-'))
  // Engines cache data/capture dirs at apply time: point them at a scratch tree so
  // measuring never appends to the user's real audit trail.
  process.env.DSH_HOME = scratch
  process.env.DSH_HANDS_DATA_DIR = join(scratch, 'hands')
  process.env.DSH_DEXTER_DATA_DIR = join(scratch, 'dexter')
  const mock = makeMockContext()
  let plugin
  try {
    plugin = await importPlugin(dir, entry)
    if (typeof plugin.apply === 'function') plugin.apply(mock.ctx, config)
    // Some plugins register asynchronously (backends are dynamic imports). Wait
    // until the registration set stops growing rather than guessing a fixed delay.
    const deadline = Date.now() + settleMs
    let lastCount = -1
    let stableSince = 0
    while (Date.now() < deadline) {
      const count = mock.registered.length
      if (count !== lastCount) {
        lastCount = count
        stableSince = Date.now()
      } else if (count > 0 && Date.now() - stableSince >= 250) {
        break
      } else if (count === 0 && Date.now() - stableSince >= 1500) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return {
      tools: mock.registered,
      logs: mock.logs,
      cleanup: () => {
        try {
          mock.dispose()
        } catch { /* ignore */ }
        rmSync(scratch, { recursive: true, force: true })
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      },
    }
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true })
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    throw error
  }
}
