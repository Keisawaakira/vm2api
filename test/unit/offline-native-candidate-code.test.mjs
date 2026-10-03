import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { CANDIDATE_ID, verifyUnchangedOutside } from '../../scripts/build-offline-native-candidates.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const patchFile =
  process.env.NATIVE_CANDIDATE_PATCHES || path.join(root, 'share/offline-candidates', CANDIDATE_ID, 'patches.json')
const patches = JSON.parse(fs.readFileSync(patchFile, 'utf8'))
const original = process.env.NATIVE_TEST_ORIGINAL === '1'
const source = (kind, id) => patches[kind].find((p) => p.id === id)[original ? 'before' : 'after']

async function captureQueryOptions(kind, blocks) {
  let seen
  const ctx = vm.createContext({
    asSystemPrompt: (x) => x,
    getEmptyToolPermissionContext: () => ({}),
    queryModelWithStreaming: async function* (input) {
      seen = input
      yield { type: 'probe' }
    },
  })
  vm.runInContext(source(kind, 'snapshot-caller-system'), ctx, { timeout: 1000 })
  const request = {
    system: blocks,
    messages: [{ role: 'user', content: 'test' }],
    toolSchemas: [],
    thinking: { type: 'adaptive', display: 'summarized' },
    maxTokens: 128000,
    model: 'claude-opus-4-6',
    outputConfig: { effort: 'max' },
    wireMessages: [{ role: 'user', content: 'exact' }],
  }
  for await (const _ of ctx.queryKinMessagesWithStreaming(request)) {
    /* actual isolated wrapper, stub downstream query */
  }
  return { seen, request }
}

async function apiSystem(
  kind,
  blocks,
  { layout = 'zero', native = true, cache = { type: 'ephemeral', ttl: '1h' } } = {},
) {
  const { seen } = await captureQueryOptions(kind, blocks)
  const options = { ...seen.options, querySource: native ? 'agent:kin' : 'repl_main_thread' }
  if (!native) delete options.__vm2apiSys
  const ctx = vm.createContext({
    input: blocks.slice(),
    options,
    options2: options,
    getSystemLayout: () => layout,
    isKinQuerySource: (x) => x === 'agent:kin',
    billingFromSystemPrompt: () => undefined,
    getAttributionHeader: () => 'x-anthropic-billing-header: test;',
    getCLISyspromptPrefix: () => 'FRAMEWORK_IDENTITY',
    resolveTurnOrigin: () => 'user',
    layoutSystemBlocks: ({ attribution, leftover }) => [attribution, 'FRAMEWORK_ENV', ...(leftover ? [leftover] : [])],
    leftoverFromSystemPrompt: (x) => x.join('\n'),
    enhanceSystemPromptWithEnvDetails: async (x) => [...x, 'FRAMEWORK_NOTES'],
    asSystemPrompt: (x) => x,
    logAPIPrefix() {},
    existsSync31: () => false,
    getBreakCacheMarkerPath: () => 'unused',
    getBreakCacheAlwaysPath: () => 'unused',
    getPromptCachingEnabled: () => !!cache,
    // Deliberately coalesces the framework side. Caller blocks must bypass this transformation.
    buildSystemPromptBlocks: (parts) => [
      { type: 'text', text: parts.join('\n'), ...(cache ? { cache_control: { ...cache } } : {}) },
    ],
  })
  const setup =
    kind === 'cli-node'
      ? 'let systemPrompt2=input;'
      : 'let systemPrompt=input; const fingerprint={},gates={},previousRequestId="p",promptId="id";'
  vm.runInContext(
    `async function build(){${setup}const advisorModel=undefined,injectChromeHere=false,needsToolBasedCacheMarker=false;${source(kind, 'preserve-caller-api-blocks')}return system;}`,
    ctx,
    { timeout: 1000 },
  )
  return JSON.parse(JSON.stringify(await ctx.build()))
}

