import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import http2 from 'node:http2'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseCCNativeTrace } from '../../src/lib/transport/cc-native-trace.mjs'
import {
  CC_TRACE_VERSION,
  CC_TRACE_KEY,
  CC_TRACE_MAX_BYTES,
  installCCNativeTrace,
} from '../../src/lib/transport/cc-native-trace-hook.mjs'

const hook =
  process.env.CC_TRACE_TEST_PRELOAD ||
  fileURLToPath(new URL('../../src/lib/transport/cc-native-trace-preload.mjs', import.meta.url))
const host = fileURLToPath(new URL('../support/cc-native-trace-host.mjs', import.meta.url))
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const bodyText = '完整正文 中文🙂 "引号" <content>格式</content>\n'.repeat(180)
const sse = [
  {
    type: 'message_start',
    message: {
      id: 'msg_trace_fixture',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-6',
      content: [],
      usage: { input_tokens: 3, output_tokens: 0 },
    },
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: bodyText } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 149 } },
  { type: 'message_stop' },
]
  .map((event) => `data: ${JSON.stringify(event)}\n\n`)
  .join('')

function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-trace-'))
  if (process.env.CC_TRACE_KEEP_FIXTURES === '1') t.diagnostic(`retained fixture: ${root}`)
  else t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}
function frame(root, tag, fixture, { admitted = true, expired = false, maxBytes = CC_TRACE_MAX_BYTES } = {}) {
  const id = crypto.randomBytes(32).toString('hex')
  if (admitted)
    fs.writeFileSync(
      path.join(root, `${id}.ticket`),
      JSON.stringify({
        version: CC_TRACE_VERSION,
        id,
        request_id: `request-${tag}`,
        expires_at: expired ? 0 : Date.now() + 60000,
        max_bytes: maxBytes,
      }),
      { mode: 0o600 },
    )
  return {
    id,
    frame: {
      type: 'kin_job_start',
      slot_id: tag,
      job_id: `job-${tag}`,
      request: {
        model: 'claude-opus-4-6',
        system: [{ type: 'text', text: `KEEP_SYSTEM_${tag} 中文🙂` }],
        messages: [{ role: 'user', content: tag }],
        metadata: { user_id: 'unchanged-session', [CC_TRACE_KEY]: id },
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: 'max' },
        max_tokens: 128000,
        fixture,
      },
    },
  }
}
async function server(
  t,
  { h2 = false, compressed = false, json = false, slow = false, replyBytes, replies, waves } = {},
) {
  const requests = []
  const instance = h2 ? http2.createServer() : http.createServer()
  instance.on('request', (req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      requests.push({ url: req.url, body, headers: req.headers })
      if (req.url === '/oauth/token') {
        res.end('{}')
        return
      }
      let reply =
        replies?.[Math.min(requests.length - 1, replies.length - 1)] ||
        replyBytes ||
        Buffer.from(json ? JSON.stringify({ type: 'fixture_json', content: bodyText }) : sse)
      if (compressed) reply = zlib.gzipSync(reply)
      res.writeHead(200, {
        'content-type': json ? 'application/json' : 'text/event-stream',
        'request-id': 'req_fixture',
        'set-cookie': 'DO_NOT_LOG_SET_COOKIE',
        ...(compressed ? { 'content-encoding': 'gzip' } : {}),
      })
      if (waves) {
        res.write(waves.first)
        const timer = setTimeout(() => res.end(waves.second), waves.delayMs)
        res.on('close', () => clearTimeout(timer))
      } else if (slow) {
        res.write(reply.subarray(0, 200))
        const timer = setTimeout(() => res.end(reply.subarray(200)), 1000)
        res.on('close', () => clearTimeout(timer))
      } else {
        for (let i = 0; i < reply.length; i += 127) res.write(reply.subarray(i, i + 127))
        res.end()
      }
    })
  })
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve))
  t.after(
    () =>
      new Promise((resolve) => {
        instance.closeAllConnections?.()
        instance.close(resolve)
      }),
  )
  return { url: `http://127.0.0.1:${instance.address().port}/v1/messages`, requests }
}
function run(
  root,
  frames,
  {
    preload = process.env.CC_TRACE_TEST_NO_PRELOAD !== '1',
    executable = process.execPath,
    compiled = false,
    hookFile = hook,
    env = {},
  } = {},
) {
  return new Promise((resolve, reject) => {
    const args = compiled ? [] : [...(preload ? ['--import', pathToFileURL(hookFile).href] : []), host]
    const child = spawn(executable, args, {
      env: {
        ...process.env,
        VM2API_CC_TRACE_ROOT: root,
        ...(compiled && preload ? { BUN_OPTIONS: `--preload ${hookFile.replaceAll('\\', '/')}` } : {}),
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout = [],
      stderr = []
    const timer = setTimeout(() => {
      child.kill()
      reject(Error('fixture timed out'))
    }, 15000)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) reject(Error(Buffer.concat(stderr).toString() || `exit ${code}`))
      else resolve(Buffer.concat(stdout).toString())
    })
    const input = Buffer.from(frames.map((value) => JSON.stringify(value) + '\n').join(''))
    for (let pos = 0; pos < input.length; pos += 19) child.stdin.write(input.subarray(pos, pos + 19))
    child.stdin.end()
  })
}
function report(root, id) {
  const raw = fs.readFileSync(path.join(root, `${id}.jsonl`), 'utf8')
  const done = JSON.parse(fs.readFileSync(path.join(root, `${id}.done`), 'utf8'))
  assert.equal(done.id, id)
  assert.doesNotMatch(raw, /DO_NOT_LOG_AUTH|DO_NOT_LOG_COOKIE|DO_NOT_LOG_SET_COOKIE|DO_NOT_LOG_REFRESH_TOKEN/)
  return {
    raw,
    parsed: parseCCNativeTrace(raw, {
      id,
      done: done.complete,
      reused: fs.existsSync(path.join(root, `${id}.reused`)),
    }),
  }
}

