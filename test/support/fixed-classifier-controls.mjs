import assert from 'node:assert/strict'
import vm from 'node:vm'
import { lifecycleContext, verifyLifecycleSource, nativeWireType } from './fixed-lifecycle-controls.mjs'

const plain = (value) => JSON.parse(JSON.stringify(value))
const tick = () => new Promise((resolve) => setImmediate(resolve))
const contextXml = { purpose: 'auto_mode_classifier', format: 'xml', stage: 'xml_s1' }
const request = () => ({
  model: 'claude-sonnet-4-6',
  max_tokens: 64,
  thinking: { type: 'disabled' },
  temperature: 0,
  system: [
    { type: 'text', text: '<block>yes</block> <block>no</block>', cache_control: { type: 'ephemeral', ttl: '1h' } },
  ],
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: '<transcript>\nRead {}\n</transcript>', cache_control: { type: 'ephemeral', ttl: '5m' } },
      ],
    },
  ],
  stop_sequences: ['</block>'],
})

export async function classifierDispatchControl(code) {
  const calls = []
  const sdk = async function* (args) {
    calls.push(args)
    yield {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: { id: 'fixture', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 1 } },
      },
    }
    yield {
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '<block>no' } },
    }
    yield {
      type: 'stream_event',
      event: { type: 'message_delta', delta: { stop_reason: 'stop_sequence', stop_sequence: '</block>' } },
    }
    yield { type: 'stream_event', event: { type: 'message_stop' } }
  }
  const input = request()
  const { context, frames } = lifecycleContext(code, {
    sdk,
    globals: { structuredClone },
    lines: [
      {
        type: 'kin_job_start',
        slot_id: 's00',
        job_id: 'invalid',
        request: input,
        request_context: { ...contextXml, extra: true },
      },
      { type: 'kin_job_start', slot_id: 's00', job_id: 'classifier', request: input, request_context: contextXml },
      {
        type: 'kin_job_start',
        slot_id: 's01',
        job_id: 'ordinary',
        request: { ...input, max_tokens: 128000, thinking: { type: 'enabled', budget_tokens: 60000 } },
      },
    ],
  })
  await context.runNativeMessagesLoop({ options: {} })
  for (let n = 0; n < 12; n++) await tick()
  await context.writeChain2
  return {
    input,
    calls: calls.map((x) =>
      plain({
        requestContext: x.requestContext,
        wireSystem: x.wireSystem,
        wireThinking: x.wireThinking,
        system: x.system,
        thinking: x.thinking,
        maxTokens: x.maxTokens,
        wireMessages: x.wireMessages,
        stopSequences: x.stopSequences,
      }),
    ),
    frames: plain(frames),
  }
}

export async function systemControl(
  code,
  helpers,
  { mode = 'zero', query = 'agent:kin', classifier = false, withBilling = false } = {},
) {
  const caller = ['', '  ', '# Environment\nKEEP_CALLER', '中文 <content>required</content>']
  const wire = [
    { type: 'text', text: '<block>yes</block>' },
    { type: 'text', text: ' ', cache_control: { type: 'ephemeral', ttl: '5m' } },
  ]
  const calls = []
  const env = {
    structuredClone,
    Array,
    Object,
    JSON,
    systemPrompt: caller.slice(),
    options2: {
      querySource: query,
      model: 'fixture',
      __vm2apiSys: query === 'sdk' ? undefined : caller.slice(),
      ...(classifier ? { requestContext: contextXml, wireSystem: wire } : {}),
    },
    getSystemLayout: () => mode,
    isKinQuerySource: (s) => ['agent:kin', 'kin_native_messages'].includes(s),
    asSystemPrompt: (x) => x,
    layoutSystemBlocks: (x) => [x.attribution, ...(x.leftover ? [x.leftover] : [])],
    enhanceSystemPromptWithEnvDetails: async (x) => [...x, 'CC native environment'],
    billingFromSystemPrompt: () => (withBilling ? 'EXISTING BILLING' : ''),
    leftoverFromSystemPrompt: () => 'legacy leftover',
    fingerprint: {},
    gates: { version: 'fixture' },
    billingIndexes: {},
    previousRequestId: 'previous',
    promptId: 'prompt',
    resolveTurnOrigin: (q) => q,
    getAttributionHeader: (_fp, opts) => {
      calls.push(plain(opts))
      return 'BILLING ' + JSON.stringify(opts)
    },
    getCLISyspromptPrefix: () => 'stock framework',
    advisorModel: false,
    injectChromeHere: false,
    logAPIPrefix() {},
    getPromptCachingEnabled: () => true,
    needsToolBasedCacheMarker: false,
    buildSystemPromptBlocks: (texts) =>
      texts.map((text, index) => ({
        type: 'text',
        text,
        ...(index === texts.length - 1 ? { cache_control: { type: 'ephemeral', ttl: '1h' } } : {}),
      })),
  }
  const ctx = vm.createContext(env)
  vm.runInContext(helpers + '\nasync function run(){' + code + '\nreturn {system,systemPrompt};}', ctx, {
    timeout: 1000,
  })
  return { value: plain(await ctx.run()), calls, caller, wire }
}

