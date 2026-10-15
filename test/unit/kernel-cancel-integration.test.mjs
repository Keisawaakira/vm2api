import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { dispatchCallInference, dispatchStreamInference } from '../../src/lib/transport/kernel-router.mjs'
import { mockWorker, candidate } from '../support/in-memory-worker.mjs'

for (const [mode, send] of [
  ['json', dispatchCallInference],
  ['sse', dispatchStreamInference],
])
  test(`${mode} abort names exactly its authenticated inference, never another model send`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-cancel-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    const token = path.join(dir, 'token')
    fs.writeFileSync(token, 'neutral-internal-token')
    const exec = candidate().exec
    exec.vm.runtime.worker_token_file = token
    const controller = new AbortController()
    const sends = mockWorker(t, () => {
      controller.abort()
      controller.abort()
      return { error: Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }) }
    })
    const result = await send({
      exec,
      envelope: { body: { model: 'fixture' } },
      signal: controller.signal,
      timeoutMs: 1000,
      ensureRust: async () => ({ ok: true }),
    })
    await new Promise((r) => setImmediate(r))
    assert.equal(result.clientCancelled, true)
    assert.equal(result.rust_execution_count, 1)
    assert.equal(sends.length, 1)
    assert.equal(sends.cancels.length, 1)
    assert.equal(sends.cancels[0].envelope.request_id, sends[0].envelope.request_id)
    assert.equal(sends[0].options.headers['x-kin-internal-token'], 'neutral-internal-token')
    assert.equal(sends.cancels[0].options.headers['x-kin-internal-token'], 'neutral-internal-token')
  })
test('after a credential replay only the active dispatch ID can be cancelled', async (t) => {
  const controller = new AbortController(),
    exec = candidate().exec
  const sends = mockWorker(t, ({ index }) => {
    if (index === 0)
      return { status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'token revoked' } } }
    controller.abort()
    return { error: Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }) }
  })
  const result = await dispatchStreamInference({
    exec,
    envelope: { body: { model: 'fixture' } },
    signal: controller.signal,
    timeoutMs: 1000,
    ensureRust: async () => ({ ok: true }),
    ensureCredential: async () => ({ ok: true }),
    recycleWrap: () => {},
  })
  await new Promise((r) => setImmediate(r))
  assert.equal(result.rust_execution_count, 2)
  assert.equal(sends.length, 2)
  assert.equal(sends.cancels.length, 1)
  assert.notEqual(sends[0].envelope.request_id, sends[1].envelope.request_id)
  assert.equal(sends.cancels[0].envelope.request_id, sends[1].envelope.request_id)
})
test('a later abort after successful settlement sends no stale cancel', async (t) => {
  const controller = new AbortController(),
    sends = mockWorker(t)
  const result = await dispatchStreamInference({
    exec: candidate().exec,
    envelope: { body: { model: 'fixture' } },
    signal: controller.signal,
    timeoutMs: 1000,
    ensureRust: async () => ({ ok: true }),
  })
  assert.equal(result.ok, true)
  controller.abort()
  await new Promise((r) => setImmediate(r))
  assert.equal(sends.length, 1)
  assert.equal(sends.cancels.length, 0)
})
test('an asynchronous failure while reading best-effort cancel response cannot crash Node', () => {
  const client = new URL('../../src/lib/transport/go-worker-client.mjs', import.meta.url).href
  const code = `import http from 'node:http';import{EventEmitter}from'node:events';import{Readable}from'node:stream';
const controller=new AbortController();let cancelCalls=0,modelCalls=0;
http.request=(options,callback)=>{const req=new EventEmitter();req.write=()=>{};req.destroy=e=>{req.emit('error',e);req.emit('close')};req.end=()=>queueMicrotask(()=>{
 let res;if(options.path==='/internal/v1/cancel'){cancelCalls++;res=new Readable({read(){setImmediate(()=>this.destroy(Error('cancel body disconnected')))}})}else{modelCalls++;res=Readable.from((async function*(){yield Buffer.from('data: '+JSON.stringify({type:'message_start',message:{content:[],usage:{input_tokens:3}}})+'\\n\\n');controller.abort();yield Buffer.from('\\n')})())}
 res.statusCode=200;res.headers={};res.trailers={};res.once('close',()=>req.emit('close'));callback(res)});return req};
const{streamGoWorker}=await import(${JSON.stringify(client)});await streamGoWorker({exec:{vmId:'fixture',vm:{runtime:{worker_socket:'unused'}}},envelope:{body:{model:'fixture'}},signal:controller.signal,timeoutMs:1000});
await new Promise(r=>setTimeout(r,80));console.log(JSON.stringify({cancelCalls,modelCalls,completed:true}));`
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, KIN_CRS_MOCK: '0' },
  })
  assert.equal(run.status, 0, run.stderr)
  const result = JSON.parse(run.stdout.trim())
  assert.deepEqual(result, { cancelCalls: 1, modelCalls: 1, completed: true })
})
