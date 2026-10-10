import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { readBody } from '../../src/lib/http/respond.mjs'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { RequestLogStore, normalizeLoggingConfig } from '../../src/lib/admin/request-log.mjs'

const original = ' { "stream": false, "n": 1e2, "n": 2, "text": "🙂' + 'x'.repeat(210000) + '" }\n'
test('parsed-raw reader retains original valid UTF-8 JSON before postread mutation', async () => {
  let seen
  const body = await readBody(Readable.from([Buffer.from(original)]), 32 * 1024 * 1024, (raw, parsed, bytes) => {
    seen = { raw, n: parsed.n, bytes }
  })
  body.text = 'changed'
  assert.equal(seen?.raw, original)
  assert.equal(seen.n, 2)
  assert.equal(seen.bytes, Buffer.byteLength(original))
})

test('raw default off; list/detail projection and legacy collision immutability', (t) => {
  assert.equal(normalizeLoggingConfig().raw_nonstream_debug, false)
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => db.close())
  const store = new RequestLogStore({ db, mode: 'debug' })
  const record = {
    request_id: 'raw-id',
    raw_debug: { caller: { text: original } },
    raw_debug_info: { available: true },
  }
  store.repo.insertDebugIfAbsent('raw-id', '2026-09-24T00:00:00Z', record)
  store.repo.insertDebug('raw-id', '2026-09-25T00:00:00Z', { overwritten: true })
  assert.equal(store.repo.getDebug('raw-id', { includeRaw: true }).raw_debug.caller.text, original)
  assert.equal(db.prepare('SELECT ts FROM request_log_debug').get().ts, '2026-09-24T00:00:00Z')
  assert.equal(store.getDebug('raw-id').raw_debug, undefined)
  assert.equal(store.listDebug()[0].raw_debug, undefined)
})

test('reader observer failure cannot affect parsing; malformed/oversize/invalid UTF-8 never call raw observer', async () => {
  assert.deepEqual(
    await readBody(Readable.from([Buffer.from('{"ok":1}')]), 100, () => {
      throw Error('observer')
    }),
    { ok: 1 },
  )
  let calls = 0
  for (const [buf, limit] of [
    [Buffer.from('{bad'), 100],
    [Buffer.from('{"ok":1}'), 2],
  ]) {
    await assert.rejects(
      readBody(Readable.from([buf]), limit, () => {
        calls++
      }),
    )
  }
  await readBody(Readable.from([Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125])]), 100, () => {
    calls++
  })
  assert.equal(calls, 0)
})

test('logging normalize/store setConfig/snapshot propagates strict flag and can disable it', (t) => {
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => db.close())
  const store = new RequestLogStore({ db })
  assert.equal(store.snapshot().raw_nonstream_debug, false)
  assert.equal(normalizeLoggingConfig({ raw_nonstream_debug: 'true' }).raw_nonstream_debug, false)
  store.setConfig({ rawNonstreamDebug: true })
  assert.equal(store.snapshot().raw_nonstream_debug, true)
  store.setConfig({ rawNonstreamDebug: false })
  assert.equal(store.snapshot().raw_nonstream_debug, false)
})

test('optional transport observer exceptions never change native inference or cause replays', async (t) => {
  const { mockWorker, candidate } = await import('../support/in-memory-worker.mjs')
  const { streamRustKernel } = await import('../../src/lib/transport/rust-kernel-client.mjs')
  const sends = mockWorker(t)
  const result = await streamRustKernel({
    exec: candidate().exec,
    body: { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] },
    rawDebug: {
      collector: {
        beginHop() {
          throw Error('observer failure')
        },
      },
    },
  })
  assert.equal(result.ok, true)
  assert.equal(sends.length, 1)
})

test('UTF-8 budget overflow freezes a contiguous component prefix even when later ASCII fits', async (t) => {
  const { createRawDebug, RAW_LIMITS } = await import('../../src/lib/admin/raw-debug.mjs')
  const caller = 'x'.repeat(RAW_LIMITS.bytes - 10)
  const capture = createRawDebug(caller, caller.length)
  t.after(() => capture.release())
  const hop = capture.beginHop('node_kernel', {}, '{}')
  hop.startResponse({ statusCode: 200, headers: {} })
  hop.chunk(Buffer.from('hello'))
  hop.chunk(Buffer.from('🙂'))
  hop.chunk(Buffer.from('A'))
  hop.endRead(true, {})
  const response = capture.record.hops[0].response
  assert.equal(response.text, 'hello')
  assert.equal(response.bytes_observed, 10)
  assert.equal(response.bytes_retained, 5)
  assert.equal(response.truncated, true)
  assert.equal(response.read_complete, true)
})