test('modern native frames retain actual HTTP evidence and original frame spelling', async (t) => {
  const root = temp(t),
    endpoint = await server(t)
  const job = frame(root, 'modern', { url: endpoint.url })
  job.frame.type = 'job_start'
  const output = await run(root, [job.frame], { env: { CC_TRACE_WIRE_MODE: 'modern' } })
  assert.equal(endpoint.requests.length, 1)
  assert.match(output, /"type":"job_done"/)
  const { raw, parsed } = report(root, job.id)
  assert.equal(parsed.status, 'captured', JSON.stringify(parsed.evidence_issues))
  assert.ok(raw.includes('job_start'))
  assert.equal(parsed.http_exchanges.length, 1)
  assert.equal(parsed.http_exchanges[0].response.body.text, sse)
  assert.equal(parsed.lifecycle.find((row) => row.type === 'native_terminal').reason, 'job_done')
})

test('CCH replace observer preserves return values, callbacks, coercion, exceptions and restoration', (t) => {
  const root = temp(t),
    original = String.prototype.replace
  const installed = installCCNativeTrace({ root })
  try {
    for (const [text, search, replacement] of [
      ['a a', 'a', 'b'],
      ['cch=00000', 'cch=00000', 'cch=abcde'],
      ['cch=00000 cch=00000', 'cch=00000', 'cch=12345'],
      ['unchanged', /none/g, 'x'],
    ]) {
      assert.equal(text.replace(search, replacement), Reflect.apply(original, text, [search, replacement]))
    }
    let calls = 0
    assert.equal(
      'ab'.replace(/a/, () => {
        calls++
        return 'c'
      }),
      'cb',
    )
    assert.equal(calls, 1)
    let coerced = 0
    const receiver = {
      toString() {
        coerced++
        return 'cch=00000'
      },
    }
    assert.equal(String.prototype.replace.call(receiver, 'cch=00000', 'cch=abcde'), 'cch=abcde')
    assert.equal(coerced, 1)
    const error = new Error('custom replace failure')
    assert.throws(
      () =>
        'a'.replace(
          {
            [Symbol.replace]() {
              throw error
            },
          },
          'b',
        ),
      (e) => e === error,
    )
    assert.equal(
      'a'.replace(
        {
          [Symbol.replace]() {
            return 42
          },
        },
        'b',
      ),
      42,
    )
  } finally {
    installed.restore()
  }
  assert.equal(String.prototype.replace, original)
})

