import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { registerHooks } from 'node:module'

// Replace only native process orchestration. The real handler, worker HTTP reader,
// converter, usage finalizer and terminal helper all run; no services or sockets.
const workerUrl = new URL('../../src/lib/transport/go-worker-client.mjs', import.meta.url).href
const routerUrl = new URL('../../src/lib/transport/kernel-router.mjs', import.meta.url).href
const hook = registerHooks({
  load(url, context, nextLoad) {
    if (url === routerUrl)
      return {
        format: 'module',
        shortCircuit: true,
        source: `import { streamGoWorker } from ${JSON.stringify(workerUrl)};
        export function dispatchStreamInference(options) {
          return streamGoWorker({ ...options, envelope: {} });
        }`,
      }
    return nextLoad(url, context)
  },
})
const { createHandleProtocol } = await import('../../src/lib/protocol/handle-protocol.mjs')
hook.deregister()

const frame = (event) => `data: ${JSON.stringify(event)}\n\n`
const initialUsage = { input_tokens: 80, cache_read_input_tokens: 20, output_tokens: 6 }
const finalUsage = { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 9 }
const events = [
  { type: 'message_start', message: { type: 'message', role: 'assistant', content: [], usage: initialUsage } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'hello' } },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } },
  { type: 'message_stop' },
]
const decode = (res) =>
  res.text
    .split('\n')
    .filter((line) => line.startsWith('data: ') && !line.includes('[DONE]'))
    .map((line) => JSON.parse(line.slice(6)))

async function run(
  t,
  {
    protocol = 'openai.chat',
    includeUsage = true,
    failure = false,
    disconnect = false,
    clientStream = true,
    afterStop,
    sourceEvents = events,
    headers = {},
    trailers = {},
  } = {},
) {
  let signal
  let calls = 0
  t.mock.method(http, 'request', (options, callback) => {
    signal = options.signal
    calls++
    const request = new EventEmitter()
    request.write = () => {}
    request.end = () =>
      queueMicrotask(() => {
        const response = Readable.from(
          (async function* () {
            for (const event of sourceEvents) yield Buffer.from(frame(event))
            if (afterStop) await afterStop(res)
          })(),
        )
        Object.assign(response, {
          statusCode: 200,
          headers,
          trailers: {
            'x-kin-usage': JSON.stringify(finalUsage),
            'x-kin-terminal-state': failure ? 'failed' : 'verified',
            ...trailers,
          },
        })
        response.once('close', () => request.emit('close'))
        callback(response)
      })
    request.destroy = (error) => request.emit('error', error)
    return request
  })
  const req = Object.assign(new EventEmitter(), {
    method: 'POST',
    url: '/v1/chat/completions',
    apiKeyKind: 'master',
    headers: { 'user-agent': 'test-client' },
  })
  const res = Object.assign(new EventEmitter(), {
    text: '',
    headersSent: false,
    destroyed: false,
    writableEnded: false,
    write(chunk) {
      this.text += chunk
      if (disconnect) {
        this.destroyed = true
        this.emit('close')
      }
    },
    end() {
      this.writableEnded = true
      this.emit('finish')
    },
  })
  let recorded
  const stats = { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 }
  const candidate = { vmId: 'vm-test', exec: { vm: { runtime: { worker_socket: 'in-memory-only' } } } }
  const h = createHandleProtocol({
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 100000, upstream_timeout_ms: 1000 },
      paths: { data: 'in-memory-only' },
    },
    settings: { get: () => false },
    json: (response, status, body) => {
      response.statusCode = status
      response.write(JSON.stringify(body))
      response.end()
    },
    writeSSEHeaders: (response) => {
      response.headersSent = true
    },
    readBody: async () => ({
      model: 'claude-opus-4-6',
      stream: clientStream,
      max_tokens: 1000,
      ...(protocol === 'openai.completions' ? { prompt: 'hi' } : { messages: [{ role: 'user', content: 'hi' }] }),
      ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
    }),
    requireAuth: () => true,
    requestLog: {
      start: () => ({ request_id: 'synthetic-worker' }),
      finish: (_ctx, value) => {
        recorded = value
      },
    },
    stickyRouter: {},
    accountQuota: {},
    apiKeyStore: {},
    apiEndpointStore: {},
    apiScheduler: {},
    failoverRunner: {
      run: async (options) =>
        options.callAttempt({ candidate, body: options.canonicalBody, signal: options.signal, onCommit() {} }),
    },
    groupsRepo: { rateMultiplier: () => 1 },
    stats,
    routingConfig: { compatibility: { persona_preset: 'zero' }, failover: { stream_keepalive_ms: 0 } },
  })
  await h.handleProtocol(req, res, protocol, req.url)
  assert.equal(req.listenerCount('aborted'), 0)
  assert.equal(res.listenerCount('close'), 0)
  return { res, recorded, signal, stats, calls }
}

