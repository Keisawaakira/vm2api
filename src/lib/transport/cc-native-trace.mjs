import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { isDeepStrictEqual } from 'node:util'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { isValidVmId } from '../vm/vm-file.mjs'
import { readFixedRelease } from '../vm/wrap-fixed.mjs'
import {
  CC_TRACE_VERSION,
  CC_TRACE_KEY,
  CC_TRACE_DIR,
  CC_TRACE_LAUNCHER,
  CC_TRACE_HOOK,
  CC_TRACE_PRELOAD,
  CC_TRACE_MAX_BYTES,
  validTraceId,
  traceHeaders,
  nativeFrameKind,
} from './cc-native-trace-hook.mjs'

export const CC_TRACE_CONTAINER_BIN = `/home/kincli/.kin/${CC_TRACE_LAUNCHER}`
const hookFile = fileURLToPath(new URL('./cc-native-trace-hook.mjs', import.meta.url))
const preloadFile = fileURLToPath(new URL('./cc-native-trace-preload.mjs', import.meta.url))
const noFollow = fs.constants.O_NOFOLLOW || 0
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const safeCode = (error) => String(error?.code || error?.name || 'trace_error').slice(0, 100)
const traceSuffixes = ['ticket', 'claimed', 'jsonl', 'done', 'reused']

export function ccNativeTraceEnabled(dataplane, routing) {
  return dataplane === 'cc-fixed' && routing?.logging?.cc_native_trace === true
}
/** Metadata-only readiness; configuration is not proof the running CLI loaded it. */
export function readCCNativeTraceReadiness(projectRoot, vmId, { cliPid } = {}) {
  const result = { configured: false, state: 'disabled', processes: [] }
  if (!projectRoot || !isValidVmId(String(vmId || ''))) return result
  const home = path.join(projectRoot, 'vms', vmId, 'cli-home', '.kin')
  const root = path.join(home, CC_TRACE_DIR)
  let dir
  try {
    const config = JSON.parse(boundedFile(path.join(projectRoot, 'vms', vmId, 'run', 'kernel.json'), 65536))
    result.configured = config.claude_bin === CC_TRACE_CONTAINER_BIN
    if (!result.configured) return result
    result.state = 'preload_not_observed'
    const st = fs.lstatSync(root)
    if (
      !st.isDirectory() ||
      st.isSymbolicLink() ||
      fs.realpathSync(root) !== path.join(fs.realpathSync(home), CC_TRACE_DIR)
    )
      return result
    const expectedHook = hash(fs.readFileSync(hookFile))
    dir = fs.opendirSync(root)
    const counter = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0)
    for (let scanned = 0; scanned < 128; scanned++) {
      const item = dir.readSync()
      if (!item) break
      const match = /^runtime-(\d+)\.json$/.exec(item.name)
      if (!match || result.processes.length >= 16) continue
      try {
        const row = JSON.parse(boundedFile(path.join(root, item.name), 8192))
        if (row.version !== CC_TRACE_VERSION || row.pid !== Number(match[1])) continue
        result.processes.push({
          pid: row.pid,
          started_at: counter(row.started_at),
          updated_at: counter(row.updated_at),
          hook_current: row.hook_sha256 === expectedHook,
          native_host_ready: row.native_host_ready === true,
          stdin_chunks: counter(row.stdin_chunks),
          stdin_lines: counter(row.stdin_lines),
          native_jobs: counter(row.native_jobs),
          jobs_with_trace_id: counter(row.jobs_with_trace_id),
          admitted_jobs: counter(row.admitted_jobs),
          last_ticket_status: ['missing_nonce', 'not_claimed', 'claimed'].includes(row.last_ticket_status)
            ? row.last_ticket_status
            : null,
          last_error_code: /^[A-Za-z][A-Za-z0-9_]{1,40}$/.test(row.last_error_code || '') ? row.last_error_code : null,
          disable_nonstreaming_fallback: row.disable_nonstreaming_fallback === true,
        })
      } catch {}
    }
    const pid = Number(cliPid)
    result.processes.sort((a, b) => Number(b.pid === pid) - Number(a.pid === pid) || b.updated_at - a.updated_at)
    result.processes = result.processes.slice(0, 4)
    const matching = result.processes.find((row) => row.pid === pid)
    if (Number.isInteger(pid) && pid > 0) {
      if (matching?.hook_current && matching.native_host_ready) result.state = 'ready'
      else if (result.processes.length) result.state = 'restart_required'
    } else if (result.processes.some((row) => row.hook_current && row.native_host_ready))
      result.state = 'observed_unverified_process'
    return result
  } catch {
    return result
  } finally {
    try {
      dir?.closeSync()
    } catch {}
  }
}

