import assert from 'node:assert/strict'
import vm from 'node:vm'
import { dispatcherControl, lifecycleContext } from './fixed-lifecycle-controls.mjs'
import { verifyHostRefreshSource, refreshControl } from './fixed-host-refresh-controls.mjs'
import { requestWireApiControl } from './fixed-request-wire-api.mjs'
const plain = (value) => JSON.parse(JSON.stringify(value))

export async function verifyKernelWireSource(sem, kind) {
  const wire = sem.kernel_wire
  assert.equal(wire.contract, 'unprefixed_native_v2')
  let checks = 1
  const parsed = vm.createContext({ process: { env: { CLAUDE_CODE_NATIVE_SLOTS: '2' } } })
  vm.runInContext((wire.environment || '') + '\n' + wire.slot_count + '\n' + wire.parse_stdin, parsed)
  assert.equal(parsed.nativeSlotCount(), 2)
  checks++
  for (const type of ['job_start', 'cancel', 'ping']) {
    assert.equal(parsed.parseStdinLine(JSON.stringify({ type })).type, type)
    checks++
  }
  for (const type of ['kin_job_start', 'kin_cancel', 'kin_ping', 'unknown']) {
    assert.equal(parsed.parseStdinLine(JSON.stringify({ type })), null)
    checks++
  }
  for (const [value, count] of [
    ['999', 20],
    ['0', 0],
    ['bad', 0],
  ]) {
    parsed.process.env.CLAUDE_CODE_NATIVE_SLOTS = value
    assert.equal(parsed.nativeSlotCount(), count)
    checks++
  }
  parsed.process.env = { CLAUDE_CODE_KIN_NATIVE_SLOTS: '2' }
  assert.equal(parsed.nativeSlotCount(), 0)
  checks++
  // These inspect RAW emitted names, independently of semantic cross-version comparisons.
  const dispatch = await dispatcherControl(wire.native)
  assert.ok(dispatch.before.some((row) => row.type === 'host_ready'))
  checks++
  assert.ok(dispatch.before.some((row) => row.type === 'pong'))
  checks++
  assert.ok(dispatch.before.some((row) => row.type === 'job_done' && row.job_id === 'quick'))
  checks++
  assert.ok(dispatch.frames.some((row) => row.type === 'cancel_ack'))
  checks++
  assert.ok(dispatch.frames.every((row) => !row.type.startsWith('kin_')))
  checks++
  assert.ok(dispatch.calls.every((call) => call.maxTokens === 128000 && call.thinking.budgetTokens === 60000))
  checks++

  const guard = sem.request_wire ? [{ type: 'dangerous_tool_use' }] : { mode: 'fixture-only-no-provider' }
  let captured
  const ctx = vm.createContext({
    asSystemPrompt: (value) => value,
    queryModelWithStreaming: async function* (value) {
      captured = value
    },
    getEmptyToolPermissionContext: () => ({}),
  })
  vm.runInContext(wire.query, ctx)
  const system = ['', '# Environment\nKEEP', ' 中文 format ']
  for (const safeguards of [undefined, null, guard]) {
    const request = {
      model: 'claude-opus-4-6',
      system,
      messages: [],
      wireMessages: [{ role: 'user', content: 'fixture' }],
      thinking: { type: 'enabled', budgetTokens: 60000 },
      maxTokens: 128000,
      outputConfig: { effort: 'max' },
      safeguards,
      ...(sem.request_wire
        ? {
            wireThinking: { type: 'enabled', budget_tokens: 60000 },
            wireBody: {
              model: 'claude-opus-4-6',
              thinking: { type: 'enabled', budget_tokens: 60000 },
              output_config: { effort: 'max' },
              safeguards,
            },
          }
        : {}),
    }
    for await (const ignored of ctx.queryKinMessagesWithStreaming(request)) void ignored
    assert.deepEqual(plain(captured.options.__vm2apiSys), system)
    checks++
    assert.equal(captured.options.safeguards, safeguards)
    checks++
    assert.equal(captured.options.maxOutputTokensOverride, 128000)
    checks++
    const api = vm.createContext({
      options2: { ...captured.options, querySource: 'agent:kin', temperatureOverride: 0.3 },
      normalizeModelStringForAPI: (x) => x,
      apiMessages: request.wireMessages,
      system: system.map((text) => ({ type: 'text', text })),
      allTools: [],
      useBetas: true,
      betasParams: ['context'],
      CONTEXT_MANAGEMENT_BETA_HEADER: 'context',
      hasThinking: true,
      mergeOfficialExtraBetas: (x) => x,
      isKinQuerySource: (x) => x === 'agent:kin',
      getAPIMetadata: () => ({ user_id: 'fixture' }),
      maxOutputTokens2: 128000,
      thinking: { type: 'enabled', budget_tokens: 60000 },
      contextManagement: null,
      extraBodyParams: {},
      outputConfig: { effort: 'max' },
      speed: undefined,
    })
    let body
    if (sem.request_wire) {
      body = requestWireApiControl(sem, {
        body: {
          ...request.wireBody,
          messages: request.wireMessages,
          system: system.map((text) => ({ type: 'text', text })),
        },
        options: captured.options,
      }).result
    } else {
      vm.runInContext(
        'function capture(){' +
          (wire.api_helpers || '') +
          sem.classifier.api_after.temperature +
          '\n' +
          wire.api_body +
          '\n}',
        api,
      )
      body = plain(api.capture())
    }
    assert.deepEqual(body.messages, request.wireMessages)
    checks++
    assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 60000 })
    checks++
    assert.equal(body.max_tokens, 128000)
    checks++
    assert.equal(
      body.betas.filter(
        (value) => value === (sem.request_wire ? 'dangerous-tool-use-2026-09-03' : 'afk-mode-2026-01-31'),
      ).length,
      safeguards == null ? 0 : 1,
    )
    checks++
    if (safeguards == null) assert.equal(Object.hasOwn(body, 'safeguards'), false)
    else assert.deepEqual(body.safeguards, guard)
    checks++
  }
  // The actual dispatcher, not only the isolated bridge, forwards the optional field.
  const observed = []
  const native = lifecycleContext(wire.native, {
    lines: [
      {
        type: 'job_start',
        slot_id: 's00',
        job_id: 'safeguards',
        request: { model: 'fixture', system: [], messages: [], safeguards: guard },
      },
    ],
    sdk: async function* (request) {
      observed.push(request)
      yield { type: 'stream_event', event: { type: 'message_stop' } }
    },
  })
  await native.context.runNativeMessagesLoop({ options: {} })
  for (let n = 0; n < 12; n++) await new Promise((resolve) => setImmediate(resolve))
  await native.context.writeChain2
  assert.equal(observed.length, 1)
  checks++
  assert.deepEqual(plain(observed[0].safeguards), guard)
  checks++
  const refreshed = await refreshControl(wire.host_refresh, { flag: '1' })
  assert.ok(refreshed)
  checks++
  const preserved = await verifyHostRefreshSource(sem, kind)
  return {
    ok: true,
    kind,
    checks: checks + preserved.checks,
    wire_checks: checks,
    preserved_checks: preserved.checks,
    scope: 'actual native/bridge/API fragments and raw protocol names; fake SDK, no full Linux ELF/provider execution',
  }
}
