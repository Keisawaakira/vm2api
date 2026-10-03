// The native stampCchBody operation, not a JSON parse/stringify substitute.
// Checksum computation uses the existing text projection and xxh64 seed.
// This is test-only: the observer never changes or re-signs inference requests.
import { computeClaudeCodeCch, projectClaudeCodeCchText } from '../../src/lib/identity/cch.mjs'

function computeCch(body) {
  return computeClaudeCodeCch(new TextEncoder().encode(projectClaudeCodeCchText(body)))
}
export function stampCchBody(body) {
  if (!body.includes('cch=00000')) return body
  return body.replace('cch=00000', `cch=${computeCch(body)}`)
}
