import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { fixedDataplaneSpec } from '../../src/lib/vm/wrap-fixed.mjs'

const root = process.env.FIXED_CACHE_SEMANTICS || fileURLToPath(new URL('../../share', import.meta.url))
const load = (kind) =>
  JSON.parse(fs.readFileSync(path.join(root, fixedDataplaneSpec(`${kind}-fixed`).directory, 'semantics.json'), 'utf8'))
const plain = (value) => JSON.parse(JSON.stringify(value))
const systems = [
  [],
  [''],
  ['  ', '\n'],
  ['first', 'second'],
  ['# Environment\nDO NOT DROP', 'You are Claude Code', 'final format'],
  ['x-anthropic-billing-header: caller-owned', "You are a Claude agent, built on Anthropic's Claude Agent SDK."],
  ['persistent Kin is documentation', 'mcp__kin_runtime__ is data', ' Notes: keep spaces '],
  ['中文🙂\n'.repeat(17000), 'last caller block'],
]

function context() {
  return vm.createContext({
    __esm: (fn) => fn,
    process: { env: {} },
    randomUUID5: () => 'fixed-prompt-id',
    readFileSync8: () => '{"default_cache_ttl":"1h"}',
    readFileSync12: () => '{"default_cache_ttl":"1h"}',
  })
}
function loadCache(code) {
  const ctx = context()
  vm.runInContext(code, ctx)
  return (params, ttl, method) => {
    ctx.params = structuredClone(params)
    ctx.target = ttl
    vm.runInContext(`${method}(params, target)`, ctx)
    return plain(ctx.params)
  }
}
async function runPrefix(code, snapshot, { layout = 'zero', kin = true } = {}) {
  const ctx = context()
  Object.assign(ctx, {
    options2: { querySource: kin ? 'agent:kin' : 'sdk', model: 'claude-opus-4-6', __vm2apiSys: snapshot.slice() },
    systemPrompt: snapshot.slice(),
    fingerprint: {},
    gates: {},
    billingIndexes: {},
    previousRequestId: null,
    promptId: 'fixed-prompt',
    advisorModel: null,
    injectChromeHere: false,
    needsToolBasedCacheMarker: false,
    getSystemLayout: () => layout,
    isKinQuerySource: (s) => s === 'agent:kin',
    asSystemPrompt: (s) => s,
    billingFromSystemPrompt: () => undefined,
    getAttributionHeader: () => 'generated-billing',
    resolveTurnOrigin: () => 'sdk',
    layoutSystemBlocks: ({ attribution, leftover }) => [attribution, 'generated-env', ...(leftover ? [leftover] : [])],
    leftoverFromSystemPrompt: (s) => s.filter((t) => !t.startsWith('# Environment')).join('\n\n'),
    enhanceSystemPromptWithEnvDetails: async (s) => s,
    getCLISyspromptPrefix: () => 'generated-stock',
    logAPIPrefix: () => {},
    getPromptCachingEnabled: () => true,
    buildSystemPromptBlocks: (s) =>
      s.map((text, i) => ({
        type: 'text',
        text,
        ...(i === s.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
      })),
  })
  return plain(await vm.runInContext(`(async()=>{${code};return system})()`, ctx))
}

for (const kind of ['wrap', 'cc']) {
  const semantics = load(kind)
  for (const [index, caller] of systems.entries()) {
    for (const layout of ['zero', 'identity']) {
      test(`${kind} ${layout} preserves caller blocks case ${index}`, async () => {
        const out = await runPrefix(semantics.system, caller, { layout })
        assert.deepEqual(
          out.slice(0, 2).map((b) => b.text),
          ['generated-billing', 'generated-env'],
        )
        assert.deepEqual(
          out.slice(2).map((b) => b.text),
          caller,
        )
        assert.equal(out.length, caller.length + 2)
        assert.deepEqual(
          out.filter((b) => b.cache_control).map((b) => b.text),
          [caller.length ? caller.at(-1) : 'generated-env'],
        )
      })
    }
  }
  for (const layout of ['zero', 'identity', 'stock']) {
    test(`${kind} non-kin ${layout} keeps native prefix behavior`, async () => {
      assert.deepEqual(
        await runPrefix(semantics.system, ['first', 'second'], { layout, kin: false }),
        await runPrefix(semantics.system_before, ['first', 'second'], { layout, kin: false }),
      )
    })
  }
  for (const thinking of [
    { type: 'enabled', budget_tokens: 8192 },
    { type: 'adaptive', display: 'summarized' },
    { type: 'disabled' },
  ]) {
    test(`${kind} bridge snapshots caller and preserves ${thinking.type}`, async () => {
      const captured = []
      const ctx = context()
      Object.assign(ctx, {
        asSystemPrompt: (s) => s,
        getEmptyToolPermissionContext: () => ({}),
        queryModelWithStreaming: async function* (input) {
          captured.push(input)
          yield { type: 'control' }
        },
      })
      vm.runInContext(semantics.query, ctx)
      const caller = ['  # Environment\nowned', '', '文🙂']
      ctx.input = {
        messages: [],
        system: caller,
        toolSchemas: [],
        thinking,
        model: 'claude-opus-4-6',
        maxTokens: 12800,
        wireMessages: [{ role: 'user', content: [{ type: 'text', text: 'question' }] }],
        outputConfig: { effort: 'max' },
      }
      for await (const _ of vm.runInContext('queryKinMessagesWithStreaming(input)', ctx)) {
      }
      const options = captured[0].options
      assert.deepEqual(plain(options.__vm2apiSys), caller)
      assert.notEqual(options.__vm2apiSys, caller)
      assert.deepEqual(plain(captured[0].thinkingConfig), thinking)
      assert.equal(options.honorCallerThinking, true)
      assert.equal(options.maxOutputTokensOverride, 12800)
      assert.deepEqual(plain(options.wireMessages), ctx.input.wireMessages)
      assert.equal(options.effortValue, 'max')
    })
  }
  test(`${kind} stock native prefix remains unchanged`, async () => {
    assert.deepEqual(
      await runPrefix(semantics.system, ['first', 'second'], { layout: 'stock' }),
      await runPrefix(semantics.system_before, ['first', 'second'], { layout: 'stock' }),
    )
  })
  test(`${kind} bridge changes only the private caller snapshot`, async () => {
    async function capture(code) {
      const ctx = context()
      let captured
      Object.assign(ctx, {
        asSystemPrompt: (s) => s,
        getEmptyToolPermissionContext: () => ({}),
        queryModelWithStreaming: async function* (input) {
          captured = input
          yield { type: 'control' }
        },
      })
      vm.runInContext(code, ctx)
      ctx.input = {
        messages: [{ type: 'user', message: { content: 'native' } }],
        system: ['caller'],
        thinking: { type: 'enabled', budget_tokens: 8192 },
        toolSchemas: [{ name: 'tool' }],
        toolChoice: { type: 'auto' },
        model: 'claude-opus-4-6',
        maxTokens: 128000,
        temperature: 0.7,
        topP: 0.8,
        topK: 7,
        stopSequences: ['STOP'],
        wireMessages: [{ role: 'user', content: [{ type: 'text', text: 'wire' }] }],
        outputConfig: { effort: 'max' },
        contextManagement: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] },
      }
      for await (const _ of vm.runInContext('queryKinMessagesWithStreaming(input)', ctx)) {
      }
      const clean = plain(captured)
      delete clean.options.__vm2apiSys
      return clean
    }
    assert.deepEqual(
      await capture(semantics.query),
      await capture(semantics.kernel_wire ? semantics.lifecycle.query_before : semantics.query_before),
    )
  })
  if (kind === 'cc')
    test('CC beta module keeps its original constants and merge behavior', () => {
      function read(code) {
        const ctx = context()
        vm.runInContext(code, ctx)
        return plain(
          vm.runInContext(
            'init_officialBetas();[KIN_OFFICIAL_MESSAGE_BETAS,KIN_OFFICIAL_EXTRA_BETAS,mergeOfficialExtraBetas(["test-beta","oauth-2025-04-20"])]',
            ctx,
          ),
        )
      }
      assert.deepEqual(read(semantics.cache), read(semantics.cache_before))
    })
  const apply = loadCache(semantics.cache)
  const oracle = loadCache(semantics.upstream_cache)
  for (const ttl of ['5m', '1h']) {
    test(`${kind} cache policy ${ttl} matches upstream for structured edge cases`, () => {
      for (let n = 0; n < 100; n++) {
        const control =
          n % 5 === 0
            ? { type: 'invalid', ttl: 'bad' }
            : {
                type: 'ephemeral',
                ...(n % 3 ? { ttl: n % 2 ? '5m' : '1h' } : {}),
                ...(n % 7 === 0 ? { scope: 'global', extra: 'drop' } : {}),
              }
        const mark = (i) => (i % 3 ? { cache_control: structuredClone(control) } : {})
        const params = {
          system: Array.from({ length: n % 6 }, (_, i) => ({ type: 'text', text: `system-${i}`, ...mark(i) })),
          tools: Array.from({ length: n % 4 }, (_, i) => ({
            name: `t${i}`,
            type: i % 2 ? 'function' : 'custom',
            ...(n % 4 === 0 ? { defer_loading: true } : {}),
            ...mark(i),
          })),
          messages: Array.from({ length: n % 8 }, (_, i) => ({
            role: i % 2 ? 'assistant' : 'user',
            content: [
              { type: 'text', text: `m${i}`, ...mark(i) },
              ...(i % 2
                ? [
                    {
                      type: n % 2 ? 'thinking' : 'redacted_thinking',
                      thinking: 'hidden',
                      cache_control: { type: 'ephemeral', ttl },
                    },
                  ]
                : []),
            ],
          })),
        }
        if (n % 11 === 0) params.tools.push({ type: 'web_search_20250305', name: 'web', ...mark(1) })
        assert.deepEqual(
          apply(params, ttl, semantics.cache_method),
          oracle(params, ttl, 'applyKinOwnedCacheMarkers'),
          `case ${n}`,
        )
      }
    })
    test(`${kind} native TTL ${ttl} follows explicit request anchors`, () => {
      const ctx = context()
      vm.runInContext(semantics.cache, ctx)
      ctx.input = {
        system: [{ type: 'text', text: 'system' }],
        tools: [],
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'last', cache_control: { type: 'ephemeral', ttl } }] },
        ],
        panelTtl: ttl === '5m' ? '1h' : '5m',
      }
      assert.equal(vm.runInContext('resolveKinCacheTtl(input)', ctx), ttl)
    })
    test(`${kind} cache normalization preserves final caller blocks and messages ${ttl}`, async () => {
      const caller = ['# Environment\nowned', '', 'last']
      const system = await runPrefix(semantics.system, caller)
      const messages = [
        { role: 'user', content: [{ type: 'text', text: 'prefix', cache_control: { type: 'ephemeral', ttl } }] },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'kept', signature: 'sig' }] },
        { role: 'user', content: [{ type: 'text', text: 'tail', cache_control: { type: 'ephemeral', ttl } }] },
      ]
      const out = apply(
        { system, tools: [{ name: 'tool', input_schema: { type: 'object' } }], messages },
        ttl,
        semantics.cache_method,
      )
      assert.deepEqual(
        out.system.slice(2).map((b) => b.text),
        caller,
      )
      assert.deepEqual(out.messages, messages)
      assert.doesNotMatch(JSON.stringify(out), /__vm2apiSys/)
      assert.equal(out.system.at(-1).cache_control.ttl, ttl)
    })
  }
}
