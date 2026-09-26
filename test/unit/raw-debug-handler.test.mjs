import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { registerHooks } from 'node:module'
import { readBody } from '../../src/lib/http/respond.mjs'
import { RequestLogStore } from '../../src/lib/admin/request-log.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { rawDebugActiveCount, createRawDebug, RAW_LIMITS } from '../../src/lib/admin/raw-debug.mjs'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'
import { candidate, mockWorker, frame, successEvents } from '../support/in-memory-worker.mjs'

const routerUrl = new URL('../../src/lib/transport/kernel-router.mjs', import.meta.url).href
const hook = registerHooks({
  load(url, context, nextLoad) {
    if (url === new URL('../../src/lib/protocol/handle-codex.mjs', import.meta.url).href)
      return {
        format: 'module',
        shortCircuit: true,
        source: `export { usageFromSseLine } from ${JSON.stringify(new URL('../../src/lib/protocol/handle-codex.mjs?raw-usage-helper', import.meta.url).href)};
        export async function handleCodexProtocol({res,json}) { return json(res,200,{mock_codex_dispatch:true}) }`,
      }
    if (url === routerUrl)
      return {
        format: 'module',
        shortCircuit: true,
        source: `import { dispatchStreamInference as dispatch } from ${JSON.stringify(`${routerUrl}?raw-debug-test`)};
      export function dispatchStreamInference(options) { return dispatch({ ...options,
        ensureRust: async () => ({ok:true}), ensureCredential: async () => ({ok:true}), recycleWrap: () => {} }); }`,
      }
    return nextLoad(url, context)
  },
})
const { createHandleProtocol } = await import('../../src/lib/protocol/handle-protocol.mjs')
hook.deregister()

function fixture(
  t,
  {
    mode = 'debug',
    enabled = true,
    respond,
    accounts = [candidate()],
    rules = [],
    authenticated = true,
    health,
    mutate,
    failSave = false,
    maxBody = 32 * 1024 * 1024,
    runnerConfig = {},
    apiStore = {},
    apiReload = () => {},
    destroyAfterFinish = false,
  } = {},
) {
  const sends = mockWorker(t, respond)
  const db = createDatabase({ dbPath: ':memory:' })
  const store = new RequestLogStore({ db, mode, rawNonstreamDebug: enabled })
  const saved = []
  const save = store.repo.insertDebugIfAbsent.bind(store.repo)
  store.repo.insertDebugIfAbsent = (...args) => {
    saved.push(structuredClone(args[2]))
    if (failSave) throw Error('SECRET DB ERROR')
    return save(...args)
  }
  t.after(() => {
    db.close()
    assert.equal(rawDebugActiveCount(), 0)
  })
  const scheduler = {
    selectAndReserve: async ({ excluded }) => {
      const selected = accounts.find((a) => !excluded.has(a.accountId) && !excluded.has(a.vmId))
      return selected ? { ...selected, ok: true, release() {} } : { ok: false, reason: 'no_eligible_accounts' }
    },
    markCooldown() {},
    markSuccess() {},
  }
  const runner = new FailoverRunner({ scheduler, config: { max_same_account_retries: 0, ...runnerConfig } })
  const handler = createHandleProtocol({
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules },
      distill: { enabled: false },
      limits: { max_body_bytes: maxBody, upstream_timeout_ms: 1000 },
      paths: {},
    },
    settings: { get: () => false },
    readBody: async (...args) => {
      const body = await readBody(...args)
      mutate?.(body)
      return body
    },
    requireAuth: (req, res) => {
      if (!authenticated) {
        res.statusCode = 401
        res.end()
      }
      return authenticated
    },
    json: (res, status, body) => {
      res.statusCode = status
      res.responseId = res._kinRequestId
      res.write(JSON.stringify(body))
      res.end()
    },
    writeSSEHeaders: (res) => {
      res.headersSent = true
    },
    requestLog: store,
    failoverRunner: runner,
    accountQuota: {},
    apiKeyStore: {},
    apiEndpointStore: apiStore,
    apiScheduler: {
      reload: apiReload,
      pick: (model) => ({
        ok: true,
        upstream_model: model,
        endpoint: { id: 'ep-test', kind: 'claude', protocol: 'anthropic', base_url: 'https://secret-url.invalid' },
        key: { id: 'key-test', api_key: 'SECRET_API_KEY', proxy_url: 'http://SECRET_PROXY' },
      }),
    },
    groupsRepo: { rateMultiplier: () => 1 },
    healthMonitor: health,
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfig: { failover: { stream_keepalive_ms: 0 } },
  })
  function start(body, { headers = {}, protocol = 'openai.chat', onResponse } = {}) {
    const original =
      typeof body === 'string'
        ? body
        : JSON.stringify({
            model: 'claude-sonnet-5',
            stream: false,
            messages: [{ role: 'user', content: 'hi' }],
            ...body,
          })
    const req = Object.assign(Readable.from([Buffer.from(original)]), {
      method: 'POST',
      url: '/v1/chat/completions',
      apiKeyKind: 'master',
      headers: { 'x-request-id': 'caller-id', ...headers },
    })
    const res = Object.assign(new EventEmitter(), {
      text: '',
      statusCode: 200,
      headersSent: false,
      destroyed: false,
      writableEnded: false,
      write(chunk) {
        this.text += chunk
        return true
      },
      end() {
        this.writableEnded = true
        if (!this.destroyed) this.writableFinished = true
        this.emit('finish')
        if (destroyAfterFinish) this.destroyed = true
        this.emit('close')
      },
    })
    onResponse?.(res, req)
    const done = handler
      .handleProtocol(req, res, protocol, req.url)
      .then(() => ({ res, req, original, record: store.repo.getDebug(res._kinRequestId, { includeRaw: true }) }))
    return { req, res, done }
  }
  return { start, run: async (...args) => start(...args).done, store, saved, sends }
}