test('simultaneous claims report incomplete evidence without merging separate native jobs', async (t) => {
  const root = temp(t),
    api = await server(t)
  const job = frame(root, 'simultaneous', { url: api.url })
  const second = { ...job.frame, job_id: 'job-second-process' }
  const hookFile = fileURLToPath(new URL('../support/cc-native-trace-claim-barrier.mjs', import.meta.url))
  await Promise.all([run(root, [job.frame], { hookFile }), run(root, [second], { hookFile })])
  assert.equal(api.requests.length, 2)
  assert.equal(fs.existsSync(path.join(root, `${job.id}.reused`)), true)
  const { parsed } = report(root, job.id)
  assert.equal(parsed.status, 'partial_capture')
  assert.equal(parsed.reason, 'native_ticket_reused')
  assert.equal(parsed.http_exchanges.length, 1)
})

test('preload readiness survives missing trace markers without recording unadmitted bodies', async (t) => {
  const root = temp(t),
    api = await server(t)
  const job = frame(root, 'unmarked', { url: api.url }, { admitted: false })
  delete job.frame.request.metadata[CC_TRACE_KEY]
  await run(root, [job.frame])
  const files = fs.readdirSync(root)
  const name = files.find((file) => /^runtime-\d+\.json$/.test(file))
  assert.ok(name, 'loaded observer must leave bounded readiness evidence')
  const ready = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'))
  assert.equal(ready.native_jobs, 1)
  assert.equal(ready.jobs_with_trace_id, 0)
  assert.equal(ready.admitted_jobs, 0)
  assert.equal(ready.last_ticket_status, 'missing_nonce')
  assert.ok(ready.stdin_lines > 0)
  assert.equal(
    files.some((file) => file.endsWith('.jsonl')),
    false,
  )
  assert.doesNotMatch(JSON.stringify(ready), /KEEP_SYSTEM|DO_NOT_LOG|unchanged-session|neutral reply/)
  assert.equal(api.requests.length, 1)
})

for (const read of ['reader', 'iterator', 'text'])
  test(`passive fetch ${read} preserves stdout and distinguishes raw/decoded views`, async (t) => {
    const root = temp(t),
      api = await server(t)
    const job = frame(root, 'one', { url: api.url, read, authProbe: true })
    const original = await run(root, [job.frame], { preload: false })
    assert.equal(fs.existsSync(path.join(root, `${job.id}.jsonl`)), false)
    const traced = await run(root, [job.frame])
    assert.equal(traced, original)
    const { parsed } = report(root, job.id)
    assert.equal(parsed.status, read === 'text' ? 'partial_capture' : 'captured')
    assert.equal(parsed.http_exchanges.length, 1)
    assert.equal(
      read === 'text'
        ? parsed.http_exchanges[0].response.decoded_text.text
        : parsed.http_exchanges[0].response.body.text,
      sse,
    )
    assert.equal(
      parsed.http_exchanges[0].request.body.text,
      api.requests
        .filter((x) => x.url === '/v1/messages')
        .at(-1)
        .body.toString(),
    )
    assert.equal(parsed.http_exchanges[0].response.read_complete, true)
    assert.equal(parsed.cleaned_request.metadata.user_id, 'unchanged-session')
    assert.equal(parsed.cleaned_request.metadata[CC_TRACE_KEY], undefined)
    assert.equal(parsed.stdout_frames.map((x) => x.text).join(''), traced)
  })

for (const compressed of [false, true])
  test(`HTTP2 capture is passive and keeps response encoding (${compressed})`, async (t) => {
    const root = temp(t),
      api = await server(t, { h2: true, compressed })
    const job = frame(root, 'h2', { url: api.url, transport: 'http2', compressed })
    const output = await run(root, [job.frame])
    const { parsed } = report(root, job.id)
    assert.equal(parsed.status, 'captured')
    assert.equal(parsed.http_exchanges.length, 1)
    const exchange = parsed.http_exchanges[0]
    assert.equal(exchange.request.body.text, api.requests[0].body.toString())
    assert.equal(compressed ? exchange.response.body.decoded.text : exchange.response.body.text, sse)
    assert.equal(exchange.transport, 'http2')
    assert.equal(parsed.stdout_frames.map((x) => x.text).join(''), output)
  })

test('overlapping native jobs and non-enrolled work do not share a trace', async (t) => {
  const root = temp(t),
    api = await server(t)
  const slow = frame(root, 'slow', { url: api.url, delay: 35 })
  const fast = frame(root, 'fast', { url: api.url, delay: 0 })
  const untraced = frame(root, 'untraced', { url: api.url, delay: 10 }, { admitted: false })
  await run(root, [slow.frame, fast.frame, untraced.frame])
  for (const job of [slow, fast]) {
    const { parsed } = report(root, job.id)
    assert.equal(parsed.status, 'captured')
    assert.equal(parsed.job_id, job.frame.job_id)
    assert.equal(parsed.http_exchanges.length, 1)
    const body = JSON.parse(parsed.http_exchanges[0].request.body.text)
    assert.equal(body.messages[0].content, job.frame.slot_id)
    assert.ok(parsed.stdout_frames.every((x) => JSON.parse(x.text).job_id === job.frame.job_id))
  }
  assert.equal(fs.existsSync(path.join(root, `${untraced.id}.jsonl`)), false)
})