export function ccNativeTraceLauncher() {
  return `#!/bin/sh\nset -eu\ncase "\${BUN_OPTIONS:-}" in\n  ''|'--preload /home/kincli/.kin/${CC_TRACE_PRELOAD}') ;;\n  *) echo 'CC trace refuses incompatible BUN_OPTIONS' >&2; exit 64 ;;\nesac\nexport VM2API_CC_TRACE_ROOT='/home/kincli/.kin/${CC_TRACE_DIR}'\nexport BUN_OPTIONS='--preload /home/kincli/.kin/${CC_TRACE_PRELOAD}'\nexec /home/kincli/.kin/cc-node-fixed "$@"\n`
}
function writeAtomic(file, data, mode) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  try {
    fs.writeFileSync(tmp, data, { flag: 'wx', mode })
    fs.renameSync(tmp, file)
    fs.chmodSync(file, mode)
  } finally {
    try {
      fs.unlinkSync(tmp)
    } catch {}
  }
}
/** Installs code only; the ordinary fixed binary/config is never changed here. */
export function installCCNativeTraceFiles(dest) {
  fs.mkdirSync(dest, { recursive: true })
  const sources = [
    [CC_TRACE_HOOK, fs.readFileSync(hookFile)],
    [CC_TRACE_PRELOAD, fs.readFileSync(preloadFile)],
    [CC_TRACE_LAUNCHER, Buffer.from(ccNativeTraceLauncher())],
  ]
  for (const [name, bytes] of sources) {
    const file = path.join(dest, name)
    let equal = false
    try {
      equal = !fs.lstatSync(file).isSymbolicLink() && fs.readFileSync(file).equals(bytes)
    } catch {}
    if (!equal) writeAtomic(file, bytes, 0o755)
  }
  const root = path.join(dest, CC_TRACE_DIR)
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('Native trace root must not be a symlink')
  fs.chmodSync(root, 0o700)
  if (process.platform !== 'win32') {
    const owner = fs.statSync(dest)
    fs.chownSync(root, owner.uid, owner.gid)
  }
  cleanExpired(root)
  return root
}
function boundedFile(file, max) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow)
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > max)
      throw Object.assign(new Error('Invalid trace file'), { code: 'trace_file_limit' })
    const chunks = []
    let read,
      total = 0
    const block = Buffer.allocUnsafe(Math.min(max + 1, 65536))
    while ((read = fs.readSync(fd, block, 0, Math.min(block.length, max + 1 - total), null))) {
      total += read
      if (total > max) throw Object.assign(new Error('Trace file grew beyond limit'), { code: 'trace_file_limit' })
      chunks.push(Buffer.from(block.subarray(0, read)))
    }
    return Buffer.concat(chunks)
  } finally {
    fs.closeSync(fd)
  }
}
function cleanupTicket(root, id) {
  if (!validTraceId(id)) return
  for (const suffix of traceSuffixes)
    try {
      fs.unlinkSync(path.join(root, `${id}.${suffix}`))
    } catch {}
}
function cleanExpired(root) {
  let dir
  try {
    dir = fs.opendirSync(root)
    for (let count = 0; count < 128; count++) {
      const item = dir.readSync()
      if (!item) break
      if (!/^(?:[a-f0-9]{64}\.(?:ticket|claimed|jsonl|done|reused)|runtime-\d+\.json)$/.test(item.name)) continue
      const file = path.join(root, item.name)
      if (fs.lstatSync(file).mtimeMs < Date.now() - 2 * 3600_000)
        try {
          fs.unlinkSync(file)
        } catch {}
    }
  } catch {
  } finally {
    try {
      dir?.closeSync()
    } catch {}
  }
}
function asBody(chunks, { encoded = false, headers = {} } = {}) {
  const data = Buffer.concat(chunks)
  const base = { bytes_retained: data.length, sha256: hash(data) }
  const text = data.toString('utf8')
  const utf8 = Buffer.from(text).equals(data)
  const body = utf8
    ? { ...base, encoding: 'utf8', text }
    : { ...base, encoding: 'base64', b64: data.toString('base64') }
  const encoding = String(headers['content-encoding'] || '').toLowerCase()
  if (encoded && encoding && encoding !== 'identity') {
    // Preserve compressed bytes; a separately labeled bounded view is for inspection.
    body.encoding = 'base64'
    body.b64 = data.toString('base64')
    delete body.text
    try {
      let decoded = data
      for (const name of encoding
        .split(',')
        .map((s) => s.trim())
        .reverse()) {
        const fn = { gzip: zlib.gunzipSync, br: zlib.brotliDecompressSync, deflate: zlib.inflateSync }[name]
        if (!fn) throw Error('unsupported_content_encoding')
        decoded = fn(decoded, { maxOutputLength: CC_TRACE_MAX_BYTES })
      }
      const decodedText = decoded.toString('utf8')
      if (!Buffer.from(decodedText).equals(decoded)) throw Error('invalid_utf8')
      body.decoded = { text: decodedText, bytes: decoded.length, source: 'content_decoded_from_captured_bytes' }
    } catch (error) {
      body.decode_error = safeCode(error)
    }
  }
  return body
}