for (const api of [false, true])
  test(`original >200k exact JSON + real finalized ${api ? 'API' : 'native'} send + observed SSE + protected derived`, async (t) => {
    const rawSse = Buffer.concat(successEvents.map(frame)).toString().replaceAll('\n', '\r\n') + ': tail🙂'
    const fx = fixture(t, {
      respond: () => ({
        readable: Readable.from([...Buffer.from(rawSse)].map((b) => Buffer.from([b]))),
        headers: { 'content-type': 'text/event-stream', authorization: 'SECRET_HEADER' },
        trailers: { 'x-kin-stop-reason': 'end_turn' },
      }),
      mutate: (body) => {
        body.messages.at(-1).content = 'postread mutation'
      },
    })
    const original =
      ' { "model":"claude-sonnet-5", "stream":false, "n":1e2, "n":2, "messages":[' +
      '{"role":"system","content":"# Environment\\nRULE🙂"},{"role":"developer","content":"' +
      'x'.repeat(210000) +
      '"},{"role":"user","content":"original"}] }\n'
    const { record, res } = await fx.run(original, { headers: api ? { 'x-kin-backend': 'api' } : {} })
    assert.equal(res.statusCode, 200, res.text)
    assert.notEqual(res.responseId, 'caller-id')
    assert.equal(record.caller_request_id, 'caller-id')
    assert.equal(record.raw_debug.caller.text, original)
    assert.equal(record.raw_debug.hops.length, 1)
    const hop = record.raw_debug.hops[0]
    assert.equal(hop.source, api ? 'node_api_kernel' : 'node_kernel')
    assert.equal(hop.response.text, rawSse)
    assert.equal(hop.response.format, 'sse')
    assert.equal(hop.response.read_complete, true)
    assert.equal(hop.outcome, 'success')
    const sent = api ? JSON.parse(fx.sends[0].envelope.body) : fx.sends[0].envelope.body
    assert.deepEqual(JSON.parse(hop.request.text), sent)
    assert.equal(sent.system[0].text, '# Environment\nRULE🙂')
    assert.equal(sent.system.length, 2)
    assert.equal(sent.messages.at(-1).content[0].text, 'postread mutation')
    assert.equal(JSON.parse(record.raw_debug.derived.client_json.text).object, 'chat.completion')
    assert.equal(fx.saved.length, 1)
    assert.equal(record.inbound_body, undefined)
    assert.equal(record.outbound_body, undefined)
    assert.doesNotMatch(JSON.stringify(record), /SECRET_API_KEY|SECRET_PROXY|secret-url|SECRET_HEADER/)
    assert.equal(fx.store.getDebug(res.responseId).raw_debug, undefined)
    // Complete real reader → HTTP boundary → saved DB → authorized route export chain.
    const exported = Object.assign(new EventEmitter(), {
      text: '',
      destroyed: false,
      writableEnded: false,
      writeHead(status, headers) {
        this.statusCode = status
        this.headers = headers
      },
      write(text) {
        this.text += text
        return true
      },
      end() {
        this.writableEnded = true
      },
    })
    const panel = createPanelHandler({
      cfg: { paths: {} },
      requestLog: fx.store,
      requireAuth(req) {
        req.apiKeyKind = 'master'
        return true
      },
      json() {
        assert.fail('expected raw JSONL response')
      },
    })
    const url = `/api/panel/request-logs/export?include_raw=1&include_muted=1&request_id=${res.responseId}`
    await panel({ method: 'GET', url }, exported, new URL(url, 'http://local'))
    const stored = fx.store.db
      .prepare('SELECT record_json FROM request_log_debug WHERE request_id=?')
      .get(res.responseId).record_json
    assert.equal(exported.text, stored + '\n')
    assert.equal(JSON.parse(exported.text).raw_debug.caller.text, original)
    assert.equal(JSON.parse(exported.text).raw_debug.hops[0].response.text, rawSse)
    if (process.env.M3_HANDLER_EXPORT_DIR)
      fs.writeFileSync(
        `${process.env.M3_HANDLER_EXPORT_DIR}/m3-${api ? 'api' : 'native'}-raw-export-sample.jsonl`,
        exported.text,
      )
  })

