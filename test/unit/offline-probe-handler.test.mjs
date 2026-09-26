import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { RequestLogStore } from '../../src/lib/admin/request-log.mjs'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { readBody } from '../../src/lib/http/respond.mjs'
import { rawDebugActiveCount } from '../../src/lib/admin/raw-debug.mjs'
import { handleUserCountTokens } from '../../src/lib/protocol/user-count-tokens.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import round from '../../src/lib/transport/offline-candidate-round.json' with { type: 'json' }

// Exercise capture paths in a fixture round without reopening the shipped catalog.
const publishedChoices = structuredClone(round.choices)
before(() =>
  round.choices.splice(
    0,
    round.choices.length,
    { value: 'candidate-cc-r3', label: 'Fixture CC' },
    { value: 'candidate-crag-r3', label: 'Fixture Crag' },
  ),
)
after(() => round.choices.splice(0, round.choices.length, ...publishedChoices))

const longText = '[BEGIN]汉字🙂<content>\n' + '第一段落🙂abc\n'.repeat(4000) + '</content>[END]'
const frame = (obj) => `event: ${obj.type}\r\ndata: ${JSON.stringify(obj)}\r\n\r\n`
function stage(
  name,
  { trailerOnly = false, negative = false, json = false, sseError = false, literalHeader = false } = {},
) {
  const text = literalHeader
    ? longText + '\nA literal kin_response_headers word is content, not an event type.'
    : longText
  const message = {
    id: 'msg_offline_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-6',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 3, output_tokens: 148 },
  }
  const chunks = [
    {
      type: 'message_start',
      message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 3, output_tokens: 0 } },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: text.slice(0, 7) } },
    { type: 'message_delta', usage: { output_tokens: 149 } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(7) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: trailerOnly ? {} : { stop_reason: 'end_turn' }, usage: { output_tokens: 148 } },
    { type: 'message_stop' },
  ]
  let raw = json ? JSON.stringify(message) : chunks.map(frame).join('')
  if (sseError) raw += 'data: {"type":"error","error":{"type":"api_error","message":"OFFLINE_ERROR"}}'
  return {
    name,
    status: 'completed',
    capture_complete: true,
    fixture: message,
    captures: [],
    kernel_reply: {
      status: 200,
      content_type: json ? 'application/json' : 'text/event-stream',
      headers: {},
      trailers: { 'X-Kin-Terminal-State': negative ? 'error' : 'verified', 'X-Kin-Stop-Reason': 'end_turn' },
      body_b64: Buffer.from(raw).toString('base64'),
      complete: true,
    },
  }
}

function fixture(
  t,
  { raw = true, mode = 'debug', producer, mutate, auth = true, plane = round.choices[0].value } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-handler-'))
  const db = createDatabase({ dbPath: ':memory:' })
  const store = new RequestLogStore({
    db,
    dataDir: root,
    mode,
    rawNonstreamDebug: raw,
    offlineKernelProbe: true,
    offlineKernelDataplane: plane,
  })
  t.after(() => {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
    assert.equal(rawDebugActiveCount(), 0)
  })
  let calls = 0,
    lastInput
  const fail = () => {
    assert.fail('offline path reached production selection/health/backend')
  }
  const handler = createHandleProtocol({
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      limits: { max_body_bytes: 32 * 1024 * 1024 },
      paths: { project: root },
    },
    requestLog: store,
    groupsRepo: { rateMultiplier: () => 1 },
    stats: { errors: 0, requests: 0, by_route: {}, convert: 0, passthrough: 0, rewrite: 0 },
    requireAuth(req, res) {
      if (!auth) {
        res.statusCode = 401
        res.end()
      }
      return auth
    },
    readBody: async (...args) => {
      const value = await readBody(...args)
      mutate?.(store)
      return value
    },
    json(res, status, value) {
      res.statusCode = status
      res.text = JSON.stringify(value)
      res.end()
    },
    writeSSEHeaders: fail,
    getHealthMonitor: fail,
    getFailoverRunner: fail,
    apiScheduler: { pick: fail },
    accountQuota: { sessions: {} },
    stickyRouter: { extractPoolKey: fail },
    routingConfig: { compatibility: { persona_preset: 'zero' } },
    runOfflineKernelProbe: async (input) => {
      calls++
      lastInput = input
      return producer
        ? await producer(input)
        : {
            simulation: true,
            meta: { vm_id: 'vm-1', selected_pairing: 'wrap' },
            stages: [stage('fake_cli'), stage('mock_api')],
          }
    },
  })
  async function run(body = {}, { kind = 'master', headers = {}, protocol = 'openai.chat', onStart } = {}) {
    const original = JSON.stringify({
      model: 'claude-opus-4-6',
      stream: false,
      reasoning_effort: 'max',
      max_tokens: 128000,
      messages: [
        { role: 'system', content: '# Environment\nCALLER_A' },
        { role: 'system', content: 'CALLER_B' },
        { role: 'user', content: 'hi' },
      ],
      ...body,
    })
    const req = Object.assign(Readable.from([Buffer.from(original)]), {
      method: 'POST',
      url: '/v1/chat/completions',
      apiKeyKind: kind,
      headers: { 'x-request-id': 'caller-offline-test', ...headers },
    })
    const res = Object.assign(new EventEmitter(), {
      text: '',
      statusCode: 200,
      headersSent: false,
      writableEnded: false,
      writableFinished: false,
      destroyed: false,
      write(value) {
        this.text += value
        return true
      },
      end() {
        this.writableEnded = true
        this.writableFinished = !this.destroyed
        this.emit('finish')
        this.emit('close')
      },
    })
    onStart?.(req, res)
    await handler.handleProtocol(req, res, protocol, req.url)
    return {
      res,
      original,
      record: store.repo.getDebug(res._kinRequestId, { includeRaw: true }),
      id: res._kinRequestId,
    }
  }
  return {
    run,
    store,
    get calls() {
      return calls
    },
    get input() {
      return lastInput
    },
  }
}