test('a reused ticket in another native host must not leave a falsely complete first trace', async (t) => {
  const root = temp(t)
  const api = await server(t)
  const job = frame(root, 'reused', { url: api.url })
  await run(root, [job.frame])
  await run(root, [{ ...job.frame, job_id: 'second-native-job' }])
  assert.equal(api.requests.length, 2)
  const { parsed } = report(root, job.id)
  assert.equal(parsed.status, 'partial_capture')
  assert.equal(parsed.reason, 'native_ticket_reused')
})

for (const extraSerializations of [0, 300, 2500])
  test(`pre-admission untraced serialization cannot be attributed later (extra=${extraSerializations})`, async (t) => {
    const root = temp(t)
    const api = await server(t)
    const earlier = frame(
      root,
      'earlier-unadmitted',
      { url: api.url, afterSerializeDelay: 70, extraSerializations, stamp: true },
      { admitted: false },
    )
    const admitted = frame(root, 'later-admitted', { url: api.url, delay: 5, afterSerializeDelay: 15, stamp: true })
    for (const job of [earlier, admitted]) {
      job.frame.request.system = [{ type: 'text', text: 'identical system' }]
      job.frame.request.messages = [{ role: 'user', content: 'identical request' }]
    }
    await run(root, [earlier.frame, admitted.frame])
    assert.equal(api.requests.length, 2)
    const { parsed } = report(root, admitted.id)
    assert.equal(parsed.http_exchanges.length, 0)
    assert.equal(parsed.status, 'partial_capture')
    assert.equal(fs.existsSync(path.join(root, `${earlier.id}.jsonl`)), false)
  })

test('an uncorrelated later API exchange makes the observation partial', async (t) => {
  const root = temp(t)
  const api = await server(t)
  const job = frame(root, 'later-gap', { url: api.url, rounds: 2, unownedSecond: true })
  await run(root, [job.frame])
  assert.equal(api.requests.length, 2)
  const { parsed } = report(root, job.id)
  assert.equal(parsed.http_exchanges.length, 1)
  assert.equal(parsed.stdout_frames.filter((row) => JSON.parse(row.text).event?.type === 'message_start').length, 2)
  assert.equal(parsed.status, 'partial_capture')
})

for (const [name, rawBytes, decoded] of [
  ['BOM', Buffer.from([0xef, 0xbb, 0xbf, 0x6f, 0x6b]), 'ok'],
  ['invalid UTF8', Buffer.from([0xff, 0x61]), '\ufffda'],
])
  test(`decoded text is not raw bytes: ${name}`, async (t) => {
    const root = temp(t)
    const api = await server(t, { replyBytes: rawBytes })
    const job = frame(root, 'text-view', { url: api.url, read: 'text' })
    await run(root, [job.frame])
    const { parsed } = report(root, job.id)
    assert.equal(parsed.status, 'partial_capture')
    assert.equal(parsed.http_exchanges[0].response.body.encoding, 'unavailable')
    assert.equal(parsed.http_exchanges[0].response.decoded_text.text, decoded)
  })

test('expired tickets never record native/API bodies', async (t) => {
  const root = temp(t),
    api = await server(t)
  const job = frame(root, 'expired', { url: api.url }, { expired: true })
  const output = await run(root, [job.frame])
  assert.match(output, /kin_job_done/)
  assert.equal(api.requests.length, 1)
  assert.equal(fs.existsSync(path.join(root, `${job.id}.jsonl`)), false)
})

test('trace sees both API rounds even if the host only forwards the first reply', async (t) => {
  const root = temp(t),
    api = await server(t)
  const job = frame(root, 'rounds', { url: api.url, rounds: 2, emitFirstOnly: true })
  await run(root, [job.frame])
  const { parsed } = report(root, job.id)
  assert.equal(parsed.http_exchanges.length, 2)
  assert.equal(parsed.reported_api_attempts, 2)
  assert.equal(parsed.stdout_frames.filter((x) => JSON.parse(x.text).event?.type === 'message_start').length, 1)
  for (const exchange of parsed.http_exchanges) assert.equal(exchange.response.body.text, sse)
})

