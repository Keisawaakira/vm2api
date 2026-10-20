import assert from 'node:assert/strict'
import { withRequestProtocolBetas } from '../../src/lib/protocol/claude-code-betas.mjs'
import { lifecycleContext } from './fixed-lifecycle-controls.mjs'
import { verifyKernelWireSource } from './fixed-kernel-wire-controls.mjs'
import { requestWireApiControl, requestWireBridgeControl } from './fixed-request-wire-api.mjs'
const plain = (value) => JSON.parse(JSON.stringify(value))

export async function verifyRequestWireSource(sem, kind) {
  assert.equal(sem.request_wire.contract, 'model_field_gates_v1')
  let checks = 1
  for (const model of ['claude-opus-4-6', 'claude-opus-5-5', 'claude-haiku-5-5']) {
    for (const profile of [true, false]) {
      for (const thinking of [{ type: 'disabled' }, { type: 'adaptive', display: 'summarized' }]) {
        const body = {
          model,
          max_tokens: 128000,
          thinking,
          output_config: {
            effort: 'max',
            format: { type: 'json_schema', schema: { type: 'object' } },
            task_budget: { type: 'tokens', total: 10 },
          },
          system: [{ type: 'text', text: '# Environment\nCALLER', cache_control: { type: 'ephemeral', ttl: '1h' } }],
          messages: [{ role: 'user', content: 'neutral fixture' }],
          tools: [],
          metadata: { user_id: 'caller-id', test_tag: 'retain' },
          service_tier: 'standard',
          diagnostics: { cache: true },
          thread: { id: 'fixture-thread' },
          betas: ['fixture-custom-beta', 'fixture-custom-beta'],
          request_context: { internal: true },
          wireMessages: [],
        }
        const input = {
          model,
          maxTokens: body.max_tokens,
          system: body.system.map((block) => block.text),
          messages: [],
          wireMessages: body.messages,
          wireThinking: body.thinking,
          wireBody: body,
          thinking: body.thinking,
          outputConfig: body.output_config,
        }
        const bridged = await requestWireBridgeControl(sem.request_wire.query, input)
        assert.equal(bridged.options.wireBody, body)
        checks++
        assert.equal(bridged.options.wireThinking, thinking)
        checks++
        assert.deepEqual(plain(bridged.options.__vm2apiSys), ['# Environment\nCALLER'])
        checks++
        const before = JSON.stringify(body)
        const { result, calls, lastRequestBetas } = requestWireApiControl(sem, {
          body,
          options: bridged.options,
          profile,
        })
        assert.equal(JSON.stringify(body), before)
        checks++
        assert.deepEqual(result.thinking, thinking)
        checks++
        assert.deepEqual(result.output_config, body.output_config)
        checks++
        assert.equal(result.max_tokens, 128000)
        checks++
        assert.deepEqual(result.messages, body.messages)
        checks++
        assert.equal(result.service_tier, 'standard')
        checks++
        assert.deepEqual(result.diagnostics, body.diagnostics)
        checks++
        assert.deepEqual(result.thread, body.thread)
        checks++
        assert.equal(result.metadata.test_tag, 'retain')
        checks++
        assert.equal(result.metadata.user_id, 'fixture-host-identity')
        checks++
        assert.equal(Object.hasOwn(result, 'request_context'), false)
        checks++
        assert.equal(Object.hasOwn(result, 'wireMessages'), false)
        checks++
        assert.equal(Object.hasOwn(result, 'temperature'), false)
        checks++
        assert.equal(calls.configureEffort, 0)
        checks++
        assert.equal(result.betas.filter((beta) => beta === 'fixture-custom-beta').length, 1)
        checks++
        for (const beta of withRequestProtocolBetas([], result)) {
          assert.ok(result.betas.includes(beta), beta)
          checks++
        }
        assert.equal(result.betas.includes('per-turn-control-2026-07-01'), model !== 'claude-opus-4-6')
        checks++
        assert.equal(result.betas.includes('claude-code-20250219'), profile)
        checks++
        assert.equal(result.betas.includes('thinking-binding-controls-2026-08-01'), false)
        checks++
        assert.deepEqual(lastRequestBetas, result.betas)
        checks++
      }
    }
  }
  for (const body of [
    { model: 'claude-opus-4-6', thinking: { type: 'enabled', budget_tokens: 60000, display: 'summarized' } },
    {
      model: 'claude-opus-5-5',
      thinking: { type: 'adaptive', display: 'updates', block_binding: { mode: 'fixture' } },
      safeguards: [{ type: 'dangerous_tool_use' }],
      speed: 'fast',
    },
  ]) {
    const result = requestWireApiControl(sem, {
      body: { ...body, messages: [], system: [], max_tokens: 128000 },
    }).result
    assert.deepEqual(result.thinking, body.thinking)
    checks++
    for (const beta of withRequestProtocolBetas([], result)) {
      assert.ok(result.betas.includes(beta), beta)
      checks++
    }
    if (body.safeguards) {
      assert.deepEqual(result.safeguards, body.safeguards)
      assert.equal(result.speed, 'fast')
      checks += 2
    }
  }
  if (kind === 'cc') {
    const output = requestWireApiControl(sem, {
      body: { model: 'claude-opus-5-5', metadata: { __vm2api_cc_trace: 'fixture-private-ticket', test_tag: 'keep' } },
    }).result
    assert.equal(Object.hasOwn(output.metadata, '__vm2api_cc_trace'), false)
    assert.equal(output.metadata.test_tag, 'keep')
    checks += 2
  }
  // Actual dispatch supplies the original body; not just a hand-built bridge option.
  let dispatched
  const body = {
    model: 'claude-opus-5-5',
    max_tokens: 128000,
    system: [{ type: 'text', text: 'KEEP' }],
    messages: [{ role: 'user', content: 'fixture' }],
    thinking: { type: 'adaptive', display: 'summarized' },
    output_config: { effort: 'max' },
    betas: ['fixture-gate'],
  }
  const native = lifecycleContext(sem.request_wire.native, {
    lines: [{ type: 'job_start', slot_id: 's00', job_id: 'request-wire', request: body }],
    sdk: async function* (args) {
      dispatched = args
      yield { type: 'stream_event', event: { type: 'message_stop' } }
    },
  })
  await native.context.runNativeMessagesLoop({ options: {} })
  for (let i = 0; i < 12; i++) await new Promise((resolve) => setImmediate(resolve))
  await native.context.writeChain2
  assert.deepEqual(plain(dispatched.wireBody), body)
  checks++
  const bridged = await requestWireBridgeControl(sem.request_wire.query, dispatched)
  const result = requestWireApiControl(sem, { body, options: bridged.options }).result
  assert.deepEqual(result.thinking, body.thinking)
  checks++
  assert.ok(result.betas.includes('fixture-gate'))
  checks++
  assert.ok(result.betas.includes('per-turn-control-2026-07-01'))
  checks++
  assert.ok(native.frames.some((frame) => frame.type === 'job_done'))
  checks++
  const preserved = await verifyKernelWireSource(sem, kind)
  return {
    ok: true,
    kind,
    checks: checks + preserved.checks,
    request_checks: checks,
    preserved_checks: preserved.checks,
    scope: 'actual native/bridge/API/gate source; fake external SDK/config, no provider or shipped Linux execution',
  }
}
