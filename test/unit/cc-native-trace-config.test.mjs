import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRawDebug } from '../../src/lib/admin/raw-debug.mjs'
import { normalizeLoggingConfig } from '../../src/lib/admin/request-log.mjs'
import { writeKernelConfig } from '../../src/lib/transport/rust-kernel-supervisor.mjs'
import {
  prepareCCNativeTrace,
  CC_TRACE_CONTAINER_BIN,
  ccNativeTraceLauncher,
} from '../../src/lib/transport/cc-native-trace.mjs'
import { CC_TRACE_KEY, CC_TRACE_HOOK } from '../../src/lib/transport/cc-native-trace-hook.mjs'
import { traceProject, writeSimulatedNativeTrace } from '../support/cc-native-trace-files.mjs'

const body = {
  model: 'claude-opus-4-6',
  max_tokens: 128000,
  thinking: { type: 'adaptive', display: 'summarized' },
  output_config: { effort: 'max' },
  system: [{ type: 'text', text: 'caller' }],
  messages: [{ role: 'user', content: 'hi' }],
  metadata: { user_id: 'opaque-identity' },
}

test('native capture setting is strictly opt-in', () => {
  assert.equal(normalizeLoggingConfig({}).cc_native_trace, false)
  assert.equal(normalizeLoggingConfig({ cc_native_trace: 'true' }).cc_native_trace, false)
  assert.equal(normalizeLoggingConfig({ cc_native_trace: true }).cc_native_trace, true)
})

test('only explicitly enabled cc-fixed uses a launcher; disabling restores original bin', (t) => {
  const project = traceProject(t)
  const vm = { id: 'vm-01', dataplane: 'cc-fixed', claude: { mode: 'oauth' } }
  for (const enabled of [false, true, false]) {
    writeKernelConfig(project.root, vm, { routing: { logging: { cc_native_trace: enabled } }, token: 'fixture-token' })
    const config = JSON.parse(fs.readFileSync(path.join(project.run, 'kernel.json')))
    assert.equal(config.dataplane, 'cc')
    assert.equal(config.claude_bin, enabled ? CC_TRACE_CONTAINER_BIN : '/home/kincli/.kin/cc-node-fixed')
  }
  writeKernelConfig(
    project.root,
    { ...vm, dataplane: 'wrap-fixed' },
    { routing: { logging: { cc_native_trace: true } }, token: 'fixture-token' },
  )
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(project.run, 'kernel.json'))).claude_bin,
    '/home/kincli/.kin/cli-node-fixed',
  )
  const script = ccNativeTraceLauncher()
  assert.match(script, /BUN_OPTIONS='--preload \/home\/kincli\/\.kin\/cc-native-trace-preload\.mjs'/)
  assert.match(script, /exec \/home\/kincli\/\.kin\/cc-node-fixed "\$@"/)
})

test('ticket changes only its reserved metadata field, then is collected and erased once', async (t) => {
  const project = traceProject(t)
  const envelope = {
    body: structuredClone(body),
    headers: { fixture: 'preserved' },
    stream: true,
    session_key: 'unchanged-affinity',
  }
  const before = structuredClone(envelope)
  const attempt = prepareCCNativeTrace(
    { projectRoot: project.root, vmId: 'vm-01', requestId: 'server-request' },
    envelope,
  )
  assert.match(attempt.id, /^[a-f0-9]{64}$/)
  assert.deepEqual(envelope, before)
  const clean = structuredClone(attempt.envelope)
  delete clean.body.metadata[CC_TRACE_KEY]
  assert.deepEqual(clean, before)
  writeSimulatedNativeTrace(project, attempt.envelope.body, 'data: {"type":"message_stop"}\n\n')
  const report = await attempt.finish({ waitMs: 0 })
  assert.equal(report.status, 'captured')
  assert.deepEqual(report.cleaned_request, body)
  assert.deepEqual(fs.readdirSync(project.traces), [])
  assert.equal((await attempt.finish()).reason, 'already_collected')
})

test('not-loaded and stale hooks leave the inference envelope untouched', async (t) => {
  const project = traceProject(t)
  const envelope = { body: structuredClone(body) }
  fs.writeFileSync(
    path.join(project.run, 'kernel.json'),
    JSON.stringify({ claude_bin: '/home/kincli/.kin/cc-node-fixed' }),
  )
  let attempt = prepareCCNativeTrace({ projectRoot: project.root, vmId: 'vm-01' }, envelope)
  assert.equal(attempt.envelope, envelope)
  assert.equal((await attempt.finish()).reason, 'cc_preload_not_configured')
  fs.writeFileSync(path.join(project.run, 'kernel.json'), JSON.stringify({ claude_bin: CC_TRACE_CONTAINER_BIN }))
  fs.writeFileSync(path.join(project.home, CC_TRACE_HOOK), 'stale helper')
  attempt = prepareCCNativeTrace({ projectRoot: project.root, vmId: 'vm-01' }, envelope)
  assert.equal(attempt.envelope, envelope)
  assert.equal((await attempt.finish()).reason, 'cc_preload_outdated')
  assert.deepEqual(fs.readdirSync(project.traces), [])
})

test('missing native producer is explicit and its ticket is removed', async (t) => {
  const project = traceProject(t)
  const attempt = prepareCCNativeTrace({ projectRoot: project.root, vmId: 'vm-01' }, { body: structuredClone(body) })
  assert.equal((await attempt.finish({ waitMs: 0 })).reason, 'native_trace_not_observed')
  assert.deepEqual(fs.readdirSync(project.traces), [])
})