test('offline end-to-end uses the real Node reader/assembly, preserving long UTF-8 despite usage149', async (t) => {
  const fx = fixture(t)
  const result = await fx.run()
  assert.equal(fx.calls, 1)
  assert.equal(result.res.statusCode, 422)
  assert.equal(JSON.parse(result.res.text).error.code, 'offline_probe_captured')
  assert.deepEqual(
    fx.input.envelope.body.system.map((b) => b.text),
    ['# Environment\nCALLER_A', 'CALLER_B'],
  )
  assert.equal(fx.input.envelope.body.output_config.effort, 'max')
  assert.equal(fx.input.envelope.body.max_tokens, 128000)
  assert.equal(result.record.raw_debug.caller.text, result.original)
  const report = JSON.parse(result.record.raw_debug.offline_probe.details.text)
  for (const phase of report.stages) {
    assert.equal(phase.node.chat.choices[0].message.content, longText)
    assert.equal(phase.checks.text_equal, true)
    assert.equal(phase.node.chat.usage.completion_tokens, 148)
  }
  assert.equal(result.record.output_tokens, null) // No synthetic billing written to usage logs.
  assert.equal(fx.store.repo.getDebug(result.id).raw_debug, undefined)
  for (const role of ['admin', 'user']) {
    const response = Object.assign(new EventEmitter(), {
      text: '',
      headers: {},
      writableEnded: false,
      destroyed: false,
      writeHead(status, headers) {
        this.statusCode = status
        this.headers = headers
      },
      setHeader(key, value) {
        this.headers[key] = value
      },
      write(chunk) {
        this.text += chunk
        return true
      },
      end(chunk = '') {
        this.text += chunk
        this.writableEnded = true
        this.emit('finish')
      },
    })
    const panel = createPanelHandler({
      cfg: { paths: {} },
      requestLog: fx.store,
      requireAuth(req) {
        req.panelRole = role
        req.panelUser = 'tester'
        req.panelUserId = 'tester'
        return true
      },
      json(res, code, body) {
        res.statusCode = code
        res.end(JSON.stringify(body))
      },
    })
    const url = `/api/panel/request-logs/export?include_raw=1&format=jsonl&include_muted=1&request_id=${result.id}`
    await panel({ method: 'GET', headers: {}, url }, response, new URL(url, 'http://local'))
    assert.equal(response.statusCode, role === 'admin' ? 200 : 403)
    if (role === 'admin') {
      assert.equal(response.headers['x-kin-export-count'], '1')
      const exported = JSON.parse(response.text)
      assert.equal(exported.raw_debug.caller.text, result.original)
      assert.deepEqual(JSON.parse(exported.raw_debug.offline_probe.details.text), report)
      if (process.env.OFFLINE_PROBE_EXPORT_DIR) {
        fs.mkdirSync(process.env.OFFLINE_PROBE_EXPORT_DIR, { recursive: true })
        fs.writeFileSync(path.join(process.env.OFFLINE_PROBE_EXPORT_DIR, 'offline-handler-export.jsonl'), response.text)
      }
    }
  }
})

