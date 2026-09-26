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
    apiScheduler: {},
    groupsRepo: { rateMultiplier: () => 1 },
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfig: routing,
    routingConfigPath: routingFile,
  })
  async function run(
    body = ordinary,
    { protocol = 'openai.chat', headers = {}, stream = true, session = 'shared' } = {},
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
    assert.equal(res.statusCode, 200, res.text)
    assert.equal(recorded.error_code, null, JSON.stringify(recorded))
    const batch = sends.slice(start)
    assert.ok(batch.length)
    return { batch, envelope: batch.at(-1).envelope, res, recorded, req, inbound }
  }
  return { run, sends, sticky, scheduler }
}

for (const stream of [true, false]) {
  for (const scenario of ['matching', 'override', 'after-zero-attempt']) {
    test(`official usage stays raw across ${scenario} (stream=${stream})`, async (t) => {
      const persona = scenario === 'override' ? 'zero' : 'official'
      const routingFile = 'in-memory-official-usage-routing'
      const readFile = fs.readFileSync.bind(fs)
      t.mock.method(fs, 'readFileSync', (file, ...args) =>
        file === routingFile ? JSON.stringify({ compatibility: { persona_preset: persona } }) : readFile(file, ...args),
      )
      const accounts = scenario === 'after-zero-attempt' ? [candidate('a'), candidate('b')] : [candidate('a')]
      accounts[0].vm.persona_preset = scenario === 'after-zero-attempt' ? 'zero' : 'official'
      if (accounts[1]) accounts[1].vm.persona_preset = 'official'
      const fx = fixture(t, {
        persona,
        routingFile,
        accounts,
        respond: ({ index }) =>
          scenario === 'after-zero-attempt' && index === 0
            ? {
                status: 429,
                body: { type: 'error', error: { type: 'rate_limit_error', message: "You've hit your limit" } },
              }
            : {},
      })
      const result = await fx.run({ ...ordinary, stream_options: { include_usage: true } }, { stream })
      const clientUsage = stream
        ? result.res.text
            .split('\n')
            .filter((line) => line.startsWith('data: {'))
            .map((line) => JSON.parse(line.slice(6)))
            .find((chunk) => Array.isArray(chunk.choices) && chunk.choices.length === 0)?.usage
        : JSON.parse(result.res.text).usage
      assert.equal(result.batch.length, scenario === 'after-zero-attempt' ? 2 : 1)
      assert.equal(result.recorded.usage.input_tokens, 40)
      assert.equal(result.recorded.usage.cache_read_input_tokens, 60)
      assert.equal(clientUsage?.prompt_tokens, 100)
      assert.equal(clientUsage?.prompt_tokens_details?.cached_tokens, 60)
    })
  }
}

for (const role of ['system', 'developer', 'user']) {
  test(`Chat ${role} message-level 5m matches accepted Messages blocks`, async (t) => {
    const fx = fixture(t)
    const annotated = { role, content: 'fixed caller content', cache_control: cc('5m') }
    const chat = { messages: role === 'user' ? [annotated] : [annotated, ...ordinary.messages] }
    const native =
      role === 'user'
        ? { messages: [{ role: 'user', content: [text('fixed caller content', '5m')] }] }
        : { system: [text('fixed caller content', '5m')], ...ordinary }
    const a = await fx.run(chat, { session: 'chat' })
    const b = await fx.run(native, { protocol: 'anthropic.messages', session: 'native' })
    assert.equal(a.envelope.cache_ttl, '5m')
    assert.equal(a.envelope.cache_ttl, b.envelope.cache_ttl)
  })
}

test('nested Chat function cache marker selects the same TTL as a Messages tool', async (t) => {
  const fx = fixture(t)
  const a = await fx.run({ ...ordinary, tools: [tool('keep', '5m')] }, { session: 'chat' })
  const b = await fx.run(
    { ...ordinary, tools: [{ name: 'keep', input_schema: { type: 'object' }, cache_control: cc('5m') }] },
    { protocol: 'anthropic.messages', session: 'native' },
  )
  assert.equal(a.envelope.cache_ttl, '5m')
  assert.equal(a.envelope.cache_ttl, b.envelope.cache_ttl)
})

