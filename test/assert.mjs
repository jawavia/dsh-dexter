/** Minimal assertion helpers: one line per check, non-zero exit on failure. */

export function createReport(title) {
  const results = []
  return {
    ok(name, condition, detail = '') {
      results.push({ name, pass: Boolean(condition), detail })
      console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
      return Boolean(condition)
    },
    eq(name, actual, expected) {
      const pass = JSON.stringify(actual) === JSON.stringify(expected)
      return this.ok(name, pass, pass ? `${JSON.stringify(actual)}` : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    },
    le(name, actual, limit) {
      return this.ok(name, actual <= limit, `${actual} <= ${limit}`)
    },
    ge(name, actual, limit) {
      return this.ok(name, actual >= limit, `${actual} >= ${limit}`)
    },
    fail(name, detail = '') {
      return this.ok(name, false, detail)
    },
    finish() {
      const failed = results.filter((result) => !result.pass)
      console.log(`\n${title}: ${results.length - failed.length}/${results.length} passed`)
      if (failed.length > 0) {
        console.log(`FAILED: ${failed.map((result) => result.name).join(', ')}`)
        process.exitCode = 1
      }
      return failed.length === 0
    },
  }
}
