import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyCacheTtlToBody,
  applyCacheTtlToUsage,
  enforceCacheTtlOrder,
  resolveCacheTtl,
} from '../../src/lib/protocol/cache-ttl.mjs'
import { calculateCost } from '../../src/lib/admin/pricing.mjs'
import { prepareCliHopBody, prepareOutboundAttempt } from '../../src/lib/protocol/outbound-attempt.mjs'
import { applyCrsUnofficialPersona } from '../../src/lib/identity/crs-persona.mjs'
const block = (ttl) => ({ type: 'text', text: 'stable', cache_control: { type: 'ephemeral', ...(ttl ? { ttl } : {}) } })

test('CLIProxy preserves legal mixed TTL and repairs only later 1h', () => {
  const body = {
    tools: [{ name: 'f', cache_control: { type: 'ephemeral', ttl: '1h' } }],
    system: [block('1h'), block('5m'), block('1h')],
    messages: [{ role: 'user', content: [block('1h')] }],
  }
  const snapshot = structuredClone(body)
  const out = enforceCacheTtlOrder(body)
  assert.equal(out.tools[0].cache_control.ttl, '1h')
  assert.deepEqual(
    out.system.map((b) => b.cache_control.ttl || '5m'),
    ['1h', '5m', '5m'],
  )
  assert.equal(out.messages[0].content[0].cache_control.ttl || '5m', '5m')
  assert.deepEqual(body, snapshot)
})

test('TTL fill preserves explicit markers, extensions and default 5m wire shape', () => {
  const body = { system: [block('5m'), block()], cache_control: { type: 'ephemeral', ttl: '5m' } }
  body.system[0].cache_control.scope = 'global'
  const out = applyCacheTtlToBody(body, '1h')
  assert.equal(out.system[0].cache_control.ttl, '5m')
  assert.equal(out.system[0].cache_control.scope, 'global')
  assert.equal(out.system[1].cache_control.ttl, '1h')
  assert.equal(out.cache_control.ttl, '5m')
  assert.deepEqual(applyCacheTtlToBody({ system: [block()] }, '5m').system[0].cache_control, { type: 'ephemeral' })
})

test('credential automatic default differs from explicit console default', () => {
  assert.equal(resolveCacheTtl({ credentialMode: 'apikey' }), '5m')
  assert.equal(resolveCacheTtl({ credentialMode: 'setup-token' }), '1h')
  assert.equal(resolveCacheTtl({ credentialMode: 'oauth', routing: { compatibility: { cache_ttl: 'auto' } } }), '1h')
  assert.equal(resolveCacheTtl({ credentialMode: 'apikey', routing: { compatibility: { cache_ttl: '1h' } } }), '1h')
})

test('native CLI hop delegates all marker placement instead of competing with its cache prefix', () => {
  const out = prepareCliHopBody(
    {
      model: 'claude-sonnet-5',
      system: [block('1h')],
      tools: [{ name: 'f', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: [block('5m')] }],
    },
    { cacheTtl: '1h' },
  )
  assert.equal(out.tools[0].cache_control, undefined)
  assert.equal(out.system[0].cache_control, undefined)
  assert.equal(out.messages[0].content[0].cache_control, undefined)
})

test('zero persona preserves caller system blocks and explicit cache TTL before CLI hop', () => {
  const first = { ...block('1h'), text: 'first caller constraint' }
  const second = { ...block('5m'), text: 'second caller constraint' }
  const input = { model: 'claude-sonnet-5', system: [first, second], messages: [{ role: 'user', content: 'hello' }] }
  const persona = applyCrsUnofficialPersona(input, { mode: 'zero' })
  assert.deepEqual(persona.system.slice(-2), [first, second])
  const out = prepareCliHopBody(persona)
  assert.deepEqual(
    out.system.slice(-2).map((b) => b.text),
    [first.text, second.text],
  )
  assert.ok(out.system.every((b) => b.cache_control == null))
})

