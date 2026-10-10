import assert from 'node:assert/strict'
import vm from 'node:vm'
import { AsyncLocalStorage } from 'node:async_hooks'
import { lifecycleContext, nativeWireType } from './fixed-lifecycle-controls.mjs'
import { verifyClassifierSource } from './fixed-classifier-controls.mjs'
const tick = () => new Promise((resolve) => setImmediate(resolve))
const plain = (value) => JSON.parse(JSON.stringify(value))

/** No init_jobSession/getJobSessionId/runWithJobSession stubs here. */
export function bootstrapContext(sem) {
  let stores = 0,
    stateInitializations = 0,
    context
  const globals = {
    AsyncLocalStorage: class extends AsyncLocalStorage {
      constructor() {
        super()
        stores++
      }
    },
    __esm: (fn) => {
      let ran = false
      return () => {
        if (!ran) {
          ran = true
          return fn()
        }
      }
    },
    init_claude: () => context.init_state?.(),
    init_sumBy() {},
    init_crypto() {},
    init_settingsCache() {},
    init_ids() {},
    init_messages3() {},
    init_staleConnection() {},
    init_stdioProtocol() {},
    init_systemLayout() {},
    __vm2apiJobError: { init() {} },
    getInitialState: () => {
      stateInitializations++
      return {
        sessionId: 'host-session',
        parentSessionId: null,
        planSlugCache: new Map(),
        sessionProjectDir: '/fixture',
      }
    },
    createSignal: () => ({ subscribe() {} }),
    STATE: { sessionId: 'host-session' },
    randomUUID: () => 'rotated-host',
    process: { env: {} },
    safeParseJSON: (value) => JSON.parse(value),
    logForDebugging2() {},
    jsonStringify: JSON.stringify,
    getOrCreateUserID: () => 'fixture-device',
    getOauthAccountInfo: () => ({ accountUuid: 'fixture-account' }),
  }
  context = vm.createContext(globals)
  vm.runInContext(
    [
      sem.helper || '',
      sem.getter || '',
      sem.regenerate || '',
      sem.state_initializer || '',
      sem.native_initializer,
      sem.api_metadata || '',
    ].join('\n'),
    context,
  )
  return { context, counts: () => ({ stores, stateInitializations }) }
}

