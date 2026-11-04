import assert from 'node:assert/strict'
import { runtimeControlContext } from './fixed-runtime-controls.mjs'
import { sealClaudeCodeCch } from '../../src/lib/identity/cch.mjs'
import { NATIVE_CHAT_CONTEXT } from '../../src/lib/protocol/chat-messages.mjs'

export async function nativeFetchControl(sem, kind) {
  const { context: ctx, requests } = runtimeControlContext(sem.runtime_wire)
  let checks = 0
  const billing = 'x-anthropic-billing-header: cc_version=fixture; cc_entrypoint=sdk-cli; cch=00000;'
  for (const enabled of [false, true]) for (const bytes of [false, true]) {
    ctx.config = { cch_enabled: enabled }
    const caller = [
      { type: 'text', text: 'x-anthropic-billing-header: cch=abcde; caller literal' },
      { type: 'text', text: '# Environment\nKEEP', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: '' },
    ]
    const body = {
      model: 'claude-opus-4-6', max_tokens: 128000,
      system: [{ type: 'text', text: billing }, ...caller],
      messages: [{ role: 'user', content: '中文🙂' }],
      request_context: { ...NATIVE_CHAT_CONTEXT, caller_system_tail_count: caller.length },
    }
    const original = JSON.stringify(body, null, 2)
    const headers = new Headers({ 'Content-Type': 'application/json', 'Content-Length': '1', 'x-custom': 'keep' })
    const dispatcher = { key: 'original-dispatcher' }
    const reply = await ctx.buildFetch(undefined, 'fixture-source')('https://fixture.invalid/v1/messages', {
      method: 'POST', headers, body: bytes ? new TextEncoder().encode(original) : original, dispatcher,
    })
    const observed = requests.at(-1)
    const text = typeof observed.init.body === 'string' ? observed.init.body : new TextDecoder().decode(observed.init.body)
    const final = JSON.parse(text)
    assert.equal(reply.fixture, true)
    assert.equal(observed.init.dispatcher, dispatcher)
    assert.equal(observed.input, 'https://fixture.invalid/v1/messages')
    assert.equal(observed.init.headers.get('content-length'), String(Buffer.byteLength(text)))
    assert.equal(headers.get('content-length'), '1')
    assert.equal(observed.init.headers.get('x-custom'), 'keep')
    assert.equal(final.request_context, undefined)
    assert.deepEqual(final.system.slice(1), caller)
    assert.deepEqual(final.messages, body.messages)
    assert.equal(JSON.stringify(body, null, 2), original)
    assert.ok(enabled ? !final.system[0].text.includes('cch=00000;') : final.system[0].text.includes('cch=00000;'))
    checks += 11
  }
  for (const bad of [-1, 100, 0.5, null, '0']) {
    const body = { model: 'claude-opus-4-6', system: [{ type: 'text', text: billing }], request_context: { ...NATIVE_CHAT_CONTEXT, caller_system_tail_count: bad } }
    const before = requests.length
    await assert.rejects(() => ctx.buildFetch(undefined, 'fixture-source')('https://fixture.invalid/v1/messages', { body: JSON.stringify(body) }), /native_caller_system_count_invalid/)
    assert.equal(requests.length, before)
    checks += 2
  }
  const plainBody = { model: 'claude-opus-4-6', system: [{ type: 'text', text: billing }], messages: [{ role: 'user', content: 'x' }] }
  assert.deepEqual(JSON.parse(ctx.__vm1437StampWire(JSON.stringify(plainBody), true)), sealClaudeCodeCch(plainBody))
  assert.equal(ctx.__vm1437CallerContext({ request_context: { protocol: 'anthropic.messages', preserve_caller_system: true } }), false)
  checks += 2
  return { ok: true, checks, kind, original_dispatcher_retained: true, real_provider_requests: 0 }
}
