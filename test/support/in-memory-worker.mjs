import assert from 'node:assert/strict'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { resetWrapRecycleState } from '../../src/lib/transport/rust-kernel-supervisor.mjs'

export const usage = { input_tokens: 40, cache_read_input_tokens: 60, output_tokens: 3 }
export const successEvents = [
  { type: 'message_start', message: { type: 'message', role: 'assistant', content: [], usage } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'ok' } },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
  { type: 'message_stop' },
]
export const frame = (event) => Buffer.from(`data: ${JSON.stringify(event)}\n\n`)

// No sockets, services or native processes. The real router/transport/envelope
// execute against this HTTP boundary; native lifecycle dependencies are injected.
export function mockWorker(t, respond = () => ({})) {
  const previous = {}
  for (const [key, value] of Object.entries({
    KIN_KERNEL_BIN: 'in-memory-only',
    KIN_CRS_MOCK: '0',
    KIN_SESSION_DUMP: '',
  })) {
    previous[key] = process.env[key]
    process.env[key] = value
  }
  resetWrapRecycleState()
  t.after(() => {
    resetWrapRecycleState()
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key]
      else process.env[key] = value
    }
  })
  const sends = []
  t.mock.method(http, 'request', (options, callback) => {
    assert.equal(options.method, 'POST', 'health/native orchestration must be injected')
    const request = new EventEmitter()
    const chunks = []
    request.write = (chunk) => chunks.push(Buffer.from(chunk))
    request.destroy = (error) => {
      request.emit('error', error)
      request.emit('close')
    }
    request.end = () =>
      queueMicrotask(() => {
        const send = { options, envelope: JSON.parse(Buffer.concat(chunks)), index: sends.length }
        sends.push(send)
        const spec = respond(send) || {}
        if (spec.error) return request.destroy(spec.error)
        const response =
          spec.readable ||
          Readable.from(
            spec.body != null ? [Buffer.from(JSON.stringify(spec.body))] : (spec.events || successEvents).map(frame),
          )
        Object.assign(response, {
          statusCode: spec.status || 200,
          headers: spec.headers || {},
          trailers: spec.trailers || {},
        })
        response.once('close', () => request.emit('close'))
        callback(response)
      })
    return request
  })
  return sends
}

export function candidate(id = 'a', mode = 'oauth') {
  const vm = { id: `vm-${id}`, claude: { mode }, runtime: { kernel_socket: `in-memory-${id}` } }
  return { accountId: `account-${id}`, vmId: vm.id, vm, exec: { vmId: vm.id, vm } }
}
