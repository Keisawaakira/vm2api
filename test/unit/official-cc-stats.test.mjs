import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseOfficialCcStats,
  inferTierFromOfficialStats,
  officialStatsText,
} from '../../src/lib/oauth/official-cc-stats.mjs'

test('explicit usage errors survive parsing and cannot certify cached quota data', () => {
  const stats = parseOfficialCcStats({
    error: { type: 'permission_error', message: 'Missing user:profile; token sk-ant-oat01-SECRET' },
    five_hour: { utilization: 12 },
    seven_day: { utilization: 30 },
  })
  assert.equal(stats.ok, false)
  assert.equal(stats.usage_error_code, 'permission_error')
  assert.match(stats.usage_error, /Missing user:profile/)
  assert.doesNotMatch(stats.usage_error, /sk-ant-oat01-SECRET/)
  assert.equal(stats.limits_present, false)
})

test('stream-json terminal failure is not reduced to usage=failed', () => {
  const stats = parseOfficialCcStats(
    [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        errors: ['HTTP 403: insufficient scope'],
      }),
    ].join('\n'),
  )
  assert.equal(stats.ok, false)
  assert.match(stats.usage_error, /HTTP 403: insufficient scope/)
  assert.equal(stats.usage_error_code, 'error_during_execution')
})

test('ordinary model prose mentioning an error is not treated as a structured CLI error', () => {
  const stats = parseOfficialCcStats({ type: 'result', result: 'The word error is ordinary text.' })
  assert.equal(stats.ok, false)
  assert.equal(stats.usage_error, undefined)
})

const quotaText =
  'You are currently using your subscription to power your Claude Code usage\nCurrent session: 5% used\nCurrent week (all models): 40% used\nCurrent week (Fable): 21% used'
const syntheticUsage = {
  type: 'assistant',
  message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: quotaText }] },
}
for (const [name, value] of [
  ['single assistant', JSON.stringify(syntheticUsage)],
  [
    'NDJSON without result',
    [JSON.stringify({ type: 'system', subtype: 'init' }), JSON.stringify(syntheticUsage)].join('\n'),
  ],
  ['NDJSON empty result', [JSON.stringify(syntheticUsage), JSON.stringify({ type: 'result', result: '' })].join('\n')],
  ['bare message', syntheticUsage.message],
])
  test(`usage text in ${name} is parsed instead of its JSON wrapper`, () => {
    const parsed = parseOfficialCcStats(value)
    assert.equal(parsed.ok, true)
    assert.equal(parsed.limits_present, true)
    assert.equal(parsed.five_hour.utilization, 0.05)
    assert.equal(parsed.seven_day.utilization, 0.4)
    assert.equal(parsed.seven_day_oi.utilization, 0.21)
    assert.equal(officialStatsText(value), quotaText)
  })

test('empty result cannot erase usage text, duplicate result does not duplicate it', () => {
  const raw = [JSON.stringify(syntheticUsage), JSON.stringify({ type: 'result', result: quotaText })].join('\n')
  assert.equal(officialStatsText(raw), quotaText)
})

test('explicit terminal failure still wins over a valid assistant quota block', () => {
  const raw = [
    JSON.stringify(syntheticUsage),
    JSON.stringify({ type: 'result', is_error: true, result: 'scope denied' }),
  ].join('\n')
  assert.equal(parseOfficialCcStats(raw).ok, false)
  assert.match(parseOfficialCcStats(raw).usage_error, /scope denied/)
})

for (const [format, encode] of [
  ['array object', (events) => events],
  ['serialized array', (events) => JSON.stringify(events)],
  ['NDJSON', (events) => events.map((e) => JSON.stringify(e)).join('\n')],
])
  test(`explicit error wins in ${format}`, () => {
    const raw = encode([syntheticUsage, { type: 'result', is_error: true, result: 'scope denied' }])
    const parsed = parseOfficialCcStats(raw)
    assert.equal(parsed.ok, false)
    assert.match(parsed.usage_error, /scope denied/)
  })

