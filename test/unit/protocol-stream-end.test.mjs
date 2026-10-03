import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  finishProtocolStream,
  writeProtocolStreamError,
  watchClientDisconnect,
} from '../../src/lib/protocol/stream-end.mjs'

const response = () =>
  Object.assign(new EventEmitter(), {
    text: 'partial text\n',
    destroyed: false,
    writableEnded: false,
    write(value) {
      this.text += value
    },
    end() {
      this.writableEnded = true
    },
  })

test('failed committed Chat stream carries an explicit error and no success sentinel', () => {
  const res = response()
  finishProtocolStream(res, {
    protocol: 'openai.chat',
    ok: false,
    errorBody: { error: { type: 'upstream_error', code: 'stream_incomplete', message: 'lost connection' } },
  })
  assert.match(res.text, /partial text/)
  assert.match(res.text, /"code":"stream_incomplete"/)
  assert.doesNotMatch(res.text, /\[DONE\]/)
  assert.equal(res.writableEnded, true)
})

test('forwarded provider errors are neither duplicated nor followed by DONE', () => {
  const res = response()
  assert.equal(
    writeProtocolStreamError(res, 'openai.chat', { error: { type: 'api_error', message: 'overloaded' } }),
    true,
  )
  assert.equal(writeProtocolStreamError(res, 'openai.chat', { error: { message: 'second' } }), false)
  finishProtocolStream(res, { protocol: 'openai.chat', ok: false })
  assert.equal((res.text.match(/"error"/g) || []).length, 1)
  assert.doesNotMatch(res.text, /\[DONE\]/)
  const badSuccess = response()
  writeProtocolStreamError(badSuccess, 'openai.chat', { error: { message: 'error' } })
  finishProtocolStream(badSuccess, { protocol: 'openai.chat', ok: true })
  assert.doesNotMatch(badSuccess.text, /\[DONE\]/)
})

test('successful Chat ends normally; observed cancellation does not invent errors', () => {
  const success = response()
  finishProtocolStream(success, { protocol: 'openai.chat', ok: true })
  assert.match(success.text, /data: \[DONE\]/)
  const cancelled = response()
  finishProtocolStream(cancelled, { protocol: 'openai.chat', ok: false, cancelled: true })
  assert.equal(cancelled.text, 'partial text\n')
  const disconnected = response()
  disconnected.destroyed = true
  finishProtocolStream(disconnected, { protocol: 'openai.chat', ok: false })
  assert.equal(disconnected.text, 'partial text\n')
})

test('Anthropic and Responses receive protocol-shaped terminal errors', () => {
  for (const protocol of ['anthropic.messages', 'openai.responses']) {
    const res = response()
    finishProtocolStream(res, { protocol, ok: false })
    assert.match(res.text, /event: error\ndata: /)
    assert.match(res.text, /"type":"error"/)
    assert.doesNotMatch(res.text, /\[DONE\]/)
  }
})

test('response close aborts inference after request upload; cleanup removes listeners', () => {
  const req = new EventEmitter()
  const res = response()
  const controller = new AbortController()
  const unwatch = watchClientDisconnect(req, res, controller)
  req.emit('close')
  assert.equal(controller.signal.aborted, false)
  res.emit('close')
  assert.equal(controller.signal.aborted, true)
  unwatch()
  assert.equal(req.listenerCount('aborted'), 0)
  assert.equal(res.listenerCount('close'), 0)
})

test('normal ended response does not abort, but an already disconnected client does', () => {
  const req = new EventEmitter()
  const res = response()
  const controller = new AbortController()
  const unwatch = watchClientDisconnect(req, res, controller)
  res.writableEnded = true
  res.emit('close')
  assert.equal(controller.signal.aborted, false)
  unwatch()
  const gone = response()
  gone.destroyed = true
  const goneController = new AbortController()
  const cleanup = watchClientDisconnect(req, gone, goneController)
  assert.equal(goneController.signal.aborted, true)
  cleanup()
})
