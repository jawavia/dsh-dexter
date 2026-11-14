/**
 * probe-page.mjs — is the client module actually served to the running Web page?
 *
 * The GUI is a browser page; without browser automation the closest honest check is to
 * fetch the page shell and the plugin's client entry over HTTP and see whether the
 * artifact is reachable. It proves delivery, not rendering.
 *
 * Usage: node tools/probe-page.mjs [baseUrl]
 */
const base = process.argv[2] || process.env.DSH_WEB_URL || 'http://127.0.0.1:63530'

const candidates = [
  '/',
  '/api/client/bundles',
  '/api/plugins',
  '/client.js',
  '/api/client/dsh-dexter',
]

async function tryFetch(path) {
  try {
    const response = await fetch(base + path)
    const text = await response.text()
    return { path, status: response.status, bytes: text.length, text }
  } catch (error) {
    return { path, status: 0, bytes: 0, text: '', error: error.message }
  }
}

const results = []
for (const path of candidates) results.push(await tryFetch(path))

for (const result of results) {
  const flag = result.status === 200 ? 'OK ' : '-- '
  console.log(`${flag}${String(result.status).padStart(3)} ${String(result.bytes).padStart(7)} B  ${result.path}${result.error ? `  (${result.error})` : ''}`)
  if (result.status === 200 && result.text.includes('dexter')) {
    const index = result.text.indexOf('dexter')
    console.log(`     mentions dexter: …${result.text.slice(Math.max(0, index - 80), index + 80).replace(/\s+/g, ' ')}…`)
  }
}

const shell = results[0]
if (shell.status === 200) {
  const mentions = ['__DSH_BOOT__', 'dexter', 'moduleLoader', 'script']
  console.log('\nshell mentions:')
  for (const needle of mentions) console.log(`  ${needle}: ${shell.text.includes(needle)}`)
  const scripts = [...shell.text.matchAll(/<script[^>]*src="([^"]+)"/g)].map((match) => match[1])
  console.log('scripts:', scripts.slice(0, 8).join(', ') || '(none)')
}
