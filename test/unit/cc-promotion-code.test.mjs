import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
const dir = process.env.CC_FIXED_DIR || fileURLToPath(new URL('../../share/cc-fixed/v155-r3/', import.meta.url))
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
const original = process.env.CC_PROMOTION_ORIGINAL === '1'
function context({
  mode = 'native',
  failInit = false,
  source = original ? 'candidate' : 'promoted',
  guard = false,
} = {}) {
  const trace = []
  const env = { ANTHROPIC_BASE_URL: guard ? 'http://127.0.0.1:1234' : 'https://provider.invalid' }
  if (mode === 'native') env.CLAUDE_CODE_KIN_NATIVE_SLOTS = '1'
  if (guard) env.VM2API_OFFLINE_CANDIDATE = 'native-v155-r3'
  const args = mode === 'version' ? ['--version'] : mode === 'crag' ? ['--single-process-subagents'] : []
  const ctx = vm.createContext({
    process: { env, argv: ['cli', 'entry', ...args] },
    console: { log: (x) => trace.push(['version', x]) },
    init_init2: () => trace.push(['init-module']),
    setIsInteractive: (x) => trace.push(['interactive', x]),
    init: async () => {
      trace.push(['init'])
      if (failInit) throw Error('fixture init rejected')
    },
    init_nativeMessagesRunner: () => trace.push(['native-module']),
    exports_nativeMessagesRunner: {
      runNativeMessagesLoop: async (options) => trace.push(['native', JSON.parse(JSON.stringify(options))]),
    },
    init_singleProcessSlots: () => trace.push(['crag-module']),
    exports_singleProcessSlots: { runSingleProcessSlots: async () => trace.push(['crag']) },
  })
  vm.runInContext(manifest.entry[source], ctx, { timeout: 1000 })
  return { ctx, trace, run: () => ctx.main2() }
}
test('promoted CC reports its original version without an offline marker', async () => {
  const c = context({ mode: 'version' })
  await c.run()
  assert.deepEqual(c.trace, [['version', '2.1.281 (Claude Code)']])
})
for (const mode of ['native', 'crag'])
  test(`promoted ${mode} entry keeps initialization before its loop`, async () => {
    const c = context({ mode })
    await c.run()
    assert.deepEqual(c.trace.slice(0, 3), [['init-module'], ['interactive', false], ['init']])
    assert.equal(c.trace[3][0], mode + '-module')
    assert.equal(c.trace[4][0], mode)
    assert.equal(c.ctx.process.env.USER_TYPE, 'external')
  })
test('failed initialization cannot enter a native loop', async () => {
  const c = context({ failInit: true })
  await assert.rejects(c.run(), /fixture init rejected/)
  assert.ok(!c.trace.some((x) => x[0] === 'native'))
})
test('accepted candidate control and promoted entry have the same initialized native behavior', async () => {
  const before = context({ source: 'candidate', guard: true }),
    after = context()
  await before.run()
  await after.run()
  assert.deepEqual(after.trace, before.trace)
})
test('promotion removes only the offline guard text from the recorded entry', () => {
  const { candidate, promoted, guard_bytes: count } = manifest.entry
  const prefix = 'async function main2(){'
  assert.equal(promoted.length, candidate.length)
  assert.equal(promoted.slice(0, prefix.length), prefix)
  assert.equal(promoted.slice(prefix.length, prefix.length + count), ' '.repeat(count))
  assert.equal(promoted.slice(prefix.length + count), candidate.slice(prefix.length + count))
  assert.ok(!promoted.includes('VM2API_OFFLINE_CANDIDATE'))
  assert.ok(promoted.includes('init_init2();setIsInteractive(!1);'))
})
