import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyCacheTtlToBody,
  clearConversationCacheTtls,
  DEFAULT_CACHE_TTL,
  enforceCacheTtlOrder,
  fillMissingCacheTtl,
  validateCacheBreakpoints,
  normalizeCacheTtl,
  pinConversationCacheTtl,
  resolveCacheTtl,
  stripIllegalCacheControlFields,
  applyCacheBreakpoints,
  applyCacheTtlToUsage,
} from '../../src/lib/protocol/cache-ttl.mjs'
import { usesShortClaudeCache } from '../../src/lib/protocol/cache-request.mjs'
import { workerEnvelope } from '../../src/lib/transport/go-worker-client.mjs'
import { calculateCost } from '../../src/lib/admin/pricing.mjs'
const block = (ttl) => ({ type: 'text', text: 'prefix', cache_control: { type: 'ephemeral', ...(ttl ? { ttl } : {}) } })

test('resolved wire TTL stays 5m/1h; auto uses credential kind', () => {
  assert.equal(DEFAULT_CACHE_TTL, '1h')
  for (const [value, expected] of [
    ['5min', '5m'],
    ['1hr', '1h'],
    [undefined, '1h'],
    ['bogus', '1h'],
  ])
    assert.equal(normalizeCacheTtl(value), expected)
  assert.equal(resolveCacheTtl({ routing: { compatibility: { cache_ttl: 'auto' } }, credentialMode: 'apikey' }), '5m')
  assert.equal(resolveCacheTtl({ routing: { compatibility: { cache_ttl: 'auto' } }, credentialMode: 'oauth' }), '1h')
})
test('header chooses default; highest inbound tier prevents new short prefix before explicit 1h', () => {
  assert.equal(resolveCacheTtl({ headers: { 'x-kin-cache-ttl': '5m' }, body: { system: [block('1h')] } }), '5m')
  assert.equal(
    resolveCacheTtl({ body: { system: [block('1h')] }, routing: { compatibility: { cache_ttl: '5m' } } }),
    '1h',
  )
  assert.equal(resolveCacheTtl({ body: { system: [block('5m')] } }), '5m')
  assert.equal(resolveCacheTtl({ officialTraffic: true, body: { system: [block('5m')] } }), '5m')
})
test('ttl-less markers (official Claude Code) take the settings menu value', () => {
  const body = {
    system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] }],
  }
  assert.equal(resolveCacheTtl({ headers: {}, body, routing: { compatibility: { cache_ttl: '1h' } } }), '1h')
  assert.equal(resolveCacheTtl({ headers: {}, body, routing: { compatibility: { cache_ttl: '5m' } } }), '5m')
  const out = applyCacheTtlToBody(body, '1h')
  assert.deepEqual(out.system[0].cache_control, { type: 'ephemeral', ttl: '1h' })
  assert.deepEqual(out.messages[0].content[0].cache_control, { type: 'ephemeral', ttl: '1h' })
})

test('owned TTL completion preserves explicit mixed TTLs and scope without mutating input', () => {
  const input = {
    system: [
      { type: 'text', text: 'hour', cache_control: { type: 'ephemeral', ttl: '1h', scope: 'global' } },
      { type: 'text', text: 'missing', cache_control: { type: 'ephemeral', scope: 'org' } },
    ],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'short', cache_control: { type: 'ephemeral', ttl: '5m' } }] },
    ],
  }
  const before = structuredClone(input)
  const output = fillMissingCacheTtl(input, '5m')
  assert.deepEqual(
    output.system.map((block) => block.cache_control),
    [
      { type: 'ephemeral', ttl: '1h', scope: 'global' },
      { type: 'ephemeral', ttl: '5m', scope: 'org' },
    ],
  )
  assert.deepEqual(output.messages, input.messages)
  assert.deepEqual(input, before)
})