function apiControl(code, options = {}) {
  const counts = { cache: 0, effort: 0 }
  const ctx = vm.createContext({
    counts,
    __esm: (fn) => {
      let done = false
      return () => {
        if (!done) {
          done = true
          fn()
        }
      }
    },
    isAnthropicAuthEnabled: () => false,
    hasProfileScope: () => true,
    system: [],
    allTools: [],
    apiMessages: [],
    readPanelCacheTtl: () => '1h',
    explicitCacheTtl: () => '1h',
    resolveKinCacheTtl: () => '1h',
    fillMissingCacheTtl: () => {
      counts.cache++
    },
    applyKinOwnedCacheMarkers: () => {
      counts.cache++
    },
    extraBodyParams: { output_config: { effort: 'max' } },
    effort: 'low',
    configureEffortParams: (_effort, out) => {
      counts.effort++
      out.effort = 'native-default'
    },
    configureTaskBudgetParams() {},
    options2: {
      querySource: 'agent:kin',
      model: 'claude-opus-4-6',
      honorCallerThinking: true,
      wireThinking:
        options.config?.type === 'enabled'
          ? { type: 'enabled', budget_tokens: options.config.budgetTokens }
          : options.config || { type: 'disabled' },
      ...options,
    },
    thinkingConfig: options.config || { type: 'disabled' },
    maxOutputTokens2: 128000,
    process: { env: {} },
    isEnvTruthy: () => false,
    modelSupportsThinking: () => true,
    modelSupportsAdaptiveThinking: () => true,
    getMaxThinkingTokensForModel: () => 8192,
    getAPIContextManagement: () => ({ edits: ['existing-native'] }),
    hasThinking: false,
    betasParams: [],
    REDACT_THINKING_BETA_HEADER: 'redact',
    thinkingClearLatched: false,
    getPromptCachingEnabled: () => true,
    retryContext: { model: 'fixture' },
    isKinQuerySource: () => true,
    mergeOfficialExtraBetas: (x) => x,
    getMergedBetas: (_model, opts) => [opts.isAgenticQuery],
  })
  vm.runInContext(
    'function run(){' +
      code +
      '\nreturn {thinking:typeof thinking==="undefined"?null:thinking,management:typeof contextManagement==="undefined"?null:contextManagement,temperature:typeof temperature==="undefined"?null:temperature,agentic:typeof isAgenticQuery==="undefined"?null:isAgenticQuery,outputConfig:typeof outputConfig==="undefined"?null:outputConfig,counts};}',
    ctx,
    { timeout: 1000 },
  )
  return plain(ctx.run())
}

