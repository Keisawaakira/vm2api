import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { streamGoWorker } from '../../src/lib/transport/go-worker-client.mjs'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { finalizeAssembledAssistantHop, mergeAssembledAssistantHop } from '../../src/lib/core/errors.mjs'
import { classifyUpstreamResult } from '../../src/lib/pool/upstream-error-policy.mjs'
import { runApiInference } from '../../src/lib/pool/api-protocol.mjs'
import * as converters from '../../src/lib/protocol/convert.mjs'

const frame = (event) => `data: ${JSON.stringify(event)}\n\n`
const usage = { input_tokens: 80, cache_read_input_tokens: 20, output_tokens: 6 }
const start = { type: 'message_start', message: { type: 'message', role: 'assistant', content: [], usage } }
const block = { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
const text = { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } }
const stop = { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } }
const end = { type: 'message_stop' }
const failure = { type: 'error', error: { type: 'api_error', message: 'synthetic upstream failure' } }
const partial = [start, block, text].map(frame)
const complete = [...partial, frame(stop), frame(end)]

// Exercise the real readers without Unix sockets, credentials, subprocesses or upstream calls.
function mockHttp(t, chunks, { headers = {}, trailers = {}, readError } = {}) {
  t.mock.method(http, 'request', (_options, callback) => {
    const request = new EventEmitter()
    let response
    request.write = () => {}
    request.destroy = (error) => (response ? response.destroy(error) : request.emit('error', error))
    request.end = () =>
      queueMicrotask(() => {
        response = Readable.from(
          (async function* () {
            for (const chunk of chunks) yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            if (readError) throw readError
          })(),
        )
        Object.assign(response, { statusCode: 200, headers, trailers })
        response.once('close', () => request.emit('close'))
        callback(response)
      })
    return request
  })
}

async function worker(t, chunks, options) {
  mockHttp(t, chunks, options)
  return streamGoWorker({
    exec: { vm: { runtime: { worker_socket: 'in-memory-only' } } },
    envelope: {},
    timeoutMs: 1000,
    onEvent() {},
  })
}

class Response extends EventEmitter {
  text = ''
  headersSent = false
  destroyed = false
  writableEnded = false
  statusCode = 200
  write(value) {
    this.text += value
  }
  end() {
    this.writableEnded = true
    this.emit('finish')
  }
}

async function handler(
  t,
  {
    backend = 'api',
    chunks = complete,
    readError,
    vmResult,
    deliveryMode = 'realtime',
    includeUsage = false,
    protocol = 'openai.chat',
    clientStream = true,
    disconnect = false,
  } = {},
) {
  if (backend === 'api') mockHttp(t, chunks, { readError })
  const res = new Response()
  if (disconnect) {
    res.write = (value) => {
      res.text += value
      res.destroyed = true
      res.emit('close')
    }
  }
  const req = Object.assign(new EventEmitter(), {
    method: 'POST',
    url: '/v1/chat/completions',
    apiKeyKind: 'master',
    headers: {
      'user-agent': 'test-client',
      ...(backend === 'api' ? { 'x-kin-backend': 'api' } : {}),
      'x-kin-delivery': deliveryMode,
    },
  })
  const stats = { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 }
  let recorded
  const h = createHandleProtocol({
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 100000, upstream_timeout_ms: 1000 },
      paths: { data: path.join(os.tmpdir(), 'kin-no-files-read-fixture') },
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
      ...(protocol === 'openai.completions'
        ? { prompt: 'fixture question' }
        : { messages: [{ role: 'user', content: 'fixture question' }] }),
      ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
    }),
    requireAuth: () => true,
    requestLog: {
      start: () => ({ request_id: 'synthetic' }),
      finish: (_ctx, value) => {
        recorded = value
      },
    },
    stickyRouter: {},
    accountQuota: { ingestHeaders() {} },
    apiKeyStore: {},
    apiEndpointStore: {},
    apiScheduler: {
      pick: () => ({
        ok: true,
        endpoint: { id: 'ep-test', kind: 'claude', protocol: 'anthropic', base_url: 'https://example.invalid' },
        upstream_model: 'claude-opus-4-6',
        key: { id: 'key-test', api_key: 'synthetic' },
      }),
    },
    failoverRunner: {
      run: async () => {
        res.headersSent = true
        res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')
        return vmResult
      },
    },
    groupsRepo: { rateMultiplier: () => 1 },
    stats,
    routingConfig: { compatibility: { persona_preset: 'zero' }, failover: { stream_keepalive_ms: 0 } },
  })
  await h.handleProtocol(req, res, protocol, '/v1/chat/completions')
  return { res, stats, recorded, req }
}