for (const bothTraced of [true, false])
  test(`indistinguishable overlapping bodies are not misattributed (both traced=${bothTraced})`, async (t) => {
    const root = temp(t),
      api = await server(t)
    const first = frame(root, 'same-one', { url: api.url, afterSerializeDelay: 25 })
    const second = frame(root, 'same-two', { url: api.url, afterSerializeDelay: 25 }, { admitted: bothTraced })
    for (const job of [first, second]) {
      job.frame.request.system = [{ type: 'text', text: 'same system' }]
      job.frame.request.messages = [{ role: 'user', content: 'same user' }]
    }
    await run(root, [first.frame, second.frame])
    assert.equal(api.requests.length, 2)
    const { parsed } = report(root, first.id)
    assert.equal(parsed.status, 'partial_capture')
    assert.equal(parsed.http_exchanges.length, 0)
    assert.ok(parsed.lifecycle.some((row) => row.type === 'correlation_ambiguous'))
    if (!bothTraced) assert.equal(fs.existsSync(path.join(root, `${second.id}.jsonl`)), false)
  })

test('parsed JSON consumption is explicitly not labeled as captured raw bytes', async (t) => {
  const root = temp(t),
    api = await server(t, { json: true })
  const job = frame(root, 'json', { url: api.url, read: 'json' })
  await run(root, [job.frame])
  const { parsed } = report(root, job.id)
  assert.equal(parsed.status, 'partial_capture')
  assert.equal(parsed.http_exchanges[0].response.body.encoding, 'unavailable')
  assert.equal(parsed.http_exchanges[0].response.parsed_json.content, bodyText)
})

test('SDK cancellation does not wait for an observer drain or turn into success', async (t) => {
  const root = temp(t),
    api = await server(t, { slow: true })
  const job = frame(root, 'cancel', { url: api.url, cancelRead: true })
  const start = Date.now()
  await run(root, [job.frame])
  assert.ok(Date.now() - start < 5000)
  const { parsed } = report(root, job.id)
  assert.equal(parsed.status, 'partial_capture')
  assert.equal(parsed.http_exchanges[0].response.read_complete, false)
})

test('retention limit keeps bounded, parseable partial evidence, not a successful full capture', async (t) => {
  const root = temp(t),
    api = await server(t)
  const job = frame(root, 'limited', { url: api.url }, { maxBytes: 8192 })
  job.frame.request.system[0].text = 'large🙂'.repeat(3000)
  const output = await run(root, [job.frame])
  assert.match(output, /kin_job_done/)
  const { raw, parsed } = report(root, job.id)
  assert.ok(Buffer.byteLength(raw) <= 8192)
  assert.equal(parsed.status, 'partial_capture')
  assert.ok(parsed.lifecycle.some((x) => x.type === 'trace_end' && x.dropped_records > 0))
})

