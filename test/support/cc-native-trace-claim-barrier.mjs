// Test-only scheduling barrier: preserve the real filesystem result while making
// both processes observe an absent claim before either can rename the ticket.
import fs from 'node:fs'
import path from 'node:path'

const root = process.env.VM2API_CC_TRACE_ROOT
const exists = fs.existsSync
let paused = false
fs.existsSync = function (file) {
  const result = exists.call(this, file)
  if (!paused && !result && typeof file === 'string' && path.dirname(file) === root && file.endsWith('.claimed')) {
    paused = true
    fs.writeFileSync(path.join(root, `barrier-${process.pid}.ready`), 'ready', { flag: 'wx' })
    const until = Date.now() + 8000
    const wait = new Int32Array(new SharedArrayBuffer(4))
    while (fs.readdirSync(root).filter((name) => /^barrier-\d+\.ready$/.test(name)).length < 2) {
      if (Date.now() > until) throw Error('simultaneous-claim barrier timed out')
      Atomics.wait(wait, 0, 0, 10)
    }
  }
  return result
}
await import('../../src/lib/transport/cc-native-trace-preload.mjs')
