import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { registerHooks } from 'node:module'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { StickyRouter } from '../../src/lib/pool/sticky-router.mjs'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'
import { clearConversationCacheTtls } from '../../src/lib/protocol/cache-ttl.mjs'
import { clearCachePrefixSessions } from '../../src/lib/protocol/cache-prefix.mjs'
import { sessionIdFromOutboundBody } from '../../src/lib/identity/identity-rewrite.mjs'
import { candidate, mockWorker } from '../support/in-memory-worker.mjs'

// Only inject native lifecycle dependencies. Handler, selected-account attempt,
// real sticky DB/runner, router, CLI preparation and worker envelope all execute.
const routerUrl = new URL('../../src/lib/transport/kernel-router.mjs', import.meta.url).href
const hook = registerHooks({
  load(url, context, nextLoad) {
    if (url === routerUrl)
      return {
        format: 'module',
        shortCircuit: true,
        source: `import { dispatchStreamInference as dispatch } from ${JSON.stringify(`${routerUrl}?cache-policy-test`)};
        export function dispatchStreamInference(options) {
          return dispatch({ ...options, ensureRust: async () => ({ ok: true }),
            ensureCredential: async () => { throw new Error('unexpected credential refresh'); }, recycleWrap: () => {} });
        }`,
      }
    return nextLoad(url, context)
  },
})
const { createHandleProtocol } = await import('../../src/lib/protocol/handle-protocol.mjs')
hook.deregister()

const cc = (ttl) => ({ type: 'ephemeral', ttl })
const text = (value, ttl) => ({ type: 'text', text: value, ...(ttl ? { cache_control: cc(ttl) } : {}) })
const ordinary = { messages: [{ role: 'user', content: 'ordinary coding request' }] }
const tool = (name, ttl) => ({
  type: 'function',
  function: { name, parameters: { type: 'object' }, ...(ttl ? { cache_control: cc(ttl) } : {}) },
})
const titleSchema = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] }

function fixture(t, { accounts = [candidate()], rules = [], respond, persona = 'official_full', routingFile } = {}) {
  clearConversationCacheTtls()
  clearCachePrefixSessions()
  const sends = mockWorker(t, respond)
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => {
    db.close()
    clearConversationCacheTtls()
    clearCachePrefixSessions()
  })
  const routing = { compatibility: { persona_preset: persona }, failover: { stream_keepalive_ms: 0 } }
  const sticky = new StickyRouter({ db, config: routing })
  const scheduler = {
    accounts,
    async selectAndReserve({ excluded, stickyKey }) {
      const bound = sticky.resolve(stickyKey)
      const available = this.accounts.filter((item) => !excluded.has(item.accountId) && !excluded.has(item.vmId))
      const selected = available.find((item) => item.accountId === bound?.accountId) || available[0]
      return selected ? { ...selected, ok: true, release() {} } : { ok: false, reason: 'no_eligible_accounts' }
    },
    markCooldown() {},
    markSuccess() {},
  }
  const runner = new FailoverRunner({ scheduler, stickyRouter: sticky, config: { max_same_account_retries: 0 } })
  let inbound
  let recorded
  let counter = 0
  const handler = createHandleProtocol({
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules },
      distill: { enabled: false },
      limits: { max_body_bytes: 100000, upstream_timeout_ms: 1000 },
      paths: {},
    },
    settings: { get: () => false },
    readBody: async () => structuredClone(inbound),
    requireAuth: () => true,
    json: (res, status, body) => {
      res.statusCode = status
      res.write(JSON.stringify(body))
      res.end()
    },
    writeSSEHeaders: (res) => {
      res.headersSent = true
    },
    requestLog: {
      start: () => ({ request_id: `cache-${++counter}` }),
      finish: (_ctx, value) => {
        recorded = value
      },
    },
    stickyRouter: sticky,
    failoverRunner: runner,
    accountQuota: {},
    apiKeyStore: {},
    apiEndpointStore: {},
    apiScheduler: {
      pick: (model) => ({
        ok: true,
        endpoint: { id: 'ep-test', kind: 'claude', protocol: 'anthropic', base_url: 'https://upstream.invalid' },
        upstream_model: model,
        key: { id: 'key-test', api_key: 'test-only' },
      }),
    },
    groupsRepo: { rateMultiplier: () => 1 },
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfig: routing,
    routingConfigPath: routingFile,
  })
  async function run(
    body = ordinary,
    { protocol = 'openai.chat', headers = {}, stream = true, session = 'shared', failure = false } = {},
  ) {
    inbound = { model: 'claude-sonnet-5', max_tokens: 1000, ...body }
    if (stream !== undefined && stream !== 'omitted') inbound.stream = stream
    const req = Object.assign(new EventEmitter(), {
      method: 'POST',
      url: protocol === 'anthropic.messages' ? '/v1/messages' : '/v1/chat/completions',
      apiKeyKind: 'master',
      headers: { 'user-agent': 'cache-policy-test', ...(session ? { 'x-session-id': session } : {}), ...headers },
    })
    const res = Object.assign(new EventEmitter(), {
      text: '',
      statusCode: 200,
      headersSent: false,
      destroyed: false,
      writableEnded: false,
      write(chunk) {
        this.text += chunk
      },
      end() {
        this.writableEnded = true
        this.emit('finish')
      },
    })
    const start = sends.length
    await handler.handleProtocol(req, res, protocol, req.url)
    if (!failure) {
      assert.equal(res.statusCode, 200, res.text)
      assert.equal(recorded.error_code, null, JSON.stringify(recorded))
    }
    const batch = sends.slice(start)
    if (!failure) assert.ok(batch.length)
    return { batch, envelope: batch.at(-1)?.envelope, res, recorded, req, inbound }
  }
  return { run, sends, sticky, scheduler }
}

