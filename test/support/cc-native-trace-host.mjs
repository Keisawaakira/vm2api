// No provider services: the parent supplies a loopback fixture URL.
import { createInterface } from 'node:readline'
import { connect } from 'node:http2'
import { officialH2Fetch } from './cc-native-undici-selector.mjs'
import { stampCchBody } from './cc-native-cch.mjs'
const tasks = new Map()
const output = (frame) => process.stdout.write(JSON.stringify(frame) + '\n')
async function readH2(url, body, signal) {
  const target = new URL(url)
  const session = connect(target.origin)
  try {
    return await new Promise((resolve, reject) => {
      const chunks = []
      const stream = session.request({
        ':method': 'POST',
        ':path': target.pathname,
        authorization: 'Bearer DO_NOT_LOG_AUTH',
        cookie: 'DO_NOT_LOG_COOKIE',
        'content-type': 'application/json',
      })
      stream.on('error', reject)
      stream.on('data', (chunk) => chunks.push(chunk))
      stream.on('end', () => resolve(Buffer.concat(chunks)))
      signal.addEventListener('abort', () => stream.close(), { once: true })
      stream.write(body.slice(0, 17))
      stream.end(body.slice(17))
    })
  } finally {
    session.close()
  }
}
async function runJob(frame, abort) {
  const request = frame.request
  const fixture = request.fixture || {}
  if (fixture.delay) await new Promise((resolve) => setTimeout(resolve, fixture.delay))
  const payload = {
    model: request.model,
    system: fixture.nativeCch
      ? [
          { type: 'text', text: 'x-anthropic-billing-header: cc_version=fixture; cch=00000;' },
          ...(request.system || []),
        ]
      : request.system,
    messages: request.messages,
    thinking: request.thinking,
    output_config: request.output_config,
    max_tokens: request.max_tokens,
    stream: true,
  }
  let body = fixture.prebuiltBody ?? JSON.stringify(payload)
  if (fixture.stamp) {
    // Generic object reserialization control. Native CCH uses the literal replacement below.
    const stamped = JSON.parse(body)
    stamped.system.unshift({ type: 'text', text: 'fixture attribution cch=012345' })
    body = JSON.stringify(stamped)
  }
  if (fixture.zeroCchForTest) body = body.replace('cch=00000', 'cch=00000')
  else if (fixture.nativeCch) body = stampCchBody(body)
  if (fixture.extraSerializations) {
    for (let n = 0; n < fixture.extraSerializations; n++) JSON.stringify({ ...payload, nonce: n })
  }
  if (fixture.afterSerializeDelay) await new Promise((resolve) => setTimeout(resolve, fixture.afterSerializeDelay))
  let earlyTerminal = false
  try {
    if (fixture.authProbe)
      await fetch(fixture.url.replace('/v1/messages', '/oauth/token'), {
        method: 'POST',
        body: 'DO_NOT_LOG_REFRESH_TOKEN',
        signal: abort.signal,
      })
    for (let round = 0; round < (fixture.rounds || 1); round++) {
      if (round > 0 && fixture.unownedSecond) {
        body = JSON.stringify({ ...payload, messages: [{ role: 'user', content: 'fresh unowned second request' }] })
        if (fixture.nativeCch) body = stampCchBody(body)
      }
      let reply
      if (fixture.transport === 'http2') reply = await readH2(fixture.url, body, abort.signal)
      else {
        const fetcher = fixture.transport === 'undici' ? officialH2Fetch() : globalThis.fetch
        if (!fetcher) throw Error('fixture_undici_not_selected')
        const response = await fetcher(fixture.url, {
          method: 'POST',
          headers: {
            authorization: 'Bearer DO_NOT_LOG_AUTH',
            cookie: 'DO_NOT_LOG_COOKIE',
            'content-type': 'application/json',
          },
          body: fixture.bytesBody ? new TextEncoder().encode(body) : body,
          signal: abort.signal,
        })
        if (fixture.read === 'json') {
          const parsed = await response.json()
          output({ type: 'kin_stream_event', job_id: frame.job_id, slot_id: frame.slot_id, event: parsed })
          continue
        }
        if (fixture.read === 'text') reply = Buffer.from(await response.text())
        else if (fixture.read === 'iterator') {
          const chunks = []
          for await (const chunk of response.body) chunks.push(Buffer.from(chunk))
          reply = Buffer.concat(chunks)
        } else {
          const reader = response.body.getReader(),
            chunks = []
          const decoder = new TextDecoder()
          let pending = '',
            firstStop = false
          for (;;) {
            const next = await reader.read()
            if (next.done) break
            chunks.push(Buffer.from(next.value))
            if (fixture.earlyTerminal || fixture.stopAtFirstStop) {
              pending += decoder.decode(next.value, { stream: true })
              let split
              while ((split = pending.indexOf('\n')) >= 0) {
                const line = pending.slice(0, split)
                pending = pending.slice(split + 1)
                if (!line.startsWith('data: ') || firstStop) continue
                const event = JSON.parse(line.slice(6))
                output({ type: 'kin_stream_event', job_id: frame.job_id, slot_id: frame.slot_id, event })
                if (event.type === 'message_stop') {
                  firstStop = true
                  if (fixture.earlyTerminal) {
                    earlyTerminal = true
                    output({ type: 'kin_job_done', job_id: frame.job_id, slot_id: frame.slot_id })
                  }
                }
              }
            }
            if (fixture.cancelRead || (fixture.stopAtFirstStop && firstStop)) {
              await reader.cancel()
              break
            }
          }
          reply = Buffer.concat(chunks)
        }
      }
      if (fixture.transport === 'http2' && fixture.compressed) {
        // Decoder belongs to the simulated application, not the observer.
        const { gunzipSync } = await import('node:zlib')
        reply = gunzipSync(reply)
      }
      if (!fixture.earlyTerminal && !fixture.stopAtFirstStop && (!fixture.emitFirstOnly || round === 0))
        for (const line of reply.toString('utf8').split('\n')) {
          if (!line.startsWith('data: ')) continue
          try {
            output({
              type: 'kin_stream_event',
              job_id: frame.job_id,
              slot_id: frame.slot_id,
              event: JSON.parse(line.slice(6)),
            })
          } catch {}
        }
    }
    if (!earlyTerminal) output({ type: 'kin_job_done', job_id: frame.job_id, slot_id: frame.slot_id })
  } catch (error) {
    output({ type: 'kin_job_error', job_id: frame.job_id, slot_id: frame.slot_id, error: error.name })
  }
}
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const frame = JSON.parse(line)
  if (frame.type === 'kin_job_start') {
    const abort = new AbortController()
    tasks.set(frame.job_id, { abort, task: runJob(frame, abort) })
  } else if (frame.type === 'kin_cancel') tasks.get(frame.job_id)?.abort.abort()
}
await Promise.all([...tasks.values()].map((x) => x.task))
// Native hosts normally stay alive with stdin open; preserve the observer grace
// in this finite, no-provider executable fixture too.
await new Promise((resolve) => setTimeout(resolve, 500))