test('owned TTL completion never places a filled 1h after a shorter marker', () => {
  const marked = (text, ttl) => ({ type: 'text', text, cache_control: { type: 'ephemeral', ...(ttl ? { ttl } : {}) } })
  const output = fillMissingCacheTtl(
    {
      tools: [{ name: 'Read', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } }],
      system: [marked('short', '5m')],
      messages: [{ role: 'user', content: [marked('tail')] }],
      cache_control: { type: 'ephemeral' },
    },
    '1h',
  )
  assert.deepEqual(output.tools[0].cache_control, { type: 'ephemeral', ttl: '1h' })
  assert.deepEqual(output.messages[0].content[0].cache_control, { type: 'ephemeral', ttl: '5m' })
  assert.deepEqual(output.cache_control, { type: 'ephemeral', ttl: '5m' })
  validateCacheBreakpoints(output)
})

test('native validation counts automatic caching against the explicit marker budget', () => {
  const input = {
    system: Array.from({ length: 4 }, (_, index) => ({
      type: 'text',
      text: String(index),
      cache_control: { type: 'ephemeral', ttl: '1h' },
    })),
    cache_control: { type: 'ephemeral' },
  }
  assert.throws(() => validateCacheBreakpoints(input), /four breakpoints/)
})

test('a conversation keeps its first TTL until that cache would have expired', () => {
  clearConversationCacheTtls()
  const t0 = 1_000_000
  assert.equal(pinConversationCacheTtl('conv-a', '5m', t0), '5m')
  // Menu flipped to 1h mid-conversation: still 5m while the 5m cache is warm.
  assert.equal(pinConversationCacheTtl('conv-a', '1h', t0 + 4 * 60_000), '5m')
  // Each turn refreshes the window.
  assert.equal(pinConversationCacheTtl('conv-a', '1h', t0 + 8 * 60_000), '5m')
  // Idle longer than 5m: the cache is gone, so the new value applies.
  assert.equal(pinConversationCacheTtl('conv-a', '1h', t0 + 14 * 60_000), '1h')
  assert.equal(pinConversationCacheTtl('conv-b', '5m', t0), '5m', 'conversations are independent')
  assert.equal(pinConversationCacheTtl('', '5m', t0), '5m')
  assert.equal(pinConversationCacheTtl('', '1h', t0), '1h', 'no key means no pin')
  clearConversationCacheTtls()
})
test('missing TTL is 5m for order checking and automatic top-level boundary is last', () => {
  const body = {
    cache_control: { type: 'ephemeral', ttl: '5m' },
    tools: [{ name: 'f', cache_control: { type: 'ephemeral', ttl: '1h' } }],
    system: [block('1h')],
    messages: [{ role: 'user', content: [block()] }],
  }
  const out = enforceCacheTtlOrder(body)
  assert.equal(out.tools[0].cache_control.ttl, '1h')
  assert.equal(out.system[0].cache_control.ttl, '1h')
  const invalid = enforceCacheTtlOrder({ ...body, cache_control: { type: 'ephemeral', ttl: '1h' } })
  assert.equal(invalid.cache_control.ttl, '5m')
})
test('public scope stripping is independent from TTL policy', () => {
  const body = { system: [{ ...block('5m'), cache_control: { type: 'ephemeral', ttl: '5m', scope: 'global' } }] }
  assert.deepEqual(stripIllegalCacheControlFields(body).system[0].cache_control, { type: 'ephemeral', ttl: '5m' })
  assert.equal(applyCacheTtlToBody(body, '1h').system[0].cache_control.ttl, '5m')
})
test('probes/helpers get short TTL; ordinary text is not classified as internal helper', () => {
  const probe = { max_tokens: 1, messages: [{ role: 'user', content: 'probe' }], system: [block('1h')] }
  assert.equal(resolveCacheTtl({ body: probe }), '5m')
  const out = applyCacheTtlToBody(probe, '1h', { short: usesShortClaudeCache({ body: probe }) })
  assert.deepEqual(out.system[0].cache_control, { type: 'ephemeral' })
  assert.equal(usesShortClaudeCache({ body: { messages: [{ role: 'user', content: 'Return a short title' }] } }), false)
  assert.equal(usesShortClaudeCache({ body: { system: 'Return a short title' } }), true)
  assert.equal(
    usesShortClaudeCache({ body: { max_tokens: 1, messages: [{ role: 'user', content: 'explain physics' }] } }),
    false,
  )
})
test('subagent default is short unless it explicitly opts into 1h', () => {
  const headers = { 'X-Claude-Code-Agent-Id': 'sub' }
  assert.equal(resolveCacheTtl({ headers }), '5m')
  assert.equal(resolveCacheTtl({ headers, body: { system: [block('1h')] } }), '1h')
  assert.equal(
    usesShortClaudeCache({ headers: { ...headers, 'anthropic-beta': 'extended-cache-ttl-2025-04-11' } }),
    false,
  )
  assert.equal(usesShortClaudeCache({ body: { messages: [{ role: 'user', content: 'cc_is_subagent=true' }] } }), false)
})
test('fill preserves historical anchors and adds only the last eligible message', () => {
  const body = {
    system: [block('1h')],
    tools: [{ name: 'f' }],
    messages: [
      { role: 'user', content: [block('1h')] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: 'next' },
    ],
  }
  const out = applyCacheBreakpoints(body, { config: { messages: 'rewrite' }, ttl: '5m' })
  assert.equal(out.messages[0].content[0].cache_control.ttl, '1h')
  assert.equal(out.messages[1].content[0].cache_control, undefined)
  assert.equal(out.messages[2].content[0].cache_control.ttl, '1h')
  assert.equal(out.tools[0].cache_control, undefined)
})
test('a covering system does not bypass deferred-tool cache validation', () => {
  const out = applyCacheBreakpoints({
    system: [block('1h')],
    tools: [{ name: 'lazy', defer_loading: true, cache_control: { type: 'ephemeral', ttl: '1h' } }],
  })
  assert.equal(out.tools[0].cache_control, undefined)
})

