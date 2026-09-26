import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isClientStream } from '../../src/lib/protocol/convert.mjs'
import {
  normalizeHealthProbeConfig,
  isHealthShape,
  isSnapshotValid,
  decideHealthIntercept,
  inboundMatchesCacheModels,
  synthesizeProtocolResponse,
  formatHealthSse,
  healthUnavailableError,
  selectHealthProbeTargets,
  createHealthProbeMonitor,
  hasCachedMessage,
  HEALTH_REAL_HEADER,
  HEALTH_VIA_CACHE,
  HEALTH_VIA_UNAVAILABLE,
  DEFAULT_HEALTH_PROBE,
} from '../../src/lib/admin/health-probe.mjs'

// The cache/intercept switch ships off, so the intercept cases opt in.
const cfg = normalizeHealthProbeConfig({ enabled: true })

const unofficial = { 'user-agent': 'Go-http-client/2.0' }
const hiBody = {
  model: 'claude-haiku-4-5',
  max_tokens: 16,
  messages: [{ role: 'user', content: 'hi' }],
}

const cachedBody = {
  id: 'msg_01CachedHelloFromProbe',
  type: 'message',
  role: 'assistant',
  model: 'claude-haiku-4-5',
  content: [{ type: 'text', text: 'hello from cache' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 12, output_tokens: 6 },
}

function cachedSnap(extra = {}) {
  return {
    ok: true,
    at: '2026-08-23T23:55:00.000Z',
    text: 'hello from cache',
    vm_id: 'vm-30',
    model: 'claude-haiku-4-5',
    body: { ...cachedBody },
    ...extra,
  }
}

test('probe cache is off until an operator enables it', () => {
  assert.equal(DEFAULT_HEALTH_PROBE.enabled, false)
  assert.equal(normalizeHealthProbeConfig().enabled, false)
  assert.equal(normalizeHealthProbeConfig({}).enabled, false)
  assert.equal(normalizeHealthProbeConfig({ enabled: true }).enabled, true)
  // Off means a third-party hello runs a real probe instead of a replay.
  assert.equal(
    decideHealthIntercept({
      headers: unofficial,
      body: hiBody,
      cfg: normalizeHealthProbeConfig(),
      snapshot: cachedSnap(),
    }).action,
    'pass',
  )
})

test('normalize fills defaults and clamps', () => {
  const n = normalizeHealthProbeConfig({ interval_sec: 5, real: { outbound_mode: 'rewrite', max_tokens: 0 } })
  assert.equal(n.interval_sec, 30)
  assert.equal(n.real.outbound_mode, 'official')
  assert.equal(n.real.prompt, 'hello')
  assert.equal(n.real.max_tokens, 64)
  assert.equal(normalizeHealthProbeConfig({ real: { outbound_mode: 'lite' } }).real.outbound_mode, 'official')
  assert.equal(normalizeHealthProbeConfig({ real: { outbound_mode: 'unofficial' } }).real.outbound_mode, 'unofficial')
  assert.equal(n.fail_closed, true)
  assert.equal(n.cache_ttl_sec, 900)
  assert.deepEqual(n.cache_models, [])
})

test('cache_ttl_sec is the validity window and aliases max_stale_sec', () => {
  const now = Date.parse('2026-08-24T00:00:00.000Z')
  const snap = { ok: true, at: '2026-08-23T23:50:00.000Z', text: 'ok' }
  const short = normalizeHealthProbeConfig({ cache_ttl_sec: 120 })
  const long = normalizeHealthProbeConfig({ max_stale_sec: 3600 })
  assert.equal(short.cache_ttl_sec, 120)
  assert.equal(short.max_stale_sec, 120)
  assert.equal(isSnapshotValid(snap, short, now), false)
  assert.equal(isSnapshotValid(snap, long, now), true)
})

test('cache_models restrict which inbound models are intercepted', () => {
  const limited = normalizeHealthProbeConfig({ cache_models: ['claude-haiku-4-5', 'claude-sonnet-5'] })
  assert.equal(inboundMatchesCacheModels({ model: 'claude-haiku-4-5' }, limited), true)
  assert.equal(inboundMatchesCacheModels({ model: 'claude-haiku-4-5-20251001' }, limited), true)
  assert.equal(inboundMatchesCacheModels({ model: 'claude-opus-5' }, limited), false)
  const now = Date.parse('2026-08-24T00:00:00.000Z')
  const snap = cachedSnap({ text: 'pong' })
  assert.equal(
    decideHealthIntercept({
      headers: unofficial,
      body: { ...hiBody, model: 'claude-opus-5' },
      cfg: limited,
      snapshot: snap,
      now,
    }).action,
    'pass',
  )
})

test('cache_model overrides the cached response model', () => {
  const pinned = normalizeHealthProbeConfig({ cache_model: 'claude-sonnet-5' })
  const msg = synthesizeProtocolResponse('anthropic.messages', hiBody, cachedSnap(), pinned)
  assert.equal(msg.model, 'claude-sonnet-5')
  assert.equal(msg.id, cachedBody.id)
})

test('NewAPI-shaped hi + 16 tokens matches', () => {
  assert.equal(isHealthShape(unofficial, hiBody, cfg), true)
  assert.equal(isHealthShape(unofficial, { ...hiBody, max_tokens: 64 }, cfg), false)
  // NewAPI omits stream (Go omitempty) and Accept; must replay JSON, not SSE.
  assert.equal(isClientStream(hiBody, unofficial), false)
  assert.equal('stream' in hiBody, false)
})

test('official Claude Code is never a health shape', () => {
  const headers = { 'user-agent': 'claude-cli/2.1.241 (external, sdk-cli)' }
  const body = {
    ...hiBody,
    system: "You are Claude Code, Anthropic's official CLI for Claude.",
    metadata: {
      user_id: JSON.stringify({
        device_id: 'a'.repeat(64),
        account_uuid: '11111111-1111-4111-8111-111111111111',
        session_id: '22222222-2222-4222-8222-222222222222',
      }),
    },
  }
  assert.equal(isHealthShape(headers, body, cfg), false)
})

test('official UA skipped even without official body', () => {
  assert.equal(isHealthShape({ 'user-agent': 'claude-cli/2.1.241 (external, sdk-cli)' }, hiBody, cfg), false)
})

test('bypass header skips match', () => {
  assert.equal(isHealthShape({ ...unofficial, [HEALTH_REAL_HEADER]: '1' }, hiBody, cfg), false)
})

test('system or tools or multi-turn are not probes', () => {
  assert.equal(isHealthShape(unofficial, { ...hiBody, system: 'x' }, cfg), false)
  assert.equal(isHealthShape(unofficial, { ...hiBody, tools: [{ name: 'x' }] }, cfg), false)
  assert.equal(
    isHealthShape(
      unofficial,
      {
        ...hiBody,
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'yo' },
        ],
      },
      cfg,
    ),
    false,
  )
})