test('VM handler waits beyond message_stop and emits one reconciled usage tail before DONE', async (t) => {
  const { res, recorded, signal, calls } = await run(t, {
    afterStop: async (response) => {
      // message_stop has been consumed, but transport EOF/trailers have not finalized.
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(decode(response).filter((chunk) => chunk.choices?.length === 0).length, 0)
      assert.doesNotMatch(response.text, /\[DONE\]/)
    },
  })
  const chunks = decode(res)
  assert.equal(chunks.filter((chunk) => chunk.choices?.length === 0).length, 1)
  assert.equal(chunks.at(-1).usage.prompt_tokens_details.cached_tokens, 90)
  assert.equal(chunks.at(-1).usage.completion_tokens, 9)
  assert.ok(chunks.slice(0, -1).every((chunk) => chunk.usage === null))
  assert.deepEqual(recorded.usage, finalUsage)
  assert.equal(res.text.trimEnd().endsWith('data: [DONE]'), true)
  assert.equal(signal.aborted, false)
  assert.equal(calls, 1)
})

for (const protocol of ['openai.chat', 'anthropic.messages']) {
  test(`VM ${protocol} rejects complete-looking output with failed trailers`, async (t) => {
    const { res, recorded, stats, calls } = await run(t, { protocol, failure: true })
    assert.equal(decode(res).filter((event) => event.error).length, 1)
    assert.doesNotMatch(res.text, /\[DONE\]/)
    assert.equal(decode(res).filter((event) => event.choices?.length === 0).length, 0)
    assert.deepEqual(recorded.usage, finalUsage)
    assert.equal(stats.errors, 1)
    assert.equal(calls, 1)
  })
}

test('VM client disconnect aborts its own signal and suppresses subsequent chunks', async (t) => {
  const { res, signal, stats, calls } = await run(t, { disconnect: true, failure: true })
  assert.equal(signal.aborted, true)
  assert.equal(decode(res).length, 1)
  assert.doesNotMatch(res.text, /\[DONE\]|"error"/)
  assert.equal(stats.errors, 0)
  assert.equal(calls, 1)
})

test('VM nonstream assembly uses trailer usage rather than the callback snapshot', async (t) => {
  const { res, recorded } = await run(t, { clientStream: false })
  assert.equal(res.statusCode, 200)
  assert.equal(JSON.parse(res.text).usage.prompt_tokens_details.cached_tokens, 90)
  assert.deepEqual(recorded.usage, finalUsage)
})

for (const [protocol, includeUsage, metadataSource] of [
  ['openai.chat', true, 'trailers'],
  ['openai.chat', false, 'headers'],
  ['openai.completions', true, 'trailers'],
]) {
  test(`VM ${protocol} metadata-only stop finalizes once (usage=${includeUsage}, ${metadataSource})`, async (t) => {
    const { res, recorded } = await run(t, {
      protocol,
      includeUsage,
      sourceEvents: events.slice(0, 2),
      [metadataSource]: { 'x-kin-stop-reason': 'max_tokens' },
    })
    const chunks = decode(res)
    const terminals = chunks.filter((chunk) => chunk.choices?.[0]?.finish_reason)
    assert.equal(terminals.length, 1)
    assert.equal(terminals[0].choices[0].finish_reason, 'length')
    assert.equal(chunks.filter((chunk) => chunk.choices?.length === 0).length, includeUsage ? 1 : 0)
    if (includeUsage) {
      assert.equal(chunks.at(-1).usage.prompt_tokens_details.cached_tokens, 90)
      assert.equal(chunks.at(-1).usage.completion_tokens, 9)
      assert.ok(chunks.slice(0, -1).every((chunk) => chunk.usage === null))
    }
    assert.deepEqual(recorded.usage, finalUsage)
    assert.equal((res.text.match(/\[DONE\]/g) || []).length, 1)
    assert.equal(res.text.trimEnd().endsWith('data: [DONE]'), true)
  })
}
