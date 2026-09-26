import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { dispatchStreamInference } from '../../src/lib/transport/kernel-router.mjs'
import { scheduleWrapRecycle, wrapHopInflight } from '../../src/lib/transport/rust-kernel-supervisor.mjs'
import { candidate, frame, mockWorker, successEvents, usage } from '../support/in-memory-worker.mjs'

const authError = {
  type: 'error',
  error: { type: 'authentication_error', code: 'needs_refresh', message: 'OAuth token has been revoked' },
}
const reset = () => Object.assign(new Error('synthetic connection reset'), { code: 'ECONNRESET' })

function fixture(t, { respond, refresh, recycle, onEvent } = {}) {
  const controller = new AbortController()
  const exec = candidate().exec
  const counts = { ensure: 0, refresh: 0, recycle: 0, commit: 0 }
  const lines = []
  const sends = mockWorker(t, (send) => respond?.(send, controller) || {})
  const run = () =>
    dispatchStreamInference({
      exec,
      body: { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] },
      cacheTtl: '5m',
      preserveCacheBreakpoints: false,
      cliHop: true,
      signal: controller.signal,
      timeoutMs: 1000,
      ensureRust: async () => {
        counts.ensure++
        return { ok: true }
      },
      ensureCredential: async (selected, options) => {
        counts.refresh++
        assert.equal(selected, exec)
        assert.equal(options.force, true)
        return refresh ? refresh(controller) : { ok: true }
      },
      recycleWrap: (selected) => {
        counts.recycle++
        return recycle?.(selected, controller)
      },
      onCommit: () => {
        counts.commit++
      },
      onEvent: async (line) => {
        lines.push(line)
        await onEvent?.(line, controller)
      },
    })
  return { run, counts, sends, lines, controller, exec }
}

test('committed auth-error stream returns original failure and usage: one send, no refresh', async (t) => {
  const fx = fixture(t, { respond: () => ({ events: [...successEvents.slice(0, 2), authError] }) })
  const result = await fx.run()
  assert.equal(fx.sends.length, 1)
  assert.equal(fx.counts.refresh, 0)
  assert.equal(fx.counts.commit, 1)
  assert.equal(result.ok, false)
  assert.equal(result.committed, true)
  assert.deepEqual(result.body, authError)
  assert.deepEqual(result.usage, usage)
  assert.equal(result.credential_retried, undefined)
  assert.equal(wrapHopInflight(fx.exec), 0)
})

test('uncommitted401 refresh recovers exactly once via actual dispatchStreamInference', async (t) => {
  const fx = fixture(t, { respond: ({ index }) => (index === 0 ? { status: 401, body: authError } : {}) })
  const result = await fx.run()
  assert.equal(result.ok, true)
  assert.equal(result.credential_retried, true)
  assert.equal(fx.sends.length, 2)
  assert.equal(fx.counts.refresh, 1)
  assert.equal(fx.counts.recycle, 1)
  assert.equal(fx.counts.commit, 1)
  assert.deepEqual(fx.sends[1].envelope, fx.sends[0].envelope)
})

test('valid uncommitted transport failure still recovers once', async (t) => {
  const fx = fixture(t, { respond: ({ index }) => (index === 0 ? { error: reset() } : {}) })
  const result = await fx.run()
  assert.equal(result.ok, true)
  assert.equal(result.rust_transport_retried, true)
  assert.equal(fx.sends.length, 2)
  assert.equal(fx.counts.refresh, 0)
})

test('cancelled uncommitted transport failure is not replayed and retains known usage', async (t) => {
  const fx = fixture(t, {
    respond: (_send, controller) => ({
      readable: Readable.from(
        (async function* () {
          yield frame(successEvents[0])
          controller.abort()
          throw reset()
        })(),
      ),
    }),
  })
  const result = await fx.run()
  assert.equal(fx.sends.length, 1)
  assert.equal(fx.counts.refresh, 0)
  assert.equal(result.committed, false)
  assert.equal(result.body.error.code, 'client_cancelled')
  assert.equal(result.status, 499)
  assert.equal(result.clientCancelled, true)
  assert.deepEqual(result.usage, usage)
  assert.equal(result.rust_transport_retried, undefined)
})

