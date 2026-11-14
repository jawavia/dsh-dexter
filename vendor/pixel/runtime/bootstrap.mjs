// dsh-click-matrix helper bootstrap.
// Compiles runtime/helper.cs once with the in-box .NET Framework C# compiler and
// caches the winexe next to the user's local app data. ASCII source only.
//
// Public API:
//   export const HELPER_VERSION = 11
//   export async function ensureHelper(): Promise<string>  // absolute exe path

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

export const HELPER_VERSION = 11

const HERE = dirname(fileURLToPath(import.meta.url))
const HELPER_SOURCE = join(HERE, 'helper.cs')
const COMPILER_TIMEOUT_MS = 180000

let inFlight = null

// Absolute path of the compiled helper executable. compileAndCache() recomputes
// the source hash on every call, so editing helper.cs is picked up on the next
// helper spawn even inside a long-lived Host process; only concurrent calls
// share one compilation.
export async function ensureHelper() {
  if (!inFlight) {
    inFlight = compileAndCache().finally(() => {
      inFlight = null
    })
  }
  return await inFlight
}

function cacheDirectory() {
  return join(process.env.LOCALAPPDATA || os.tmpdir(), 'dsh-click-matrix', 'helpers')
}

function candidateCompilers() {
  const list = []
  const explicit = process.env.DSH_CLICK_MATRIX_CSC
  if (explicit && explicit.trim()) list.push(explicit.trim())
  const windir = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows'
  list.push(join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'))
  list.push(join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'))
  const seen = new Set()
  const available = []
  for (const candidate of list) {
    const key = candidate.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (existsSync(candidate)) available.push(candidate)
  }
  return available
}

function compilerFlavour(cscPath) {
  const normalized = cscPath.toLowerCase().replace(/\//g, '\\')
  if (normalized.includes('framework64')) return 'framework64'
  if (normalized.includes('\\framework\\')) return 'framework'
  return 'custom'
}

function isUsableFile(path) {
  try {
    const stat = statSync(path)
    return stat.isFile() && stat.size > 0
  } catch {
    return false
  }
}

// v1.3 (integrity): the compiled helper is published next to a sha256
// sidecar. A cache hit only counts when the binary still matches it, so a
// half-written/quarantined/swapped exe is rebuilt instead of silently used.
function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function sidecarPath(exePath) {
  return exePath + '.sha256'
}

function isIntact(exePath) {
  try {
    const want = readFileSync(sidecarPath(exePath), 'utf8').trim()
    if (want === '') return false
    return sha256File(exePath) === want
  } catch {
    return false
  }
}

function writeSidecar(exePath) {
  try {
    writeFileSync(sidecarPath(exePath), sha256File(exePath) + '\n', 'utf8')
  } catch {
    /* best effort: verification will simply recompile next time */
  }
}

function runCompiler(cscPath, args) {
  return new Promise((resolve) => {
    execFile(
      cscPath,
      args,
      { windowsHide: true, timeout: COMPILER_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, encoding: 'buffer' },
      (error, stdout, stderr) => {
        const out = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout || '')
        const err = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr || '')
        let code = 0
        if (error) code = typeof error.code === 'number' ? error.code : -1
        resolve({ code, stdout: out.trim(), stderr: err.trim() })
      },
    )
  })
}

async function compileAndCache() {
  if (!existsSync(HELPER_SOURCE)) {
    throw new Error('click-matrix bootstrap: helper source not found: ' + HELPER_SOURCE)
  }
  const source = readFileSync(HELPER_SOURCE)
  const compilers = candidateCompilers()
  if (compilers.length === 0) {
    throw new Error(
      'click-matrix bootstrap: no csc.exe found (looked for Framework64/Framework v4.0.30319 csc.exe under %WINDIR%; ' +
        'set DSH_CLICK_MATRIX_CSC to override)',
    )
  }

  const primary = compilers[0]
  const flavour = compilerFlavour(primary)
  const cacheKey = createHash('sha256')
    .update(source)
    .update('\0')
    .update(String(HELPER_VERSION))
    .update('\0')
    .update(flavour)
    .digest('hex')

  const dir = cacheDirectory()
  mkdirSync(dir, { recursive: true })
  const finalPath = join(dir, 'helper-' + HELPER_VERSION + '-' + cacheKey + '.exe')
  if (isUsableFile(finalPath)) {
    if (isIntact(finalPath)) return finalPath
    try {
      rmSync(finalPath, { force: true })
      rmSync(sidecarPath(finalPath), { force: true })
    } catch {
      /* fall through to recompile */
    }
  }

  const errors = []
  for (const compiler of compilers) {
    const tmpPath = finalPath + '.tmp-' + process.pid + '-' + Date.now().toString(36)
    const args = [
      '/nologo',
      '/target:winexe',
      '/platform:anycpu',
      '/out:' + tmpPath,
      '/r:System.Windows.Forms.dll',
      '/r:System.Drawing.dll',
      '/r:System.Web.Extensions.dll',
      HELPER_SOURCE,
    ]
    const result = await runCompiler(compiler, args)
    const produced = result.code === 0 && isUsableFile(tmpPath)
    if (produced) {
      try {
        if (isUsableFile(finalPath)) {
          rmSync(tmpPath, { force: true })
        } else {
          try {
            renameSync(tmpPath, finalPath)
          } catch (renameError) {
            if (!isUsableFile(finalPath)) throw renameError
            rmSync(tmpPath, { force: true })
          }
        }
        writeSidecar(finalPath)
        return finalPath
      } catch (publishError) {
        rmSync(tmpPath, { force: true })
        errors.push('csc (' + compiler + ') produced output but publishing failed: ' + String(publishError && publishError.message))
        continue
      }
    }
    rmSync(tmpPath, { force: true })
    const detail = [result.stderr, result.stdout].filter(Boolean).join(' | ')
    errors.push('csc (' + compiler + ') exit ' + result.code + (detail ? ': ' + detail : ': no output'))
  }

  throw new Error(
    'click-matrix bootstrap: failed to compile ' + HELPER_SOURCE + '. ' + errors.join(' || '),
  )
}