test('openai chat and completions extract the short user', () => {
  assert.equal(
    isHealthShape(
      unofficial,
      {
        model: 'claude-haiku-4-5',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hello' }],
      },
      cfg,
    ),
    true,
  )
  assert.equal(
    isHealthShape(
      unofficial,
      {
        model: 'claude-haiku-4-5',
        max_tokens: 8,
        prompt: 'ping',
      },
      cfg,
    ),
    true,
  )
})

test('valid snapshot vs stale / failed', () => {
  const now = Date.parse('2026-08-24T00:00:00.000Z')
  const fresh = { ok: true, at: '2026-08-23T23:55:00.000Z', text: 'ok' }
  const old = { ok: true, at: '2026-08-23T23:40:00.000Z', text: 'ok' }
  const failed = { ok: false, at: '2026-08-23T23:59:00.000Z', error: 'boom' }
  assert.equal(isSnapshotValid(fresh, cfg, now), true)
  assert.equal(isSnapshotValid(old, cfg, now), false)
  assert.equal(isSnapshotValid(failed, cfg, now), false)
})

test('decide: cache when valid, pass through transient miss, 503 only when no credential', () => {
  const now = Date.parse('2026-08-24T00:00:00.000Z')
  const snap = cachedSnap({ text: 'pong', vm_id: 'vm-01' })
  const cache = decideHealthIntercept({ headers: unofficial, body: hiBody, cfg, snapshot: snap, now })
  assert.equal(cache.action, 'cache')
  assert.equal(cache.via, HEALTH_VIA_CACHE)
  const transient = decideHealthIntercept({
    headers: unofficial,
    body: hiBody,
    cfg,
    snapshot: { ok: false, at: '2026-08-23T23:59:00.000Z', error: 'OAuth access token has been revoked.' },
    now,
  })
  assert.equal(transient.action, 'pass')
  const empty = decideHealthIntercept({ headers: unofficial, body: hiBody, cfg, snapshot: null, now })
  assert.equal(empty.action, 'pass')
  const fail = decideHealthIntercept({
    headers: unofficial,
    body: hiBody,
    cfg,
    snapshot: { ok: false, at: '2026-08-23T23:59:00.000Z', error: 'no_schedulable_credential' },
    now,
  })
  assert.equal(fail.action, 'fail')
  assert.equal(fail.via, HEALTH_VIA_UNAVAILABLE)
  const pass = decideHealthIntercept({
    headers: unofficial,
    body: hiBody,
    cfg: { ...cfg, fail_closed: false },
    snapshot: { ok: false, at: '2026-08-23T23:59:00.000Z', error: 'no_schedulable_credential' },
    now,
  })
  assert.equal(pass.action, 'pass')
})