for (const control of [
  { name: 'toggle off', setup: { enabled: false } },
  { name: 'mode normal', setup: { mode: 'normal' } },
  { name: 'server off cannot header override', setup: { mode: 'off' }, headers: { 'x-kin-debug': '1' } },
  { name: 'stream true', body: { stream: true } },
  { name: 'stream omitted', body: { stream: undefined } },
  { name: 'stream zero', body: { stream: 0 } },
  { name: 'auth failure', setup: { authenticated: false } },
  { name: 'invalid JSON', body: '{ invalid' },
  { name: 'oversize', setup: { maxBody: 2 } },
  { name: 'non Chat', protocol: 'anthropic.messages' },
])
  test(`raw enrollment control: ${control.name}`, async (t) => {
    const fx = fixture(t, control.setup)
    const { res } = await fx.run(control.body || {}, { headers: control.headers, protocol: control.protocol })
    assert.equal(res._kinRequestId, 'caller-id')
    assert.equal(fx.saved.length, 0)
  })

test('effective debug header may enroll only when server toggle is true and server not off', async (t) => {
  const fx = fixture(t, { mode: 'normal' })
  const { record } = await fx.run({}, { headers: { 'x-kin-debug': '1' } })
  assert.ok(record.raw_debug)
})

test('same caller IDs are distinct; legacy public-ID reuse cannot overwrite or retimestamp raw', async (t) => {
  const fx = fixture(t)
  const a = await fx.run({})
  const b = await fx.run({})
  assert.notEqual(a.res.responseId, b.res.responseId)
  fx.store.setConfig({ rawNonstreamDebug: false })
  await fx.run({}, { headers: { 'x-request-id': a.res.responseId } })
  assert.deepEqual(fx.store.repo.getDebug(a.res.responseId, { includeRaw: true }), a.record)
})

test('local no-account and early health failure promote before JSON, never fabricate hop response', async (t) => {
  const fx = fixture(t, { accounts: [] })
  const { record, res } = await fx.run({})
  assert.notEqual(res.responseId, 'caller-id')
  assert.equal(record.raw_debug.status, 'not_sent')
  assert.deepEqual(record.raw_debug.hops, [])
  assert.equal(fx.saved.length, 1)
  const health = fixture(t, { health: { decide: () => ({ action: 'fail', via: 'health-test', snapshot: {} }) } })
  const early = await health.run({})
  assert.notEqual(early.res.responseId, 'caller-id')
  assert.equal(early.record.raw_debug.status, 'not_sent')
})