for (const role of ['system', 'developer']) {
  test(`Chat ${role} title matches normalized Messages title`, async (t) => {
    const fx = fixture(t)
    const a = await fx.run(
      { messages: [{ role, content: 'Return a short title' }, ...ordinary.messages] },
      { session: 'chat' },
    )
    const b = await fx.run(
      { system: [text('Return a short title')], ...ordinary },
      { protocol: 'anthropic.messages', session: 'native' },
    )
    assert.equal(a.envelope.cache_ttl, '5m')
    assert.equal(a.envelope.cache_ttl, b.envelope.cache_ttl)
  })
}

test('Chat structured-title response_format matches normalized Messages output_config', async (t) => {
  const fx = fixture(t)
  const messages = [{ role: 'user', content: '<session>write tests</session>' }]
  const a = await fx.run(
    { messages, response_format: { type: 'json_schema', json_schema: { name: 'title', schema: titleSchema } } },
    { session: 'chat' },
  )
  const b = await fx.run(
    { messages, output_config: { format: { type: 'json_schema', schema: titleSchema } } },
    { protocol: 'anthropic.messages', session: 'native' },
  )
  assert.equal(a.envelope.cache_ttl, '5m')
  assert.equal(a.envelope.cache_ttl, b.envelope.cache_ttl)
})

test('filtered tools/markers are not resurrected by raw-body policy merging', async (t) => {
  const fx = fixture(t)
  const dropped = { ...tool('drop'), cache_control: cc('1h') }
  const { envelope } = await fx.run({
    ...ordinary,
    tools: [tool('keep', '5m'), dropped],
    tool_choice: { type: 'allowed_tools', tools: [{ type: 'function', function: { name: 'keep' } }] },
  })
  assert.equal(envelope.cache_ttl, '5m')
  assert.deepEqual(
    envelope.body.tools.map((item) => item.name),
    ['keep'],
  )
  assert.doesNotMatch(JSON.stringify(envelope.body), /cache_control/)
})

test('filtered invalid message cache_control does not choose a TTL', async (t) => {
  const fx = fixture(t)
  const { envelope } = await fx.run({
    messages: [{ role: 'user', content: 'ordinary', cache_control: { type: 'unsupported', ttl: '5m' } }],
  })
  assert.equal(envelope.cache_ttl, '1h')
})

for (const phase of ['before_convert', 'before_upstream']) {
  test(`cache policy observes accepted ${phase} interception instead of raw markers`, async (t) => {
    const replacement =
      phase === 'before_convert'
        ? { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'ordinary', cache_control: cc('5m') }] }
        : {
            model: 'claude-sonnet-5',
            max_tokens: 1000,
            messages: [{ role: 'user', content: [text('ordinary', '5m')] }],
          }
    const fx = fixture(t, { rules: [{ phase, action: { replace_body_json: replacement } }] })
    const { envelope } = await fx.run({ ...ordinary, tools: [{ ...tool('rejected'), cache_control: cc('1h') }] })
    assert.equal(envelope.cache_ttl, '5m')
    assert.equal(envelope.body.tools, undefined)
  })
}

for (const format of ['object', 'string']) {
  test(`original ${format} parent metadata survives Chat normalization for subagent detection`, async (t) => {
    const fx = fixture(t)
    const id = { session_id: 'shared', parent_session_id: 'parent' }
    const { envelope } = await fx.run({
      ...ordinary,
      metadata: { user_id: format === 'string' ? JSON.stringify(id) : id },
    })
    assert.equal(envelope.cache_ttl, '5m')
    assert.doesNotMatch(JSON.stringify(envelope.body.metadata), /parent_session_id/)
  })
}

for (const [headerTtl, bodyTtl] of [
  ['1h', '5m'],
  ['5m', '1h'],
]) {
  test(`ordinary header ${headerTtl} overrides normalized body ${bodyTtl}`, async (t) => {
    const fx = fixture(t)
    const { envelope } = await fx.run(
      { messages: [{ role: 'user', content: 'ordinary', cache_control: cc(bodyTtl) }] },
      { headers: { 'x-kin-cache-ttl': headerTtl } },
    )
    assert.equal(envelope.cache_ttl, headerTtl)
  })
}