function validatedTraceRows(text, id) {
  const rows = [],
    issues = [],
    seenApis = new Map(),
    ambiguousApis = new Set()
  let malformed = 0,
    last = 0,
    offset = 0,
    lines = 0
  const issue = (code) => {
    malformed++
    if (issues.length < 32) issues.push(code)
  }
  while (offset < text.length) {
    if (++lines > 40000) {
      issue('record_limit')
      break
    }
    let end = text.indexOf('\n', offset)
    if (end < 0) end = text.length
    const line = text.slice(offset, end)
    offset = end + 1
    if (!line) continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      issue('invalid_json')
      continue
    }
    if (!row || typeof row !== 'object' || !Number.isSafeInteger(row.n) || row.n <= last) {
      issue('duplicate_or_invalid_sequence')
      continue
    }
    if (row.n !== last + 1) issue('sequence_gap')
    last = row.n
    if (row.type === 'api_request') {
      if (!Number.isSafeInteger(row.api) || row.api < 1 || seenApis.has(row.api)) {
        issue('duplicate_or_invalid_api')
        ambiguousApis.add(row.api)
        continue
      }
      seenApis.set(row.api, { response: false, ended: false })
    } else if (row.api != null) {
      const api = seenApis.get(row.api)
      if (!api || ambiguousApis.has(row.api)) {
        issue('unmatched_api_record')
        continue
      }
      if (row.type === 'api_response') {
        if (api.response) {
          issue('duplicate_api_response')
          continue
        }
        api.response = true
      }
      if (row.type === 'api_end') {
        if (api.ended) {
          issue('duplicate_api_end')
          continue
        }
        api.ended = true
      } else if (api.ended && ['api_response_body', 'api_parsed_response', 'api_decoded_text'].includes(row.type)) {
        issue('body_after_api_end')
        continue
      }
    }
    rows.push(row)
  }
  const ofType = (type) => rows.filter((row) => row.type === type)
  const starts = ofType('trace_start'),
    ends = ofType('trace_end')
  const inputs = ofType('native_input'),
    cleaned = ofType('native_request_cleaned')
  const terminals = ofType('native_terminal'),
    outputs = ofType('native_stdout')
  const start = starts[0],
    end = ends[0]
  if (!validTraceId(id) || typeof start?.job_id !== 'string' || !start.job_id || start.job_id.length > 256)
    issue('native_identity')
  if (starts.length !== 1 || rows[0] !== start || ends.length !== 1 || rows.at(-1) !== end) issue('trace_lifecycle')
  if (inputs.length !== 1 || cleaned.length !== 1 || !outputs.length || terminals.length !== 1)
    issue('native_evidence_missing')
  try {
    const input = JSON.parse(inputs[0].text)
    if (
      nativeFrameKind(input.type) !== 'job_start' ||
      input.job_id !== start.job_id ||
      input.request?.metadata?.[CC_TRACE_KEY] !== id
    )
      throw Error('binding')
    delete input.request.metadata[CC_TRACE_KEY]
    if (!isDeepStrictEqual(input.request, cleaned[0].request)) throw Error('cleaned')
    let terminalSeen = false
    for (const output of outputs) {
      const frame = JSON.parse(output.text)
      if (frame.job_id !== start.job_id) throw Error('stdout_owner')
      if (frame.type === terminals[0]?.reason) terminalSeen = true
    }
    if (!terminalSeen) throw Error('terminal')
  } catch {
    issue('native_binding_or_terminal')
  }
  if (
    !end ||
    end.id !== id ||
    !Number.isSafeInteger(end.api_calls) ||
    end.api_calls < 0 ||
    end.api_calls !== seenApis.size ||
    [...seenApis.keys()].some((api) => api > end.api_calls)
  )
    issue('api_count_mismatch')
  if (
    !end ||
    !Number.isSafeInteger(end.dropped_records) ||
    !Number.isSafeInteger(end.pending_responses) ||
    typeof end.producer_error !== 'boolean'
  )
    issue('incomplete_end_metadata')
  for (const api of seenApis.values()) {
    if (!api.ended) issue('api_end_missing')
    if (!api.response) issue('api_response_missing')
  }
  if (!seenApis.size && !['job_error', 'cancel_ack'].includes(nativeFrameKind(terminals[0]?.reason)))
    issue('zero_api_success_unverified')
  return { rows, malformed, issues }
}