for (const api of [false, true])
  test(`precommit SSE error and malformed JSON rejection retained (${api ? 'api' : 'native'})`, async (t) => {
    const errorText =
      'data: {"type":"error","error":{"type":"api_error","code":"upstream_failure","message":"EXACT SECRET ERROR"}}\r\n\r\n'
    const fx = fixture(t, {
      respond: () => ({
        readable: Readable.from([Buffer.from(errorText)]),
        headers: { 'content-type': 'text/event-stream' },
      }),
    })
    const { record } = await fx.run({}, { headers: api ? { 'x-kin-backend': 'api' } : {} })
    assert.equal(record.raw_debug.hops[0].response.text, errorText)
    assert.equal(record.raw_debug.hops[0].outcome, 'failed')
    assert.doesNotMatch(JSON.stringify(fx.store.listDebug()), /EXACT SECRET ERROR/)
  })

test('native inner transport retry + outer account replay preserve real hop/attempt order', async (t) => {
  const fx = fixture(t, {
    accounts: [candidate('a'), candidate('b')],
    respond: ({ index }) =>
      index === 0
        ? { error: Object.assign(Error('local'), { code: 'EPIPE' }) }
        : index === 1
          ? { status: 429, body: { error: { type: 'rate_limit_error', message: 'rate limit' } } }
          : {},
  })
  const { record } = await fx.run({})
  assert.deepEqual(
    record.raw_debug.hops.map((h) => [h.hop_no, h.attempt_no, h.account_id]),
    [
      [1, 1, 'account-a'],
      [2, 1, 'account-a'],
      [3, 2, 'account-b'],
    ],
  )
  assert.equal(record.raw_debug.hops[0].response, null)
  assert.equal(record.raw_debug.hops[0].response_missing, 'no_response_observed')
  assert.equal(fx.saved.length, 1)
})

test('API socket connect retry is a local attempt, not proof of provider invocation', async (t) => {
  const fx = fixture(t, {
    respond: ({ index }) => (index < 2 ? { error: Object.assign(Error('connect'), { code: 'ECONNREFUSED' }) } : {}),
  })
  const { record } = await fx.run({}, { headers: { 'x-kin-backend': 'api' } })
  assert.deepEqual(
    record.raw_debug.hops.map((h) => [h.local_connect_attempt, h.provider_call]),
    [
      [1, 'unknown'],
      [2, 'unknown'],
      [3, 'unknown'],
    ],
  )
  assert.equal(record.raw_debug.hops[0].response, null)
})

test('disconnect persists once only after upstream reader cleanup; persistence errors release capacity', async (t) => {
  let release
  let cleaned = false
  const fx = fixture(t, {
    respond: () => ({
      readable: Readable.from(
        (async function* () {
          try {
            yield frame(successEvents[0])
            await new Promise((r) => {
              release = r
            })
            yield Buffer.from(': cleanup tail\n')
          } finally {
            cleaned = true
          }
        })(),
      ),
    }),
  })
  const pending = fx.start({})
  while (!release) await new Promise((r) => setImmediate(r))
  pending.res.destroyed = true
  pending.res.emit('close')
  assert.equal(fx.saved.length, 0)
  release()
  const { record } = await pending.done
  assert.equal(cleaned, true)
  assert.equal(fx.saved.length, 1)
  assert.match(record.raw_debug.hops[0].response.text, /cleanup tail/)
  assert.equal(record.raw_debug.inference_outcome, 'cancelled')
  const failing = fixture(t, { failSave: true })
  const warnings = []
  t.mock.method(console, 'warn', (text) => warnings.push(text))
  await failing.run({})
  assert.equal(rawDebugActiveCount(), 0)
  assert.doesNotMatch(warnings.join(''), /SECRET DB ERROR/)
})