test('an observed native job can finish after the kernel response without losing its late body', async (t) => {
  const project = traceProject(t)
  const attempt = prepareCCNativeTrace({ projectRoot: project.root, vmId: 'vm-01' }, { body: structuredClone(body) })
  writeSimulatedNativeTrace(project, attempt.envelope.body, 'LATE_NATIVE_RESPONSE')
  const file = path.join(project.traces, `${attempt.id}.jsonl`)
  const done = path.join(project.traces, `${attempt.id}.done`)
  const completeBytes = fs.readFileSync(file)
  const completion = fs.readFileSync(done)
  fs.unlinkSync(done)
  fs.writeFileSync(file, completeBytes.subarray(0, completeBytes.indexOf(Buffer.from('"type":"api_response_body"'))))
  const completed = new Promise((resolve) =>
    setTimeout(() => {
      fs.writeFileSync(file, completeBytes)
      fs.writeFileSync(done, completion)
      resolve()
    }, 80),
  )
  const report = await attempt.finish({ waitMs: 5, waitForTerminal: true })
  await completed
  assert.equal(report.status, 'captured')
  assert.equal(report.http_exchanges[0].response.body.text, 'LATE_NATIVE_RESPONSE')
  assert.deepEqual(fs.readdirSync(project.traces), [])
})

test('waiting for an active native job remains client-cancellable', async (t) => {
  const project = traceProject(t)
  const attempt = prepareCCNativeTrace({ projectRoot: project.root, vmId: 'vm-01' }, { body: structuredClone(body) })
  writeSimulatedNativeTrace(project, attempt.envelope.body, 'partial')
  fs.unlinkSync(path.join(project.traces, `${attempt.id}.done`))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60)
  t.after(() => clearTimeout(timer))
  const report = await attempt.finish({ waitMs: 5, waitForTerminal: true, signal: controller.signal })
  assert.equal(controller.signal.aborted, true)
  assert.notEqual(report.status, 'captured')
  assert.deepEqual(fs.readdirSync(project.traces), [])
})

for (const expired of [false, true])
  test(`default native wait respects the admission deadline (already expired=${expired})`, async (t) => {
    const project = traceProject(t)
    const attempt = prepareCCNativeTrace(
      { projectRoot: project.root, vmId: 'vm-01', timeoutMs: 80 },
      { body: structuredClone(body) },
    )
    writeSimulatedNativeTrace(project, attempt.envelope.body, 'unfinished')
    fs.unlinkSync(path.join(project.traces, `${attempt.id}.done`))
    if (expired) await new Promise((resolve) => setTimeout(resolve, 150))
    const started = performance.now()
    const report = await attempt.finish({ waitForTerminal: true })
    assert.ok(performance.now() - started < 500, 'must not grant a fresh one-second window')
    assert.notEqual(report.status, 'captured')
    assert.deepEqual(fs.readdirSync(project.traces), [])
  })

test('missing producer does not acquire an extended native wait', async (t) => {
  const project = traceProject(t)
  const attempt = prepareCCNativeTrace({ projectRoot: project.root, vmId: 'vm-01' }, { body: structuredClone(body) })
  assert.equal((await attempt.finish({ waitMs: 0, waitForTerminal: true })).reason, 'native_trace_not_observed')
  assert.deepEqual(fs.readdirSync(project.traces), [])
})

test('linked files are refused and a false completion byte count stays partial', async (t) => {
  const project = traceProject(t)
  const first = prepareCCNativeTrace({ projectRoot: project.root, vmId: 'vm-01' }, { body: structuredClone(body) })
  writeSimulatedNativeTrace(project, first.envelope.body, 'data: {}\n\n')
  const file = path.join(project.traces, `${first.id}.jsonl`)
  const other = path.join(project.root, 'linked-evidence')
  fs.linkSync(file, other)
  assert.equal((await first.finish({ waitMs: 0 })).status, 'unavailable')
  assert.ok(fs.existsSync(other))
  const second = prepareCCNativeTrace({ projectRoot: project.root, vmId: 'vm-01' }, { body: structuredClone(body) })
  writeSimulatedNativeTrace(project, second.envelope.body, 'data: {}\n\n')
  fs.writeFileSync(
    path.join(project.traces, `${second.id}.done`),
    JSON.stringify({ id: second.id, complete: true, bytes: 1 }),
  )
  assert.equal((await second.finish({ waitMs: 0 })).status, 'partial_capture')
  assert.deepEqual(fs.readdirSync(project.traces), [])
})

test('a partial native capture does not masquerade as complete Node-only capture', () => {
  const collector = createRawDebug('{}', 2)
  try {
    const hop = collector.beginHop('node_kernel', {}, '{}')
    hop.startResponse({ statusCode: 200, headers: { 'content-type': 'application/json' } })
    hop.chunk(Buffer.from('{}'))
    hop.endRead(true, {})
    hop.outcome({ ok: true, body: {}, terminalState: 'verified' })
    hop.nativeTrace({ status: 'unavailable', reason: 'cc_preload_not_configured' })
    assert.equal(collector.settle({ clientComplete: true }).status, 'partial_capture')
  } finally {
    collector.release()
  }
})