export async function verifyClassifierSource(sem, previous, kind) {
  // Bind only dependency source captured from the actual CLI, not a stub of a missing function.
  if (sem.api_helpers)
    sem = {
      ...sem,
      api_after: Object.fromEntries(
        Object.entries(sem.api_after).map(([name, text]) => [name, sem.api_helpers + '\n' + text]),
      ),
    }
  let checks = 0
  const lifecycle = {
    ...previous.lifecycle,
    query: sem.query,
    query_before: sem.query_before,
    native: sem.native,
    reference_native: sem.reference_native,
  }
  const oldChecks = await verifyLifecycleSource(lifecycle, kind)
  checks += oldChecks.checks
  const dispatch = await classifierDispatchControl(sem.native)
  assert.equal(dispatch.calls.length, 2)
  checks++
  const [classified, ordinary] = dispatch.calls
  assert.deepEqual(classified.requestContext, contextXml)
  checks++
  assert.deepEqual(classified.wireSystem, dispatch.input.system)
  checks++
  assert.deepEqual(classified.wireThinking, { type: 'disabled' })
  checks++
  assert.equal(classified.maxTokens, 64)
  checks++
  assert.deepEqual(classified.wireMessages, dispatch.input.messages)
  checks++
  assert.deepEqual(classified.stopSequences, ['</block>'])
  checks++
  assert.equal(ordinary.requestContext, undefined)
  checks++
  assert.deepEqual(ordinary.thinking, { type: 'enabled', budgetTokens: 60000 })
  checks++
  assert.ok(
    dispatch.frames.some(
      (f) =>
        f.type === nativeWireType(sem.native, 'job_error') &&
        f.job_id === 'invalid' &&
        f.code === 'invalid_request_context',
    ),
  )
  checks++
  assert.ok(
    dispatch.frames.some(
      (f) =>
        f.type === nativeWireType(sem.native, 'host_ready') && f.capabilities?.includes('classifier_request_context'),
    ),
  )
  checks++
  for (const mode of ['zero', 'identity', 'stock'])
    for (const query of ['agent:kin', 'kin_native_messages', 'sdk'])
      for (const withBilling of [true, false]) {
        const now = await systemControl(sem.system, sem.classifierHelpers, { mode, query, withBilling })
        const before = await systemControl(previous.system, '', { mode, query, withBilling })
        assert.deepEqual(now.value, before.value, `${kind} ordinary system ${mode}/${query}/${withBilling}`)
        assert.deepEqual(now.calls, before.calls)
        checks += 2
      }
  for (const mode of ['zero', 'identity', 'stock']) {
    const result = await systemControl(sem.system, sem.classifierHelpers, { mode, classifier: true })
    assert.deepEqual(result.value.system.slice(1), result.wire)
    assert.equal(result.value.system.length, result.wire.length + 1)
    checks += 2
  }
  for (const [type, config] of [
    ['disabled', { type: 'disabled' }],
    ['adaptive', { type: 'adaptive' }],
    ['enabled', { type: 'enabled', budgetTokens: 60000 }],
  ]) {
    const current = apiControl(sem.api_after.thinking, { config })
    if (sem.direct_wire_thinking && type === 'disabled') assert.deepEqual(current.thinking, { type: 'disabled' })
    else assert.deepEqual(current, apiControl(sem.api_before.thinking, { config }), kind + ' ordinary ' + type)
    checks++
  }
  const disabled = apiControl(sem.api_after.thinking, {
    requestContext: contextXml,
    wireThinking: { type: 'disabled' },
  })
  assert.deepEqual(disabled.thinking, { type: 'disabled' })
  checks++
  for (const type of ['agentic', 'management', 'temperature', 'effort', 'cache']) {
    assert.deepEqual(apiControl(sem.api_after[type]), apiControl(sem.api_before[type]))
    checks++
  }
  assert.equal(apiControl(sem.api_after.agentic, { requestContext: contextXml }).agentic, false)
  checks++
  assert.equal(apiControl(sem.api_after.management, { requestContext: contextXml }).management, null)
  checks++
  assert.equal(apiControl(sem.api_after.temperature, { requestContext: contextXml }).temperature, null)
  checks++
  assert.equal(
    apiControl(sem.api_after.temperature, { requestContext: contextXml, temperatureOverride: 0 }).temperature,
    0,
  )
  checks++
  const explicitEffort = apiControl(sem.api_after.effort, { requestContext: contextXml })
  assert.equal(explicitEffort.outputConfig.effort, 'max')
  checks++
  assert.equal(explicitEffort.counts.effort, 0)
  checks++
  assert.equal(apiControl(sem.api_after.cache, { requestContext: contextXml }).counts.cache, 0)
  checks++
  assert.equal(apiControl(sem.api_after.cache).counts.cache, 1)
  checks++
  return {
    ok: true,
    kind,
    checks,
    scope: 'actual patched source and native dispatcher; fake SDK/boundaries, not Linux ELF or cloud',
  }
}