test('active capacity refusal keeps no original/derived body and does not reject inference', async (t) => {
  const held = Array.from({ length: RAW_LIMITS.active }, () => createRawDebug('x', 1))
  try {
    const fx = fixture(t)
    const { record, res } = await fx.run({})
    assert.equal(res.statusCode, 200)
    assert.equal(record.raw_debug.status, 'omitted_capacity')
    assert.equal(record.raw_debug.caller.text, undefined)
    assert.deepEqual(record.raw_debug.derived, {})
  } finally {
    held.forEach((c) => c.release())
  }
})

for (const api of [false, true])
  test(`actual rejected JSON whitespace/malformed text and partial reads (${api ? 'api' : 'native'})`, async (t) => {
    const exact = ' { "error": { "message": "raw-only-secret🙂" }, BAD JSON\n'
    const fx = fixture(t, {
      respond: () => ({
        status: 403,
        headers: { 'content-type': 'application/json' },
        readable: Readable.from([Buffer.from(exact)]),
      }),
    })
    const { record } = await fx.run({}, { headers: api ? { 'x-kin-backend': 'api' } : {} })
    assert.equal(record.raw_debug.hops[0].response.text, exact)
    assert.equal(record.raw_debug.hops[0].response.format, 'json')
    assert.equal(record.raw_debug.hops[0].response.read_complete, true)
    assert.doesNotMatch(JSON.stringify(fx.store.listDebug()), /raw-only-secret/)
    const partial = fixture(t, {
      respond: () => ({
        headers: { 'content-type': 'text/event-stream' },
        readable: Readable.from(
          (async function* () {
            yield Buffer.from(': partial🙂\r\n')
            throw Object.assign(Error('read failed'), { code: 'EIO' })
          })(),
        ),
      }),
    })
    const out = await partial.run({}, { headers: api ? { 'x-kin-backend': 'api' } : {} })
    for (const hop of out.record.raw_debug.hops) {
      assert.equal(hop.response.text, ': partial🙂\r\n')
      assert.equal(hop.response.read_complete, false)
      assert.equal(hop.outcome, 'failed')
    }
  })

test('native rejection read limit preserves observed excess chunk; contradictory native trailers stay separate', async (t) => {
  const exact = 'x'.repeat(1024 * 1024 + 1)
  const fx = fixture(t, { respond: () => ({ status: 403, readable: Readable.from([Buffer.from(exact)]) }) })
  const { record } = await fx.run({})
  assert.equal(record.raw_debug.hops[0].response.text, exact)
  assert.equal(record.raw_debug.hops[0].response.read_complete, false)
  const contradictory = fixture(t, {
    respond: () => ({
      headers: { 'x-kin-terminal-state': 'verified', 'x-kin-stop-reason': 'end_turn' },
      trailers: { 'x-kin-terminal-state': 'failed', 'x-kin-stop-reason': 'max_tokens' },
    }),
  })
  const result = await contradictory.run({})
  const hop = result.record.raw_debug.hops[0]
  assert.equal(JSON.parse(hop.initial_metadata.text)['x-kin-stop-reason'], 'end_turn')
  assert.equal(JSON.parse(hop.trailing_metadata.text)['x-kin-stop-reason'], 'max_tokens')
  assert.equal(hop.outcome, 'failed')
  assert.equal(hop.response.read_complete, true)
})

test('malformed SSE event remains exact raw, not fabricated parsed JSON', async (t) => {
  const exact = 'data: { BROKEN🙂\r\n\r\n'
  const fx = fixture(t, { respond: () => ({ readable: Readable.from([Buffer.from(exact)]) }) })
  const { record } = await fx.run({})
  assert.equal(record.raw_debug.hops[0].response.text, exact)
  assert.equal(record.raw_debug.hops[0].outcome, 'failed')
})