test('HTTP assembly uses credential default before creating new breakpoints', () => {
  const { body } = prepareOutboundAttempt({
    canonicalBody: {
      model: 'claude-sonnet-5',
      system: [{ type: 'text', text: 'prefix' }],
      messages: [{ role: 'user', content: 'hello' }],
    },
    unofficial: true,
    officialClient: false,
    credentialMode: 'apikey',
    identity: { deviceId: 'd'.repeat(64) },
    cacheBreakpoints: { enabled: true, system_tail: true, messages: 'fill' },
  })
  assert.equal(body.system[0].cache_control.ttl || '5m', '5m')
  assert.equal(body.messages[0].content[0].cache_control.ttl || '5m', '5m')
})

test('native CLI owns cache markers even for official callers', () => {
  const out = prepareCliHopBody(
    { model: 'claude-sonnet-5', tools: [{ name: 'f' }], messages: [{ role: 'user', content: [block()] }] },
    { officialClient: true, cacheTtl: null },
  )
  assert.equal(out.tools[0].cache_control, undefined)
  assert.equal(out.messages[0].content[0].cache_control, undefined)
})

test('HTTP assembly retains explicit legal mixed TTL after default fill', () => {
  const canonicalBody = {
    model: 'claude-sonnet-5',
    system: [block('1h')],
    messages: [{ role: 'user', content: [block('5m')] }],
  }
  const { body } = prepareOutboundAttempt({
    canonicalBody,
    inbound: canonicalBody,
    unofficial: true,
    officialClient: false,
    identity: { deviceId: 'd'.repeat(64) },
    cacheTtl: '1h',
    cacheBreakpoints: { enabled: true, messages: 'fill' },
  })
  assert.equal(body.system[0].cache_control.ttl, '1h')
  assert.equal(body.messages[0].content[0].cache_control.ttl, '5m')
})

test('upstream mixed usage and aliases cannot be reclassified by requested TTL', () => {
  const usage = {
    cache_creation_input_tokens: 1000,
    cache_creation: { ephemeral_5m_input_tokens: 700, ephemeral_1h_input_tokens: 300 },
  }
  for (const ttl of ['1h', '5m']) {
    assert.deepEqual(applyCacheTtlToUsage(usage, ttl), usage)
    const cost = calculateCost({ ...usage, cache_ttl: ttl }, 'claude-sonnet-5')
    assert.equal(cost.cache_creation_5m_tokens, 700)
    assert.equal(cost.cache_creation_1h_tokens, 300)
    assert.equal(cost.cache_creation_cost, 0.00295)
  }
  const cost = calculateCost(
    {
      cache_creation_input_tokens: 1000,
      cache_creation_5m_tokens: 0,
      cache_creation_1h_tokens: 1000,
      cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 0 },
    },
    'claude-sonnet-5',
  )
  assert.equal(cost.cache_creation_5m_tokens, 1000)
  assert.equal(cost.cache_creation_1h_tokens, 0)
})

test('missing/partial split is unknown, conservatively priced and marked estimated', () => {
  for (const ttl of [undefined, '1h', '5m']) {
    const usage = { cache_creation_input_tokens: 1000, cache_ttl: ttl }
    const cost = calculateCost(usage, 'claude-sonnet-5')
    assert.equal(cost.cache_creation_5m_tokens, null)
    assert.equal(cost.cache_creation_1h_tokens, null)
    assert.equal(cost.cache_creation_unclassified_tokens, 1000)
    assert.equal(cost.cache_creation_estimated, true)
    assert.equal(cost.cache_creation_cost, 0.0025)
  }
  const cost = calculateCost(
    { cache_creation_input_tokens: 1000, cache_creation: { ephemeral_1h_input_tokens: 300 } },
    'claude-sonnet-5',
  )
  assert.equal(cost.cache_creation_1h_tokens, 300)
  assert.equal(cost.cache_creation_5m_tokens, null)
  assert.equal(cost.cache_creation_unclassified_tokens, 700)
  assert.equal(cost.cache_creation_estimated, true)
})