function events(res) {
  return res.text
    .split('\n')
    .filter((line) => line.startsWith('data: ') && !line.includes('[DONE]'))
    .map((line) => JSON.parse(line.slice(6)))
}

for (const terminal of ['incomplete', 'error', 'transport_error', 'rejected']) {
  test(`negative worker terminal ${terminal} survives assistant/pool finalization`, async (t) => {
    const result = await worker(t, complete, { trailers: { 'x-kin-terminal-state': terminal } })
    assert.equal(result.ok, false)
    assert.ok(result.body.error)
    assert.equal(finalizeAssembledAssistantHop(result).ok, false)
    assert.notEqual(classifyUpstreamResult(result).scope, 'success')
  })
}

test('EOF remainder error is observed, not just forwarded', async (t) => {
  const result = await worker(t, [...complete, frame(failure).trimEnd()])
  assert.equal(result.ok, false)
  assert.equal(result.body.error.message, failure.error.message)
})

test('worker and JSON assembly retain authoritative merged trailer usage', async (t) => {
  const finalUsage = { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 9 }
  const result = await worker(t, complete, { trailers: { 'x-kin-usage': JSON.stringify(finalUsage) } })
  assert.deepEqual(result.usage, finalUsage)
  assert.deepEqual(result.body.usage, finalUsage)
  const olderAssembly = { ...result.body, usage }
  const assembled = mergeAssembledAssistantHop(result, olderAssembly)
  assert.deepEqual(assembled.usage, finalUsage)
  assert.deepEqual(assembled.body.usage, finalUsage)
})

