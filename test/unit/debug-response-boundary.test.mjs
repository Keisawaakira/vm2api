import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { RequestLogStore } from '../../src/lib/admin/request-log.mjs'

function fixture(t, mode = 'debug', headers = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-response-boundary-'))
  const store = new RequestLogStore({ dataDir: root, mode })
  t.after(() => {
    store.db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const ctx = store.start({ method: 'POST', headers, socket: {} }, { pathName: '/v1/chat/completions' })
  const wire = []
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    getHeaders: () => ({ 'content-type': 'text/event-stream', 'set-cookie': 'fixture-cookie' }),
    write(chunk) {
      wire.push(Buffer.from(chunk))
      return false
    },
    end(chunk) {
      if (chunk) wire.push(Buffer.from(chunk))
      this.emit('finish')
      return this
    },
  })
  store.tapResponse(ctx, res)
  return { store, ctx, res, wire }
}

test('client SSE debug capture redacts stored secrets without changing wire/backpressure', (t) => {
  const fx = fixture(t)
  const secret = 'sk-ant-oat01-ABCDEFGH12345678'
  const text = `data: ${JSON.stringify({ text: '中文🙂', secret })}\n\n`
  const bytes = Buffer.from(text),
    cut = bytes.indexOf(Buffer.from('🙂')) + 1
  assert.equal(fx.res.write(bytes.subarray(0, cut)), false)
  assert.equal(fx.res.end(bytes.subarray(cut)), fx.res)
  fx.store.finish(fx.ctx, { status: 200 })
  const response = fx.store.getDebug(fx.ctx.request_id).response
  assert.equal(Buffer.concat(fx.wire).toString(), text)
  assert.equal(response.bytes, bytes.length)
  assert.equal(response.truncated, false)
  assert.match(response.body, /中文🙂/)
  assert.doesNotMatch(response.body, /ABCDEFGH12345678/)
  assert.match(response.body, /REDACTED/)
  assert.equal(response.headers['set-cookie'], '***REDACTED***')
})

test('caller debug may capture its response but cannot enable operator outbound storage', (t) => {
  const fx = fixture(t, 'normal', { 'x-kin-debug': '1' })
  assert.equal(fx.ctx.mode, 'debug')
  assert.equal(fx.ctx.capture_outbound, false)
  fx.res.end('{"ok":true}')
  fx.store.finish(fx.ctx, {
    status: 200,
    outbound_body: { system: 'OPERATOR_ONLY' },
    outbound_headers: { custom: 'OPERATOR_ONLY' },
  })
  const record = fx.store.getDebug(fx.ctx.request_id)
  assert.equal(record.outbound_body, null)
  assert.equal(record.outbound_headers, null)
  assert.equal(JSON.parse(record.response.body).ok, true)
})