test('disabled or non-probe body passes through', () => {
  assert.equal(
    decideHealthIntercept({
      headers: unofficial,
      body: hiBody,
      cfg: { ...cfg, enabled: false },
    }).action,
    'pass',
  )
  assert.equal(
    decideHealthIntercept({
      headers: unofficial,
      body: { ...hiBody, max_tokens: 2048, messages: [{ role: 'user', content: 'write a report' }] },
      cfg,
    }).action,
    'pass',
  )
})

test('replay cached Messages and chat.completions without synthesizing msg_health_*', () => {
  const snap = cachedSnap()
  const msg = synthesizeProtocolResponse('anthropic.messages', hiBody, snap)
  assert.equal(msg.id, 'msg_01CachedHelloFromProbe')
  assert.equal(msg.type, 'message')
  assert.equal(msg.stop_reason, 'end_turn')
  assert.equal(msg.content[0].text, 'hello from cache')
  assert.equal(msg.usage.output_tokens, 6)
  assert.equal(msg.kin, undefined)
  assert.doesNotMatch(msg.id, /msg_health_/)
  const chat = synthesizeProtocolResponse('openai.chat', { model: 'claude-haiku-4-5' }, snap)
  assert.equal(chat.object, 'chat.completion')
  assert.equal(chat.choices[0].message.content, 'hello from cache')
  assert.equal(chat.usage.total_tokens, 18)
  assert.equal(chat.id, 'msg_01CachedHelloFromProbe')
  assert.equal(synthesizeProtocolResponse('anthropic.messages', hiBody, { text: 'ok' }), null)
})

test('SSE Messages and chat.completions include the cached id and text', () => {
  const snap = cachedSnap({ body: { ...cachedBody, content: [{ type: 'text', text: 'ok-cache' }] } })
  const sse = formatHealthSse('anthropic.messages', hiBody, snap)
  assert.match(sse, /event: message_stop/)
  assert.match(sse, /ok-cache/)
  assert.match(sse, /msg_01CachedHelloFromProbe/)
  assert.doesNotMatch(sse, /msg_health_/)
  const chat = formatHealthSse('openai.chat', hiBody, snap)
  assert.match(chat, /chat.completion.chunk/)
  assert.match(chat, /\[DONE\]/)
  assert.match(chat, /"id":"msg_01CachedHelloFromProbe"/)
  assert.doesNotMatch(chat, /chatcmpl-|msg_health_/)
})

test('text-only snapshot is not a cache hit', () => {
  const now = Date.parse('2026-08-24T00:00:00.000Z')
  const snap = { ok: true, at: '2026-08-23T23:55:00.000Z', text: 'pong', vm_id: 'vm-01' }
  assert.equal(hasCachedMessage(snap), false)
  assert.equal(decideHealthIntercept({ headers: unofficial, body: hiBody, cfg, snapshot: snap, now }).action, 'pass')
})

test('503 body has health_unavailable and optional last_error', () => {
  const err = healthUnavailableError({ at: '2026-08-24T00:00:00.000Z', error: 'no slot' }, 'req-1')
  assert.equal(err.error.code, HEALTH_VIA_UNAVAILABLE)
  assert.equal(err.error.probed_at, '2026-08-24T00:00:00.000Z')
  assert.equal(err.error.last_error, 'no slot')
  assert.equal(err.error.request_id, 'req-1')
})

