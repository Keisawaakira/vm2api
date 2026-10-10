// Actual extracted native functions; SDK/network/stdio boundaries are neutral fixtures.
import vm from 'node:vm'
import { AsyncLocalStorage } from 'node:async_hooks'
import assert from 'node:assert/strict'
const tick = () => new Promise((resolve) => setImmediate(resolve))
const plain = (value) => JSON.parse(JSON.stringify(value))
export class FixtureAPIError extends Error {
  constructor(status = 503, message = 'fixture service error', error = { type: 'api_error', message }, headers = {}) {
    super(message)
    this.status = status
    this.error = error
    this.headers = headers
  }
}
export class FixtureConnectionError extends FixtureAPIError {
  constructor(message = 'fetch failed', cause = { code: 'ECONNRESET' }) {
    super(undefined, message)
    this.status = undefined
    this.cause = cause
  }
}
export class FixtureTimeoutError extends FixtureConnectionError {
  constructor(value = 'timed out') {
    super(typeof value === 'object' ? value.message : value, { code: 'ETIMEDOUT' })
  }
}
export class FixtureAbortError extends Error {}
export class FixtureCannotRetry extends Error {
  constructor(error, context) {
    super('cannot retry')
    this.originalError = error
    this.retryContext = context
  }
}
function sdkGlobals() {
  const no = () => {},
    never = () => false
  return {
    Error,
    Promise,
    Map,
    Set,
    Array,
    Object,
    JSON,
    Number,
    String,
    Boolean,
    Date,
    Math,
    RegExp,
    Headers,
    AbortController,
    AsyncLocalStorage,
    APIError: FixtureAPIError,
    APIConnectionError: FixtureConnectionError,
    APIConnectionTimeoutError: FixtureTimeoutError,
    APIUserAbortError: FixtureAbortError,
    CannotRetryError: FixtureCannotRetry,
    FallbackTriggeredError: class extends Error {},
    __esm: (fn) => {
      let done = false
      return () => {
        if (!done) {
          done = true
          fn()
        }
      }
    },
    __export: no,
    init_claude: no,
    init_jobSession: no,
    init_ids: no,
    init_messages3: no,
    init_staleConnection: no,
    init_systemLayout: no,
    init_sdk: no,
    isStaleConnectionError: (e) => !!e && e.code === 'ECONNRESET',
    isStaleConnectionError2: never,
    isStaleConnectionHay: (s) => /connection.reset/i.test(s),
    isKinQuerySource: (s) => s === 'agent:kin' || s === 'kin_native_messages',
    isFastModeEnabled: never,
    isFastModeCooldown: never,
    isPersistentRetryEnabled: never,
    is529Error: (e) => e?.status === 529,
    shouldRetry529: () => true,
    isOAuthTokenRevokedError: never,
    isBedrockAuthError: never,
    isVertexAuthError: never,
    isFastModeNotEnabledError: never,
    isClaudeAISubscriber: () => true,
    isNonCustomOpusModel: never,
    getMaxRetries: () => 2,
    errorMessage: (e) => e?.message || String(e),
    logForDebugging: no,
    logForDebugging2: no,
    logEvent: no,
    logError: no,
    logError2: no,
    isEnvTruthy: (value) => value === '1' || value === true,
    logForDiagnosticsNoPII: no,
    getFeatureValue_CACHED_MAY_BE_STALE: never,
    disableKeepAlive: no,
    resetOfficialH2Fetch: no,
    handleAwsCredentialError: never,
    handleGcpCredentialError: never,
    shouldRetry: () => true,
    parseMaxTokensContextOverflowError: () => null,
    getRetryAfter: () => null,
    getRetryDelay: () => 0,
    getAPIProviderForStatsig: () => 'fixture',
    createSystemAPIErrorMessage: () => ({ type: 'system', subtype: 'api_retry' }),
    sleep2: async () => {},
    abortError: () => new FixtureAbortError(),
    MAX_529_RETRIES: 3,
    FLOOR_OUTPUT_TOKENS: 1024,
    REPEATED_529_ERROR_MESSAGE: 'repeated overload',
    getClaudeAIOAuthTokens: () => null,
    setTimeout,
    clearTimeout,
    performance,
  }
}
export const nativeWireType = (code, name) => (/["']job_start["']/.test(code) ? name : 'kin_' + name)
export const comparableWireFrames = (frames) =>
  frames.map((frame) => ({
    ...frame,
    type: frame.type.replace(/^kin_/, ''),
    ...(frame.event ? { event: { ...frame.event, type: frame.event.type.replace(/^kin_/, '') } } : {}),
  }))

export function lifecycleContext(code, { lines = [], sdk, frames = [], globals = {} } = {}) {
  const context = vm.createContext({
    ...sdkGlobals(),
    ...globals,
    process: {
      env: {
        [nativeWireType(code, 'job_start') === 'job_start'
          ? 'CLAUDE_CODE_NATIVE_SLOTS'
          : 'CLAUDE_CODE_KIN_NATIVE_SLOTS']: '2',
        USER_TYPE: 'external',
      },
      stdin: {},
      stderr: { write() {} },
      stdout: {
        write(line, callback) {
          frames.push(JSON.parse(line))
          queueMicrotask(() => callback?.())
          return true
        },
        once() {},
      },
    },
    WRAP_OFFICIAL_CLI_VERSION: 'fixture',
    getSystemLayout: () => 'zero',
    getKinTimezone: () => 'UTC',
    createInterface: () => ({
      async *[Symbol.asyncIterator]() {
        for (const line of lines)
          yield typeof line === 'string'
            ? line
            : JSON.stringify({
                ...line,
                type: nativeWireType(code, line.type.replace(/^kin_/, '')),
              })
      },
    }),
    getJobSessionId: () => 'fixture-session',
    asSessionId: (x) => x,
    runWithJobSession: (_id, fn) => fn(),
    createUserMessage: (value) => ({ type: 'user', message: { role: 'user', ...value } }),
    createAssistantMessage: (value) => ({ type: 'assistant', message: { role: 'assistant', ...value } }),
    queryKinMessagesWithStreaming: sdk || async function* () {},
  })
  const matches = code.match(/import\s*\{\s*createInterface\s*\}\s*from\s*["']readline["'];?/g) || []
  assert.equal(matches.length, 1, 'exactly one stdin boundary is injected')
  vm.runInContext(code.replace(matches[0], ''), context, { timeout: 1500 })
  context.init_nativeMessagesRunner()
  return { context, frames }
}
export async function dispatcherControl(code) {
  let release
  const held = new Promise((resolve) => {
    release = resolve
  })
  const request = (model) => ({
    model,
    system: [
      { type: 'text', text: '' },
      { type: 'text', text: '# Environment\nKEEP' },
      { type: 'text', text: '中文 format' },
    ],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'neutral' }] }],
    max_tokens: 128000,
    thinking: { type: 'enabled', budget_tokens: 60000 },
  })
  const lines = [
    { type: 'kin_job_start', slot_id: 's00', job_id: 'held', request: request('held') },
    { type: 'kin_cancel', slot_id: 's00', job_id: 'held' },
    { type: 'kin_ping', nonce: 'ping-fixture' },
    { type: 'kin_job_start', slot_id: 's01', job_id: 'quick', request: request('quick') },
  ]
  const calls = []
  const sdk = async function* (args) {
    calls.push(args)
    if (args.model === 'held') {
      await held
      if (args.signal.aborted) throw new FixtureAbortError()
    }
    yield {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: { type: 'message', content: [], usage: { input_tokens: 7, output_tokens: 0 } },
      },
    }
    yield {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '完整中文🙂 <content>fixture</content>' },
      },
    }
    yield {
      type: 'stream_event',
      event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 149 } },
    }
    yield { type: 'stream_event', event: { type: 'message_stop' } }
  }
  const { context, frames } = lifecycleContext(code, { lines, sdk })
  const loop = context.runNativeMessagesLoop({ options: {} })
  // The SDK is deliberately unsettled; this checks dispatch without sleeping out a real timeout.
  for (let n = 0; n < 8; n++) await tick()
  const before = plain(frames),
    pendingAck = before.some((f) => f.type === nativeWireType(code, 'cancel_ack') && f.job_id === 'held')
  release()
  await loop
  for (let n = 0; n < 8; n++) await tick()
  await context.writeChain2
  return {
    before,
    frames: plain(frames),
    pendingAck,
    calls: calls.map((c) => ({
      model: c.model,
      system: plain(c.system),
      thinking: plain(c.thinking),
      maxTokens: c.maxTokens,
      wireMessages: plain(c.wireMessages),
    })),
  }
}
export async function cancelReuseControl(code) {
  let release
  const oldTask = new Promise((resolve) => {
    release = resolve
  })
  const { context, frames } = lifecycleContext(code)
  const abort = new AbortController(),
    slot = { id: 's00', phase: 'running', jobId: 'old', abort, task: oldTask }
  const slots = new Map([['s00', slot]])
  oldTask.then(() => {
    slot.phase = 'running'
    slot.jobId = 'new'
    slot.abort = new AbortController()
    slot.task = new Promise(() => {})
  })
  const pending = context.cancelJob(slots, 's00', 'old')
  assert.equal(abort.signal.aborted, true)
  release()
  await pending
  await context.cancelJob(slots, 'missing', 'unknown')
  await context.cancelJob(slots, 's00', 'already-completed')
  await context.writeChain2
  return { phase: slot.phase, jobId: slot.jobId, frames: plain(frames) }
}
export function classifier(code) {
  const { context } = lifecycleContext(code)
  return (error, options = {}) =>
    plain((context.__vm2apiJobError?.classify || context.classifyKinJobError)(error, { sawEvent: false, ...options }))
}
export async function runJobControl(code, error = null, { envelope = false } = {}) {
  const sdk = async function* (args) {
    args.onResponseHeaders?.({ 'retry-after': '7', 'request-id': 'req_fixture' })
    if (error) {
      args.onError?.(error)
      if (envelope) {
        yield {
          type: 'assistant',
          isApiErrorMessage: true,
          error: 'server_error',
          message: { content: [{ type: 'text', text: 'rendered error' }] },
        }
        return
      }
      throw error
    }
    yield {
      type: 'stream_event',
      event: { type: 'message_start', message: { content: [], usage: { input_tokens: 5 } } },
    }
    yield {
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'ok' } },
    }
    yield {
      type: 'stream_event',
      event: { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 100 } },
    }
    yield { type: 'stream_event', event: { type: 'message_stop' } }
  }
  const { context, frames } = lifecycleContext(code, { sdk })
  await context.runJob(
    { id: 's00' },
    'case-job',
    { model: 'fixture', messages: [{ role: 'user', content: 'neutral' }] },
    {},
    new AbortController(),
  )
  await context.writeChain2
  return plain(frames)
}
export async function retryControl(code, querySource, { failOnce = true, persistent = false } = {}) {
  let attempts = 0
  const original = new FixtureAPIError(503, 'raw failure'),
    ctx = vm.createContext({
      ...sdkGlobals(),
      process: { env: { USER_TYPE: 'external' } },
      isPersistentRetryEnabled: () => persistent,
      isTransientCapacityError: () => false,
    })
  vm.runInContext(code, ctx, { timeout: 1000 })
  const generator = ctx.withRetry(
    async () => ({}),
    async () => {
      attempts++
      if (failOnce && attempts === 1) throw original
      return 'ok'
    },
    { querySource, model: 'fixture', thinkingConfig: { type: 'disabled' }, signal: new AbortController().signal },
  )
  const yielded = []
  let value, error
  try {
    for (;;) {
      const step = await generator.next()
      if (step.done) {
        value = step.value
        break
      }
      yielded.push(plain(step.value))
    }
  } catch (e) {
    error = e
  }
  return { attempts, yielded, value, error: !!error, originalPreserved: error?.originalError === original }
}
export async function queryControl(code) {
  let captured
  const context = vm.createContext({
    asSystemPrompt: (x) => x,
    queryModelWithStreaming: async function* (params) {
      captured = params
    },
  })
  vm.runInContext(code, context, { timeout: 1000 })
  const signal = new AbortController().signal,
    onError = () => {},
    onHeaders = () => {}
  const input = {
    messages: [{ type: 'user', message: { content: 'neutral' } }],
    system: ['', '# Environment\nKEEP', ' 中文 format '],
    toolSchemas: [{ name: 'tool', input_schema: { type: 'object' } }],
    toolChoice: { type: 'auto' },
    thinking: { type: 'enabled', budgetTokens: 60000 },
    maxTokens: 128000,
    temperature: 0.3,
    topP: 0.8,
    topK: 3,
    stopSequences: ['STOP'],
    model: 'fixture',
    signal,
    wireMessages: [{ role: 'user', content: 'neutral' }],
    outputConfig: { effort: 'max' },
    contextManagement: { edits: [] },
    onResponseHeaders: onHeaders,
    onError,
  }
  for await (const unused of context.queryKinMessagesWithStreaming(input)) void unused
  const options = captured.options
  assert.equal(captured.signal, signal)
  assert.equal(options.onResponseHeaders, onHeaders)
  const result = {
    params: plain(captured),
    hasErrorCallback: options.onError === onError,
    snapshot: options.__vm2apiSys ? plain(options.__vm2apiSys) : null,
  }
  if (options.__vm2apiSys) {
    input.system[1] = 'mutated'
    assert.equal(options.__vm2apiSys[1], '# Environment\nKEEP')
  }
  return result
}
export function transportControl(parts, source) {
  const raw = new FixtureConnectionError(),
    calls = []
  const ctx = vm.createContext({
    ...sdkGlobals(),
    process: { env: {} },
    options2: { querySource: source, model: 'fixture', onError: (error) => calls.push(error) },
    errorFromRetry: new FixtureCannotRetry(raw, {}),
    streamingError: raw,
    streamIdleAborted: true,
    streamWatchdogFiredAt: 1,
    streamRequestId: 'fixture',
    attemptNumber: 1,
    maxOutputTokens: 128000,
    thinkingConfig: { type: 'enabled' },
    __error: null,
  })
  const evaluate = (code) => {
    ctx.__error = null
    vm.runInContext('try{' + code + '}catch(error){__error=error}', ctx, { timeout: 1000 })
    return ctx.__error
  }
  const gate = evaluate(parts.error_gate),
    fallback = evaluate(parts.fallback),
    timeout = evaluate(parts.timeout)
  return {
    rawError: gate === raw,
    errorCallback: calls.length === 1 && calls[0] === raw,
    fallbackBlocked: fallback === raw,
    timeoutClass: timeout instanceof FixtureTimeoutError,
    timeoutMessage: timeout?.message,
  }
}
export async function dispatchControl(retryCode, dispatch, source) {
  let calls = 0,
    clients = 0
  const fail = new FixtureAPIError(503, 'raw HTTP failure')
  const signal = new AbortController().signal
  const ctx = vm.createContext({
    ...sdkGlobals(),
    process: { env: { USER_TYPE: 'external' } },
    signal,
    thinkingConfig: { type: 'disabled' },
    isFastMode: false,
    options2: { querySource: source, model: 'fixture' },
    attemptNumber: 0,
    isFastModeRequest: false,
    start: 0,
    attemptStartTimes: [],
    maxOutputTokens: 0,
    clientRequestId: undefined,
    streamRequestId: undefined,
    streamResponse: undefined,
    queryCheckpoint() {},
    captureAPIRequest() {},
    headlessProfilerCheckpoint() {},
    getAPIProvider: () => 'fixture',
    isFirstPartyAnthropicBaseUrl: () => false,
    paramsFromContext: () => ({
      model: 'fixture',
      max_tokens: 128000,
      system: ['caller'],
      messages: [{ role: 'user', content: 'neutral' }],
    }),
    getAnthropicClient: async (options) => {
      clients++
      assert.equal(options.maxRetries, 0)
      assert.equal(options.source, source)
      return {
        beta: {
          messages: {
            create: (params, opts) => {
              assert.equal(params.stream, true)
              assert.equal(params.max_tokens, 128000)
              assert.equal(opts.signal, signal)
              return {
                withResponse: async () => {
                  calls++
                  if (calls === 1) throw fail
                  return {
                    data: { controller: new AbortController() },
                    request_id: 'fixture',
                    response: { headers: new Headers() },
                  }
                },
              }
            },
          },
        },
      }
    },
  })
  vm.runInContext(retryCode + '\nasync function* __dispatch(){' + dispatch + 'return yield* generator;}', ctx, {
    timeout: 1000,
  })
  let error
  try {
    for await (const x of ctx.__dispatch()) void x
  } catch (e) {
    error = e
  }
  return { calls, clients, failed: !!error, original: error?.originalError === fail }
}
export async function verifyLifecycleSource(semantics, kind) {
  let checks = 0
  const dispatch = await dispatcherControl(semantics.native)
  assert.equal(dispatch.pendingAck, false)
  checks++
  assert.ok(
    dispatch.before.some((f) => f.type === nativeWireType(semantics.native, 'pong') && f.nonce === 'ping-fixture'),
  )
  checks++
  assert.ok(
    dispatch.before.some((f) => f.type === nativeWireType(semantics.native, 'job_done') && f.job_id === 'quick'),
  )
  checks++
  assert.ok(
    dispatch.frames.some((f) => f.type === nativeWireType(semantics.native, 'cancel_ack') && f.job_id === 'held'),
  )
  checks++
  const reuse = await cancelReuseControl(semantics.native)
  assert.equal(reuse.phase, 'running')
  assert.equal(reuse.jobId, 'new')
  assert.equal(reuse.frames.length, 3)
  checks += 3
  const actual = classifier(semantics.native),
    reference = classifier(semantics.reference_native)
  for (const status of [400, 401, 403, 408, 429, 500, 502, 504, 529])
    for (const type of ['api_error', 'overloaded_error', 'permission_error']) {
      const e = new FixtureAPIError(
        status,
        'outer message',
        { error: { type, message: ' inner message ' } },
        new Headers({ 'retry-after': '12' }),
      )
      assert.deepEqual(actual(e), reference(e))
      checks++
    }
  for (const error of [
    new FixtureConnectionError(),
    new FixtureTimeoutError('timed out'),
    Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }),
    new Error('Stream ended without receiving any events'),
    new Error('ordinary failure'),
  ])
    for (const sawEvent of [false, true]) {
      assert.deepEqual(actual(error, { sawEvent }), reference(error, { sawEvent }))
      checks++
    }
  for (const source of ['agent:kin', 'kin_native_messages', 'sdk']) {
    const value = await retryControl(semantics.retry, source),
      expected = await retryControl(semantics.reference_retry, source)
    assert.deepEqual(value, expected)
    checks++
    assert.equal(value.attempts, source === 'sdk' ? 2 : 1)
    checks++
  }
  for (const source of ['agent:kin', 'kin_native_messages', 'sdk']) {
    assert.deepEqual(
      transportControl(semantics.transport.after, source),
      transportControl(semantics.transport.reference, source),
    )
    checks++
    const actualDispatch = await dispatchControl(semantics.retry, semantics.transport.after.dispatch, source)
    assert.deepEqual(
      actualDispatch,
      await dispatchControl(semantics.reference_retry, semantics.transport.reference.dispatch, source),
    )
    checks++
    assert.equal(actualDispatch.calls, source === 'sdk' ? 2 : 1)
    checks++
  }
  const query = await queryControl(semantics.query),
    before = await queryControl(semantics.query_before)
  assert.equal(query.hasErrorCallback, true)
  checks++
  assert.deepEqual(query.snapshot, ['', '# Environment\nKEEP', ' 中文 format '])
  checks++
  delete query.params.options.__vm2apiSys
  delete before.params.options.__vm2apiSys
  assert.deepEqual(query.params, before.params)
  checks++
  for (const error of [
    null,
    new FixtureAPIError(429, 'rate limited', { type: 'rate_limit_error', message: 'limited' }),
    new FixtureConnectionError(),
  ]) {
    assert.deepEqual(
      comparableWireFrames(await runJobControl(semantics.native, error)),
      comparableWireFrames(await runJobControl(semantics.reference_native, error)),
    )
    checks++
  }
  return {
    ok: true,
    checks,
    kind,
    scope: 'exact source controls with fake SDK/stdio; no Linux ELF or provider execution',
  }
}