test('worker failure retains usage already observed before the reset', async (t) => {
  const result = await worker(t, partial, {
    readError: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.usage?.input_tokens, 80)
  assert.equal(result.usage?.cache_read_input_tokens, 20)
})

test('split UTF-8 is decoded incrementally by the worker', async (t) => {
  const bytes = Buffer.from(complete.join(''))
  const cut = bytes.indexOf(Buffer.from('你')) + 1
  const result = await worker(t, [bytes.subarray(0, cut), bytes.subarray(cut)])
  assert.equal(result.ok, true)
  assert.equal(result.body.content[0].text, '你好')
})

test('missing message_stop compatibility still requires visible content and a stop reason', async (t) => {
  const result = await worker(t, [...partial, frame(stop)])
  assert.equal(result.ok, true)
})

for (const deliveryMode of ['realtime', 'verified']) {
  test(`API ${deliveryMode} forwards one SSE error and never success DONE`, async (t) => {
    const { res } = await handler(t, { chunks: [...partial, frame(failure)], deliveryMode })
    assert.equal(events(res).filter((event) => event.error).length, 1)
    assert.doesNotMatch(res.text, /\[DONE\]/)
    assert.equal(res.writableEnded, true)
  })
}

test('API clean truncated EOF cannot claim success from text mentioning message_stop', async (t) => {
  const fakeStop = frame({ ...text, delta: { type: 'text_delta', text: 'message_stop is only text' } })
  const { res } = await handler(t, { chunks: [frame(start), frame(block), fakeStop], deliveryMode: 'verified' })
  assert.equal(events(res).filter((event) => event.error).length, 1)
  assert.doesNotMatch(res.text, /\[DONE\]/)
})

test('API read reset after visible output is finalized in-band, not thrown to server catch', async (t) => {
  const { res } = await handler(t, {
    chunks: partial,
    readError: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
  })
  assert.equal(events(res).filter((event) => event.error).length, 1)
  assert.doesNotMatch(res.text, /\[DONE\]/)
  assert.equal(res.writableEnded, true)
})

test('VM upstream ECONNRESET with a live client is not silent cancellation', async (t) => {
  const vmResult = {
    ok: false,
    committed: true,
    transportError: true,
    status: 0,
    body: { type: 'error', error: { type: 'worker_error', code: 'ECONNRESET', message: 'read ECONNRESET' } },
  }
  const { res, recorded } = await handler(t, { backend: 'oauth', vmResult })
  assert.equal(events(res).filter((event) => event.error).length, 1)
  assert.doesNotMatch(res.text, /\[DONE\]/)
  assert.notEqual(recorded.error_code, 'client_cancelled')
})

test('explicit failed complete-looking output cannot be promoted by assembly, policy or handler', async (t) => {
  const vmResult = {
    ok: false,
    committed: true,
    transportError: true,
    terminalState: 'incomplete',
    status: 200,
    body: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'partial' }],
      stop_reason: 'end_turn',
      usage,
    },
  }
  const finalized = finalizeAssembledAssistantHop(vmResult)
  assert.equal(finalized.ok, false)
  assert.equal(finalized.committed, true)
  assert.equal(mergeAssembledAssistantHop(vmResult, vmResult.body), vmResult)
  assert.notEqual(classifyUpstreamResult(finalized).scope, 'success')
  const { res } = await handler(t, { backend: 'oauth', vmResult })
  assert.equal(events(res).filter((event) => event.error).length, 1)
  assert.doesNotMatch(res.text, /\[DONE\]/)
})

test('VM final logging uses transport usage rather than an older body snapshot', async (t) => {
  const finalUsage = { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 9 }
  const vmResult = {
    ok: true,
    status: 200,
    usage: finalUsage,
    body: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
      usage,
    },
  }
  const { recorded } = await handler(t, { backend: 'oauth', vmResult })
  assert.deepEqual(recorded.usage, finalUsage)
})

test('API trailing usage is opt-in, singular and precedes DONE', async (t) => {
  const { res } = await handler(t, { includeUsage: true })
  assert.equal(events(res).filter((event) => Array.isArray(event.choices) && event.choices.length === 0).length, 1)
  assert.equal((res.text.match(/\[DONE\]/g) || []).length, 1)
  assert.equal(res.text.trimEnd().endsWith('data: [DONE]'), true)
})

test('API does not add an empty-choices usage chunk when it was not requested', async (t) => {
  const { res } = await handler(t)
  assert.equal(events(res).filter((event) => Array.isArray(event.choices) && event.choices.length === 0).length, 0)
})

for (const code of ['aborted', 'ECONNRESET']) {
  test(`VM connected-client ${code}/context canceled remains an upstream failure`, async (t) => {
    const vmResult = {
      ok: false,
      committed: true,
      transportError: true,
      status: 0,
      body: { type: 'error', error: { type: 'worker_error', code, message: 'upstream context canceled' } },
    }
    const { res, stats, recorded } = await handler(t, { backend: 'oauth', vmResult })
    assert.equal(events(res).filter((event) => event.error).length, 1)
    assert.notEqual(events(res).find((event) => event.error).error.code, 'client_cancelled')
    assert.notEqual(recorded.error_code, 'client_cancelled')
    assert.equal(stats.errors, 1)
  })
}

