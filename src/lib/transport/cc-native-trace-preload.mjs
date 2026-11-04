import http2 from 'node:http2'
import { createRequire } from 'node:module'
import { installCCNativeTrace } from './cc-native-trace-hook.mjs'

if (process.env.VM2API_CC_TRACE_ROOT) {
  const installed = installCCNativeTrace()
  if (process.versions.bun) {
    try {
      // Bun names this live-export API mock.module. It replaces bindings only;
      // every observed call delegates to the original transport and response.
      const { mock } = await import('bun:test')
      try {
        const exports = { ...http2, default: http2 }
        mock.module('node:http2', () => exports)
        mock.module('http2', () => exports)
        installed.setHttp2Binding('bun_live_exports')
      } catch {
        installed.setHttp2Binding('unavailable')
      }
      try {
        // The fixed CC's officialH2Fetch uses require('undici').fetch with its
        // own Agent/dispatcher, not globalThis.fetch or node:http2.connect.
        const require = createRequire(import.meta.url)
        const original = require('undici')
        const fetch = installed.wrapFetch(original.fetch, 'undici')
        const exports = { ...original, fetch }
        mock.module('undici', () => exports)
        if (require('undici').fetch !== fetch) throw Error('undici_binding_not_replaced')
        installed.setUndiciBinding('bun_live_exports')
      } catch {
        installed.setUndiciBinding('unavailable')
      }
    } catch {
      installed.setHttp2Binding('unavailable')
      installed.setUndiciBinding('unavailable')
    }
  }
}