test('aggregate cap does not truncate inference: >16MiB caller + sends/response counts keep growing', async (t) => {
  const fx = fixture(t)
  const original = JSON.stringify({
    model: 'claude-sonnet-5',
    stream: false,
    messages: [
      { role: 'system', content: 'x'.repeat(RAW_LIMITS.bytes + 100) },
      { role: 'user', content: 'hi' },
    ],
  })
  const { record, res } = await fx.run(original)
  assert.equal(res.statusCode, 200)
  assert.equal(fx.sends[0].envelope.body.system[0].text.length, RAW_LIMITS.bytes + 100)
  assert.equal(record.raw_debug.bytes_retained, RAW_LIMITS.bytes)
  assert.ok(record.raw_debug.bytes_observed > 2 * RAW_LIMITS.bytes)
  assert.equal(record.raw_debug.caller.truncated, true)
  assert.equal(record.raw_debug.hops[0].response.truncated, true)
  assert.equal(record.raw_debug.hops[0].response.read_complete, true)
})

test('response error/finish/close race is a signal, not an early save; local validation captures original', async (t) => {
  let release
  const fx = fixture(t, {
    respond: () => ({
      readable: Readable.from(
        (async function* () {
          await new Promise((r) => {
            release = r
          })
          for (const e of successEvents) yield frame(e)
        })(),
      ),
    }),
  })
  const pending = fx.start({})
  while (!release) await new Promise((r) => setImmediate(r))
  pending.res.emit('error', Error('client error'))
  pending.res.emit('finish')
  assert.equal(fx.saved.length, 0)
  release()
  const { record } = await pending.done
  assert.equal(record.raw_debug.inference_outcome, 'failed')
  assert.equal(fx.saved.length, 1)
  assert.equal(pending.res.listenerCount('error'), 0)
  const validation = fixture(t)
  const local = await validation.run({ messages: [] })
  assert.equal(local.res.statusCode, 400)
  assert.notEqual(local.res.responseId, 'caller-id')
  assert.equal(local.record.raw_debug.hops.length, 0)
})

for (const kind of ['original Codex', 'Claude rewritten Codex', 'Codex rewritten Claude'])
  test(`conservative platform enrollment: ${kind}`, async (t) => {
    const to =
      kind === 'Claude rewritten Codex' ? 'gpt-5' : kind === 'Codex rewritten Claude' ? 'claude-sonnet-5' : null
    const fx = fixture(t, { rules: to ? [{ phase: 'before_convert', action: { set_body_field: { model: to } } }] : [] })
    const { res } = await fx.run({ model: kind === 'Claude rewritten Codex' ? 'claude-sonnet-5' : 'gpt-5' })
    assert.equal(res._kinRequestId, 'caller-id')
    assert.equal(fx.saved.length, 0)
    assert.equal(rawDebugActiveCount(), 0)
    if (kind !== 'Codex rewritten Claude') assert.equal(JSON.parse(res.text).mock_codex_dispatch, true)
  })

test('16 actual hop cap omits only evidence and keeps later inference/account replay successful', async (t) => {
  const fx = fixture(t, {
    accounts: Array.from({ length: 19 }, (_, i) => candidate(String(i))),
    runnerConfig: { max_total_attempts: 20, max_account_switches: 20 },
    respond: ({ index }) =>
      index < 18 ? { status: 429, body: { error: { type: 'rate_limit_error', message: 'rate limit' } } } : {},
  })
  const { record, res } = await fx.run({})
  assert.equal(res.statusCode, 200)
  assert.equal(fx.sends.length, 19)
  assert.equal(record.raw_debug.hops.length, 16)
  assert.equal(record.raw_debug.hops_observed, 19)
  assert.equal(record.raw_debug.hops_omitted, 3)
  assert.equal(record.raw_debug.status, 'partial_capture')
  assert.equal(record.raw_debug.inference_outcome, 'success')
})

test('repaired outer attempts retain the runner attempt number and repair flag', async (t) => {
  const fx = fixture(t, {
    respond: ({ index }) =>
      index === 0
        ? {
            status: 400,
            body: { error: { type: 'invalid_request_error', message: 'Invalid signature in thinking block' } },
          }
        : {},
  })
  const { record, res } = await fx.run({})
  assert.equal(res.statusCode, 200)
  assert.deepEqual(
    record.raw_debug.hops.map((h) => [h.attempt_no, h.repaired]),
    [
      [1, false],
      [2, true],
    ],
  )
})