const callerTexts = [
  '# Environment\ncaller-owned',
  'You are Claude Code\nnot boilerplate',
  'Keep agent-sdk / claude-desktop / claude-vscode / cc_entrypoint examples exactly.',
  '# Doing tasks\nrule\n# Tone and style\nother rule',
  '  A\n\n\nB\t ',
  '',
  ' \n\t ',
  '<total_tokens>7 tokens left</total_tokens>',
  'x-anthropic-billing-header: cch=00000; caller-owned',
  ...Array.from({ length: 43 }, (_, i) => `rule ${i}: keep exactly`),
]
for (const stream of [true, false])
  for (const persona of ['zero', 'official', 'official_full', 'identity'])
    for (const slot of ['zero', 'official', 'official_full', 'inherit']) {
      test(`Chat caller blocks reach worker untouched (${persona}/${slot}, stream=${stream})`, async (t) => {
        const routingFile = 'in-memory-caller-preservation'
        const read = fs.readFileSync.bind(fs)
        t.mock.method(fs, 'readFileSync', (file, ...args) =>
          file === routingFile
            ? JSON.stringify({
                compatibility: {
                  persona_preset: persona,
                  overlay_preset: 'standing',
                  persona_park: true,
                  persona_standing: 'INJECTED_OVERLAY',
                },
              })
            : read(file, ...args),
        )
        const account = candidate()
        if (slot !== 'inherit') account.vm.persona_preset = slot
        const fx = fixture(t, { accounts: [account], persona, routingFile })
        const messages = callerTexts.map((text, i) => ({
          role: i % 2 ? 'developer' : 'system',
          content: i % 3 ? [{ type: i % 2 ? 'input_text' : 'text', text }] : text,
        }))
        messages.splice(2, 0, { role: 'user', content: 'before systems' })
        messages.push({ role: 'user', content: 'USER EXACT' })
        const { envelope, res } = await fx.run(
          { messages, max_tokens: 1, stream_options: { include_usage: true } },
          { stream },
        )
        assert.deepEqual(
          envelope.body.system.map((b) => b.text),
          callerTexts,
        )
        assert.equal(envelope.body.max_tokens, 1)
        assert.equal(envelope.body.tools, undefined)
        assert.doesNotMatch(JSON.stringify(envelope.body.messages), /INJECTED_OVERLAY|system-reminder/)
        assert.ok(sessionIdFromOutboundBody(envelope.body))
        assert.equal(envelope.cache_ttl, '1h')
        const usage = stream
          ? res.text
              .split('\n')
              .filter((l) => l.startsWith('data: {'))
              .map((l) => JSON.parse(l.slice(6)))
              .find((c) => c.choices?.length === 0).usage
          : JSON.parse(res.text).usage
        assert.equal(usage.prompt_tokens, 100)
      })
    }

test('Chat second-account retry preserves systems and switches only native identity', async (t) => {
  const accounts = [candidate('a'), candidate('b')]
  // First account inherits the global preset; the second explicitly overrides it.
  accounts[1].vm.persona_preset = 'zero'
  const fx = fixture(t, {
    accounts,
    respond: ({ index }) =>
      index === 0
        ? {
            status: 429,
            body: { type: 'error', error: { type: 'rate_limit_error', message: "You've hit your limit" } },
          }
        : {},
  })
  const { batch } = await fx.run(
    { messages: [...callerTexts.map((text) => ({ role: 'system', content: text })), { role: 'user', content: 'hi' }] },
    { stream: false },
  )
  assert.equal(batch.length, 2)
  for (const send of batch)
    assert.deepEqual(
      send.envelope.body.system.map((b) => b.text),
      callerTexts,
    )
  assert.notEqual(batch[0].envelope.body.metadata.user_id, batch[1].envelope.body.metadata.user_id)
})