const cases = [
  ['RULE_A', 'RULE_B'],
  ['', '  ', '# Environment\ncaller environment', 'You are Claude Code\ncaller rule', 'claude-desktop\nkeep this too'],
  Array.from({ length: 80 }, (_, i) => `block-${i} 中🙂\n  preserve spacing ${i}`),
]
for (const kind of ['cli-node', 'cc-node']) {
  test(`${kind} native query carries immutable caller blocks and original effort/token fields`, async () => {
    const blocks = ['one', 'two']
    const { seen, request } = await captureQueryOptions(kind, blocks)
    assert.deepEqual(Array.from(seen.options.__vm2apiSys || []), blocks)
    blocks[0] = 'mutated later'
    assert.equal(seen.options.__vm2apiSys[0], 'one')
    assert.equal(seen.options.maxOutputTokensOverride, 128000)
    assert.equal(seen.options.effortValue, 'max')
    assert.deepEqual(seen.options.outputConfigOverride, request.outputConfig)
    assert.deepEqual(seen.options.wireMessages, request.wireMessages)
  })
  for (const layout of ['zero', 'identity'])
    for (const [i, blocks] of cases.entries()) {
      test(`${kind} ${layout} preserves caller case${i} as independent final API blocks`, async () => {
        const system = await apiSystem(kind, blocks, { layout })
        assert.deepEqual(
          system.slice(-blocks.length).map((b) => b.text),
          blocks,
        )
        assert.equal(system.length, blocks.length + 1)
        assert.equal(system.filter((b) => b.cache_control).length, 1)
        assert.deepEqual(system.at(-1).cache_control, { type: 'ephemeral', ttl: '1h' })
        assert.equal(system[0].cache_control, undefined)
      })
    }
  test(`${kind} keeps disabled/global cache policy and does not invent caller blocks`, async () => {
    const absent = await apiSystem(kind, [], {})
    assert.equal(absent.length, 1)
    const none = await apiSystem(kind, ['A'], { cache: null })
    assert.equal(
      none.some((b) => b.cache_control),
      false,
    )
    const global = await apiSystem(kind, ['A'], { cache: { type: 'ephemeral', ttl: '5m', scope: 'global' } })
    assert.equal(global[0].cache_control.scope, 'global')
    assert.equal(global.at(-1).cache_control, undefined)
  })
  test(`${kind} non-native and stock paths do not duplicate protected blocks`, async () => {
    const nonnative = await apiSystem(kind, ['A', 'B'], { native: false })
    assert.equal(nonnative.length, 1)
    const stock = await apiSystem(kind, ['A', 'B'], { layout: 'stock' })
    assert.equal(stock.length, 1)
  })
  test(`${kind} candidate entry rejects missing marker or non-loopback destinations`, async () => {
    const id = kind === 'cli-node' ? 'offline-entry-guard' : 'offline-guard-and-cc-initialization'
    for (const env of [
      {},
      { VM2API_OFFLINE_CANDIDATE: CANDIDATE_ID, ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
      { VM2API_OFFLINE_CANDIDATE: CANDIDATE_ID, ANTHROPIC_BASE_URL: 'http://127.0.0.1.attacker:123' },
    ]) {
      const ctx = vm.createContext({
        process: { env, argv: ['bin', 'entry', '--version'] },
        console: {
          log() {
            throw Error('entry passed its guard')
          },
        },
      })
      vm.runInContext(source(kind, id), ctx, { timeout: 1000 })
      await assert.rejects(ctx.main2(), /candidate is offline-only/)
    }
  })
}
for (const mode of ['native', 'crag'])
  test(`CC ${mode} entry initializes before its loop`, async () => {
    const trace = []
    let ready = false
    const ctx = vm.createContext({
      process: {
        env: {
          VM2API_OFFLINE_CANDIDATE: CANDIDATE_ID,
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:1234',
          ...(mode === 'native' ? { CLAUDE_CODE_KIN_NATIVE_SLOTS: '1' } : {}),
        },
        argv: ['bin', 'entry', ...(mode === 'crag' ? ['--single-process-subagents'] : [])],
      },
      init_init2() {
        trace.push('init-module')
      },
      setIsInteractive(v) {
        trace.push(`interactive:${v}`)
      },
      init: async () => {
        trace.push('init')
        ready = true
      },
      init_nativeMessagesRunner() {},
      init_singleProcessSlots() {},
      exports_nativeMessagesRunner: {
        runNativeMessagesLoop: async () => {
          assert.equal(ready, true)
          trace.push('native')
        },
      },
      exports_singleProcessSlots: {
        runSingleProcessSlots: async () => {
          assert.equal(ready, true)
          trace.push('crag')
        },
      },
    })
    vm.runInContext(source('cc-node', 'offline-guard-and-cc-initialization'), ctx, { timeout: 1000 })
    await ctx.main2()
    assert.deepEqual(trace, ['init-module', 'interactive:false', 'init', mode])
  })
test('unchanged-range verification rejects edits outside declared source spans', () => {
  const before = Buffer.from('0123456789'),
    after = Buffer.from('012XX56789')
  verifyUnchangedOutside(before, after, [{ offset: 3, bytes: 2 }])
  assert.throws(
    () => verifyUnchangedOutside(before, Buffer.from('012XX56788'), [{ offset: 3, bytes: 2 }]),
    /Trailing bytes changed/,
  )
})
