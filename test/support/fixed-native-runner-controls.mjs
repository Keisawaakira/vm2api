import vm from 'node:vm'
import { AsyncLocalStorage } from 'node:async_hooks'
import assert from 'node:assert/strict'

const esm = init => { let ready = false; return () => { if (!ready) { ready = true; init() } } }
const tick = () => new Promise(resolve => setImmediate(resolve))
const plain = value => JSON.parse(JSON.stringify(value))

/** Actual current dispatcher and session functions; SDK generation and header/stdin/stdout are named external seams. */
export async function nativeRunnerControl(sem, kind) {
  let checks = 0, release
  const held = new Promise(resolve => { release = resolve })
  const frames = [], calls = [], storage = new AsyncLocalStorage(), auto = new AsyncLocalStorage()
  const helper = sem.native_refresh.session_helper
  const code = sem.native_refresh.runner
  const input = (id, slot, model, window) => ({ type: 'job_start', job_id: id, slot_id: slot, request: {
    model, max_tokens: 128000, auto_compact_window: window,
    metadata: { user_id: JSON.stringify({ session_id: '00000000-0000-4000-8000-00000000000' + (slot === 's00' ? '1' : '2') }) },
    system: [{ type: 'text', text: '# Environment\nCALLER' }, { type: 'text', text: ' ' }],
    messages: [{ role: 'user', content: 'hello' }], thinking: { type: 'enabled', budget_tokens: 60000, display: 'summarized' },
  } })
  const lines = [input('held', 's00', 'held', 160000), { type: 'cancel', slot_id: 's00', job_id: 'held' },
    { type: 'ping', nonce: 'still-responsive' }, input('quick', 's01', 'quick', 240000)]
  const context = vm.createContext({
    __esm: esm, __export: () => {}, Array, Object, String, Number, JSON, Math, Map, Set, Promise, Error,
    AbortController, AsyncLocalStorage, structuredClone, Buffer, queueMicrotask,
    process: { env: { CLAUDE_CODE_NATIVE_SLOTS: '2', USER_TYPE: 'external' }, stdin: {}, stderr: { write() {} }, stdout: {
      write(line, callback) { frames.push(JSON.parse(line)); queueMicrotask(() => callback?.()); return true }, once() {},
    } },
    kernelEnv: key => key === 'NATIVE_SLOTS' ? '2' : undefined,
    WRAP_OFFICIAL_CLI_VERSION: '2.1.303', getSystemLayout: () => 'zero', getKinTimezone: () => 'UTC',
    init_claude() {}, init_ids() {}, init_messages3() {}, init_staleConnection() {}, init_systemLayout() {},
    init_jobError() {}, init_outboundHeaders() {}, init_vmTelemetry() {},
    __vm2apiJobError: { init() {}, classify: error => ({ error: error?.message || 'fixture-error', status: 502 }) },
    getJobSessionId: () => storage.getStore(), runWithJobSession: (id, action) => storage.run(id, action), init_jobSession() {},
    getJobAutoCompactWindow: () => auto.getStore(), runWithJobAutoCompactWindow: (value, action) => auto.run(value, action),
    asSessionId: value => value,
    createUserMessage: value => ({ type: 'user', message: { role: 'user', ...value } }),
    createAssistantMessage: value => ({ type: 'assistant', message: { role: 'assistant', ...value } }),
    createInterface: () => ({ async *[Symbol.asyncIterator]() { for (const line of lines) yield JSON.stringify(line) } }),
    createInterface2: () => ({ async *[Symbol.asyncIterator]() { for (const line of lines) yield JSON.stringify(line) } }),
    startVmTelemetry: () => undefined, captureVmJob: () => null, sendSlotStart() {},
    // Report callbacks and generated SDK content are external effects, not missing session implementations.
    withOutboundHeaders: (_report, action) => action(),
    classifyKinJobError: error => ({ error: error?.message || 'fixture-error', status: 502 }),
    isStaleConnectionError: () => false, isStaleConnectionHay: () => false,
    queryKinMessagesWithStreaming: async function* (body) {
      calls.push({ model: body.model, session: context.getJobSessionId(), window: context.getJobAutoCompactWindow(), body: plain(body.wireBody) })
      if (body.model === 'held') await held
      if (body.signal.aborted) return
      yield { type: 'stream_event', event: { type: 'message_start', message: { type: 'message', content: [], usage: { input_tokens: 1 } } } }
      yield { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '<content>完整中文🙂</content>' } } }
      yield { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 149 } } }
      yield { type: 'stream_event', event: { type: 'message_stop' } }
    },
  })
  const clean = code.replace(/\bimport\s*\{[^}]*\}\s*from\s*["']readline["'];?/g, '')
  vm.runInContext(clean, context)
  if (helper) {
    vm.runInContext(helper.replace(/^import[^;]+;\s*/gm, ''), context)
    context.init_jobSession()
  }
  context.init_nativeMessagesRunner()
  const loop = context.runNativeMessagesLoop({ options: {} })
  for (let i = 0; i < 12; i++) await tick()
  assert.ok(frames.some(frame => frame.type === 'pong' && frame.nonce === 'still-responsive'))
  assert.equal(frames.some(frame => frame.type === 'cancel_ack'), false)
  assert.equal(calls.length, 2)
  assert.notEqual(calls[0].session, calls[1].session)
  assert.equal(calls[0].window, 160000)
  assert.equal(calls[1].window, 240000)
  assert.deepEqual(calls[1].body.system, lines[3].request.system)
  checks += 7
  release()
  await loop
  for (let i = 0; i < 12; i++) await tick()
  assert.ok(frames.some(frame => frame.type === 'cancel_ack' && frame.job_id === 'held'))
  assert.equal(frames.filter(frame => frame.type === 'job_done' && frame.job_id === 'quick').length, 1)
  assert.equal(frames.some(frame => frame.type === 'job_done' && frame.job_id === 'held'), false)
  assert.ok(frames.some(frame => frame.event?.content_block?.text === '<content>完整中文🙂</content>'))
  checks += 4
  const sessionValues = await Promise.all(['one','two'].map((id, index) => context.runWithJobSession(id, async () => {
    await tick()
    return context.getJobSessionId()
  })))
  assert.deepEqual(sessionValues, ['one','two'])
  checks++
  return { ok: true, checks, kind, real_session_helper: !!helper, native_linux_execution: false, sdk_stdio_and_header_seams: true }
}