const helpers = [
  ['probe', { max_tokens: 1, messages: [{ role: 'user', content: 'probe' }] }, {}],
  ['title', { messages: [{ role: 'developer', content: 'Return a short title' }, ...ordinary.messages] }, {}],
  ['subagent', ordinary, { 'x-claude-code-agent-id': 'agent' }],
]
for (const [name, body, headers] of helpers) {
  for (const helperFirst of [true, false]) {
    test(`${name} bypasses ordinary pin (${helperFirst ? 'helper' : 'ordinary'} first)`, async (t) => {
      const fx = fixture(t)
      const requests = [() => fx.run(body, { headers }), () => fx.run()]
      if (!helperFirst) requests.reverse()
      const results = []
      for (const request of requests) results.push((await request()).envelope.cache_ttl)
      assert.deepEqual(results, helperFirst ? ['5m', '1h'] : ['1h', '5m'])
      const changed = await fx.run(ordinary, { headers: { 'x-kin-cache-ttl': '5m' } })
      assert.equal(changed.envelope.cache_ttl, '1h', 'ordinary changes still use their own first pin')
    })
  }
}

for (const explicit of ['header', 'body']) {
  for (const helperFirst of [true, false]) {
    test(`explicit1h subagent (${explicit}, ${helperFirst ? 'subagent' : 'ordinary5m'} first) never shares ordinary5m pin`, async (t) => {
      const fx = fixture(t)
      const body =
        explicit === 'body'
          ? { messages: [{ role: 'user', content: 'ordinary coding request', cache_control: cc('1h') }] }
          : ordinary
      const headers = {
        'x-claude-code-parent-agent-id': 'parent',
        ...(explicit === 'header' ? { 'x-kin-cache-ttl': '1h' } : {}),
      }
      const requests = [
        () => fx.run(body, { headers }),
        () => fx.run(ordinary, { headers: { 'x-kin-cache-ttl': '5m' } }),
      ]
      if (!helperFirst) requests.reverse()
      const results = []
      for (const request of requests) results.push((await request()).envelope.cache_ttl)
      assert.deepEqual(results, helperFirst ? ['1h', '5m'] : ['5m', '1h'])
      assert.equal((await fx.run()).envelope.cache_ttl, '5m')
    })
  }
}

for (const stream of [true, false]) {
  for (const helperFirst of [true, false]) {
    test(`Messages root 1h subagent honors explicit TTL (stream=${stream}, helperFirst=${helperFirst})`, async (t) => {
      const fx = fixture(t)
      const helper = () =>
        fx.run(
          { ...ordinary, cache_control: cc('1h') },
          { protocol: 'anthropic.messages', headers: { 'x-claude-code-agent-id': 'agent' }, stream },
        )
      const normal = () => fx.run(ordinary, { headers: { 'x-kin-cache-ttl': '5m' } })
      const requests = helperFirst ? [helper, normal] : [normal, helper]
      const results = []
      for (const request of requests) results.push((await request()).envelope.cache_ttl)
      assert.deepEqual(results, helperFirst ? ['1h', '5m'] : ['5m', '1h'])
      assert.equal((await fx.run()).envelope.cache_ttl, '5m')
    })
  }
}

test('subagent extended-TTL beta still permits ordinary credential default without reading its pin', async (t) => {
  const fx = fixture(t)
  await fx.run(ordinary, { headers: { 'x-kin-cache-ttl': '5m' } })
  const { envelope } = await fx.run(ordinary, {
    headers: { 'x-claude-code-agent-id': 'agent', 'anthropic-beta': 'extended-cache-ttl-2025-04-11' },
  })
  assert.equal(envelope.cache_ttl, '1h')
})

test('helpers do not refresh the ordinary pin idle clock', async (t) => {
  const fx = fixture(t)
  let now = 100000000
  t.mock.method(Date, 'now', () => now)
  await fx.run(ordinary, { headers: { 'x-kin-cache-ttl': '5m' } })
  now += 4 * 60000
  await fx.run(helpers[0][1])
  now += 2 * 60000
  assert.equal((await fx.run()).envelope.cache_ttl, '1h')
})

test('ordinary accesses refresh their own idle pin and it expires only after idle TTL', async (t) => {
  const fx = fixture(t)
  let now = 100000000
  t.mock.method(Date, 'now', () => now)
  await fx.run(ordinary, { headers: { 'x-kin-cache-ttl': '5m' } })
  now += 4 * 60000
  assert.equal((await fx.run()).envelope.cache_ttl, '5m')
  now += 4 * 60000
  assert.equal((await fx.run()).envelope.cache_ttl, '5m')
  now += 6 * 60000
  assert.equal((await fx.run()).envelope.cache_ttl, '1h')
})

