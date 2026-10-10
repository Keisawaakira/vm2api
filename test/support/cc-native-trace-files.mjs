// Synthetic filesystem/producer boundary for Node integration tests, not native execution.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fixedDataplaneSpec, CC_FIXED_ID } from '../../src/lib/vm/wrap-fixed.mjs'
import { installCCNativeTraceFiles, CC_TRACE_CONTAINER_BIN } from '../../src/lib/transport/cc-native-trace.mjs'
import {
  CC_TRACE_VERSION,
  CC_TRACE_KEY,
  CC_TRACE_DIR,
  CC_TRACE_HOOK,
} from '../../src/lib/transport/cc-native-trace-hook.mjs'
const sha = (data) => crypto.createHash('sha256').update(data).digest('hex')

export function traceProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-trace-bridge-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const release = path.join(root, 'share', fixedDataplaneSpec('cc-fixed').directory)
  const home = path.join(root, 'vms', 'vm-01', 'cli-home', '.kin')
  const run = path.join(root, 'vms', 'vm-01', 'run')
  fs.mkdirSync(release, { recursive: true })
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(run, { recursive: true })
  const elf = Buffer.alloc(128, 7)
  elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1])
  elf.writeUInt16LE(62, 18)
  const cliHash = sha(elf)
  const artifact = (file) => ({
    file,
    bytes: elf.length,
    sha256: cliHash,
    unpacked_sha256: cliHash,
    validations: { exact_unpack_roundtrip: true },
  })
  const manifest = {
    version: 1,
    id: CC_FIXED_ID,
    dataplane: 'cc-fixed',
    cache_contract: fixedDataplaneSpec('cc-fixed').cacheContract,
    native_lifecycle_contract: fixedDataplaneSpec('cc-fixed').lifecycleContract,
    classifier_contract: fixedDataplaneSpec('cc-fixed').classifierContract,
    native_wire_contract: fixedDataplaneSpec('cc-fixed').wireContract,
    request_wire_contract: fixedDataplaneSpec('cc-fixed').requestContract,
    session_contract: fixedDataplaneSpec('cc-fixed').sessionContract,
    status: 'owner_approved',
    production_approved: true,
    local_validation: { completed: true },
    kernel: artifact('kin-kernel.bin'),
    artifacts: { 'cc-node': artifact('cc-node') },
  }
  fs.writeFileSync(path.join(release, 'manifest.json'), JSON.stringify(manifest))
  for (const file of ['cc-node', 'kin-kernel.bin']) fs.writeFileSync(path.join(release, file), elf)
  fs.writeFileSync(path.join(home, 'cc-node-fixed'), elf)
  fs.writeFileSync(path.join(run, 'kernel.json'), JSON.stringify({ claude_bin: CC_TRACE_CONTAINER_BIN }))
  const traces = installCCNativeTraceFiles(home)
  return { root, home, run, traces, cliHash }
}

export function writeSimulatedNativeTrace(project, request, sse, { wrongHash = false, complete = true } = {}) {
  const id = request.metadata?.[CC_TRACE_KEY]
  if (typeof id !== 'string') throw Error('Expected server trace nonce')
  const ticket = JSON.parse(fs.readFileSync(path.join(project.traces, `${id}.ticket`), 'utf8'))
  const clean = structuredClone(request)
  delete clean.metadata[CC_TRACE_KEY]
  const rows = [
    {
      type: 'trace_start',
      version: CC_TRACE_VERSION,
      id,
      job_id: 'job-fixture',
      slot_id: 's0',
      request_id: ticket.request_id,
      hook_sha256: sha(fs.readFileSync(path.join(project.home, CC_TRACE_HOOK))),
      runtime: { executable_sha256: wrongHash ? '0'.repeat(64) : project.cliHash, pid: 123 },
    },
    {
      type: 'native_input',
      text: JSON.stringify({ type: 'kin_job_start', job_id: 'job-fixture', slot_id: 's0', request }),
    },
    { type: 'native_request_cleaned', request: clean },
    {
      type: 'api_request',
      api: 1,
      transport: 'fixture',
      method: 'POST',
      url: 'http://local-fixture/v1/messages',
      headers: { authorization: 'MUST_NOT_EXPORT_HEADER' },
      response_content_decoded: true,
    },
    {
      type: 'api_request_body',
      api: 1,
      bytes: Buffer.byteLength(JSON.stringify(clean)),
      b64: Buffer.from(JSON.stringify(clean)).toString('base64'),
    },
    {
      type: 'api_response',
      api: 1,
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'set-cookie': 'MUST_NOT_EXPORT_HEADER' },
    },
    { type: 'api_response_body', api: 1, bytes: Buffer.byteLength(sse), b64: Buffer.from(sse).toString('base64') },
    { type: 'api_end', api: 1, complete },
    { type: 'native_stdout', text: JSON.stringify({ type: 'kin_job_done', job_id: 'job-fixture' }) + '\n' },
    { type: 'native_terminal', reason: 'kin_job_done' },
    {
      type: 'trace_end',
      id,
      api_calls: 1,
      dropped_records: 0,
      pending_responses: complete ? 0 : 1,
      producer_error: false,
      observation_grace_ms: 0,
    },
  ].map((row, n) => ({ n: n + 1, at: Date.now(), ...row }))
  const text = rows.map((row) => JSON.stringify(row) + '\n').join('')
  fs.renameSync(path.join(project.traces, `${id}.ticket`), path.join(project.traces, `${id}.claimed`))
  fs.writeFileSync(path.join(project.traces, `${id}.jsonl`), text, { mode: 0o600 })
  fs.writeFileSync(
    path.join(project.traces, `${id}.done`),
    JSON.stringify({ id, complete, bytes: Buffer.byteLength(text) }),
    { mode: 0o600 },
  )
  return { id, clean }
}