for (const protocol of ['anthropic.messages', 'openai.completions']) {
  test(`API ${protocol} shares error deduplication even if stop follows error`, async (t) => {
    const { res, stats, recorded } = await handler(t, {
      protocol,
      chunks: [...partial, frame(failure), frame(failure), frame(stop), frame(end)],
    })
    assert.equal(events(res).filter((event) => event.error || event.type === 'error').length, 1, res.text)
    assert.doesNotMatch(res.text, /\[DONE\]|response.completed|event: message_stop/)
    assert.equal(stats.errors, 1)
    assert.deepEqual(recorded.usage, usage)
  })
}

for (const chunks of [[frame(failure)], [...partial, frame(failure), frame(stop), frame(end)]]) {
  test(`API nonstream ${chunks.length === 1 ? 'error-only' : 'partial then error'} remains an error envelope`, async (t) => {
    const { res, recorded } = await handler(t, { chunks, clientStream: false })
    const body = JSON.parse(res.text)
    assert.ok(res.statusCode >= 400)
    assert.equal(body.error.message, failure.error.message)
    if (chunks.length > 1) assert.deepEqual(recorded.usage, usage)
  })
}

test('API nonstream read failure is returned rather than thrown', async (t) => {
  const { res, recorded } = await handler(t, {
    chunks: partial,
    clientStream: false,
    readError: Object.assign(new Error('context canceled'), { code: 'ECONNRESET' }),
  })
  assert.equal(res.statusCode, 502)
  assert.notEqual(JSON.parse(res.text).error.code, 'client_cancelled')
  assert.deepEqual(recorded.usage, usage)
})

for (const deliveryMode of ['realtime', 'verified']) {
  test(`API ${deliveryMode} truncated EOF fails even without a transport exception`, async (t) => {
    const { res, stats } = await handler(t, { chunks: partial, deliveryMode })
    assert.equal(events(res).filter((event) => event.error).length, 1)
    assert.doesNotMatch(res.text, /\[DONE\]/)
    assert.equal(stats.errors, 1)
  })
}

test('API disconnect after request upload suppresses subsequent output and cleans listeners', async (t) => {
  const { res, req, stats } = await handler(t, { disconnect: true, chunks: [...partial, frame(failure)] })
  assert.equal(events(res).length, 1)
  assert.equal(events(res).filter((event) => event.error).length, 0)
  assert.doesNotMatch(res.text, /\[DONE\]/)
  assert.equal(stats.errors, 0)
  assert.equal(req.listenerCount('aborted'), 0)
  assert.equal(res.listenerCount('close'), 0)
})

test('API legacy completions opted-in tail carries usage with the legacy object shape', async (t) => {
  const { res } = await handler(t, { protocol: 'openai.completions', includeUsage: true })
  const chunks = events(res)
  assert.ok(chunks.every((chunk) => chunk.object === 'text_completion'))
  assert.ok(chunks.slice(0, -1).every((chunk) => chunk.usage === null))
  assert.deepEqual(chunks.at(-1).choices, [])
  assert.equal(chunks.at(-1).usage.completion_tokens, 6)
  assert.equal(chunks.at(-1).usage.prompt_tokens_details.cached_tokens, 20)
  assert.equal(chunks.at(-1).usage.total_tokens, chunks.at(-1).usage.prompt_tokens + 6)
  assert.equal((res.text.match(/\[DONE\]/g) || []).length, 1)
})

