import assert from 'node:assert/strict'
import { callerSystemControl } from './fixed-caller-cache-controls.mjs'
import { requestWireApiControl, requestWireBridgeControl } from './fixed-request-wire-api.mjs'
import { NATIVE_CHAT_CONTEXT } from '../../src/lib/protocol/chat-messages.mjs'
import { nativeFetchControl } from './fixed-native-fetch-controls.mjs'
import { nativeRunnerControl } from './fixed-native-runner-controls.mjs'
import { telemetryFactoryControl } from './fixed-native-telemetry-controls.mjs'

const plain = value => JSON.parse(JSON.stringify(value))

/** Request construction uses real embedded functions. SDK, identity and config are explicit external seams. */
export async function verifyNativeRefreshSource(sem, kind) {
  let checks = 0
  const systems = [
    [], [{ type: 'text', text: '' }, { type: 'text', text: ' \n\t ' }],
    [{ type: 'text', text: '# Environment\nKEEP' }, { type: 'text', text: 'You are Claude Code\nKEEP ALSO' }],
    [{ type: 'text', text: 'x-anthropic-billing-header: cch=abcde; caller literal' }, { type: 'text', text: 'rule', cache_control: { type: 'ephemeral' } }],
    [{ type: 'text', text: 'rule-one', cache_control: { type: 'ephemeral', ttl: '1h' } }, { type: 'text', text: 'rule-two', cache_control: { type: 'ephemeral', ttl: '5m' } }],
    Array.from({ length: 80 }, (_, i) => ({ type: 'text', text: `${i}: 中文🙂\n` })),
  ]
  for (const mode of ['zero','identity','official_full','stock']) for (const system of systems) {
    const body = {
      model: 'claude-opus-4-6', max_tokens: 128000,
      request_context: { ...NATIVE_CHAT_CONTEXT },
      system: structuredClone(system),
      thinking: { type: 'enabled', budget_tokens: 60000, display: 'summarized' },
      output_config: { effort: 'max' },
      tools: [{ name: 'fixture', input_schema: { type: 'object' }, eager_input_streaming: false }],
      messages: [
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'prior', signature: 'fixture-signature' }, { type: 'text', text: '<content>history</content>' }] },
        { role: 'user', content: [{ type: 'text', text: 'question', cache_control: { type: 'ephemeral' } }] },
      ],
    }
    const frozen = JSON.stringify(body)
    const prefix = await callerSystemControl(sem, body, { mode })
    assert.deepEqual(system.length ? prefix.system.slice(-system.length) : [], system, `${kind}/${mode} caller block boundaries`)
    assert.ok(prefix.system.length >= system.length)
    checks += 2
    const bridged = await requestWireBridgeControl(sem.request_wire.query, {
      model: body.model, system: body.system.map(b => b.text), messages: [], thinking: { type: 'enabled', budgetTokens: 60000 },
      wireSystem: body.system, wireBody: body, wireMessages: body.messages, wireThinking: body.thinking,
      maxTokens: body.max_tokens, outputConfig: body.output_config, toolSchemas: body.tools,
    })
    assert.deepEqual(plain(bridged.options.wireBody), body)
    const wire = requestWireApiControl(sem, { body, options: bridged.options, constructedSystem: prefix.system, systemOwnership: prefix, cacheSource: sem.request_wire.cache }).result
    assert.deepEqual(wire.system, prefix.system)
    assert.deepEqual(wire.messages, body.messages)
    assert.deepEqual(wire.thinking, body.thinking)
    assert.deepEqual(wire.output_config, body.output_config)
    assert.deepEqual(wire.tools, body.tools)
    assert.equal(wire.max_tokens, body.max_tokens)
    assert.equal(wire.request_context.protocol, 'openai.chat')
    assert.equal(wire.request_context.caller_system_tail_count, system.length)
    assert.equal(wire.kin_outbound_shape, undefined)
    assert.equal(JSON.stringify(body), frozen)
    checks += 11
  }
  const fetch = await nativeFetchControl(sem, kind)
  const runner = await nativeRunnerControl(sem, kind)
  const telemetry = kind === 'cc'
    ? await telemetryFactoryControl(sem.native_refresh.telemetry_factory, sem.native_refresh.telemetry_bindings)
    : null
  checks += fetch.checks + runner.checks + (telemetry?.checks || 0)
  return { ok: true, checks, fetch, runner, telemetry, scope: 'real native prefix/bridge/constructor/CCH/owner; SDK, config and IO external seams; no shipped Linux/provider execution' }
}