export async function verifyCCSessionSource(sem, previous) {
  let checks = 0
  const fixture = bootstrapContext(sem),
    c = fixture.context
  c.init_nativeMessagesRunner()
  assert.equal(fixture.counts().stores, 1)
  checks++
  assert.equal(fixture.counts().stateInitializations, 1)
  checks++
  assert.equal(c.getSessionId(), 'host-session')
  checks++
  assert.equal(c.getJobSessionId(), undefined)
  checks++
  c.init_jobSession()
  c.init_state()
  c.init_nativeMessagesRunner()
  assert.deepEqual(fixture.counts(), { stores: 1, stateInitializations: 1 })
  checks++
  let release
  const held = new Promise((resolve) => {
    release = resolve
  })
  const first = c.runWithJobSession('session-a', async () => {
    const before = c.getSessionId()
    await held
    return [before, c.getSessionId(), JSON.parse(c.getAPIMetadata().user_id)]
  })
  const second = c.runWithJobSession('session-b', async () => {
    await tick()
    return [c.getSessionId(), JSON.parse(c.getAPIMetadata().user_id)]
  })
  assert.equal(c.getSessionId(), 'host-session')
  checks++
  const b = await second
  release()
  const a = await first
  assert.deepEqual(a.slice(0, 2), ['session-a', 'session-a'])
  checks++
  assert.equal(a[2].session_id, 'session-a')
  checks++
  assert.equal(b[0], 'session-b')
  checks++
  assert.equal(b[1].session_id, 'session-b')
  checks++
  assert.deepEqual({ ...a[2], session_id: 'X' }, { ...b[1], session_id: 'X' })
  checks++
  assert.equal(c.getSessionId(), 'host-session')
  checks++
  await assert.rejects(
    c.runWithJobSession('failed-job', async () => {
      await tick()
      throw Error('fixture failure')
    }),
    /fixture failure/,
  )
  assert.equal(c.getJobSessionId(), undefined)
  checks++
  assert.equal(c.getSessionId(), 'host-session')
  checks++
  assert.equal(c.regenerateSessionId({ setCurrentAsParent: true }), 'rotated-host')
  checks++
  assert.equal(c.STATE.parentSessionId, 'host-session')
  checks++
  assert.equal(c.getSessionId(), 'rotated-host')
  checks++

  // Actual native dispatcher -> runJob -> session wrapper -> getAPIMetadata, with
  // only the cloud SDK replaced. Finish the second job while the first is waiting.
  const seen = [],
    done = []
  let native, releaseFirst
  const waitFirst = new Promise((resolve) => {
    releaseFirst = resolve
  })
  const sdk = async function* (args) {
    const before = native.context.getSessionId()
    if (args.model === 'first') await waitFirst
    else await tick()
    seen.push({
      before,
      after: native.context.getSessionId(),
      metadata: JSON.parse(native.context.getAPIMetadata().user_id),
    })
    yield {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: { id: args.model, role: 'assistant', content: [], usage: { input_tokens: 1 } },
      },
    }
    yield {
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: args.model } },
    }
    yield { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } } }
    yield { type: 'stream_event', event: { type: 'message_stop' } }
    done.push(args.model)
  }
  const request = (model) => ({
    model,
    messages: [{ role: 'user', content: 'neutral' }],
    metadata: { user_id: JSON.stringify({ session_id: 'wire-' + model }) },
  })
  const code = sem.helper + '\n' + sem.getter + '\n' + sem.api_metadata + '\n' + previous.lifecycle.native
  native = lifecycleContext(code, {
    sdk,
    globals: {
      AsyncLocalStorage,
      STATE: { sessionId: 'host-session' },
      safeParseJSON: JSON.parse,
      jsonStringify: JSON.stringify,
      getOrCreateUserID: () => 'device',
      getOauthAccountInfo: () => ({ accountUuid: 'account' }),
    },
    lines: [
      { type: 'kin_job_start', slot_id: 's00', job_id: 'first', request: request('first') },
      { type: 'kin_job_start', slot_id: 's01', job_id: 'second', request: request('second') },
    ],
  })
  await native.context.runNativeMessagesLoop({ options: {} })
  for (let n = 0; n < 10; n++) await tick()
  assert.deepEqual(done, ['second'])
  checks++
  releaseFirst()
  for (let n = 0; n < 10; n++) await tick()
  await native.context.writeChain2
  assert.deepEqual(
    seen.map((row) => [row.before, row.after, row.metadata.session_id]),
    [
      ['wire-second', 'wire-second', 'wire-second'],
      ['wire-first', 'wire-first', 'wire-first'],
    ],
  )
  checks++
  assert.equal(native.context.getSessionId(), 'host-session')
  checks++
  assert.equal(native.frames.filter((f) => f.type === nativeWireType(code, 'job_done')).length, 2)
  checks++
  assert.deepEqual(plain(native.frames.filter((f) => f.type === nativeWireType(code, 'job_error'))), [])
  checks++

  const oldSourceControls = await verifyClassifierSource(
    { ...previous.classifier, native: sem.helper + '\n' + previous.classifier.native },
    previous,
    'cc',
  )
  checks += oldSourceControls.checks
  return {
    ok: true,
    checks,
    session_checks: checks - oldSourceControls.checks,
    preserved_checks: oldSourceControls.checks,
    scope:
      'real job-session bootstrap/AsyncLocalStorage/native dispatch and metadata, plus preserved source controls; fake SDK, not Linux ELF/cloud',
  }
}