test('thinking tail is not a rolling breakpoint host', () => {
  const out = applyCacheBreakpoints(
    {
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }] },
      ],
    },
    { config: { messages: 'fill' } },
  )
  assert.equal(out.messages[0].content[0].cache_control.type, 'ephemeral')
  assert.equal(out.messages[1].content[0].cache_control, undefined)
})
test('native CLI envelope carries the pinned conversation TTL under upstream policy', () => {
  const { envelope: out } = workerEnvelope({
    body: { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hello' }] },
    cacheTtl: '1h',
    preserveCacheBreakpoints: false,
  })
  assert.equal(out.cache_ttl, '1h')
  assert.equal(out.preserve_cache_breakpoints, false)
})

test('a late creation total does not fabricate the stale cache TTL split', () => {
  const usage = {
    cache_creation_input_tokens: 14890,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 119 },
  }
  const out = applyCacheTtlToUsage(usage, '1h')
  assert.equal(out, usage)
  assert.equal(out.cache_creation.ephemeral_1h_input_tokens, 119)
  assert.equal(out.cache_creation_input_tokens, 14890)
  assert.equal(out.cache_ttl, undefined)
})

test('measured 5m usage stays in the 1.25x bucket', () => {
  const usage = {
    cache_creation_input_tokens: 2000,
    cache_creation: { ephemeral_5m_input_tokens: 2000, ephemeral_1h_input_tokens: 0 },
  }
  const out = applyCacheTtlToUsage(usage, '5m')
  assert.equal(out, usage)
  assert.equal(out.cache_creation.ephemeral_5m_input_tokens, 2000)
  const billed = calculateCost(out, 'claude-sonnet-5')
  assert.equal(billed.cache_creation_cost, 0.005)
})

test('kernel preservation envelope cannot also force TTL rewrite', () => {
  const { envelope: out } = workerEnvelope({
    body: { model: 'claude-sonnet-5', system: [block('1h')], messages: [{ role: 'user', content: [block('5m')] }] },
    cacheTtl: '1h',
    preserveCacheBreakpoints: true,
  })
  assert.equal(out.cache_ttl, null)
  assert.equal(out.preserve_cache_breakpoints, true)
  assert.equal(out.body.system[0].cache_control.ttl, '1h')
  assert.equal(out.body.messages[0].content[0].cache_control.ttl, '5m')
})
