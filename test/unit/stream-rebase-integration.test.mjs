import test from 'node:test'
import assert from 'node:assert/strict'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'
import { classifyUpstreamResult } from '../../src/lib/pool/upstream-error-policy.mjs'
import { dispatchStreamInference } from '../../src/lib/transport/kernel-router.mjs'
import { candidate, mockWorker, successEvents, usage } from '../support/in-memory-worker.mjs'

// A confirmed provider rejection has no local needs_refresh hint. The terminal
// metadata must not let it evade either the inner or outer commitment guard.
const authError = {
  type: 'error',
  error: { type: 'authentication_error', message: 'OAuth token has been revoked' },
}

for (const hasRefresh of [true, false]) {
  for (const committed of [true, false]) {
    test(`confirmed auth policy preserves retirement but never replays committed output (refresh=${hasRefresh}, committed=${committed})`, () => {
      const policy = classifyUpstreamResult(
        { ok: false, status: 200, committed, terminalState: 'error', body: authError },
        { hasRefresh },
      )
      assert.equal(policy.action, committed ? 'stop' : 'continue-and-cooldown')
      assert.equal(policy.reason, hasRefresh ? 'oauth_revoked' : 'oauth_no_refresh')
      assert.equal(policy.cooldownUntil, Number.MAX_SAFE_INTEGER)
    })
  }

  test(`real outer runner and inner router keep committed auth failure on its original account (refresh=${hasRefresh})`, async (t) => {
    const accounts = [candidate('a'), candidate('b')]
    if (hasRefresh) accounts[0].vm.claude.refresh_token = 'synthetic-refresh-not-a-credential'
    const sends = mockWorker(t, ({ index }) =>
      index === 0
        ? { events: [...successEvents.slice(0, 2), authError], trailers: { 'x-kin-terminal-state': 'error' } }
        : {},
    )
    const retired = []
    const cooldowns = []
    const observed = []
    const scheduler = {
      async selectAndReserve({ excluded }) {
        const selected = accounts.find((item) => !excluded.has(item.accountId) && !excluded.has(item.vmId))
        return selected ? { ...selected, ok: true, release() {} } : { ok: false, reason: 'no_eligible_accounts' }
      },
      markCooldown(selected) {
        cooldowns.push(selected.accountId)
      },
      markSuccess() {},
    }
    const runner = new FailoverRunner({
      scheduler,
      onCredentialFailure: ({ selected }) => retired.push(selected.accountId),
      config: { max_attempts: 3, max_same_account_retries: 0 },
    })
    const result = await runner.run({
      requestId: 'confirmed-auth-after-commit',
      model: 'claude-sonnet-5',
      canonicalBody: { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hello' }] },
      stream: true,
      callAttempt: ({ candidate: selected, body, onCommit }) =>
        dispatchStreamInference({
          exec: selected.exec,
          body,
          cliHop: true,
          ensureRust: async () => ({ ok: true }),
          ensureCredential: async () => {
            throw new Error('committed output must not refresh credentials')
          },
          recycleWrap() {},
          onCommit,
          onEvent: (line) => observed.push(line),
        }),
    })
    assert.equal(sends.length, 1, 'neither inner refresh nor outer failover may resend delivered output')
    assert.equal(result.ok, false)
    assert.equal(result.committed, true)
    assert.equal(result.accountId, 'account-a')
    assert.equal(result.attemptCount, 1)
    assert.deepEqual(result.body, authError)
    assert.deepEqual(result.usage, usage)
    assert.match(observed.join('\n'), /authentication_error/)
    assert.deepEqual(cooldowns, ['account-a'])
    assert.deepEqual(retired, ['account-a'])
  })
}

for (const [type, status] of [
  ['rate_limit_error', 429],
  ['overloaded_error', 529],
  ['permission_error', 403],
  ['invalid_request_error', 400],
]) {
  test(`precommit ${type} retains main semantic status and test trailer usage without recycling`, async (t) => {
    const finalUsage = { input_tokens: 7, cache_read_input_tokens: 93, output_tokens: 0 }
    const error = { type: 'error', error: { type, message: 'synthetic upstream rejection' } }
    const sends = mockWorker(t, () => ({
      events: [successEvents[0], error],
      trailers: { 'x-kin-usage': JSON.stringify(finalUsage) },
    }))
    let recycled = 0
    let emitted = 0
    const result = await dispatchStreamInference({
      exec: candidate().exec,
      body: { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hello' }] },
      cliHop: true,
      ensureRust: async () => ({ ok: true }),
      ensureCredential: async () => {
        throw new Error('non-auth rejection must not refresh credentials')
      },
      recycleWrap: () => {
        recycled++
      },
      onEvent: () => {
        emitted++
      },
    })
    assert.equal(sends.length, 1)
    assert.equal(result.status, status)
    assert.equal(result.ok, false)
    assert.equal(result.committed, false)
    assert.equal(result.streamError, true)
    assert.equal(result.terminalState, 'rejected')
    assert.deepEqual(result.body, error)
    assert.deepEqual(result.usage, finalUsage)
    assert.equal(recycled, 0)
    assert.equal(emitted, 0, 'precommit errors remain available for normal HTTP/pool classification')
  })
}
