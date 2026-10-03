import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import * as native from '../../src/lib/transport/cc-native-trace.mjs'
import { CC_TRACE_HOOK } from '../../src/lib/transport/cc-native-trace-hook.mjs'
import { traceProject } from '../support/cc-native-trace-files.mjs'

function runtime(project, extra = {}) {
  return {
    version: 1,
    pid: 42,
    started_at: Date.now() - 1000,
    updated_at: Date.now(),
    hook_sha256: crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(project.home, CC_TRACE_HOOK)))
      .digest('hex'),
    bun: '1.3.14',
    stage: 'native_host_ready',
    native_host_ready: true,
    stdin_chunks: 1,
    stdin_lines: 1,
    native_jobs: 1,
    jobs_with_trace_id: 0,
    admitted_jobs: 0,
    last_ticket_status: 'missing_nonce',
    disable_nonstreaming_fallback: true,
    ...extra,
  }
}
const read = (project, options = {}) => native.readCCNativeTraceReadiness(project.root, 'vm-01', options)

test('written kernel configuration alone is not running-preload evidence', (t) => {
  const project = traceProject(t)
  const status = read(project, { cliPid: 42 })
  assert.equal(status.configured, true)
  assert.equal(status.state, 'preload_not_observed')
})

test('readiness matches the live CLI pid and current hook, not a stale process', (t) => {
  const project = traceProject(t)
  fs.writeFileSync(path.join(project.traces, 'runtime-42.json'), JSON.stringify(runtime(project)))
  assert.equal(read(project, { cliPid: 42 }).state, 'ready')
  assert.equal(read(project, { cliPid: 99 }).state, 'restart_required')
  assert.equal(read(project).state, 'observed_unverified_process')
  fs.writeFileSync(
    path.join(project.traces, 'runtime-42.json'),
    JSON.stringify(runtime(project, { hook_sha256: '0'.repeat(64) })),
  )
  assert.equal(read(project, { cliPid: 42 }).state, 'restart_required')
})

test('readiness exposes bounded counters and never arbitrary snapshot fields', (t) => {
  const project = traceProject(t)
  fs.writeFileSync(
    path.join(project.traces, 'runtime-42.json'),
    JSON.stringify(runtime(project, { body: 'DO_NOT_EXPORT_BODY', authorization: 'DO_NOT_EXPORT_AUTH' })),
  )
  const status = read(project, { cliPid: 42 })
  assert.equal(status.processes[0].native_jobs, 1)
  assert.equal(status.processes[0].last_ticket_status, 'missing_nonce')
  assert.equal(status.processes[0].disable_nonstreaming_fallback, true)
  assert.doesNotMatch(JSON.stringify(status), /DO_NOT_EXPORT/)
})

test('VM detail exposes readiness using the live kernel PID without a model request', async (t) => {
  const { buildVmDetail } = await import('../../src/lib/admin/panel-api.mjs')
  const project = traceProject(t)
  fs.writeFileSync(
    path.join(project.root, 'vms', 'vm-01.json'),
    JSON.stringify({ id: 'vm-01', status: 'stopped', dataplane: 'cc-fixed', claude: {} }),
  )
  fs.writeFileSync(path.join(project.traces, 'runtime-42.json'), JSON.stringify(runtime(project)))
  const response = await buildVmDetail({
    cfg: { paths: { project: project.root } },
    id: 'vm-01',
    accountQuota: { accounts: {} },
    routingConfig: { logging: { mode: 'normal', raw_nonstream_debug: true, cc_native_trace: true } },
    kernelHealth: async () => ({ reachable: true, cli_pid: 42 }),
    slotProcessStatus: async () => ({}),
  })
  assert.equal(response.ok, true)
  assert.equal(response.data.kernel.cc_native_trace.state, 'ready')
  assert.equal(response.data.kernel.cc_native_trace.enabled, true)
  assert.equal(
    response.data.kernel.cc_native_trace.raw_enabled,
    true,
    'per-key effective Debug can override normal mode',
  )
})

test('unavailable raw trace includes pending-ticket/readiness diagnostics without guessing API data', async (t) => {
  const project = traceProject(t)
  fs.writeFileSync(path.join(project.traces, 'runtime-42.json'), JSON.stringify(runtime(project)))
  const attempt = native.prepareCCNativeTrace(
    { projectRoot: project.root, vmId: 'vm-01' },
    { body: { metadata: {}, messages: [] } },
  )
  const report = await attempt.finish({ waitMs: 0 })
  assert.equal(report.status, 'unavailable')
  assert.equal(report.reason, 'native_trace_not_observed')
  assert.equal(report.diagnostics.ticket_state, 'pending')
  assert.equal(report.diagnostics.readiness.processes[0].last_ticket_status, 'missing_nonce')
  assert.equal(report.http_exchanges, undefined)
  assert.deepEqual(fs.readdirSync(project.traces), ['runtime-42.json'])
})
