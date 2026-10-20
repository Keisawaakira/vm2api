import assert from 'node:assert/strict'
import vm from 'node:vm'
import { sealClaudeCodeCch } from '../../src/lib/identity/cch.mjs'
import { classifier } from './fixed-lifecycle-controls.mjs'

const plain = (value) => JSON.parse(JSON.stringify(value))
const esm = (init) => {
  let initialized = false
  return () => {
    if (!initialized) {
      initialized = true
      init()
    }
  }
}

/** Execute actual recorded CCH/config/fetch, without a network or credential. */
export function runtimeControlContext(runtime) {
  const requests = []
  const context = vm.createContext({
    JSON,
    TextEncoder,
    TextDecoder,
    Headers,
    Request,
    Error,
    Uint8Array,
    __esm: esm,
    process: { env: {} },
    config: {},
    configError: false,
    getAPIProvider: () => 'firstParty',
    isFirstPartyAnthropicBaseUrl: () => true,
    getUserAgent: () => 'fixture-UA',
    applyOfficialOutboundHeaders(headers) {
      headers.set('user-agent', 'fixture-UA')
    },
    randomUUID2: () => 'fixture-client-id',
    getWorkload: () => 'fixture-workload',
    getWorkload2: () => 'fixture-workload',
    officialCliVersion: () => 'fixture-version',
    isAttributionHeaderEnabled: () => true,
    logForDebugging() {},
    logForDebugging2() {},
    isEnvTruthy: (value) => value === '1',
    clearCompactWarningSuppression() {},
    maybeTimeBasedMicrocompact: () => null,
    getMainLoopModel: () => 'claude-opus-4-6',
    isMainThreadSource: (value) => !value || value.startsWith('repl_main_thread'),
    getCachedMCModule() {
      throw new Error('The pinned payload must not invent a cached-MC implementation')
    },
    CACHED_MICROCOMPACT_UNAVAILABLE:
      'cached_microcompact_unavailable: enabled in kernel.json, but this CLI build has no cache-editing implementation',
    shouldUseGlobalCacheScope: () => false,
    useToolSearch: false,
    filteredTools: [],
    deferredToolNames: new Set(),
    isMcpInstructionsDeltaEnabled: () => false,
    officialH2Fetch: () =>
      function (input, init) {
        requests.push({ input, init, receiver: this })
        return Promise.resolve({ fixture: true })
      },
    CLIENT_REQUEST_ID_HEADER: 'x-client-request-id',
  })
  const readConfig = () => {
    if (context.configError) throw new Error('fixture missing config')
    return JSON.stringify(context.config)
  }
  context.readFileSync7 = readConfig
  context.readFileSync8 = readConfig
  context.readFileSync12 = readConfig
  vm.runInContext(runtime.cch + '\ninit_cch()', context)
  for (const code of new Set([runtime.cache_config, runtime.config].filter(Boolean))) {
    vm.runInContext(
      code.replace(/^import\s*\{\s*readFileSync\s+as\s+\w+\s*\}\s*from\s*["']fs["'];?\s*$/gm, ''),
      context,
    )
  }
  vm.runInContext('init_cacheTtl()', context)
  vm.runInContext((runtime.attribution_helpers || '') + '\n' + runtime.attribution + '\n' + runtime.fetch, context)
  return { context, requests }
}

/** Controls are bound to executable source, not the manifest's prose claims. */
export async function verifyRuntimeSource(sem, kind) {
  const runtime = sem.runtime_wire
  assert.equal(runtime.contract, 'system_cch_runtime_v1')
  const { context: ctx, requests } = runtimeControlContext(runtime)
  let checks = 1
  const billing = 'x-anthropic-billing-header: cc_version=fixture; cc_entrypoint=sdk-cli; cch=00000;'
  const cases = [
    {
      model: 'claude-opus-4-6',
      max_tokens: 128000,
      system: [{ type: 'text', text: billing }],
      messages: [{ role: 'user', content: '中文🙂' }],
    },
    {
      model: 'claude-opus-4-6',
      messages: [{ role: 'user', content: 'x-anthropic-billing-header: literal; cch=abcde;' }],
      system: [{ type: 'text', text: billing }],
      max_tokens: 128000,
      fallbacks: ['claude-sonnet-4-6'],
      fallback_credit_token: 'fixture-credit',
    },
    {
      model: 'claude-opus-5-5',
      messages: [{ role: 'user', content: 'literal cch=00000; and cch=abcde; remain data' }],
      system: [
        { type: 'text', text: billing },
        { type: 'text', text: '# Environment\nKEEP\nformat <content>', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: '' },
      ],
      max_tokens: 128000,
      thinking: { type: 'enabled', budget_tokens: 60000, display: 'summarized' },
    },
    { model: 'claude-opus-4-6', system: 'ordinary caller rule', messages: [{ role: 'user', content: billing }] },
  ]
  for (const body of cases) {
    const frozen = JSON.stringify(body)
    for (const indentation of [undefined, 2]) {
      const raw = JSON.stringify(body, null, indentation)
      const expected = body.system === 'ordinary caller rule' ? raw : JSON.stringify(sealClaudeCodeCch(body))
      assert.equal(ctx.stampCchBody(raw, true), expected, `${kind}: CCH is canonical and system-only`)
      checks++
      assert.equal(ctx.stampCchBody(raw, false), raw, `${kind}: disabled CCH leaves input bytes alone`)
      checks++
      assert.deepEqual(JSON.parse(ctx.stampCchBody(raw, true)).messages, body.messages)
      checks++
      assert.equal(JSON.stringify(body), frozen)
      checks++
    }
  }
  for (const [config, cch, cached] of [
    [{ cch_enabled: false, cached_microcompact_enabled: true }, false, true],
    [{ cch_enabled: 'bad', cached_microcompact_enabled: null }, false, true],
    [{ cch_enabled: true, cached_microcompact_enabled: false }, true, false],
    [{}, true, false],
  ]) {
    ctx.config = config
    assert.equal(ctx.readPanelCchEnabled(), cch)
    checks++
    assert.equal(ctx.readPanelCachedMicrocompactEnabled(), cached)
    checks++
  }
  ctx.config = { cch_enabled: false, cached_microcompact_enabled: true }
  assert.equal(ctx.readPanelCchEnabled(), false)
  assert.equal(ctx.readPanelCachedMicrocompactEnabled(), true)
  ctx.configError = true
  assert.equal(ctx.readPanelCchEnabled(), false)
  assert.equal(ctx.readPanelCachedMicrocompactEnabled(), true)
  checks += 4
  ctx.configError = false
  const dispatcher = { fixture: 'original dispatcher' }
  const fetchReference = runtimeControlContext({ ...runtime, fetch: runtime.reference_fetch })
  for (const enabled of [true, false]) {
    ctx.config = { cch_enabled: enabled }
    fetchReference.context.config = { cch_enabled: enabled }
    const raw = JSON.stringify(cases[0])
    for (const bytes of [false, true]) {
      const headers = new Headers({ 'content-length': '123', 'x-custom': 'keep' })
      const init = { method: 'POST', headers, body: bytes ? new TextEncoder().encode(raw) : raw, dispatcher }
      const response = ctx
        .buildFetch(undefined, 'fixture-source')
        .call(dispatcher, 'https://fixture.invalid/v1/messages', init)
      const sent = requests.at(-1)
      await fetchReference.context
        .buildFetch(undefined, 'fixture-source')
        .call(dispatcher, 'https://fixture.invalid/v1/messages', init)
      const referenceSent = fetchReference.requests.at(-1)
      assert.equal(sent.input, 'https://fixture.invalid/v1/messages')
      assert.equal(sent.init.dispatcher, dispatcher)
      assert.equal(sent.receiver, referenceSent.receiver, 'Preserve the actual upstream fetch call convention')
      assert.equal(sent.init.headers.get('content-length'), enabled ? null : '123')
      assert.equal(headers.get('content-length'), '123')
      assert.equal(sent.init.headers.get('x-custom'), 'keep')
      const expected = enabled ? JSON.stringify(sealClaudeCodeCch(cases[0])) : raw
      assert.equal(
        typeof sent.init.body === 'string' ? sent.init.body : new TextDecoder().decode(sent.init.body),
        expected,
      )
      assert.deepEqual(await response, { fixture: true })
      checks += 8
    }
  }
  const reference = runtimeControlContext({ ...runtime, attribution: runtime.reference_attribution })
  for (const opts of [
    {},
    { includeCch: false, includeSubscriberFields: false, isSubagent: true, promptIndex: 0, turnIndex: 1 },
    {
      prevReqId: 'req_fixture',
      promptId: '11111111-2222-4333-8444-555555555555',
      turnOrigin: 'sdk',
      promptIndex: 0,
      turnIndex: 1,
    },
    { prevReqId: 'bad', promptId: 'bad', turnOrigin: 'INVALID', promptIndex: -1, turnIndex: 0 },
    { promptIndex: 10000001, turnIndex: 10000001 },
  ]) {
    assert.equal(
      ctx.getAttributionHeader('fixture-fingerprint', opts),
      reference.context.getAttributionHeader('fixture-fingerprint', opts),
    )
    checks++
  }
  vm.runInContext('var cachedMicrocompactRuntime;\n' + runtime.reference_compact_runtime, ctx)
  assert.equal(await ctx.cachedMicrocompactRuntime.implementation('claude-opus-4-6'), null)
  checks++
  vm.runInContext(runtime.compact, ctx)
  ctx.config = { cached_microcompact_enabled: false }
  const messages = [{ type: 'user', message: { content: [{ type: 'text', text: 'unchanged' }] } }]
  assert.equal(
    (await ctx.microcompactMessages(messages, { options: { mainLoopModel: 'claude-opus-4-6' } }, 'repl_main_thread'))
      .messages,
    messages,
  )
  checks++
  ctx.options2 = { model: 'claude-opus-4-6' }
  vm.runInContext(
    'async function gate(){' + runtime.compact_gate + '\nreturn {cachedMCEnabled,cacheEditingBetaHeader}}',
    ctx,
  )
  assert.deepEqual(plain(await ctx.gate()), { cachedMCEnabled: false, cacheEditingBetaHeader: '' })
  checks++
  ctx.config = { cached_microcompact_enabled: true }
  await assert.rejects(
    ctx.microcompactMessages(messages, { options: { mainLoopModel: 'claude-opus-4-6' } }, 'repl_main_thread'),
    /cached_microcompact_unavailable:/,
  )
  checks++
  await assert.rejects(ctx.gate(), /cached_microcompact_unavailable:/)
  checks++
  const failure = classifier(sem.lifecycle.native)(new Error(ctx.CACHED_MICROCOMPACT_UNAVAILABLE))
  assert.deepEqual(failure, {
    error: ctx.CACHED_MICROCOMPACT_UNAVAILABLE,
    code: 'cached_microcompact_unavailable',
    status: 400,
    error_type: 'invalid_request_error',
  })
  checks++
  return {
    ok: true,
    kind,
    checks,
    scope:
      'actual CCH/config/fetch/attribution/unsupported-mode source; external I/O boundaries substituted, no provider or full Linux CLI',
  }
}
