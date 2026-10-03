// Exact selector body recovered from cc-fixed-v155-r3 SHA256 0e9744c49ce5...
// Only __require is supplied here; the Agent, dispatcher and fetch choice stay intact.
import { createRequire } from 'node:module'
const __require = createRequire(import.meta.url)
let h2Fetch
export function officialH2Fetch() {
  if (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ANTHROPIC_UNIX_SOCKET
  ) {
    return
  }
  if (h2Fetch) return h2Fetch
  try {
    const undici = __require('undici')
    const agent = new undici.Agent({ allowH2: true })
    h2Fetch = (input, init) =>
      undici.fetch(input, {
        ...init,
        dispatcher: agent,
      })
    return h2Fetch
  } catch {
    return
  }
}