for (const options of [
  { trailerOnly: true },
  { json: true },
  { negative: true },
  { sseError: true },
  { literalHeader: true },
])
  test(`offline production reader preserves actual terminal/JSON behavior ${JSON.stringify(options)}`, async (t) => {
    const fx = fixture(t, {
      producer: async () => ({
        simulation: true,
        meta: {},
        stages: [stage('fake_cli', options), stage('mock_api', options)],
      }),
    })
    const { record, res } = await fx.run()
    const report = JSON.parse(record.raw_debug.offline_probe.details.text)
    // The VM streaming contract requires SSE. A raw JSON kernel reply is rejected,
    // not silently translated into a successful short completion.
    const good = !options.negative && !options.sseError && !options.json
    assert.equal(
      report.stages.every((s) => s.checks.text_equal),
      good,
      JSON.stringify(
        report.stages.map((s) => ({
          status: s.node?.status,
          ok: s.node?.ok,
          error: s.node?.message?.error,
          checks: s.checks,
        })),
      ),
    )
    assert.equal(JSON.parse(res.text).error.code, good ? 'offline_probe_captured' : 'offline_probe_incomplete')
  })

for (const [body, opts, settings] of [
  [{ stream: true }, {}, {}],
  [{ model: 'gpt-5' }, {}, {}],
  [{}, { protocol: 'anthropic.messages' }, {}],
  [{}, { headers: { 'x-kin-backend': 'api' } }, {}],
  [{}, { kind: 'managed' }, {}],
  [{}, {}, { raw: false }],
  [{}, {}, { mode: 'off' }],
])
  test(`offline admission fails closed ${JSON.stringify({ body, opts, settings })}`, async (t) => {
    const fx = fixture(t, settings)
    const { res } = await fx.run(body, opts)
    assert.equal(res.statusCode, 422)
    assert.equal(fx.calls, 0)
  })

test('mode/pairing is latched; changing settings during read cannot fall through to real inference', async (t) => {
  const fx = fixture(t, {
    mutate: (store) => store.setConfig({ offlineKernelProbe: false, offlineKernelDataplane: 'crag' }),
  })
  await fx.run()
  assert.equal(fx.calls, 1)
  assert.equal(fx.input.plane, round.choices[0].value)
})

test('upstream credentials are not forwarded and runner failure stays local', async (t) => {
  const fx = fixture(t, {
    producer: async (input) => {
      assert.doesNotMatch(JSON.stringify(input.envelope.headers), /SECRET_KEY|SECRET_PROXY/)
      throw Object.assign(new Error('Offline test failure'), { code: 'offline_test_failure' })
    },
  })
  const { res, record } = await fx.run(
    {},
    { headers: { authorization: 'Bearer SECRET_KEY', 'x-api-key': 'SECRET_KEY', 'x-kin-proxy': 'SECRET_PROXY' } },
  )
  assert.equal(res.statusCode, 422)
  assert.equal(fx.calls, 1)
  assert.equal(JSON.parse(res.text).error.code, 'offline_test_failure')
  assert.match(record.raw_debug.offline_probe.details.text, /offline_test_failure/)
})

test('candidate selection and pending acceptance remain explicit through handler and protected record', async (t) => {
  const candidate = {
    id: round.id,
    status: 'offline_only_pending_runtime',
    production_approved: false,
    user_capture_accepted: false,
    cli_sha256: 'a'.repeat(64),
    manifest_sha256: 'b'.repeat(64),
    local_validation: { completed: true, native_execution: false, user_capture_accepted: false },
  }
  const fx = fixture(t, {
    plane: round.choices[0].value,
    producer: async (input) => {
      assert.equal(input.plane, round.choices[0].value)
      return {
        simulation: true,
        meta: { selected_pairing: 'wrap', source: 'offline_candidate_files', candidate },
        stages: [stage('fake_cli'), stage('mock_api')],
      }
    },
  })
  const { res, record, id } = await fx.run()
  assert.equal(JSON.parse(res.text).error.code, 'offline_probe_captured')
  assert.equal(record.raw_debug.inference_outcome, 'not_run')
  assert.equal(record.raw_debug.offline_probe.candidate.local_checks_completed, true)
  assert.equal(record.raw_debug.offline_probe.candidate.production_approved, false)
  assert.equal(record.raw_debug.offline_probe.candidate.user_capture_accepted, false)
  assert.deepEqual(JSON.parse(record.raw_debug.offline_probe.details.text).meta.candidate, candidate)
  assert.equal(fx.store.repo.getDebug(id).raw_debug, undefined)
  const response = Object.assign(new EventEmitter(), {
    text: '',
    headers: {},
    writableEnded: false,
    destroyed: false,
    writeHead(code, headers) {
      this.statusCode = code
      this.headers = headers
    },
    setHeader(k, v) {
      this.headers[k] = v
    },
    write(chunk) {
      this.text += chunk
      return true
    },
    end(chunk = '') {
      this.text += chunk
      this.writableEnded = true
      this.emit('finish')
    },
  })
  const panel = createPanelHandler({
    cfg: { paths: {} },
    requestLog: fx.store,
    requireAuth(req) {
      req.panelRole = 'admin'
      req.panelUser = 'admin'
      req.panelUserId = 'admin'
      return true
    },
    json(res, status, body) {
      res.statusCode = status
      res.end(JSON.stringify(body))
    },
  })
  const url = `/api/panel/request-logs/export?include_raw=1&format=jsonl&include_muted=1&request_id=${id}`
  await panel({ method: 'GET', headers: {}, url }, response, new URL(url, 'http://local'))
  assert.equal(response.statusCode, 200)
  const exported = JSON.parse(response.text)
  assert.deepEqual(JSON.parse(exported.raw_debug.offline_probe.details.text).meta.candidate, candidate)
  assert.equal(exported.raw_debug.offline_probe.candidate.user_capture_accepted, false)
  if (process.env.OFFLINE_CANDIDATE_EXPORT_DIR) {
    fs.mkdirSync(process.env.OFFLINE_CANDIDATE_EXPORT_DIR, { recursive: true })
    fs.writeFileSync(
      path.join(process.env.OFFLINE_CANDIDATE_EXPORT_DIR, 'candidate-handler-export.jsonl'),
      response.text,
    )
  }
})

