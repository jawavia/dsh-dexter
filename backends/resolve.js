/**
 * Where the legacy engines live.
 *
 * The kernel does not vendor them: this plugin owns the kernel, the engines keep
 * their injection code, and the adapter loads them from the installation that is
 * already on the machine. Resolution order, first hit wins:
 *
 *   1. the `legacy*Path` config value (absolute package directory)
 *   2. DSH_DEXTER_LEGACY_ROOT  — a tree with `engines/{pixel,control,stroke}`
 *   3. `local.config.json` next to this package (git-ignored; local dev only)
 *   4. package resolution from this package's own module scope
 *      (`dsh-click-matrix`, `dsh-x2`, `dsh-stroke` installed next to us)
 *
 * Nothing here hard-codes a machine path: that is what keeps the repository free
 * of local paths while a transition install still finds the engines.
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PACKAGE_DIR = resolve(HERE, '..')

const ENGINES = Object.freeze({
  pixel: { packageName: 'dsh-click-matrix', subdir: 'pixel', entry: 'index.js' },
  uia: { packageName: 'dsh-x2', subdir: 'control', entry: 'src/win32.js' },
})

function readLocalConfig() {
  const candidates = [
    process.env.DSH_DEXTER_LOCAL_CONFIG || '',
    join(PACKAGE_DIR, 'local.config.json'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue
      return JSON.parse(readFileSync(candidate, 'utf8'))
    } catch { /* a broken local config must not break the plugin */ }
  }
  return null
}

function tryResolvePackage(packageName) {
  try {
    const require = createRequire(join(PACKAGE_DIR, 'index.js'))
    return dirname(require.resolve(`${packageName}/package.json`))
  } catch {
    return ''
  }
}

/**
 * @param {'pixel'|'uia'|'stroke'} kind
 * @param {string} [configured] absolute package directory from config
 * @returns {{ok:boolean, dir:string, entry:string, source:string, reason?:string}}
 */
export function resolveEngine(kind, configured = '') {
  const spec = ENGINES[kind]
  if (!spec) return { ok: false, dir: '', entry: '', source: 'unknown', reason: `未知引擎 ${kind}` }

  if (typeof configured === 'string' && configured.trim() !== '') {
    const dir = isAbsolute(configured) ? configured : resolve(PACKAGE_DIR, configured)
    const entry = join(dir, spec.entry)
    if (existsSync(entry)) return { ok: true, dir, entry, source: 'config' }
    return { ok: false, dir, entry, source: 'config', reason: `配置的 ${kind} 路径里没有 ${spec.entry}` }
  }

  // Vendored engines ship inside this package, so a fresh install works with no
  // prerequisites. An explicit config path still wins; this only fills the gap.
  // (The vendor directory is named after the engine kind, not after the legacy package's
  // own sub-directory name, so `uia` lives in vendor/uia rather than vendor/control.)
  const vendorSubdir = kind === 'uia' ? 'uia' : spec.subdir
  const vendored = join(PACKAGE_DIR, 'vendor', vendorSubdir)
  if (existsSync(join(vendored, spec.entry))) {
    return { ok: true, dir: vendored, entry: join(vendored, spec.entry), source: 'vendor' }
  }

  const root = process.env.DSH_DEXTER_LEGACY_ROOT || ''
  if (root.trim() !== '') {
    const dir = join(root, 'engines', spec.subdir)
    const entry = join(dir, spec.entry)
    if (existsSync(entry)) return { ok: true, dir, entry, source: 'env:DSH_DEXTER_LEGACY_ROOT' }
  }

  const local = readLocalConfig()
  if (local && typeof local === 'object') {
    const mapped = local[`${kind}Path`] || (local.legacyRoot ? join(local.legacyRoot, 'engines', spec.subdir) : '')
    if (mapped) {
      const dir = isAbsolute(mapped) ? mapped : resolve(PACKAGE_DIR, mapped)
      const entry = join(dir, spec.entry)
      if (existsSync(entry)) return { ok: true, dir, entry, source: 'local.config.json' }
    }
  }

  const packageDir = tryResolvePackage(spec.packageName)
  if (packageDir) {
    const entry = join(packageDir, spec.entry)
    if (existsSync(entry)) return { ok: true, dir: packageDir, entry, source: 'package' }
  }

  return {
    ok: false,
    dir: '',
    entry: '',
    source: 'missing',
    reason: `找不到 ${spec.packageName}：请设置 legacy${kind === 'uia' ? 'Uia' : kind === 'pixel' ? 'Pixel' : 'Stroke'}Path、DSH_DEXTER_LEGACY_ROOT，或把它装在本插件旁边`,
  }
}

/** Resolve every engine once, for hands_status and the apply-time log. */
export function describeEngines(config) {
  return {
    pixel: resolveEngine('pixel', config.legacyPixelPath),
    uia: resolveEngine('uia', config.legacyUiaPath),
  }
}
