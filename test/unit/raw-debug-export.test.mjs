import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { RequestLogStore } from '../../src/lib/admin/request-log.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { RAW_EXPORT_BYTES } from '../../src/lib/admin/raw-debug.mjs'

function fixture(t) {
  const db = createDatabase({ dbPath: ':memory:' })
  const sql = []
  const prepare = db.prepare.bind(db)
  t.mock.method(db, 'prepare', (text) => {
    sql.push(text)
    return prepare(text)
  })
  const store = new RequestLogStore({ db, mode: 'debug' })
  t.after(() => db.close())
  let seq = 0
  function add(id, text, { owner = 'alice', ts = '2026-09-24T00:00:00Z', raw = true } = {}) {
    const record = {
      request_id: id,
      user_id: owner,
      ts,
      ...(raw ? { raw_debug: { caller: { text } }, raw_debug_info: { available: true } } : {}),
    }
    store.repo.insertSummaryIfAbsent({
      id: `log_${++seq}`,
      request_id: id,
      ts,
      user_id: owner,
      status: 200,
      protocol: 'openai.chat',
    })
    store.repo.insertDebugIfAbsent(id, ts, record)
    return db.prepare('SELECT record_json FROM request_log_debug WHERE request_id=?').get(id).record_json
  }
  async function route(
    url,
    { role = 'admin', owner = 'alice', backpressure = false, disconnect = false, writeError = false } = {},
  ) {
    const res = Object.assign(new EventEmitter(), {
      statusCode: 0,
      text: '',
      headers: {},
      destroyed: false,
      writableEnded: false,
      writeHead(status, headers) {
        this.statusCode = status
        this.headers = { ...this.headers, ...headers }
      },
      setHeader(key, value) {
        this.headers[key] = value
      },
      write(chunk) {
        this.text += chunk
        if (writeError) {
          queueMicrotask(() => this.emit('error', new Error('write failed')))
          return false
        }
        if (disconnect) {
          this.destroyed = true
          queueMicrotask(() => this.emit('close'))
          return false
        }
        if (backpressure) {
          queueMicrotask(() => this.emit('drain'))
          return false
        }
        return true
      },
      end(chunk = '') {
        this.text += chunk
        this.writableEnded = true
        this.emit('finish')
      },
    })
    const handler = createPanelHandler({
      cfg: { paths: {} },
      requestLog: store,
      requireAuth: (req) => {
        req.panelRole = role
        req.panelUserId = owner
        req.panelUser = owner
        return true
      },
      json: (res, status, body) => {
        res.statusCode = status
        res.body = body
        res.end(JSON.stringify(body))
      },
    })
    await handler({ method: 'GET', url, headers: {} }, res, new URL(url, 'http://local'))
    return res
  }
  return { db, sql, store, add, route }
}

test('both debug-list SQL branches + default detail exclude raw before parse; owner spoof and exact admin raw gate', async (t) => {
  const fx = fixture(t)
  fx.add('raw-a', 'UNREDACTED_RAW_SECRET🙂')
  fx.add('raw-b', 'BOB_SECRET', { owner: 'bob' })
  for (const role of ['admin', 'super', 'user']) {
    const list = await fx.route('/api/panel/request-logs?mode=debug&user_id=bob', { role })
    assert.equal(list.statusCode, 200)
    assert.doesNotMatch(list.text, /UNREDACTED_RAW_SECRET|BOB_SECRET/)
    const detail = await fx.route('/api/panel/request-logs/raw-a', { role })
    assert.equal(detail.statusCode, 200)
    assert.equal(detail.body.item.raw_debug, undefined)
    const raw = await fx.route('/api/panel/request-logs/raw-a?include_raw=1', { role })
    assert.equal(raw.statusCode, role === 'admin' ? 200 : 403)
    const exp = await fx.route('/api/panel/request-logs/export?include_raw=1', { role })
    assert.equal(exp.statusCode, role === 'admin' ? 200 : 403)
  }
  assert.equal((await fx.route('/api/panel/request-logs/raw-b?user_id=bob', { role: 'user' })).statusCode, 404)
  const owned = await fx.route('/api/panel/request-logs?mode=debug&user_id=bob', { role: 'user' })
  assert.deepEqual(
    owned.body.items.map((r) => r.request_id),
    ['raw-a'],
  )
  assert.ok(fx.sql.some((s) => s.includes("json_remove(record_json, '$.raw_debug')") && s.includes('ORDER BY ts')))
  assert.ok(fx.sql.some((s) => s.includes("json_remove(d.record_json, '$.raw_debug')")))
  assert.ok(fx.sql.some((s) => s.includes("json_remove(record_json, '$.raw_debug')") && s.includes('WHERE request_id')))
})