for (const complete of [true, false])
  for (const [format, encode] of [
    ['object', (event) => event],
    ['JSON', (event) => JSON.stringify(event)],
    ['array', (event) => [event, { type: 'result', result: '' }]],
    ['JSON array', (event) => JSON.stringify([event, { type: 'result', result: '' }])],
    ['NDJSON', (event) => JSON.stringify(event) + '\n' + JSON.stringify({ type: 'result', result: '' })],
  ])
    test(`structured quota wins over conflicting text (${format}, complete=${complete})`, () => {
      const limits = [{ kind: 'session', percent: 88 }, ...(complete ? [{ kind: 'weekly_all', percent: 99 }] : [])]
      const raw = encode({ ...syntheticUsage, usage_report: { rate_limits: { limits } } })
      const parsed = parseOfficialCcStats(raw)
      assert.equal(parsed.five_hour.utilization, 0.88)
      assert.equal(parsed.limits_present, complete)
      assert.equal(parsed.seven_day?.utilization ?? null, complete ? 0.99 : null)
    })

test('synthetic acknowledgement without quota is still not success', () => {
  const value = {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'You are currently using a subscription.' }] },
  }
  assert.equal(parseOfficialCcStats(value).ok, false)
})

test('parses official /stats text for Pro + 5h/7d', () => {
  const stats = parseOfficialCcStats('Plan: Claude Pro\n5-hour limit: 12% used\n7-day limit: 34% used')
  assert.equal(stats.account_tier, null)
  assert.equal(stats.five_hour.utilization, 0.12)
  assert.equal(stats.seven_day.utilization, 0.34)
})

test('parses Max and extra usage from text', () => {
  assert.equal(inferTierFromOfficialStats('Current plan: Claude Max'), 'max')
  const stats = parseOfficialCcStats('Claude Max\nExtra usage: enabled\nWeekly 8%')
  assert.equal(stats.account_tier, null)
  assert.equal(stats.extra_usage.is_enabled, true)
  assert.equal(stats.seven_day.utilization, 0.08)
})

test('local cost /stats without quota is not a successful ingest', () => {
  const stats = parseOfficialCcStats(
    JSON.stringify({
      type: 'result',
      is_error: false,
      result: 'Total cost:            $0.0000\nTotal duration (API):  0s',
    }),
  )
  assert.equal(stats.ok, false)
  assert.equal(stats.account_tier, null)
})

test('parses JSON envelope result text', () => {
  const stats = parseOfficialCcStats(
    JSON.stringify({
      type: 'result',
      result: 'Plan: Claude Pro\n5-hour 4%',
    }),
  )
  assert.equal(stats.account_tier, null)
  assert.equal(stats.five_hour.utilization_pct, 4)
  assert.equal(stats.ok, true)
})

test('direct official usage shape with explicit no Fable classifies Pro', () => {
  const stats = parseOfficialCcStats({
    five_hour: { utilization: 12 },
    seven_day: { utilization: 34 },
    seven_day_sonnet: { utilization: 8 },
    seven_day_opus: { utilization: 2 },
    seven_day_fable: null,
  })
  assert.equal(stats.ok, true)
  assert.equal(stats.limits_present, true)
  assert.equal(stats.usage_has_fable, false)
  assert.equal(stats.account_tier, 'pro')
})

test('direct official usage with only five hour is incomplete', () => {
  const stats = parseOfficialCcStats({ five_hour: { utilization: 12 }, seven_day_fable: null })
  assert.equal(stats.ok, true)
  assert.equal(stats.limits_present, false)
  assert.equal(stats.account_tier, null)
})

test('stream-json /usage reads usage_report limits including Fable', () => {
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({
      type: 'assistant',
      usage_report: {
        rate_limits: {
          limits: [
            { kind: 'session', group: 'session', percent: 12, resets_at: '2026-09-24T20:00:00Z' },
            { kind: 'weekly_all', group: 'weekly', percent: 34, resets_at: '2026-09-30T00:00:00Z' },
            {
              kind: 'weekly_scoped',
              group: 'weekly',
              percent: 21,
              resets_at: '2026-09-30T00:00:00Z',
              scope: { model: { display_name: 'Fable' } },
            },
          ],
          extra_usage: null,
        },
      },
    }),
    JSON.stringify({ type: 'result', result: 'Current session: 12% used' }),
  ].join('\n')
  const stats = parseOfficialCcStats(lines)
  assert.equal(stats.ok, true)
  assert.equal(stats.limits_present, true)
  assert.equal(stats.five_hour.utilization, 0.12)
  assert.equal(stats.seven_day.utilization, 0.34)
  assert.equal(stats.seven_day_oi.utilization, 0.21)
  assert.equal(stats.seven_day_oi.resets_at, '2026-09-30T00:00:00Z')
})