const oracleInputs = JSON.parse(fs.readFileSync(new URL('../fixtures/cpa/inputs.json', import.meta.url)))
const oracleGoldens = JSON.parse(fs.readFileSync(new URL('../fixtures/cpa/goldens.json', import.meta.url)))
const clock = (value) => JSON.parse(JSON.stringify(value, (key, value) => (key === 'created' ? 0 : value)))
const decode = (res) =>
  res.text
    .split('\n')
    .filter((l) => l.startsWith('data: {'))
    .map((l) => JSON.parse(l.slice(6)))

for (const backend of ['oauth', 'api'])
  for (const stream of [false, true]) {
    test(`Chat real ${backend} reader preserves raw tool JSON and caller systems, stream=${stream}`, async (t) => {
      const input = oracleInputs.find((c) => c.id === 'response-tools')
      const golden = oracleGoldens.cases.find((c) => c.id === input.id)
      const fx = fixture(t, { respond: () => ({ events: input.events }) })
      const { res, envelope, batch } = await fx.run(
        {
          model: 'claude-sonnet-4-6',
          messages: [
            ...callerTexts.map((text) => ({ role: 'system', content: text })),
            { role: 'user', content: 'hi' },
          ],
        },
        { stream, headers: { 'x-kin-backend': backend } },
      )
      const body = backend === 'api' ? JSON.parse(envelope.body) : envelope.body
      assert.deepEqual(
        body.system.map((b) => b.text),
        callerTexts,
      )
      assert.equal(batch.length, 1)
      if (!stream) assert.deepEqual(clock(JSON.parse(res.text)), clock(golden.buffered))
      else {
        const expected = golden.chunks.filter((c) => c.choices.length)
        assert.deepEqual(clock(decode(res)), clock(expected))
        assert.match(res.text, /\[DONE\]/)
      }
    })
  }
for (const stream of [false, true])
  test(`Chat initial content and reasoning retained, stream=${stream}`, async (t) => {
    const input = oracleInputs.find((c) => c.id === 'response-initial')
    const fx = fixture(t, { respond: () => ({ events: input.events }) })
    const { res } = await fx.run(ordinary, { stream })
    if (stream) {
      assert.equal(
        decode(res)
          .map((c) => c.choices?.[0]?.delta?.content || '')
          .join(''),
        'initial',
      )
      assert.match(res.text, /thought/)
    } else {
      const message = JSON.parse(res.text).choices[0].message
      assert.equal(message.content, 'initial')
      assert.equal(message.reasoning_content, 'thought')
    }
  })
for (const stream of [false, true])
  test(`Chat multiple messages is ${stream ? 'a sticky stream error' : 'buffered without loss'}`, async (t) => {
    const input = oracleInputs.find((c) => c.id === 'response-multiple')
    const fx = fixture(t, { respond: () => ({ events: input.events }) })
    const { res, batch, recorded } = await fx.run(ordinary, { stream, failure: stream })
    assert.equal(batch.length, 1, 'never continue or replay after output')
    if (stream) {
      assert.equal(decode(res).filter((c) => c.error).length, 1)
      assert.doesNotMatch(res.text, /\[DONE\]/)
      assert.ok(recorded.error_code)
    } else {
      const out = JSON.parse(res.text)
      assert.equal(out.id, 'msg_second')
      assert.equal(out.model, 'second-model')
      assert.equal(out.choices[0].message.content, 'hellohello')
      assert.equal(out.choices[0].message.reasoning_content, 'Reason exactReason exact')
    }
  })
for (const stream of [false, true])
  test(`Chat authoritative trailer usage and length outrank tool presence, stream=${stream}`, async (t) => {
    const input = oracleInputs.find((c) => c.id === 'response-tools')
    const events = structuredClone(input.events)
    events.at(-2).delta.stop_reason = 'max_tokens'
    const fx = fixture(t, {
      respond: () => ({
        events,
        trailers: {
          'x-kin-usage': JSON.stringify({ input_tokens: 11, cache_read_input_tokens: 9, output_tokens: 29 }),
        },
      }),
    })
    const { res } = await fx.run({ ...ordinary, stream_options: { include_usage: true } }, { stream })
    const output = stream ? decode(res) : [JSON.parse(res.text)]
    assert.equal(output.find((c) => c.choices?.[0]?.finish_reason)?.choices[0].finish_reason, 'length')
    assert.equal(output.at(-1).usage.completion_tokens, 29)
    assert.equal(output.at(-1).usage.prompt_tokens, 23)
  })