test('admin explicit JSONL is exact stored-record roundtrip; summary CSV/JSONL unchanged; missing/expired unavailable', async (t) => {
  const fx = fixture(t)
  const stored = fx.add('raw-a', ' {"dup":1e2,"dup":2,"secret":"中文🙂\\\n\u0001"} ')
  fx.add('legacy', 'not raw', { raw: false })
  fx.add('expired', 'old', { ts: '2000-01-01T00:00:00Z' })
  fx.store.repo.cleanup({ retainDays: 99999, debugRetainDays: 3, maxBytes: 0 })
  const raw = await fx.route('/api/panel/request-logs/export?include_raw=1&format=jsonl&include_muted=1', {
    backpressure: true,
  })
  assert.equal(raw.statusCode, 200)
  assert.equal(raw.text, stored + '\n')
  assert.deepEqual(JSON.parse(raw.text), JSON.parse(stored))
  assert.equal(Number(raw.headers['x-kin-export-bytes']), Buffer.byteLength(raw.text))
  assert.match(raw.headers['access-control-expose-headers'], /x-kin-export-count/)
  assert.match(raw.headers['access-control-expose-headers'], /x-kin-export-truncated/)
  assert.equal(raw.headers['x-kin-export-unavailable'], '2')
  assert.equal(raw.headers['x-kin-export-truncated'], '1')
  assert.equal((await fx.route('/api/panel/request-logs/export?include_raw=1&format=csv')).statusCode, 400)
  const single = await fx.route(
    '/api/panel/request-logs/export?include_raw=1&format=jsonl&request_id=raw-a&include_muted=1',
  )
  assert.equal(single.text, stored + '\n')
  const absent = await fx.route('/api/panel/request-logs/export?include_raw=1&request_id=missing')
  assert.equal(absent.headers['x-kin-export-unavailable'], '1')
  assert.equal(absent.text, '')
  for (const format of ['jsonl', 'csv']) {
    const ordinary = await fx.route(`/api/panel/request-logs/export?format=${format}&include_muted=1`)
    assert.doesNotMatch(ordinary.text, /raw_debug|dup|secret/)
  }
  const expired = await fx.route('/api/panel/request-logs/expired?include_raw=1')
  assert.equal(expired.statusCode, 200)
  assert.equal(expired.body.item.raw_debug, undefined)
  // Evidence sample is opt-in so ordinary suite runs do not write outside temp memory.
  if (process.env.M3_EXPORT_SAMPLE) fs.writeFileSync(process.env.M3_EXPORT_SAMPLE, raw.text)
})

test('whole-record byte preselection handles Unicode/escaping and oversized first row without loading it', async (t) => {
  const fx = fixture(t)
  fx.add('small', 'safe🙂', { ts: '2026-09-24T00:00:00Z' })
  // 6-byte JSON escaping expands a legal <16MiB text capture beyond the export limit.
  fx.add('oversized', '\u0001'.repeat(Math.ceil(RAW_EXPORT_BYTES / 6)), { ts: '2026-09-24T00:00:02Z' })
  const get = fx.store.repo._getRawDebug.get.bind(fx.store.repo._getRawDebug)
  const loaded = []
  t.mock.method(fx.store.repo._getRawDebug, 'get', (id) => {
    loaded.push(id)
    assert.notEqual(id, 'oversized')
    return get(id)
  })
  const res = await fx.route('/api/panel/request-logs/export?include_raw=1&include_muted=1')
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['x-kin-export-count'], '1')
  assert.equal(res.headers['x-kin-export-oversized'], '1')
  assert.deepEqual(loaded, ['small'])
  assert.ok(fx.sql.some((s) => s.includes('LENGTH(CAST(record_json AS BLOB)) + 1')))
  assert.equal(res.text.endsWith('\n'), true)
})

test('byte and row caps report omissions, disconnect/backpressure do not send remaining records', async (t) => {
  const fx = fixture(t)
  // Two complete ~17MiB serialized rows exceed 32MiB together.
  fx.add('a', 'x'.repeat(17 * 1024 * 1024))
  fx.add('b', 'y'.repeat(17 * 1024 * 1024))
  const res = await fx.route('/api/panel/request-logs/export?include_raw=1&include_muted=1')
  assert.equal(res.headers['x-kin-export-count'], '1')
  assert.equal(res.headers['x-kin-export-byte-limited'], '1')
  assert.ok(Buffer.byteLength(res.text) <= RAW_EXPORT_BYTES)
  const rows = await fx.route('/api/panel/request-logs/export?include_raw=1&include_muted=1&limit=1')
  assert.equal(rows.headers['x-kin-export-row-limited'], '1')
  fx.db.prepare('DELETE FROM request_log_debug').run()
  fx.db.prepare('DELETE FROM usage_logs').run()
  fx.add('c', 'short')
  fx.add('d', 'short')
  const closed = await fx.route('/api/panel/request-logs/export?include_raw=1&include_muted=1', { disconnect: true })
  assert.equal(closed.text.trim().split('\n').length, 1)
  assert.equal(closed.writableEnded, false)
  assert.equal(closed.listenerCount('drain'), 0)
  const errored = await fx.route('/api/panel/request-logs/export?include_raw=1&include_muted=1', { writeError: true })
  assert.equal(errored.text.trim().split('\n').length, 1)
  assert.equal(errored.writableEnded, false)
  assert.equal(errored.listenerCount('drain'), 0)
})