test('actual native undici selector captures cloud replies without changing dispatch', {
  skip: !process.env.BUN_BIN,
}, async (t) => {
  const compileRoot = temp(t)
  const executable = path.join(compileRoot, process.platform === 'win32' ? 'undici-host.exe' : 'undici-host')
  execFileSync(process.env.BUN_BIN, ['build', host, '--compile', '--outfile', executable], { stdio: 'pipe' })
  const opts = {
    executable,
    compiled: true,
    env: { HTTPS_PROXY: '', HTTP_PROXY: '', https_proxy: '', http_proxy: '', ANTHROPIC_UNIX_SOCKET: '' },
  }
  for (const bytesBody of [false, true]) {
    await t.test(`native CCH string replacement retains exact request ownership bytes=${bytesBody}`, async (t) => {
      const root = temp(t),
        api = await server(t)
      const job = frame(root, 'native-cch', { url: api.url, transport: 'undici', nativeCch: true, bytesBody })
      const baseline = await run(root, [job.frame], { ...opts, preload: false })
      const sent = api.requests[0].body
      api.requests.length = 0
      const traced = await run(root, [job.frame], opts)
      assert.equal(traced, baseline)
      assert.equal(api.requests.length, 1)
      assert.deepEqual(api.requests[0].body, sent)
      assert.doesNotMatch(sent.toString(), /cch=00000/)
      const { parsed } = report(root, job.id)
      assert.equal(parsed.status, 'captured', JSON.stringify(parsed.lifecycle))
      assert.equal(parsed.http_exchanges.length, 1)
      assert.equal(parsed.http_exchanges[0].request.body.text, sent.toString())
      assert.equal(parsed.http_exchanges[0].response.body.text, sse)
      assert.equal(parsed.http_exchanges[0].response.read_complete, true)
    })
  }

  await t.test('native CCH cannot borrow ownership from a later admitted identical body', async (t) => {
    const root = temp(t),
      api = await server(t)
    const earlier = frame(
      root,
      'raw-cch-unadmitted',
      { url: api.url, transport: 'undici', nativeCch: true, afterSerializeDelay: 70 },
      { admitted: false },
    )
    const admitted = frame(root, 'raw-cch-admitted', {
      url: api.url,
      transport: 'undici',
      nativeCch: true,
      delay: 5,
      afterSerializeDelay: 15,
    })
    for (const item of [earlier, admitted]) {
      item.frame.request.system = [{ type: 'text', text: 'same system' }]
      item.frame.request.messages = [{ role: 'user', content: 'same prompt' }]
    }
    await run(root, [earlier.frame, admitted.frame], opts)
    assert.equal(api.requests.length, 2)
    const { parsed } = report(root, admitted.id)
    assert.equal(parsed.status, 'partial_capture')
    assert.equal(parsed.http_exchanges.length, 0)
    assert.equal(fs.existsSync(path.join(root, `${earlier.id}.jsonl`)), false)
  })

  for (const zeroCchForTest of [false, true])
    await t.test(`unregistered CCH input cannot acquire a later owner, zeroCch=${zeroCchForTest}`, async (t) => {
      const root = temp(t),
        api = await server(t)
      const admitted = frame(root, 'prebuilt-admitted', {
        url: api.url,
        transport: 'undici',
        nativeCch: true,
        delay: 5,
        afterSerializeDelay: 15,
      })
      const request = admitted.frame.request
      request.fixture.zeroCchForTest = zeroCchForTest
      const prebuiltBody = JSON.stringify({
        model: request.model,
        system: [
          { type: 'text', text: 'x-anthropic-billing-header: cc_version=fixture; cch=00000;' },
          ...request.system,
        ],
        messages: request.messages,
        thinking: request.thinking,
        output_config: request.output_config,
        max_tokens: request.max_tokens,
        stream: true,
      })
      const earlier = frame(
        root,
        'prebuilt-unadmitted',
        { url: api.url, transport: 'undici', nativeCch: true, zeroCchForTest, prebuiltBody, afterSerializeDelay: 70 },
        { admitted: false },
      )
      await run(root, [earlier.frame, admitted.frame], opts)
      assert.equal(api.requests.length, 2)
      assert.deepEqual(api.requests[0].body, api.requests[1].body)
      const { parsed } = report(root, admitted.id)
      assert.equal(parsed.status, 'partial_capture')
      assert.equal(parsed.http_exchanges.length, 0)
      assert.equal(fs.existsSync(path.join(root, `${earlier.id}.jsonl`)), false)
    })

  await t.test('compiled modern protocol keeps undici/CCH request and terminal evidence', async (t) => {
    const root = temp(t),
      api = await server(t)
    const job = frame(root, 'modern-undici', { url: api.url, transport: 'undici', nativeCch: true })
    job.frame.type = 'job_start'
    await run(root, [job.frame], { ...opts, env: { CC_TRACE_WIRE_MODE: 'modern' } })
    const { parsed } = report(root, job.id)
    assert.equal(parsed.status, 'captured', JSON.stringify(parsed.evidence_issues))
    assert.equal(parsed.http_exchanges.length, 1)
    assert.equal(parsed.http_exchanges[0].response.body.text, sse)
    assert.equal(parsed.lifecycle.find((row) => row.type === 'native_terminal').reason, 'job_done')
    assert.equal(api.requests.length, 1)
  })

  await t.test('distinct concurrent native CCH bodies remain isolated', async (t) => {
    const root = temp(t),
      api = await server(t)
    const jobs = ['A', 'B'].map((name) =>
      frame(root, 'raw-cch-' + name, { url: api.url, transport: 'undici', nativeCch: true, delay: 10 }),
    )
    await run(
      root,
      jobs.map((j) => j.frame),
      opts,
    )
    assert.equal(api.requests.length, 2)
    for (const job of jobs) {
      const { parsed } = report(root, job.id)
      assert.equal(parsed.status, 'captured')
      assert.equal(parsed.http_exchanges.length, 1)
      assert.deepEqual(JSON.parse(parsed.http_exchanges[0].request.body.text).messages, job.frame.request.messages)
    }
  })

  const first = Buffer.from(sse.replace(JSON.stringify(bodyText), JSON.stringify('FIRST_FOUNDATION')))
  const second = Buffer.from(
    sse.replace(JSON.stringify(bodyText), JSON.stringify('SECOND_CLOUD_BODY 中文🙂'.repeat(500))),
  )

  await t.test('two cloud calls, only first forwarded: both responses and original bytes are retained', async (t) => {
    const root = temp(t),
      api = await server(t, { replies: [first, second] })
    const job = frame(root, 'undici-rounds', {
      url: api.url,
      transport: 'undici',
      rounds: 2,
      emitFirstOnly: true,
      nativeCch: true,
    })
    const baseline = await run(root, [job.frame], { ...opts, preload: false })
    const sentBefore = api.requests.map((req) => req.body.toString())
    api.requests.length = 0
    const traced = await run(root, [job.frame], opts)
    assert.equal(traced, baseline)
    assert.deepEqual(
      api.requests.map((req) => req.body.toString()),
      sentBefore,
    )
    const { parsed } = report(root, job.id)
    assert.equal(parsed.status, 'captured')
    assert.equal(parsed.http_exchanges.length, 2)
    assert.equal(parsed.http_exchanges[0].transport, 'undici')
    assert.equal(parsed.http_exchanges[0].response.body.text, first.toString())
    assert.equal(parsed.http_exchanges[1].response.body.text, second.toString())
    assert.equal(parsed.stdout_frames.filter((row) => JSON.parse(row.text).event?.type === 'message_start').length, 1)
    assert.equal(
      parsed.stdout_frames.some((row) => row.text.includes('SECOND_CLOUD_BODY')),
      false,
    )
  })

  await t.test('native terminal before cloud EOF does not discard late response data', async (t) => {
    const root = temp(t),
      api = await server(t, { waves: { first, second, delayMs: 900 } })
    const job = frame(root, 'undici-early-terminal', {
      url: api.url,
      transport: 'undici',
      earlyTerminal: true,
      nativeCch: true,
    })
    await run(root, [job.frame], opts)
    const { parsed } = report(root, job.id)
    assert.equal(api.requests.length, 1)
    assert.equal(parsed.status, 'captured')
    assert.equal(parsed.http_exchanges[0].response.body.text, Buffer.concat([first, second]).toString())
    assert.equal(parsed.http_exchanges[0].response.read_complete, true)
    const terminal = parsed.lifecycle.find((row) => row.type === 'native_terminal')
    const timeline = parsed.http_exchanges[0].timeline
    assert.ok(terminal.n < timeline.last_response_body.n)
    assert.ok(timeline.last_response_body.n < timeline.response_end.n)
    assert.equal(
      parsed.stdout_frames.some((row) => row.text.includes('SECOND_CLOUD_BODY')),
      false,
    )
  })

  await t.test(
    'SDK stops after the first message: unread/cancelled response is never certified complete',
    async (t) => {
      const root = temp(t),
        api = await server(t, { waves: { first, second, delayMs: 900 } })
      const job = frame(root, 'undici-early-read-stop', {
        url: api.url,
        transport: 'undici',
        stopAtFirstStop: true,
        nativeCch: true,
      })
      await run(root, [job.frame], opts)
      const { parsed } = report(root, job.id)
      assert.equal(api.requests.length, 1)
      assert.equal(parsed.http_exchanges.length, 1)
      assert.equal(parsed.http_exchanges[0].response.read_complete, false)
      assert.equal(parsed.http_exchanges[0].response.capture_kind, 'sdk_cancel')
      assert.equal(parsed.http_exchanges[0].response.observation_layer, 'sdk_response_consumer')
      assert.equal(parsed.status, 'partial_capture')
      assert.equal(parsed.reason, 'api_response_not_fully_read')
    },
  )
  await t.test('undici ownership remains isolated when unadmitted work serialized first', async (t) => {
    const root = temp(t),
      api = await server(t)
    const earlier = frame(
      root,
      'undici-unadmitted',
      { url: api.url, transport: 'undici', stamp: true, afterSerializeDelay: 70 },
      { admitted: false },
    )
    const admitted = frame(root, 'undici-admitted', {
      url: api.url,
      transport: 'undici',
      stamp: true,
      delay: 5,
      afterSerializeDelay: 15,
    })
    for (const item of [earlier, admitted]) {
      item.frame.request.system = [{ type: 'text', text: 'same system' }]
      item.frame.request.messages = [{ role: 'user', content: 'same prompt' }]
    }
    await run(root, [earlier.frame, admitted.frame], opts)
    assert.equal(api.requests.length, 2)
    const { parsed } = report(root, admitted.id)
    assert.equal(parsed.status, 'partial_capture')
    assert.equal(parsed.http_exchanges.length, 0)
    assert.equal(fs.existsSync(path.join(root, `${earlier.id}.jsonl`)), false)
  })

  await t.test('a later unowned undici call is a metadata gap, not another user body', async (t) => {
    const root = temp(t),
      api = await server(t)
    const job = frame(root, 'undici-gap', {
      url: api.url,
      transport: 'undici',
      rounds: 2,
      unownedSecond: true,
      nativeCch: true,
    })
    await run(root, [job.frame], opts)
    const { parsed } = report(root, job.id)
    assert.equal(api.requests.length, 2)
    assert.equal(parsed.http_exchanges.length, 1)
    assert.equal(parsed.status, 'partial_capture')
    assert.ok(parsed.lifecycle.some((event) => event.type === 'correlation_gap'))
  })

  await t.test('pending cloud response has a bounded observation deadline without cancelling inference', async (t) => {
    const root = temp(t),
      api = await server(t, { waves: { first, second, delayMs: 2000 } })
    const job = frame(root, 'undici-deadline', {
      url: api.url,
      transport: 'undici',
      earlyTerminal: true,
      nativeCch: true,
    })
    const file = path.join(root, `${job.id}.ticket`)
    const ticket = JSON.parse(fs.readFileSync(file, 'utf8'))
    ticket.expires_at = Date.now() + 1000
    fs.writeFileSync(file, JSON.stringify(ticket))
    const output = await run(root, [job.frame], opts)
    const { parsed } = report(root, job.id)
    assert.equal(api.requests.length, 1)
    assert.match(output, /kin_job_done/)
    assert.equal(parsed.status, 'partial_capture')
    assert.ok(
      parsed.lifecycle.some((event) => event.type === 'observer_error' && event.code === 'capture_window_expired'),
    )
    assert.ok(parsed.lifecycle.some((event) => event.type === 'trace_end' && event.pending_responses === 1))
  })
})

