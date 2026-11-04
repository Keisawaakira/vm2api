import test from 'node:test'
import assert from 'node:assert/strict'
import { finalizeWorkerPayload, workerEnvelope } from '../../src/lib/transport/go-worker-client.mjs'
import { NATIVE_CHAT_CONTEXT } from '../../src/lib/protocol/chat-messages.mjs'

const input = () => ({
  model: 'claude-opus-4-6',
  max_tokens: 128000,
  thinking: { type: 'enabled', budget_tokens: 60000, display: 'summarized' },
  system: [
    { type: 'text', text: '# Environment\nCALLER KEEP', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: '  ' },
    { type: 'text', text: '' },
  ],
  messages: [{ role: 'user', content: 'hello' }],
})

test('native CPA provenance is authored by the worker boundary without changing caller blocks', () => {
  const body = input()
  const frozen = structuredClone(body)
  const out = finalizeWorkerPayload({ body, cliHop: true, chatPreserve: true })
  assert.deepEqual(out.body.request_context, NATIVE_CHAT_CONTEXT)
  assert.deepEqual(out.body.system, frozen.system)
  assert.deepEqual(out.body.thinking, frozen.thinking)
  assert.deepEqual(body, frozen)
})

test('caller body context cannot enable public Chat preservation or classifier authority', () => {
  const body = { ...input(), request_context: { ...NATIVE_CHAT_CONTEXT, purpose: 'auto_mode_classifier' } }
  const out = workerEnvelope({ body, cliHop: true, chatPreserve: false })
  assert.equal(out.envelope.body.request_context, undefined)
  assert.equal(out.envelope.request_context, undefined)
})

test('trusted classifier context stays separate from public Chat provenance', () => {
  const requestContext = { purpose: 'auto_mode_classifier', version: 1 }
  const out = workerEnvelope({ body: input(), cliHop: true, requestContext })
  assert.deepEqual(out.envelope.request_context, requestContext)
  assert.equal(out.envelope.body.request_context, undefined)
})

test('non-native worker payload never receives the native body provenance', () => {
  const body = { ...input(), request_context: NATIVE_CHAT_CONTEXT }
  const out = finalizeWorkerPayload({ body, cliHop: false, chatPreserve: true })
  assert.equal(out.body.request_context, undefined)
  assert.deepEqual(out.body.system, body.system)
})