for (const stream of [false, true])
  test(`Chat forced tool and explicit auto/none survive real preparation, stream=${stream}`, async (t) => {
    const fx = fixture(t)
    for (const reasoning_effort of ['auto', 'none', 'max']) {
      const body = { ...ordinary, reasoning_effort, model: 'claude-sonnet-4-6', top_p: 0.7 }
      const { envelope } = await fx.run(body, { stream, session: reasoning_effort })
      assert.equal(envelope.body.top_p, undefined)
      assert.equal(envelope.body.output_config?.effort, reasoning_effort === 'max' ? 'max' : undefined)
      assert.equal(envelope.body.thinking.type, reasoning_effort === 'none' ? 'disabled' : 'adaptive')
      const forced = await fx.run(
        { ...body, tools: [tool('f')], tool_choice: 'required' },
        { stream, session: 'forced-' + reasoning_effort },
      )
      assert.equal(forced.envelope.body.tool_choice.type, 'any')
      assert.equal(forced.envelope.body.thinking, undefined)
      assert.equal(forced.envelope.body.output_config?.effort, undefined)
    }
  })
test('unsupported caller system is HTTP400 before any native send', async (t) => {
  const fx = fixture(t)
  const { res, batch } = await fx.run(
    {
      messages: [
        { role: 'system', content: [{ type: 'image_url', image_url: { url: 'https://example.invalid' } }] },
        ...ordinary.messages,
      ],
    },
    { stream: false, failure: true },
  )
  assert.equal(res.statusCode, 400)
  assert.equal(batch.length, 0)
  assert.equal(JSON.parse(res.text).error.code, 'invalid_chat_request')
})
for (const change of ['unchanged', 'removed', 'changed', 'ordinary'])
  test(`Chat generated structured-format cache hint: ${change}`, async (t) => {
    const rules = ['removed', 'changed'].includes(change)
      ? [
          {
            phase: 'before_upstream',
            action: {
              set_body_field: { system: change === 'removed' ? [] : [{ type: 'text', text: 'replaced instruction' }] },
            },
          },
        ]
      : []
    const fx = fixture(t, { rules })
    const schema = { type: 'object', properties: { [change === 'ordinary' ? 'value' : 'title']: { type: 'string' } } }
    const { envelope } = await fx.run(
      {
        messages: [{ role: 'user', content: '<session>write tests</session>' }],
        response_format: { type: 'json_schema', json_schema: { schema } },
      },
      { stream: false },
    )
    assert.equal(envelope.cache_ttl, change === 'unchanged' ? '5m' : '1h')
    assert.equal(envelope.body.output_config, undefined)
    assert.equal(envelope.body.cacheTitleHint, undefined)
  })

test('Chat suffix wins over body effort while preserving validated native model routing', async (t) => {
  const fx = fixture(t)
  const { envelope } = await fx.run(
    { ...ordinary, model: 'claude-sonnet-4-6(high)', reasoning_effort: 'none' },
    { stream: false },
  )
  assert.equal(envelope.body.model, 'claude-sonnet-4-6')
  assert.deepEqual(envelope.body.thinking, { type: 'adaptive', display: 'omitted' })
  assert.equal(envelope.body.output_config.effort, 'high')
})
test('buffered multiple Messages preserve tools even when native block indices are reused', async (t) => {
  const input = oracleInputs.find((c) => c.id === 'response-tools')
  const second = structuredClone(input.events)
  second[0].message.id = 'second'
  second[3].delta.partial_json = '{ "second": 2 }'
  const fx = fixture(t, { respond: () => ({ events: [...input.events, ...second] }) })
  const { res, batch } = await fx.run(ordinary, { stream: false })
  const output = JSON.parse(res.text)
  assert.equal(batch.length, 1)
  assert.equal(output.id, 'second')
  assert.deepEqual(
    output.choices[0].message.tool_calls.map((t) => t.function.arguments),
    ['{ "z" : 1, "a":2 }', '{}', '{ "second": 2 }', '{}'],
  )
})

