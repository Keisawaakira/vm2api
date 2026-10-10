import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  runOfficialCcUsage,
  officialCcQuotaSucceeded,
  writeOfficialCcStatus,
  readOfficialCcStatus,
} from '../../src/lib/oauth/official-cc-bootstrap.mjs'
import { runSlotOauth } from '../../src/lib/transport/slot-oauth.mjs'
import { parseOfficialCcStats } from '../../src/lib/oauth/official-cc-stats.mjs'

const fullQuota = { five_hour: { utilization: 12 }, seven_day: { utilization: 34 }, seven_day_fable: null }
function fixture(t, replies) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'official-usage-worker-'))
  fs.mkdirSync(path.join(home, '.claude'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const calls = []
  const exec = { vmId: 'vm-07', homeDir: home, vm: { id: 'vm-07' } }
  const slotOauth = (actualExec, op, options) =>
    runSlotOauth(actualExec, op, {
      ...options,
      runDocker: async (argv, io) => {
        const reply = replies[Math.min(calls.length, replies.length - 1)]
        calls.push({ argv, io })
        return reply.timed_out
          ? { timed_out: true, stdout: '', stderr: '', code: null }
          : { code: 0, timed_out: false, stdout: JSON.stringify(reply), stderr: '' }
      },
    })
  const run = (extra = {}) =>
    runOfficialCcUsage({
      exec,
      homeDir: home,
      slotOauth,
      retryDelayMs: 0,
      turn() {
        throw Error('must not use the local CLI billing banner as quota data')
      },
      ...extra,
    })
  return { home, calls, run }
}

test('bootstrap quota uses the selected slot worker, not another CLI print turn', async (t) => {
  const f = fixture(t, [{ ok: true, status: 200, body: fullQuota, headers: { 'set-cookie': 'DO_NOT_STORE_HEADER' } }])
  const result = await f.run()
  assert.equal(f.calls.length, 1)
  assert.deepEqual(f.calls[0].argv, [
    'exec',
    '-i',
    '-u',
    '10007:987',
    'kin-07',
    '/usr/local/bin/kin-worker',
    'oauth',
    'usage',
    '--config',
    '/run/kin/worker.json',
  ])
  assert.equal(f.calls[0].io.stdin, '')
  assert.equal(result.stats.five_hour.utilization, 0.12)
  assert.equal(result.stats.seven_day.utilization, 0.34)
  assert.equal(result.stats.via, 'slot-worker')
  assert.equal(result.turn.code, null, 'an HTTP probe is not a CLI exit code')
  assert.equal(result.turn.http_status, 200)
  assert.equal(officialCcQuotaSucceeded(result.stats), true)
  const artifact = JSON.parse(fs.readFileSync(path.join(f.home, '.claude', 'kin-official-usage.json'), 'utf8'))
  assert.equal(artifact.type, 'official_usage_probe')
  assert.equal(artifact.source, 'slot-worker-oauth')
  assert.deepEqual(artifact.response.body, fullQuota)
  assert.doesNotMatch(JSON.stringify(artifact), /DO_NOT_STORE_HEADER/)
})

for (const status of [401, 403, 429])
  test(`quota HTTP ${status} cannot borrow cached windows or trigger repeated requests`, async (t) => {
    const f = fixture(t, [
      {
        ok: false,
        status,
        body: {
          ...fullQuota,
          error: { type: 'permission_error', message: 'scope user:profile missing; Bearer SECRET' },
        },
      },
    ])
    const result = await f.run()
    assert.equal(f.calls.length, 1)
    assert.equal(officialCcQuotaSucceeded(result.stats), false)
    assert.equal(result.stats.five_hour, undefined)
    assert.match(result.stats.usage_error, /scope user:profile missing/)
    assert.doesNotMatch(result.stats.usage_error, /SECRET/)
    writeOfficialCcStatus(f.home, {
      status: 'error',
      hello_ok: true,
      usage_ok: false,
      usage_via: 'slot-worker',
      exit_code: null,
      error: result.stats.usage_error,
    })
    // A stale CLI error must not be mixed into the new worker probe.
    fs.writeFileSync(path.join(f.home, '.claude', 'kin-official-usage.err'), 'STALE_CLI_ERROR')
    const diagnostic = readOfficialCcStatus(f.home).usage_diagnostics
    assert.equal(diagnostic.source, 'existing_slot_worker_result')
    assert.equal(diagnostic.http_status, status)
    assert.equal(diagnostic.cli_exit_code, null)
    assert.equal(diagnostic.limits_present, false)
    assert.doesNotMatch(JSON.stringify(diagnostic), /SECRET|STALE_CLI_ERROR/)
  })

test('HTTP 200 with an explicit error is not a successful quota check', async (t) => {
  const f = fixture(t, [
    { ok: true, status: 200, body: { ...fullQuota, error: { type: 'api_error', message: 'quota query failed' } } },
  ])
  const result = await f.run({ retries: 0 })
  assert.equal(officialCcQuotaSucceeded(result.stats), false)
  assert.match(result.stats.usage_error, /quota query failed/)
})

test('transient worker failure can recover, while retries remain bounded', async (t) => {
  const f = fixture(t, [{ timed_out: true }, { ok: true, status: 200, body: fullQuota }])
  const result = await f.run()
  assert.equal(result.attempts, 2)
  assert.equal(officialCcQuotaSucceeded(result.stats), true)
})

test('a profile/banner without quota is never accepted as quota', async (t) => {
  const f = fixture(t, [
    {
      ok: true,
      status: 200,
      body: { plan: 'Claude Max', result: 'You are currently using your subscription to power your Claude Code usage' },
    },
  ])
  const result = await f.run()
  assert.equal(f.calls.length, 3)
  assert.equal(officialCcQuotaSucceeded(result.stats), false)
  assert.equal(result.stats.usage_error_code, 'usage_output_unrecognized')
})

test('a successful local usage command with null rate_limits has no subscription quota', () => {
  const banner = 'You are currently using your subscription to power your Claude Code usage'
  const raw = [
    {
      type: 'assistant',
      message: { model: '<synthetic>', content: [{ type: 'text', text: banner }] },
      usage_report: { session: { total_cost_usd: 0, model_usage: {} }, rate_limits: null },
      local_command_run: { command: 'usage', args: '' },
    },
    { type: 'result', is_error: false, num_turns: 0, local_command: 'usage', result: banner },
  ]
    .map((row) => JSON.stringify(row))
    .join('\n')
  assert.equal(officialCcQuotaSucceeded(parseOfficialCcStats(raw)), false)
})

test('a worker rejection stays failed even if HTTP 200 carries quota fields', async (t) => {
  const f = fixture(t, [{ ok: false, status: 200, body: fullQuota }])
  const result = await f.run({ retries: 0 })
  assert.equal(officialCcQuotaSucceeded(result.stats), false)
  assert.equal(result.stats.five_hour, undefined)
})

test('missing VM context is rejected before any helper operation', async (t) => {
  const f = fixture(t, [{ ok: true, status: 200, body: fullQuota }])
  await assert.rejects(() => f.run({ exec: null }), /VM and homeDir/)
  assert.equal(f.calls.length, 0)
})

test('worker prose with quota-looking numbers is not structured OAuth quota data', async (t) => {
  const f = fixture(t, [
    {
      ok: true,
      status: 200,
      body: { type: 'result', result: 'Current session: 5% used\nCurrent week (all models): 40% used' },
    },
  ])
  const result = await f.run({ retries: 0 })
  assert.equal(officialCcQuotaSucceeded(result.stats), false)
  assert.equal(result.stats.five_hour, undefined)
  writeOfficialCcStatus(f.home, { status: 'error', hello_ok: true, usage_ok: false, usage_via: 'slot-worker' })
  const diagnostic = readOfficialCcStatus(f.home).usage_diagnostics
  assert.equal(diagnostic.limits_present, false)
  assert.equal(diagnostic.code, 'usage_output_unrecognized')
})

test('worker text cannot fill a missing structured window', async (t) => {
  const f = fixture(t, [
    { body: { five_hour: { utilization: 12 }, result: '7-day limit: 90% used' }, ok: true, status: 200 },
  ])
  const result = await f.run({ retries: 0 })
  assert.equal(result.stats.five_hour.utilization, 0.12)
  assert.equal(result.stats.seven_day, null)
  assert.equal(result.stats.limits_present, false)
})

test('zero-valued quota windows are real successful data', async (t) => {
  const f = fixture(t, [
    {
      ok: true,
      status: 200,
      body: { five_hour: { utilization: 0 }, seven_day: { utilization: 0 }, seven_day_fable: null },
    },
  ])
  const result = await f.run()
  assert.equal(result.stats.five_hour.utilization, 0)
  assert.equal(result.stats.seven_day.utilization, 0)
  assert.equal(officialCcQuotaSucceeded(result.stats), true)
})