test('candidate admission failure is recorded and never retries released inference', async (t) => {
  const fx = fixture(t, {
    plane: round.choices[0].value,
    producer: async () => {
      throw Object.assign(Error('Candidate kernel differs'), {
        code: 'offline_candidate_kernel_mismatch',
        diagnostic: { meta: { candidate: { id: round.id, status: 'not_loaded' } } },
      })
    },
  })
  const { res, record } = await fx.run()
  assert.equal(fx.calls, 1)
  assert.equal(JSON.parse(res.text).error.code, 'offline_candidate_kernel_mismatch')
  assert.equal(record.raw_debug.offline_probe.candidate.local_checks_completed, false)
  assert.equal(record.raw_debug.diagnostic_outcome, 'incomplete')
})

test('published closed round refuses capture without restoring real inference', async (t) => {
  const activeFixture = round.choices.splice(0, round.choices.length, ...publishedChoices)
  try {
    const fx = fixture(t, { plane: 'candidate-cc-r3' })
    const { res, record } = await fx.run()
    assert.equal(JSON.parse(res.text).error.code, 'offline_selection_required')
    assert.equal(fx.calls, 0)
    assert.equal(record.raw_debug.inference_outcome, 'not_run')
  } finally {
    round.choices.splice(0, round.choices.length, ...activeFixture)
  }
})

for (const plane of ['current', 'wrap-fixed', 'candidate-wrap', 'candidate-cc-r2'])
  test(`stale public offline selection ${plane} refuses before a sandbox launch`, async (t) => {
    const fx = fixture(t, { plane })
    const { res, record } = await fx.run()
    assert.equal(JSON.parse(res.text).error.code, 'offline_selection_required')
    assert.equal(fx.calls, 0)
    assert.equal(record.raw_debug.inference_outcome, 'not_run')
  })

test('partial capture cannot be reported as a complete offline chain even when text matches', async (t) => {
  const fx = fixture(t, {
    producer: async () => {
      const first = stage('fake_cli')
      first.capture_complete = false
      return { simulation: true, meta: {}, stages: [first, stage('mock_api')] }
    },
  })
  const { res } = await fx.run()
  assert.equal(JSON.parse(res.text).error.code, 'offline_probe_incomplete')
})

test('client cancellation aborts the sandbox and still saves an explicit cancelled record', async (t) => {
  let response
  const fx = fixture(t, {
    producer: async ({ signal }) => {
      setImmediate(() => {
        response.destroyed = true
        response.emit('close')
      })
      await new Promise((resolve, reject) =>
        signal.addEventListener(
          'abort',
          () => reject(Object.assign(Error('cancelled'), { code: 'offline_cancelled' })),
          { once: true },
        ),
      )
    },
  })
  const { record } = await fx.run(
    {},
    {
      onStart: (_req, res) => {
        response = res
      },
    },
  )
  assert.equal(record.raw_debug.inference_outcome, 'not_run')
  assert.equal(record.raw_debug.diagnostic_outcome, 'cancelled')
  assert.equal(record.raw_debug.client_response_complete, false)
  assert.match(record.raw_debug.offline_probe.details.text, /offline_cancelled/)
  assert.equal(fx.calls, 1)
})

test('count_tokens is rejected before body/credential/slot access while offline mode is active', async () => {
  let status
  await handleUserCountTokens(
    {},
    {},
    {
      offlineKernelProbe: true,
      requireAuth: () => true,
      json: (_res, code) => {
        status = code
      },
      readBody: () => assert.fail('readBody should not run'),
      getPoolScheduler: () => assert.fail('real pool should not run'),
    },
  )
  assert.equal(status, 422)
})

test('authentication is still required before collecting or starting a probe', async (t) => {
  const fx = fixture(t, { auth: false })
  const { res, record } = await fx.run()
  assert.equal(res.statusCode, 401)
  assert.equal(fx.calls, 0)
  assert.ok(!record?.raw_debug)
})