test('selectHealthProbeTargets uses summary credential flags', () => {
  const vms = [
    { id: 'vm-01', schedulable: true, status: 'running', has_token: true },
    { id: 'vm-02', schedulable: true, status: 'running', has_token: false },
    { id: 'vm-03', schedulable: false, status: 'running', has_token: true },
    { id: 'vm-04', schedulable: true, status: 'running', has_refresh: true, refresh_error: 'invalid_grant' },
    {
      id: 'vm-05',
      schedulable: true,
      status: 'running',
      has_refresh: true,
      cooldown_until: Date.now() + 60_000,
      cooldown_reason: 'authentication_failed_after_refresh',
    },
  ]
  assert.deepEqual(
    selectHealthProbeTargets(vms, cfg).map((v) => v.id),
    ['vm-01'],
  )
  const pinned = normalizeHealthProbeConfig({ real: { vm_ids: ['vm-02'] } })
  assert.deepEqual(selectHealthProbeTargets(vms, pinned), [])
})

test('monitor singleflight writes snapshot and fail_closed decides fail', async () => {
  let calls = 0
  const monitor = createHealthProbeMonitor({
    config: { enabled: true, interval_sec: 600, run_on_start: false },
    listTargets: () => [{ id: 'vm-01', schedulable: true, status: 'running', has_token: true }],
    runChat: async () => {
      calls += 1
      return {
        ok: true,
        text: 'hi',
        vm_id: 'vm-01',
        status: 200,
        model: 'claude-haiku-4-5',
        body: {
          id: 'msg_01RealProbeHi',
          type: 'message',
          role: 'assistant',
          model: 'claude-haiku-4-5',
          content: [{ type: 'text', text: 'hi' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 8, output_tokens: 2 },
        },
      }
    },
    now: () => Date.parse('2026-08-24T00:00:00.000Z'),
  })
  const [a, b] = await Promise.all([monitor.runRealProbe(), monitor.runRealProbe()])
  assert.equal(calls, 1)
  assert.equal(a.ok, true)
  assert.equal(b.vm_id, 'vm-01')
  assert.equal(a.message_id, 'msg_01RealProbeHi')
  assert.equal(monitor.rawSnapshot().body.id, 'msg_01RealProbeHi')
  const hit = monitor.decide(unofficial, hiBody)
  assert.equal(hit.action, 'cache')
  const replay = synthesizeProtocolResponse('anthropic.messages', hiBody, monitor.rawSnapshot())
  assert.equal(replay.id, 'msg_01RealProbeHi')
  assert.doesNotMatch(replay.id, /msg_health_/)
  monitor.stop()
})

test('failed real probe keeps a still-valid cached snapshot', async () => {
  let calls = 0
  const now = Date.parse('2026-08-24T00:00:00.000Z')
  const monitor = createHealthProbeMonitor({
    config: { enabled: true, interval_sec: 600, cache_ttl_sec: 900, run_on_start: false },
    listTargets: () => [{ id: 'vm-01', schedulable: true, status: 'running', has_token: true }],
    runChat: async () => {
      calls += 1
      if (calls === 1) {
        return {
          ok: true,
          text: 'hi',
          vm_id: 'vm-01',
          status: 200,
          model: 'claude-haiku-4-5',
          body: {
            id: 'msg_01KeepOnFail',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'hi' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 4, output_tokens: 1 },
          },
        }
      }
      return { ok: false, error: { message: 'OAuth access token has been revoked.' }, status: 401 }
    },
    now: () => now,
  })
  const first = await monitor.runRealProbe()
  assert.equal(first.ok, true)
  const second = await monitor.runRealProbe()
  assert.equal(second.ok, true)
  assert.equal(monitor.rawSnapshot().last_error, 'OAuth access token has been revoked.')
  assert.equal(monitor.rawSnapshot().body.id, 'msg_01KeepOnFail')
  assert.equal(monitor.decide(unofficial, hiBody).action, 'cache')
  monitor.stop()
})

test('default match tokens stay below default real probe budget', () => {
  assert.ok(DEFAULT_HEALTH_PROBE.match.max_tokens < DEFAULT_HEALTH_PROBE.real.max_tokens)
})