test('API Chat raw usage and opted-in client tail both bypass persona hiding', async (t) => {
  mockHttp(t, complete)
  const res = new Response()
  const result = await runApiInference({
    cfg: { paths: { data: 'in-memory' } },
    res,
    scheduler: {
      pick: () => ({
        ok: true,
        endpoint: { id: 'ep-test', kind: 'claude', protocol: 'anthropic', base_url: 'https://example.invalid' },
        upstream_model: 'claude-opus-4-6',
        key: { id: 'key-test', api_key: 'synthetic' },
      }),
    },
    protocol: 'openai.chat',
    clientStream: true,
    deliveryMode: 'verified',
    timeoutMs: 1000,
    inbound: { model: 'claude-opus-4-6', stream_options: { include_usage: true } },
    convertedBody: { model: 'claude-opus-4-6', messages: [{ role: 'user', content: 'hi' }] },
    personaHideTokens: 18,
    converters: {
      ...converters,
      writeSSEHeaders: (response) => {
        response.headersSent = true
      },
    },
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.usage, usage)
  assert.deepEqual(result.body.usage, usage)
  const tail = events(res).at(-1)
  assert.deepEqual(tail.choices, [])
  assert.equal(tail.usage.prompt_tokens, 100)
  assert.equal(tail.usage.prompt_tokens_details.cached_tokens, 20)
  assert.ok(
    events(res)
      .slice(0, -1)
      .every((chunk) => chunk.usage === null),
  )
})

test('negative worker header wins over a positive trailer', async (t) => {
  const result = await worker(t, complete, {
    headers: { 'x-kin-terminal-state': 'failed' },
    trailers: { 'x-kin-terminal-state': 'verified' },
  })
  assert.equal(result.ok, false)
  assert.equal(result.terminalState, 'failed')
  assert.notEqual(classifyUpstreamResult(result).scope, 'success')
})

test('positive worker metadata cannot rescue an empty body without a real message_stop', async (t) => {
  const result = await worker(t, [frame(start)], {
    trailers: { 'x-kin-terminal-state': 'verified', 'x-kin-stop-reason': 'end_turn' },
  })
  assert.equal(result.ok, false)
  assert.equal(result.committed, false)
})

for (const content of [[], [{ type: 'thinking', thinking: 'offline plan', signature: 'sig' }]]) {
  test(`real message_stop completes ${content.length ? 'thinking-only' : 'empty'} content without inventing a stop reason`, async (t) => {
    const result = await worker(t, [frame({ ...start, message: { ...start.message, content } }), frame(end)])
    assert.equal(result.ok, true)
    assert.equal(result.sawMessageStop, true)
    assert.equal(result.stopReason, null)
    assert.equal(finalizeAssembledAssistantHop(result).ok, true)
    // A caller may defer downstream commitment; the terminal event still ends this hop.
    assert.equal(classifyUpstreamResult({ ...result, committed: false }).scope, 'success')
  })
}

test('a real message_stop cannot override an explicit empty-stream failure', async (t) => {
  const result = await worker(t, [frame(start), frame(end), frame(failure)], {
    trailers: { 'x-kin-terminal-state': 'failed' },
  })
  assert.equal(result.ok, false)
  assert.equal(result.sawMessageStop, true)
  assert.equal(finalizeAssembledAssistantHop(result).ok, false)
})

test('an empty final message_stop keeps prior buffered Chat content through merge', async (t) => {
  const chunks = [...complete, frame(start), frame(end)]
  const result = await worker(t, chunks)
  const assembler = converters.createClaudeMessageAssembler({ chat: true })
  for (const chunk of chunks)
    for (const line of chunk.split('\n')) converters.applyClaudeSSELineToMessage(line, assembler)
  const merged = mergeAssembledAssistantHop(result, assembler.message)
  assert.equal(result.sawMessageStop, true)
  assert.equal(converters.fromClaudeToOpenAIChat(merged.body, 'claude-opus-4-6').choices[0].message.content, '你好')
})

test('a previous sequence terminal does not complete a later partial message', async (t) => {
  const result = await worker(t, [...complete, frame(start), frame(block), frame(text)])
  assert.equal(result.ok, false)
  assert.equal(result.sawMessageStop, false)
  assert.equal(result.stopReason, null)
})

test('split UTF-8 is decoded incrementally by the API adapter', async (t) => {
  const bytes = Buffer.from(complete.join(''))
  const cut = bytes.indexOf(Buffer.from('你')) + 1
  const { res } = await handler(t, { chunks: [bytes.subarray(0, cut), bytes.subarray(cut)] })
  assert.equal(
    events(res)
      .map((event) => event.choices?.[0]?.delta?.content || '')
      .join(''),
    '你好',
  )
})
