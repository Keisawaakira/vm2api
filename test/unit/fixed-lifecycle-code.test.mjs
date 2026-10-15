import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { fixedDataplaneSpec } from '../../src/lib/vm/wrap-fixed.mjs'
import {
  classifier,
  nativeWireType,
  comparableWireFrames,
  dispatcherControl,
  cancelReuseControl,
  retryControl,
  queryControl,
  runJobControl,
  transportControl,
  dispatchControl,
  lifecycleContext,
  FixtureAPIError,
  FixtureConnectionError,
  FixtureTimeoutError,
} from '../support/fixed-lifecycle-controls.mjs'
const root = fileURLToPath(new URL('../../', import.meta.url))
const preview = process.env.FIXED_LIFECYCLE_PREVIEW
const baseline = process.env.FIXED_LIFECYCLE_BASELINE === '1'
const all = {}
for (const kind of ['wrap', 'cc']) {
  const data = JSON.parse(
    fs.readFileSync(
      preview
        ? path.join(preview, kind + '-lifecycle-semantics.json')
        : path.join(root, 'share', fixedDataplaneSpec(kind + '-fixed').directory, 'semantics.json'),
      'utf8',
    ),
  )
  const sem = preview ? data : data.lifecycle
  all[kind] = sem
  const native = baseline ? sem.native_before : sem.native,
    retry = baseline ? sem.retry_before : sem.retry
  const query = baseline ? sem.query_before : sem.query,
    transport = baseline ? sem.transport.before : sem.transport.after
  test(`${kind} slow cancel does not block ping/another slot and does not ack before actual settlement`, async () => {
    const result = await dispatcherControl(native)
    assert.equal(result.pendingAck, false)
    assert.ok(result.before.some((x) => x.type === nativeWireType(native, 'pong')))
    assert.ok(result.before.some((x) => x.type === nativeWireType(native, 'job_done') && x.job_id === 'quick'))
    assert.ok(result.frames.some((x) => x.type === nativeWireType(native, 'cancel_ack') && x.job_id === 'held'))
    assert.ok(result.before.find((x) => x.type === nativeWireType(native, 'host_ready')).capabilities.includes('ping'))
    assert.equal(result.calls.length, 2)
    for (const c of result.calls) {
      assert.equal(c.maxTokens, 128000)
      assert.deepEqual(c.thinking, { type: 'enabled', budgetTokens: 60000 })
      assert.deepEqual(c.system, ['', '# Environment\nKEEP', '中文 format'])
    }
  })
  test(`${kind} late cancel ack preserves a new job in the reused slot; unknown/done cancel is idempotent`, async () => {
    const result = await cancelReuseControl(native)
    assert.equal(result.phase, 'running')
    assert.equal(result.jobId, 'new')
    assert.deepEqual(
      result.frames.map((x) => [x.type, x.job_id, x.slot_id]),
      [
        [nativeWireType(native, 'cancel_ack'), 'old', 's00'],
        [nativeWireType(native, 'cancel_ack'), 'unknown', 'missing'],
        [nativeWireType(native, 'cancel_ack'), 'already-completed', 's00'],
      ],
    )
  })
  test(`${kind} query bridge keeps system snapshot, wire fields and error callback`, async () => {
    const result = await queryControl(query)
    assert.equal(result.hasErrorCallback, true)
    assert.deepEqual(result.snapshot, ['', '# Environment\nKEEP', ' 中文 format '])
    assert.equal(result.params.options.querySource, 'agent:kin')
    assert.equal(result.params.options.maxOutputTokensOverride, 128000)
    assert.equal(result.params.thinkingConfig.budgetTokens, 60000)
  })
  for (const source of ['agent:kin', 'kin_native_messages', 'sdk']) {
    test(`${kind} real retry function and dispatch wiring source=${source}`, async () => {
      const r = await retryControl(retry, source, { persistent: true })
      assert.equal(r.attempts, source === 'sdk' ? 2 : 1)
      const sent = await dispatchControl(retry, transport.dispatch, source)
      assert.equal(sent.calls, source === 'sdk' ? 2 : 1)
      assert.equal(sent.failed, source !== 'sdk')
      if (source !== 'sdk') assert.equal(sent.original, true)
    })
    test(`${kind} raw error, fallback suppression and timeout type source=${source}`, () => {
      const actual = transportControl(transport, source),
        expected = transportControl(sem.transport.reference, source)
      assert.deepEqual(actual, expected)
      if (source !== 'sdk') {
        assert.equal(actual.rawError, true)
        assert.equal(actual.errorCallback, true)
        assert.equal(actual.fallbackBlocked, true)
        assert.equal(actual.timeoutClass, true)
      }
    })
  }
  test(`${kind} success payloads and terminal semantics match across old/new wire names`, async () => {
    assert.deepEqual(
      comparableWireFrames(await runJobControl(native)),
      comparableWireFrames(await runJobControl(sem.reference_native)),
    )
  })
  for (const status of [400, 401, 403, 408, 429, 500, 504, 529]) {
    test(`${kind} error status ${status} and retry-after are preserved rather than rendered away`, async () => {
      const error = new FixtureAPIError(
        status,
        'HTTP failure',
        { type: status === 429 ? 'rate_limit_error' : 'api_error', message: '  full upstream message  ' },
        { 'Retry-After': '7' },
      )
      const actual = await runJobControl(native, error),
        expected = await runJobControl(sem.reference_native, error)
      assert.deepEqual(comparableWireFrames(actual), comparableWireFrames(expected))
      const terminal = actual.at(-1)
      assert.equal(terminal.type, nativeWireType(native, 'job_error'))
      assert.equal(terminal.retry_after, '7')
    })
  }
  test(`${kind} network/timeout/SSE errors agree with the original classifier`, () => {
    const actual = classifier(native),
      reference = classifier(sem.reference_native)
    const causes = [
      new FixtureConnectionError(),
      new FixtureTimeoutError('timeout'),
      new FixtureConnectionError('SSE Error', {
        message:
          'SSE Error: ' + JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }),
      }),
      new Error('Stream ended without receiving any events'),
      new Error('x'.repeat(1000)),
    ]
    for (const e of causes)
      for (const sawEvent of [true, false]) assert.deepEqual(actual(e, { sawEvent }), reference(e, { sawEvent }))
  })
}
test('CC private error module does not overwrite other bundled helper names', () => {
  const marker = () => 'retained'
  const { context } = lifecycleContext(all.cc.native, {
    globals: { field: marker, text: marker, clip: marker, retryAfterOf: marker, fromApiError: marker, C: marker },
  })
  for (const key of ['field', 'text', 'clip', 'retryAfterOf', 'fromApiError', 'C']) assert.equal(context[key], marker)
})
test('Bun1.3.14 compiled miniature runs both actual source control sets', {
  skip: !process.env.BUN_BIN || baseline,
}, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-life-compile-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 40 }))
  const input = path.join(dir, 'entry.mjs'),
    bin = path.join(dir, process.platform === 'win32' ? 'entry.exe' : 'entry')
  const controls = path.join(root, 'test/support/fixed-lifecycle-controls.mjs').replaceAll('\\', '/')
  fs.writeFileSync(
    input,
    `import{verifyLifecycleSource}from ${JSON.stringify(controls)};const all=${JSON.stringify(all)};for(const[k,v]of Object.entries(all))console.log(JSON.stringify(await verifyLifecycleSource(v,k)));`,
  )
  execFileSync(process.env.BUN_BIN, ['build', input, '--compile', '--outfile', bin], { stdio: 'pipe', timeout: 60000 })
  const stdout = execFileSync(bin, [], { encoding: 'utf8', timeout: 60000, env: { ...process.env, BUN_OPTIONS: '' } })
  const results = stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.deepEqual(
    results.map((x) => [x.kind, x.ok, x.checks]),
    [
      ['wrap', true, 65],
      ['cc', true, 65],
    ],
  )
})