test('uncaught local error finalizes exactly once without inventing upstream or client JSON', async (t) => {
  const fx = fixture(t, {
    health: {
      decide() {
        throw Object.assign(Error('LOCAL_SECRET_ERROR'), { status: 422 })
      },
    },
  })
  const pending = fx.start({})
  await assert.rejects(pending.done, /LOCAL_SECRET_ERROR/)
  assert.equal(fx.saved.length, 1)
  assert.equal(fx.saved[0].status, 422)
  assert.equal(fx.saved[0].raw_debug.status, 'not_sent')
  assert.equal(fx.saved[0].raw_debug.client_response_complete, false)
  assert.deepEqual(fx.saved[0].raw_debug.derived_missing, ['assembled_message', 'client_json'])
  assert.doesNotMatch(JSON.stringify(fx.saved[0]), /LOCAL_SECRET_ERROR/)
  assert.equal(rawDebugActiveCount(), 0)
})

test('normal completed response destruction after writableFinished is not client cancellation', async (t) => {
  const fx = fixture(t, { destroyAfterFinish: true })
  const { record, res } = await fx.run({})
  assert.equal(res.destroyed, true)
  assert.equal(res.writableFinished, true)
  assert.equal(record.raw_debug.inference_outcome, 'success')
  assert.equal(record.raw_debug.client_response_complete, true)
})

for (const enabled of [false, true]) {
  test(`API date Retry-After is a normal rejection, not an unobserved exception (raw=${enabled})`, async (t) => {
    const now = Date.parse('2026-09-24T12:00:00Z')
    t.mock.method(Date, 'now', () => now)
    const retryAt = 'Thu, 24 Sep 2026 20:45:00 GMT'
    const text = '{ "error": { "message": "rate limited" } }'
    const upstream = Readable.from([Buffer.from(text)])
    t.after(() => upstream.destroy())
    let cooldown
    const fx = fixture(t, {
      enabled,
      apiStore: {
        setKeyCooldown(_id, until) {
          cooldown = until
        },
        listRaw: () => [],
      },
      respond: () => ({
        readable: upstream,
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': retryAt },
      }),
    })
    const { res, record } = await fx.run({}, { headers: { 'x-kin-backend': 'api' } })
    assert.equal(res.statusCode, 429)
    assert.equal(cooldown, '2026-09-24T20:45:00.000Z')
    assert.equal(upstream.readableEnded, true)
    assert.equal(fx.sends.length, 1)
    if (enabled) {
      const hop = record.raw_debug.hops[0]
      assert.equal(hop.status, 429)
      assert.equal(hop.response.text, text)
      assert.equal(hop.response.read_complete, true)
      assert.equal(hop.outcome, 'failed')
    } else assert.equal(record.raw_debug, undefined)
  })

  test(`API post-response bookkeeping failure cleans up before settlement (raw=${enabled})`, async (t) => {
    const upstream = Readable.from([Buffer.from('{"error":{"message":"not read yet"}}')])
    t.after(() => upstream.destroy())
    const fx = fixture(t, {
      enabled,
      apiStore: {
        setKeyCooldown() {},
        listRaw() {
          throw new Error('bookkeeping failed')
        },
      },
      respond: () => ({
        readable: upstream,
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '1' },
      }),
    })
    await assert.rejects(fx.run({}, { headers: { 'x-kin-backend': 'api' } }), /bookkeeping failed/)
    assert.equal(upstream.destroyed, true, 'the received upstream response must not remain live')
    assert.equal(fx.sends.length, 1)
    assert.equal(rawDebugActiveCount(), 0)
    if (enabled) {
      assert.equal(fx.saved.length, 1)
      const raw = fx.saved[0].raw_debug
      const hop = raw.hops[0]
      assert.equal(hop.status, 429)
      assert.equal(hop.response.format, 'json')
      assert.equal(hop.response.text, '', 'unread bytes are not invented')
      assert.equal(hop.response.read_complete, false)
      assert.equal(hop.outcome, 'failed')
      assert.equal(raw.status, 'partial_capture')
      assert.equal(raw.inference_outcome, 'failed')
    }
  })
}