test('compiled Bun host loads the same preload and preserves per-job identity', {
  skip: !process.env.BUN_BIN,
}, async (t) => {
  const root = temp(t),
    api = await server(t)
  const executable = path.join(root, process.platform === 'win32' ? 'native-host.exe' : 'native-host')
  execFileSync(process.env.BUN_BIN, ['build', host, '--compile', '--outfile', executable], { stdio: 'pipe' })
  const h2 = await server(t, { h2: true })
  const jobs = [frame(root, 'compiled-fetch', { url: api.url, delay: 10, stamp: true })]
  if (process.env.CC_TRACE_TEST_FETCH_ONLY !== '1')
    jobs.push(frame(root, 'compiled-h2', { url: h2.url, transport: 'http2', stamp: true }))
  const output = await run(
    root,
    jobs.map((x) => x.frame),
    { executable, compiled: true },
  )
  for (const job of jobs) {
    const { parsed } = report(root, job.id)
    assert.equal(
      parsed.status,
      'captured',
      JSON.stringify({
        job: job.frame.job_id,
        reason: parsed.reason,
        api: parsed.http_exchanges.map((x) => ({
          transport: x.transport,
          response: x.response.read_complete,
          bytes: x.response.body.bytes_retained,
        })),
        lifecycle: parsed.lifecycle,
      }),
    )
    assert.equal(parsed.runtime.executable_sha256, sha(fs.readFileSync(executable)))
    assert.equal(parsed.http_exchanges[0].response.body.text, sse)
    assert.equal(parsed.job_id, job.frame.job_id)
    assert.equal(
      parsed.stdout_frames.map((x) => x.text).join(''),
      output
        .split('\n')
        .filter((x) => x && JSON.parse(x).job_id === job.frame.job_id)
        .map((x) => x + '\n')
        .join(''),
    )
  }
})