function trailerOnlyCompletion(id = 'response-tools') {
  const input = oracleInputs.find((item) => item.id === id)
  const events = structuredClone(input.events)
  const finalDelta = events.findLast((event) => event.type === 'message_delta')
  const stopReason = finalDelta.delta.stop_reason
  delete finalDelta.delta.stop_reason
  return { events, trailers: { 'x-kin-stop-reason': stopReason, 'x-kin-terminal-state': 'verified' } }
}

for (const stream of [false, true]) {
  test(`Chat trailer-only native stop preserves raw tool JSON, stream=${stream}`, async (t) => {
    const spec = trailerOnlyCompletion()
    const raw = spec.events.find((event) => event.type === 'content_block_delta' && event.index === 3).delta
      .partial_json
    assert.equal(raw, '{ "z" : 1, "a":2 }')
    const fx = fixture(t, { respond: () => spec })
    const { res, batch } = await fx.run({ ...ordinary, stream_options: { include_usage: true } }, { stream })
    assert.equal(batch.length, 1)
    if (stream) {
      const chunks = decode(res)
      const tools = chunks.flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls || [])
      assert.equal(tools[0].function.arguments, raw)
      assert.equal(chunks.filter((chunk) => chunk.choices?.[0]?.finish_reason).length, 1)
      assert.equal(chunks.find((chunk) => chunk.choices?.[0]?.finish_reason).choices[0].finish_reason, 'tool_calls')
      assert.equal(chunks.filter((chunk) => chunk.choices?.length === 0).length, 1)
      assert.match(res.text, /\[DONE\]/)
    } else {
      const output = JSON.parse(res.text)
      assert.equal(output.choices[0].message.tool_calls[0].function.arguments, raw)
      assert.equal(output.choices[0].finish_reason, 'tool_calls')
    }
  })

  test(`Chat final-trailer-only multiple Messages ${stream ? 'remain a sticky stream error' : 'retain all accumulated text/reasoning'}`, async (t) => {
    const fx = fixture(t, { respond: () => trailerOnlyCompletion('response-multiple') })
    const { res, batch } = await fx.run(ordinary, { stream, failure: stream })
    assert.equal(batch.length, 1)
    if (stream) {
      assert.equal(decode(res).filter((chunk) => chunk.error).length, 1)
      assert.doesNotMatch(res.text, /\[DONE\]/)
    } else {
      const output = JSON.parse(res.text)
      assert.equal(output.id, 'msg_second')
      assert.equal(output.model, 'second-model')
      assert.equal(output.choices[0].message.content, 'hellohello')
      assert.equal(output.choices[0].message.reasoning_content, 'Reason exactReason exact')
      assert.equal(output.choices[0].finish_reason, 'stop')
    }
  })

  for (const failure of ['failed', 'cancelled', 'sse-error']) {
    test(`Chat trailer-only stop never rescues ${failure}, stream=${stream}`, async (t) => {
      const spec = trailerOnlyCompletion()
      if (failure === 'sse-error')
        spec.events.push({ type: 'error', error: { type: 'api_error', message: 'explicit failure after tools' } })
      else spec.trailers['x-kin-terminal-state'] = failure
      const fx = fixture(t, { respond: () => spec })
      const { res, batch } = await fx.run(
        { ...ordinary, stream_options: { include_usage: true } },
        { stream, failure: true },
      )
      assert.equal(batch.length, 1)
      assert.doesNotMatch(res.text, /\[DONE\]/)
      if (stream) {
        assert.equal(decode(res).filter((chunk) => chunk.error).length, 1)
        assert.equal(decode(res).filter((chunk) => chunk.choices?.length === 0).length, 0)
      } else {
        assert.equal(res.statusCode, 502)
        assert.ok(JSON.parse(res.text).error)
      }
    })
  }
}

for (const input of oracleInputs.filter((item) => item.id.startsWith('suffix-review-'))) {
  test(`Chat known-model suffix route matches executed CPA: ${input.id}`, async (t) => {
    const expected = oracleGoldens.cases.find((item) => item.id === input.id).thinking
    assert.ok(expected, 'this fixture must be accepted by the actual CPA thinking pipeline')
    const fx = fixture(t)
    const { envelope, batch } = await fx.run(
      { ...JSON.parse(input.inputRawJSON), max_tokens: 32000 },
      { stream: false },
    )
    assert.equal(batch.length, 1)
    assert.equal(envelope.body.model, input.model.replace(/\([^()]*\)$/, ''))
    assert.deepEqual(envelope.body.thinking, expected.thinking)
    assert.deepEqual(envelope.body.output_config, expected.output_config)
    assert.equal(envelope.body.max_tokens, expected.max_tokens)
  })
}