for (const [mode, ttl] of [
  ['oauth', '1h'],
  ['setup-token', '1h'],
  ['apikey', '5m'],
]) {
  test(`selected ${mode} credential default stays ${ttl}`, async (t) => {
    const fx = fixture(t, { accounts: [candidate('a', mode)] })
    assert.equal((await fx.run()).envelope.cache_ttl, ttl)
  })
}

test('actual no-ID first request to bound growing history preserves selected-session TTL (F6 preservation)', async (t) => {
  const fx = fixture(t)
  const first = await fx.run(ordinary, { session: null, headers: { 'x-kin-cache-ttl': '1h' } })
  const key = fx.sticky.extractPoolKey(first.req, first.inbound, { platform: 'anthropic' })
  const bound = fx.sticky.resolve(key)
  assert.ok(bound.sessionId)
  assert.equal(bound.sessionId, sessionIdFromOutboundBody(first.envelope.body))
  const next = await fx.run(
    { messages: [...ordinary.messages, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'next turn' }] },
    { session: null, headers: { 'x-kin-cache-ttl': '5m' } },
  )
  assert.equal(sessionIdFromOutboundBody(next.envelope.body), bound.sessionId)
  assert.equal(next.envelope.cache_ttl, '1h')
})

test('selected-account TTL pins stay isolated across a real quota failover', async (t) => {
  let rejectA = false
  const a = candidate('a', 'oauth')
  const b = candidate('b', 'apikey')
  const fx = fixture(t, {
    accounts: [a, b],
    respond: ({ options }) =>
      rejectA && options.socketPath.endsWith('-a')
        ? {
            status: 429,
            body: { type: 'error', error: { type: 'rate_limit_error', message: '5h exhausted' } },
            headers: { 'anthropic-ratelimit-unified-5h-status': 'rejected' },
          }
        : {},
  })
  assert.equal((await fx.run()).envelope.cache_ttl, '1h')
  rejectA = true
  const failedOver = await fx.run()
  assert.deepEqual(
    failedOver.batch.map((send) => send.envelope.cache_ttl),
    ['1h', '5m'],
  )
  assert.equal(failedOver.recorded.account_id, b.accountId)
  assert.equal((await fx.run(ordinary, { headers: { 'x-kin-cache-ttl': '1h' } })).envelope.cache_ttl, '5m')
  fx.sticky.unbindByAccount({ accountId: b.accountId })
  rejectA = false
  assert.equal((await fx.run(ordinary, { headers: { 'x-kin-cache-ttl': '5m' } })).envelope.cache_ttl, '1h')
})

for (const stream of [true, false, 'omitted']) {
  test(`client stream=${stream} forwards resolved TTL and CLI flags in actual worker envelope`, async (t) => {
    const fx = fixture(t, { persona: 'official' })
    const body = { messages: [{ role: 'system', content: 'fixed caller instructions' }, ...ordinary.messages] }
    const { envelope, res } = await fx.run(body, { stream, headers: { 'x-kin-cache-ttl': '5m' } })
    assert.equal(envelope.cache_ttl, '5m')
    assert.equal(envelope.stream, true)
    assert.equal(envelope.delivery_mode, 'realtime')
    assert.equal(envelope.preserve_cache_breakpoints, false)
    assert.deepEqual(envelope.body.system, [{ type: 'text', text: 'fixed caller instructions' }])
    assert.ok(
      envelope.body.messages.every((message) => message.role !== 'system'),
      'Chat must not inject Node persona turns',
    )
    if (stream === true) assert.match(res.text, /\[DONE\]/)
    else assert.equal(JSON.parse(res.text).object, 'chat.completion')
  })
}

for (const persona of ['official', 'official_full']) {
  test(`${persona} ordinary Chat prefix is stable through actual handler and worker finalizer`, async (t) => {
    const fx = fixture(t, { persona })
    const messages = [{ role: 'system', content: 'fixed caller instructions' }, ...ordinary.messages]
    const first = (await fx.run({ messages })).envelope.body
    const next = (
      await fx.run({ messages: [...messages, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'next' }] })
    ).envelope.body
    assert.deepEqual(next.system, first.system)
    assert.deepEqual(next.messages.slice(0, first.messages.length), first.messages)
  })
}
