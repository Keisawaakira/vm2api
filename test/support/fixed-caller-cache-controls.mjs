import assert from 'node:assert/strict'
import vm from 'node:vm'
import { requestWireApiControl, requestWireBridgeControl } from './fixed-request-wire-api.mjs'
import { lifecycleContext } from './fixed-lifecycle-controls.mjs'

const plain = (value) => JSON.parse(JSON.stringify(value))
const tick = () => new Promise((resolve) => setImmediate(resolve))
const systemTexts = (system) =>
  Array.isArray(system) ? system.map((block) => (typeof block === 'string' ? block : block.text)) : [system]

/** Actual API-prefix source, with only identity/environment/SDK boundaries substituted. */
export async function callerSystemControl(sem, body, { mode = 'zero', native = true, options = {} } = {}) {
  const texts = body.system == null ? [] : systemTexts(body.system)
  const context = vm.createContext({
    structuredClone,
    options2: {
      querySource: native ? 'agent:kin' : 'sdk',
      model: body.model,
      wireSystem: native ? body.system : undefined,
      wireBody: native ? body : undefined,
      __vm2apiSys: native ? texts.slice() : undefined,
      ...options,
    },
    systemPrompt: texts.slice(),
    // The real query normalizes history before this extracted system prefix.
    messagesForAPI: structuredClone(body.messages || []),
    fingerprint: {},
    gates: {},
    billingIndexes: {},
    previousRequestId: null,
    promptId: 'fixture-prompt',
    advisorModel: null,
    injectChromeHere: false,
    needsToolBasedCacheMarker: false,
    getSystemLayout: () => mode,
    isKinQuerySource: (value) => ['agent:kin', 'native_messages'].includes(value),
    asSystemPrompt: (value) => value,
    billingFromSystemPrompt: () => '',
    getAttributionHeader: () => 'GENERATED_BILLING',
    resolveTurnOrigin: () => 'sdk',
    layoutSystemBlocks: ({ attribution, leftover }) => [attribution, 'GENERATED_ENV', ...(leftover ? [leftover] : [])],
    leftoverFromSystemPrompt: (value) => value.filter((text) => !text.startsWith('# Environment')).join('\n\n'),
    enhanceSystemPromptWithEnvDetails: async (value) => value,
    getCLISyspromptPrefix: () => 'GENERATED_STOCK',
    logAPIPrefix() {},
    getPromptCachingEnabled: () => true,
    buildSystemPromptBlocks: (value) =>
      value.map((text, index) => ({
        type: 'text',
        text,
        ...(index === value.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
      })),
  })
  const helpers = sem.classifier.classifierHelpers + '\n' + (sem.caller_cache?.system_helpers || '')
  const source = sem.kernel_wire.system
  vm.runInContext(
    helpers +
      '\nasync function capture(){' +
      source +
      '\nreturn {system, kinWireSystem:typeof kinWireSystem!=="undefined"?kinWireSystem:typeof _wS!=="undefined"?_wS:null,kinCallerBlocks:typeof _cS!=="undefined"?_cS:null}}',
    context,
  )
  return plain(await context.capture())
}

function markers(body) {
  return [
    ...(body.tools || []).filter((block) => block?.cache_control),
    ...(body.system || []).filter((block) => block?.cache_control),
    ...(body.messages || []).flatMap((message) =>
      Array.isArray(message.content) ? message.content.filter((block) => block?.cache_control) : [],
    ),
  ]
}

export async function verifyCallerCacheSource(sem, kind) {
  let checks = 0
  const fixtures = [
    [],
    [
      { type: 'text', text: '' },
      { type: 'text', text: '  ' },
      { type: 'text', text: '# Environment\nKEEP' },
    ],
    [
      { type: 'text', text: 'one', cache_control: { type: 'ephemeral', ttl: '1h' } },
      { type: 'text', text: 'two', cache_control: { type: 'ephemeral' } },
    ],
    [
      { type: 'text', text: 'x-anthropic-billing-header: caller-owned' },
      { type: 'text', text: '# Environment\nKEEP', cache_control: { type: 'ephemeral', ttl: '1h' } },
      { type: 'text', text: '', cache_control: { type: 'ephemeral' } },
    ],
    Array.from({ length: 80 }, (_, index) => ({ type: 'text', text: `${index}: 中文🙂\n` })),
  ]
  for (const mode of ['zero', 'identity']) {
    for (const system of fixtures) {
      const body = {
        model: 'claude-opus-4-6',
        max_tokens: 128000,
        thinking: { type: 'enabled', budget_tokens: 60000, display: 'summarized' },
        output_config: { effort: 'max' },
        system: structuredClone(system),
        tools: [
          { name: 'CallerTool', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral', ttl: '1h' } },
        ],
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'signed history', signature: 'fixture-signature' },
              { type: 'text', text: 'history' },
            ],
          },
          {
            role: 'user',
            content: [{ type: 'text', text: 'question', cache_control: { type: 'ephemeral', ttl: '5m' } }],
          },
        ],
      }
      const before = JSON.stringify(body)
      const prefix = await callerSystemControl(sem, body, { mode })
      const caller = system.length ? prefix.system.slice(-system.length) : []
      assert.deepEqual(caller, system, `${kind}/${mode}: caller system must keep text, fields and marker presence`)
      checks++
      // Generated system markers must not insert a short TTL before caller 1h markers.
      assert.ok(markers({ system: prefix.system }).length === markers({ system }).length)
      checks++
      const bridge = await requestWireBridgeControl(sem.request_wire.query, {
        model: body.model,
        messages: [],
        system: systemTexts(body.system),
        wireSystem: body.system,
        wireBody: body,
        wireMessages: body.messages,
        wireThinking: body.thinking,
        thinking: { type: 'enabled', budgetTokens: 60000 },
        maxTokens: body.max_tokens,
        outputConfig: body.output_config,
        toolSchemas: body.tools,
      })
      const result = requestWireApiControl(sem, {
        body,
        options: bridge.options,
        cacheSource: sem.caller_cache?.cache_source || sem.request_wire.cache,
        constructedSystem: prefix.system,
        systemOwnership: prefix,
      }).result
      assert.deepEqual(result.system, prefix.system)
      assert.deepEqual(result.tools, body.tools)
      assert.deepEqual(result.messages, body.messages)
      checks += 3
      assert.deepEqual(result.thinking, body.thinking)
      assert.deepEqual(result.output_config, body.output_config)
      assert.equal(result.max_tokens, 128000)
      checks += 3
      assert.equal(JSON.stringify(body), before, 'Reference execution cannot mutate caller input')
      assert.ok(markers(result).length <= 4)
      checks += 2
    }
  }
  // Four caller markers exhaust capacity; native caching may not silently drop one.
  const four = {
    model: 'claude-opus-5-5',
    max_tokens: 128000,
    system: Array.from({ length: 4 }, (_, index) => ({
      type: 'text',
      text: `marker ${index}`,
      cache_control: { type: 'ephemeral', ...(index % 2 ? {} : { ttl: '1h' }) },
    })),
    messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }],
    tools: [],
  }
  const prefix = await callerSystemControl(sem, four)
  const result = requestWireApiControl(sem, {
    body: four,
    cacheSource: sem.caller_cache?.cache_source || sem.request_wire.cache,
    constructedSystem: prefix.system,
    systemOwnership: prefix,
  }).result
  assert.deepEqual(result.system.slice(-4), four.system)
  assert.equal(markers(result).length, 4)
  assert.deepEqual(result.tools, [])
  checks += 3

  // Actual native loop hands the wire object to the bridge, including missing TTL.
  let dispatched
  const native = lifecycleContext(sem.request_wire.native, {
    lines: [{ type: 'job_start', job_id: 'caller-cache', slot_id: 's00', request: four }],
    sdk: async function* (input) {
      dispatched = input
      yield { type: 'stream_event', event: { type: 'message_stop' } }
    },
  })
  await native.context.runNativeMessagesLoop({ options: {} })
  for (let index = 0; index < 12; index++) await tick()
  await native.context.writeChain2
  assert.deepEqual(plain(dispatched.wireSystem), four.system)
  assert.deepEqual(plain(dispatched.wireBody), four)
  checks += 2
  const bridged = await requestWireBridgeControl(sem.request_wire.query, dispatched)
  assert.deepEqual(plain(bridged.options.wireSystem), four.system)
  checks++

  if (sem.caller_cache) {
    // Differentials execute the donor's real cache functions, not a hand-written oracle.
    for (const ttl of ['5m', '1h']) {
      for (let index = 0; index < 80; index++) {
        const input = {
          system: Array.from({ length: index % 5 }, (_, number) => ({
            type: 'text',
            text: `s${number}`,
            cache_control: { type: 'ephemeral', ...(number % 2 ? {} : { ttl: '1h' }) },
          })),
          tools: Array.from({ length: index % 3 }, (_, number) => ({
            name: `t${number}`,
            input_schema: {},
            cache_control: { type: 'ephemeral', ttl: '5m' },
          })),
          messages: [{ role: 'user', content: [{ type: 'text', text: 'keep', cache_control: { type: 'ephemeral' } }] }],
        }
        const ownership = {
          preserveSystem: index % 2 === 0,
          preserveToolCount: index % 3,
          preserveMessages: index % 4 === 0,
        }
        const apply = (source) => {
          const ctx = vm.createContext({
            __esm: (fn) => fn,
            process: { env: {} },
            readFileSync8: () => '{}',
            readFileSync12: () => '{}',
            input: structuredClone(input),
            ttl,
            ownership,
          })
          const code = source.replace(/^import\s*\{\s*readFileSync\s+as\s+\w+\s*\}\s*from\s*["']fs["'];?\s*$/gm, '')
          vm.runInContext(code + '\napplyKinOwnedCacheMarkers(input,ttl,ownership)', ctx)
          return plain(ctx.input)
        }
        assert.deepEqual(
          apply(sem.caller_cache.cache_source),
          apply(sem.caller_cache.reference_cache),
          `${kind}: ownership oracle case ${index}`,
        )
        checks++
      }
    }
    for (const mode of ['zero', 'identity', 'stock']) {
      const body = {
        model: 'claude-opus-4-6',
        system: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' },
        ],
      }
      const previous = { ...sem, kernel_wire: { ...sem.kernel_wire, system: sem.caller_cache.previous_system } }
      assert.deepEqual(
        await callerSystemControl(sem, body, { native: false, mode }),
        await callerSystemControl(previous, body, { native: false, mode }),
      )
      checks++
    }
  }
  return {
    ok: true,
    kind,
    checks,
    scope:
      'actual native loop/bridge/system/API/cache with external SDK/config boundaries mocked; no Linux ELF/cloud certification',
  }
}