/** Parse only bounded sidecar records; never read paths supplied in their JSON. */
export function parseCCNativeTrace(
  text,
  { id, done = false, reused = false, expectedImageHashes = [], expectedHookHash } = {},
) {
  const validated = validatedTraceRows(text, id)
  const rows = validated.rows
  let malformed = validated.malformed
  const start = rows.find((row) => row.type === 'trace_start')
  if (!start || start.id !== id || start.version !== CC_TRACE_VERSION)
    return { status: 'invalid_trace', reason: 'identity_mismatch' }
  if (expectedHookHash && start.hook_sha256 !== expectedHookHash)
    return { status: 'invalid_trace', reason: 'hook_hash_mismatch' }
  const image = start.runtime?.executable_sha256
  if (expectedImageHashes.length && !expectedImageHashes.includes(image))
    return { status: 'invalid_trace', reason: 'runtime_image_mismatch', runtime: start.runtime }
  const end = rows.find((row) => row.type === 'trace_end' && row.id === id)
  const apis = new Map(),
    stdout = [],
    lifecycle = []
  let nativeInput, cleaned
  for (const row of rows) {
    if (row.type === 'native_input' && typeof row.text === 'string') nativeInput = { text: row.text }
    else if (row.type === 'native_request_cleaned') cleaned = row.request
    else if (row.type === 'native_stdout' && typeof row.text === 'string')
      stdout.push({ n: row.n, at: row.at, text: row.text })
    else if (row.type === 'api_request')
      apis.set(row.api, {
        index: row.api,
        transport: row.transport,
        after_terminal: row.after_terminal === true,
        request: { method: row.method, url: row.url, headers: traceHeaders(row.headers) },
        response: {
          read_complete: false,
          observation_layer: row.transport === 'http2' ? 'http2_stream_events' : 'sdk_response_consumer',
        },
        timeline: { request: { n: row.n, at: row.at } },
        requestChunks: [],
        responseChunks: [],
        contentDecoded: row.response_content_decoded === true,
      })
    else if (row.api != null && apis.has(row.api)) {
      const api = apis.get(row.api)
      if (row.type === 'api_request_body' || row.type === 'api_response_body') {
        if (typeof row.b64 !== 'string' || row.b64.length > CC_TRACE_MAX_BYTES * 2) {
          malformed++
          continue
        }
        const value = Buffer.from(row.b64, 'base64')
        if (value.length !== row.bytes || value.toString('base64') !== row.b64) {
          malformed++
          continue
        }
        api[row.type === 'api_request_body' ? 'requestChunks' : 'responseChunks'].push(value)
        if (row.type === 'api_response_body') {
          api.timeline.first_response_body ||= { n: row.n, at: row.at }
          api.timeline.last_response_body = { n: row.n, at: row.at }
        }
      } else if (row.type === 'api_response') {
        api.timeline.response_headers = { n: row.n, at: row.at }
        api.response.status = row.status
        api.response.headers = traceHeaders(row.headers)
      } else if (row.type === 'api_end') {
        api.timeline.response_end = { n: row.n, at: row.at }
        api.response.read_complete = row.complete === true
        api.response.capture_kind = row.capture_kind
      } else if (row.type === 'api_parsed_response') {
        api.response.parsed_json = row.value
        api.response.raw_body_unavailable = true
      } else if (row.type === 'api_decoded_text') {
        api.response.decoded_text = { text: row.text, source: 'Response.text() decoded view, not raw bytes' }
        api.response.raw_body_unavailable = true
      } else if (row.type === 'unsupported_body') {
        api[row.direction === 'api_response_body' ? 'response' : 'request'].raw_body_unavailable = true
      } else if (row.type === 'api_trailers') api.response.trailers = traceHeaders(row.headers)
      else if (row.type === 'api_error' || row.type === 'observer_error') {
        api.error_code = String(row.code || 'unknown').slice(0, 100)
      }
    } else if (
      [
        'native_terminal',
        'native_cancel',
        'trace_end',
        'observer_error',
        'correlation_ambiguous',
        'correlation_evicted',
        'correlation_gap',
      ].includes(row.type)
    )
      lifecycle.push(row)
  }
  const exchanges = []
  for (const api of apis.values()) {
    const { requestChunks, responseChunks, contentDecoded, ...record } = api
    record.request.body = record.request.raw_body_unavailable ? { encoding: 'unavailable' } : asBody(requestChunks)
    record.response.body = record.response.raw_body_unavailable
      ? { encoding: 'unavailable', reason: 'Only a decoded/parsed SDK view was observed, not raw bytes' }
      : asBody(responseChunks, { encoded: !contentDecoded, headers: record.response.headers })
    record.response.body_content_decoded = contentDecoded
    exchanges.push(record)
  }
  const outputWithoutTransport =
    exchanges.length === 0 &&
    stdout.some((row) => {
      try {
        return JSON.parse(row.text).event?.type === 'message_start'
      } catch {
        return false
      }
    })
  const warning = rows.some(
    (row) =>
      ['observer_error', 'correlation_ambiguous', 'correlation_evicted', 'correlation_gap'].includes(row.type) ||
      (row.type === 'native_terminal' &&
        !['job_done', 'job_error', 'cancel_ack'].includes(nativeFrameKind(row.reason))),
  )
  const complete =
    done &&
    !reused &&
    !!end &&
    start.correlation_registry_complete !== false &&
    !warning &&
    !malformed &&
    !outputWithoutTransport &&
    !end.dropped_records &&
    !end.producer_error &&
    !end.pending_responses &&
    exchanges.every(
      (api) => api.response.read_complete && !api.response.raw_body_unavailable && !api.request.raw_body_unavailable,
    )
  return {
    version: CC_TRACE_VERSION,
    status: complete ? 'captured' : 'partial_capture',
    ...(reused
      ? { reason: 'native_ticket_reused' }
      : outputWithoutTransport
        ? { reason: 'api_transport_not_observed' }
        : malformed
          ? { reason: 'evidence_inconsistent' }
          : warning
            ? { reason: 'correlation_or_observer_gap' }
            : exchanges.some((api) => !api.response.read_complete)
              ? { reason: 'api_response_not_fully_read' }
              : exchanges.some((api) => api.response.raw_body_unavailable || api.request.raw_body_unavailable)
                ? { reason: 'raw_body_not_observed' }
                : {}),
    source_scope:
      'Actual CC stdin; final global/undici fetch and HTTP2 requests; API response bytes observed through SDK consumption or HTTP2 events; separate CC stdout. Unread bytes after cancellation are unknown. Auth headers excluded.',
    id,
    runtime: start.runtime,
    execution_options: start.execution_options,
    correlation: start.correlation,
    correlation_registry_complete: start.correlation_registry_complete,
    hook_sha256: start.hook_sha256,
    job_id: start.job_id,
    slot_id: start.slot_id,
    native_input: nativeInput,
    cleaned_request: cleaned,
    http_exchanges: exchanges,
    stdout_frames: stdout,
    lifecycle,
    malformed_records: malformed,
    evidence_issues: validated.issues,
    reported_api_attempts: end?.api_calls ?? null,
    observation_grace_ms: end?.observation_grace_ms ?? null,
  }
}