test('committed transport failure is not replayed and retains known usage', async (t) => {
  const fx = fixture(t, {
    respond: () => ({
      readable: Readable.from(
        (async function* () {
          yield frame(successEvents[0])
          yield frame(successEvents[1])
          throw reset()
        })(),
      ),
    }),
  })
  const result = await fx.run()
  assert.equal(fx.sends.length, 1)
  assert.equal(fx.counts.refresh, 0)
  assert.equal(result.committed, true)
  assert.equal(result.body.error.code, 'ECONNRESET')
  assert.deepEqual(result.usage, usage)
})

test('already-cancelled auth failure does not begin credential refresh', async (t) => {
  const fx = fixture(t, {
    respond: (_send, controller) => {
      controller.abort()
      return { status: 401, body: authError }
    },
  })
  const result = await fx.run()
  assert.equal(fx.sends.length, 1)
  assert.equal(fx.counts.refresh, 0)
  assert.equal(fx.counts.recycle, 0)
  assert.equal(result.body.error.code, 'client_cancelled')
  assert.equal(result.terminalState, 'cancelled')
})

for (const refreshOk of [true, false]) {
  test(`abort during ${refreshOk ? 'successful' : 'failed'} refresh preserves usage as cancellation without recovery recycle or send`, async (t) => {
    const fx = fixture(t, {
      respond: () => ({ events: [successEvents[0], authError] }),
      refresh: async (controller) => {
        await new Promise((resolve) => setImmediate(resolve))
        controller.abort()
        return refreshOk ? { ok: true } : { ok: false, error: { code: 'invalid_grant', message: 'refresh failed' } }
      },
    })
    const result = await fx.run()
    assert.equal(fx.sends.length, 1)
    assert.equal(fx.counts.refresh, 1)
    assert.equal(result.body.error.code, 'client_cancelled')
    assert.deepEqual(result.usage, usage)
    assert.equal(result.committed, false)
    assert.equal(result.credential_retried, undefined)
    assert.equal(result.credential_ensure_failed, undefined)
    // Cancellation owns the lifecycle result, but keeps already observed usage.
    // Neither recovery nor leaked-slot cleanup should recycle a healthy CLI.
    assert.equal(result.status, 499)
    assert.equal(result.terminalState, 'cancelled')
    assert.equal(result.clientCancelled, true)
    assert.equal(fx.counts.recycle, 0)
  })
}

test('abort while awaiting scheduled recycle prevents the post-refresh send', async (t) => {
  let recycled = false
  const fx = fixture(t, {
    respond: () => ({ status: 401, body: authError }),
    recycle: (exec, controller) =>
      scheduleWrapRecycle(exec, {
        cooldownMs: 0,
        restart: async () => {
          await new Promise((resolve) => setImmediate(resolve))
          recycled = true
          controller.abort()
          return { ok: true }
        },
      }),
  })
  const result = await fx.run()
  assert.equal(recycled, true)
  assert.equal(fx.sends.length, 1)
  assert.equal(fx.counts.refresh, 1)
  assert.equal(fx.counts.recycle, 1)
  assert.equal(result.body.error.code, 'client_cancelled')
  assert.equal(result.status, 499)
  assert.equal(result.credential_retried, undefined)
})

test('failed precommit credential refresh retains its existing failure contract without replay', async (t) => {
  const fx = fixture(t, {
    respond: () => ({ status: 401, body: authError }),
    refresh: async () => ({ ok: false, error: { code: 'invalid_grant', message: 'refresh failed' } }),
  })
  const result = await fx.run()
  assert.equal(fx.sends.length, 1)
  assert.equal(fx.counts.refresh, 1)
  assert.equal(result.credential_ensure_failed, true)
  assert.equal(result.body.error.code, 'invalid_grant')
  assert.equal(result.committed, false)
})
