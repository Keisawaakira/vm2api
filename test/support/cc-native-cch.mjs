// The native stampCchBody operation, not a JSON parse/stringify substitute.
// Checksum computation uses the existing text projection and xxh64 seed.
// This is test-only: the observer never changes or re-signs inference requests.
import vm from 'node:vm'
import { computeClaudeCodeCch, projectClaudeCodeCchText } from '../../src/lib/identity/cch.mjs'

function computeCch(body) {
  return computeClaudeCodeCch(new TextEncoder().encode(projectClaudeCodeCchText(body)))
}
export function stampCchBody(body) {
  if (!body.includes('cch=00000')) return body
  return body.replace('cch=00000', `cch=${computeCch(body)}`)
}

// Execute the actual CCH module extracted from the selected fixed package.
// JSON references the preloaded observer's methods; no substitute seal is used.
export function stampFixedCchBody(body, enabled, source) {
  let initialized = false
  const stamp = vm.runInNewContext(source + '\ninit_cch(); stampCchBody', {
    JSON,
    TextEncoder,
    __esm: (initialize) => () => {
      if (!initialized) {
        initialized = true
        initialize()
      }
    },
  })
  return stamp(body, enabled)
}

// Current upstream operation: canonical serialization followed by the two
// observed billing-regexp callbacks. Keep the legacy discriminator above.
export function stampCanonicalCchBody(body, enabled = true) {
  const billingCch = /(x-anthropic-billing-header:[^"]*?\bcch=)[0-9a-f]{5}(?=;)/i
  if (!enabled || !billingCch.test(body)) return body
  let wireBody = body
  try {
    const compact = JSON.stringify(JSON.parse(body))
    if (typeof compact === 'string') wireBody = compact
  } catch {}
  const placeholder = wireBody.replace(billingCch, (_match, prefix) => `${prefix}00000`)
  return placeholder.replace(billingCch, (_match, prefix) => `${prefix}${computeCch(placeholder)}`)
}