/** Synchronous admission before serialization; failure returns an unchanged inference envelope. */
export function prepareCCNativeTrace({ projectRoot, vmId, requestId, timeoutMs, maxBytes } = {}, envelope) {
  const unavailable = (reason) => ({ envelope, finish: async () => ({ status: 'unavailable', reason }) })
  if (!projectRoot || !isValidVmId(String(vmId || ''))) return unavailable('vm_unavailable')
  if (!envelope?.body?.metadata || typeof envelope.body.metadata !== 'object' || Array.isArray(envelope.body.metadata))
    return unavailable('metadata_shape')
  const home = path.join(projectRoot, 'vms', vmId, 'cli-home', '.kin')
  const root = path.join(home, CC_TRACE_DIR)
  let id
  try {
    const config = JSON.parse(boundedFile(path.join(projectRoot, 'vms', vmId, 'run', 'kernel.json'), 65536))
    if (config.claude_bin !== CC_TRACE_CONTAINER_BIN) return unavailable('cc_preload_not_configured')
    const release = readFixedRelease(projectRoot, 'cc-fixed')
    if (!release.ok) return unavailable('fixed_release_unavailable')
    const hook = fs.readFileSync(hookFile),
      preload = fs.readFileSync(preloadFile)
    if (
      !boundedFile(path.join(home, CC_TRACE_HOOK), 256 * 1024).equals(hook) ||
      !boundedFile(path.join(home, CC_TRACE_PRELOAD), 65536).equals(preload)
    )
      return unavailable('cc_preload_outdated')
    const rootStat = fs.lstatSync(root)
    const canonicalHome = fs.realpathSync(path.dirname(home))
    if (
      !rootStat.isDirectory() ||
      rootStat.isSymbolicLink() ||
      fs.realpathSync(home) !== path.join(canonicalHome, '.kin') ||
      fs.realpathSync(root) !== path.join(canonicalHome, '.kin', CC_TRACE_DIR)
    )
      return unavailable('trace_root_invalid')
    cleanExpired(root)
    id = crypto.randomBytes(32).toString('hex')
    const nativeDeadline = Date.now() + Math.min(Math.max(Number(timeoutMs) || 600000, 1), 3540000)
    const ticket = {
      version: CC_TRACE_VERSION,
      id,
      request_id: String(requestId || '').slice(0, 128),
      expires_at: Date.now() + Math.min(Math.max(Number(timeoutMs) || 600000, 60000) + 60000, 3600000),
      max_bytes: Math.min(Math.max(Number(maxBytes) || CC_TRACE_MAX_BYTES, 4096), CC_TRACE_MAX_BYTES),
    }
    const fd = fs.openSync(
      path.join(root, `${id}.ticket`),
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      0o600,
    )
    try {
      fs.writeFileSync(fd, JSON.stringify(ticket))
      if (process.platform !== 'win32') fs.fchownSync(fd, rootStat.uid, rootStat.gid)
    } finally {
      fs.closeSync(fd)
    }
    let settled = false
    return {
      id,
      envelope: {
        ...envelope,
        body: { ...envelope.body, metadata: { ...envelope.body.metadata, [CC_TRACE_KEY]: id } },
      },
      async finish({ waitMs = 1000, waitForTerminal = false, signal } = {}) {
        if (settled) return { status: 'unavailable', reason: 'already_collected' }
        settled = true
        const startupDeadline = Date.now() + Math.min(Math.max(Number(waitMs) || 0, 0), 1500)
        let completion,
          observedProducer = false
        try {
          do {
            if (signal?.aborted) break
            try {
              const state = JSON.parse(boundedFile(path.join(root, `${id}.done`), 4096))
              if (state.id === id) {
                completion = state
                break
              }
            } catch {}
            if (waitForTerminal && !observedProducer) {
              try {
                const stat = fs.lstatSync(path.join(root, `${id}.jsonl`))
                observedProducer = stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
              } catch {}
            }
            // Kernel message_stop can precede CC's remaining API work or HTTP EOF.
            // Only an actually observed job extends the short startup grace;
            // failed sends, absent hooks, cancellation and the request deadline do not.
            const deadline = waitForTerminal && observedProducer ? nativeDeadline : startupDeadline
            if (Date.now() >= deadline) break
            await delay(20)
          } while (true)
          const text = boundedFile(path.join(root, `${id}.jsonl`), CC_TRACE_MAX_BYTES + 4096).toString('utf8')
          const done = !signal?.aborted && completion?.complete === true && completion.bytes === Buffer.byteLength(text)
          let reused = false
          try {
            boundedFile(path.join(root, `${id}.reused`), 4096)
            reused = true
          } catch (error) {
            if (error.code !== 'ENOENT') reused = true
          }
          return parseCCNativeTrace(text, {
            id,
            done,
            reused,
            expectedImageHashes: [release.cli.sha256, release.manifest.artifacts['cc-node'].unpacked_sha256],
            expectedHookHash: hash(hook),
          })
        } catch (error) {
          return {
            status: 'unavailable',
            reason: error?.code === 'ENOENT' ? 'native_trace_not_observed' : safeCode(error),
            id,
            diagnostics: {
              ticket_state: fs.existsSync(path.join(root, `${id}.reused`))
                ? 'reused'
                : fs.existsSync(path.join(root, `${id}.claimed`))
                  ? 'claimed'
                  : fs.existsSync(path.join(root, `${id}.ticket`))
                    ? 'pending'
                    : 'absent',
              readiness: readCCNativeTraceReadiness(projectRoot, vmId),
              scope: 'Process metadata snapshot, not attribution of another request to this trace',
            },
          }
        } finally {
          cleanupTicket(root, id)
        }
      },
    }
  } catch (error) {
    if (id) cleanupTicket(root, id)
    return unavailable(safeCode(error))
  }
}