test('complete official /usage limits without Fable classify Pro', () => {
  const stats = parseOfficialCcStats({
    five_hour: { utilization: 12 },
    seven_day: { utilization: 34 },
    limits: [
      { kind: 'session', percent: 12 },
      { kind: 'weekly_all', percent: 34, scope: { model: { display_name: 'All models' } } },
      { kind: 'weekly_scoped', percent: 3, scope: { model: { display_name: 'Sonnet' } } },
    ],
  })
  assert.equal(stats.ok, true)
  assert.equal(stats.limits_present, true)
  assert.equal(stats.usage_has_fable, false)
  assert.equal(stats.account_tier, 'pro')
})

test('stream-json /usage without limits is flagged incomplete', () => {
  const lines = [
    JSON.stringify({ type: 'assistant', usage_report: { rate_limits: { limits: null } } }),
    JSON.stringify({ type: 'result', result: 'Total cost: $0.0000' }),
  ].join('\n')
  const stats = parseOfficialCcStats(lines)
  assert.equal(stats.ok, false)
  assert.equal(stats.limits_present, false)
})

test('2.1.28x /usage text rows map Fable to seven_day_oi', () => {
  const stats = parseOfficialCcStats(
    JSON.stringify({
      type: 'result',
      result:
        'You are currently using your subscription to power your Claude Code usage\n' +
        'Current session: 5% used · resets 8pm\n' +
        'Current week (all models): 40% used · resets Sep 30\n' +
        'Current week (Sonnet only): 3% used\n' +
        'Current week (Fable): 21% used · resets Sep 30',
    }),
  )
  assert.equal(stats.ok, true)
  assert.equal(stats.five_hour.utilization, 0.05)
  assert.equal(stats.seven_day.utilization, 0.4)
  assert.equal(stats.seven_day_sonnet.utilization, 0.03)
  assert.equal(stats.seven_day_oi.utilization, 0.21)
  assert.equal(stats.limits_present, true)
})

test('2.1.28x /usage text needs session and all-models rows before it is complete', () => {
  const stats = parseOfficialCcStats(
    JSON.stringify({
      type: 'result',
      result: 'Current week (Sonnet only): 3% used\nCurrent week (Fable): 21% used',
    }),
  )
  assert.equal(stats.ok, true)
  assert.equal(stats.limits_present, false)
  assert.equal(stats.account_tier, null)
})

test('2.1.293 print /usage result JSON keeps every utilization field', () => {
  const payload = {
    five_hour: { utilization: 12, resets_at: '2026-10-07T20:00:00Z' },
    seven_day: { utilization: 34, resets_at: '2026-10-12T00:00:00Z' },
    seven_day_sonnet: { utilization: 8, resets_at: '2026-10-12T00:00:00Z' },
    seven_day_opus: { utilization: 2, resets_at: '2026-10-12T00:00:00Z' },
    seven_day_oauth_apps: { utilization: 5, resets_at: '2026-10-12T00:00:00Z' },
    extra_usage: { is_enabled: true, monthly_limit: 2000, used_credits: 100, utilization: 5 },
  }
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({ type: 'result', subtype: 'success', result: JSON.stringify(payload) }),
  ].join('\n')
  const stats = parseOfficialCcStats(lines)
  assert.equal(stats.ok, true)
  assert.equal(stats.limits_present, true)
  assert.equal(stats.five_hour.utilization, 0.12)
  assert.equal(stats.seven_day.utilization, 0.34)
  assert.equal(stats.seven_day_sonnet.utilization, 0.08)
  assert.equal(stats.seven_day_opus.utilization, 0.02)
  assert.equal(stats.seven_day_oauth_apps.utilization, 0.05)
  assert.equal(stats.extra_usage.monthly_limit, 2000)
  assert.equal(stats.extra_usage.used_credits, 100)
  assert.equal(stats.usage_has_fable, null)
  assert.equal(stats.account_tier, null)
})

test('tierFromOauthProfile trusts has_claude_max / organization_type', async () => {
  const { tierFromOauthProfile } = await import('../../src/lib/oauth/official-cc-stats.mjs')
  assert.equal(tierFromOauthProfile({ account: { has_claude_max: true, has_claude_pro: false } }), 'max')
  assert.equal(tierFromOauthProfile({ organization: { organization_type: 'claude_max' } }), 'max')
  assert.equal(tierFromOauthProfile({ organization: { rate_limit_tier: 'default_claude_max_20x' } }), 'max')
  assert.equal(tierFromOauthProfile({ account: { has_claude_pro: true } }), 'pro')
  assert.equal(tierFromOauthProfile({ organization: { organization_type: 'claude_pro' } }), 'pro')
  assert.equal(tierFromOauthProfile({}), null)
})
