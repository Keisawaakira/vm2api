import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyCacheTtlToBody,
  clearConversationCacheTtls,
  DEFAULT_CACHE_TTL,
  enforceCacheTtlOrder,
  normalizeCacheTtl,
  pinConversationCacheTtl,
  resolveCacheTtl,
  stripIllegalCacheControlFields,
  applyCacheBreakpoints,
} from '../../src/lib/protocol/cache-ttl.mjs'
import { usesShortClaudeCache } from '../../src/lib/protocol/cache-request.mjs'
import { workerEnvelope } from '../../src/lib/transport/go-worker-client.mjs'
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
  const out = workerEnvelope({
    body: { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hello' }] },
    cacheTtl: '1h',
    preserveCacheBreakpoints: false,
  })
  assert.equal(out.cache_ttl, '1h')
  assert.equal(out.preserve_cache_breakpoints, false)
})

test('kernel preservation envelope cannot also force TTL rewrite', () => {
  const out = workerEnvelope({
    body: { model: 'claude-sonnet-5', system: [block('1h')], messages: [{ role: 'user', content: [block('5m')] }] },
    cacheTtl: '1h',
    preserveCacheBreakpoints: true,
  })
  assert.equal(out.cache_ttl, null)
  assert.equal(out.preserve_cache_breakpoints, true)
  assert.equal(out.body.system[0].cache_control.ttl, '1h')
  assert.equal(out.body.messages[0].content[0].cache_control.ttl, '5m')
})
