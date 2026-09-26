import { StringDecoder } from 'node:string_decoder'

// Retained evidence limits, not process RSS limits. JSON escaping/export has a separate bound.
export const RAW_LIMITS = Object.freeze({ bytes: 16 * 1024 * 1024, hops: 16, active: 4 })
export const RAW_EXPORT_BYTES = 32 * 1024 * 1024
let active = 0
const safeId = (value) =>
  String(value || '')
    .replace(/[^a-zA-Z0-9_.:-]/g, '')
    .slice(0, 128)
const metadataKeys =
  /^(content-type|request-id|x-request-id|retry-after|x-kin-(terminal-state|stop-reason|model|usage|input-tokens|output-tokens|cache-read-input-tokens|cache-creation-input-tokens)|anthropic-ratelimit-[a-z-]+)$/

/** Optional observers must never change transport, retries, usage or inference outcome. */
export function observeRaw(target, method, ...args) {
  try {
    return target?.[method]?.(...args)
  } catch {
    return undefined
  }
}

function prefixUtf8(text, maxBytes) {
  if (maxBytes <= 0) return ''
  const buf = Buffer.from(text)
  if (buf.length <= maxBytes) return text
  let end = Math.max(0, maxBytes)
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
  return buf.subarray(0, end).toString('utf8')
}

export function rawDebugActiveCount() {
  return active
}

/** A candidate reserves capacity before mutation, then is promoted or discarded by the handler. */
export function createRawDebug(raw, bytes) {
  const admitted = active < RAW_LIMITS.active
  if (admitted) active++
  let released = false
  let sealed = false
  const record = {
    version: 1,
    source_scope: 'Node-bound bodies and observed decoded UTF-8; not hidden Anthropic wire',
    status: admitted ? 'capturing' : 'omitted_capacity',
    bytes_observed: 0,
    bytes_retained: 0,
    truncated: false,
    hops_observed: 0,
    hops_omitted: 0,
    hops: [],
    derived: {},
  }
  function component(text = '') {
    const field = { text: '', bytes_observed: 0, bytes_retained: 0, truncated: false }
    append(field, text)
    return field
  }
  function append(field, text) {
    if (sealed) return
    const size = Buffer.byteLength(text)
    field.bytes_observed += size
    record.bytes_observed += size
    // A truncated component must remain a contiguous prefix, even if a later ASCII
    // chunk would fit the bytes left by an earlier multibyte code point.
    const remaining = admitted && !field.truncated ? Math.max(0, RAW_LIMITS.bytes - record.bytes_retained) : 0
    const kept = size <= remaining ? text : prefixUtf8(text, remaining)
    const saved = Buffer.byteLength(kept)
    field.text += kept
    field.bytes_retained += saved
    record.bytes_retained += saved
    if (saved < size) field.truncated = record.truncated = true
  }
  const boundedId = (value) => component(safeId(value)).text
  // Capacity refusal holds no original body reference or derived material.
  if (admitted) record.caller = component(raw)
  else {
    record.bytes_observed = bytes
    record.caller = { bytes_observed: bytes, bytes_retained: 0, omitted: 'active_capacity' }
  }
  raw = null

  const collector = {
    record,
    beginHop(source, context, requestText) {
      if (sealed) return null
      if (typeof requestText === 'function') requestText = requestText()
      const hopNo = ++record.hops_observed
      const retained = admitted && record.hops.length < RAW_LIMITS.hops
      if (!retained) record.hops_omitted++
      const entry = retained
        ? {
            hop_no: hopNo,
            source,
            attempt_no: Number(context?.attemptNo) || 1,
            repaired: context?.repaired === true,
            local_connect_attempt: Number(context?.connectAttempt) || 1,
            provider_call: 'unknown',
            account_id: boundedId(context?.accountId),
            vm_id: boundedId(context?.vmId),
            endpoint_id: boundedId(context?.endpointId),
            request: component(requestText),
            response: null,
          }
        : null
      if (entry) record.hops.push(entry)
      else record.bytes_observed += Buffer.byteLength(requestText)
      requestText = null
      let decoder = new StringDecoder('utf8')
      let ended = false
      let sawResponse = false
      function metadata(headers) {
        const allowed = {}
        for (const [key, value] of Object.entries(headers || {})) {
          if (metadataKeys.test(key.toLowerCase())) allowed[key.toLowerCase()] = String(value)
        }
        return component(JSON.stringify(allowed))
      }
      return {
        startResponse(response) {
          if (sawResponse) return
          sawResponse = true
          if (!entry) return
          const contentType = String(response.headers?.['content-type'] || '').toLowerCase()
          entry.status = Number(response.statusCode) || 0
          entry.initial_metadata = metadata(response.headers)
          entry.response = {
            ...component(),
            format: contentType.includes('json') ? 'json' : contentType.includes('event-stream') ? 'sse' : 'unknown',
            read_complete: false,
          }
        },
        chunk(chunk) {
          const text = Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk)
          if (entry?.response) append(entry.response, text)
          else record.bytes_observed += Buffer.byteLength(text)
        },
        endRead(complete, trailers) {
          if (ended) return
          ended = true
          const tail = decoder.end()
          decoder = null
          if (entry?.response) {
            append(entry.response, tail)
            entry.response.read_complete = complete === true
            entry.trailing_metadata = metadata(trailers)
          } else record.bytes_observed += Buffer.byteLength(tail)
        },
        outcome(result) {
          if (!entry) return
          entry.outcome = result?.ok === true ? 'success' : 'failed'
          entry.error_code = boundedId(result?.body?.error?.code || result?.error_code)
          entry.terminal_state = boundedId(result?.terminalState)
          if (!sawResponse) entry.response_missing = 'no_response_observed'
          if (result?.body && sawResponse) entry.derived_message = component(JSON.stringify(result.body))
        },
        connectError() {
          if (entry && !sawResponse) {
            entry.outcome = 'local_transport_error'
            entry.response_missing = 'no_response_observed'
          }
        },
      }
    },
    offlineProbe(report) {
      if (!admitted || sealed) return false
      record.source_scope = 'Offline diagnostic sandbox and Node decoder replay; no real provider request'
      record.offline_probe = {
        simulation: true,
        complete:
          !report?.error &&
          report?.stages?.length === 2 &&
          report.stages.every(
            (stage) => stage.status === 'completed' && stage.capture_complete === true && stage.checks?.text_equal,
          ),
        vm_id: boundedId(report?.meta?.vm_id),
        pairing: boundedId(report?.meta?.selected_pairing),
        kernel_sha256: boundedId(report?.meta?.kernel_sha256),
        cli_sha256: boundedId(report?.meta?.cli_sha256),
        ...(report?.meta?.candidate
          ? {
              candidate: {
                id: boundedId(report.meta.candidate.id),
                status: boundedId(report.meta.candidate.status),
                production_approved: false,
                local_checks_completed: report.meta.candidate.local_validation?.completed === true,
                user_capture_accepted: false,
              },
            }
          : {}),
        phases: (report?.stages || []).slice(0, 2).map((stage) => ({
          name: boundedId(stage.name),
          status: boundedId(stage.status),
          checks: stage.checks || null,
        })),
        details: component(JSON.stringify(report)),
      }
      return !record.offline_probe.details.truncated
    },
    derived(name, value) {
      if (!admitted || sealed || !['client_json', 'assembled_message'].includes(name) || record.derived[name]) return
      record.derived[name] = component(JSON.stringify(value))
    },
    settle({ cancelled = false, failed = false, clientComplete = false } = {}) {
      if (sealed) return record
      record.inference_outcome = record.offline_probe
        ? 'not_run'
        : cancelled
          ? 'cancelled'
          : failed
            ? 'failed'
            : 'success'
      if (record.offline_probe)
        record.diagnostic_outcome = cancelled
          ? 'cancelled'
          : record.offline_probe.complete && !record.truncated
            ? 'complete'
            : 'incomplete'
      record.client_response_complete = clientComplete
      record.derived_missing = ['assembled_message', 'client_json'].filter((name) => !record.derived[name])
      if (admitted && record.offline_probe)
        record.status = record.truncated ? 'offline_partial_capture' : 'offline_capture'
      else if (admitted)
        record.status = !record.hops_observed
          ? 'not_sent'
          : record.truncated ||
              record.hops_omitted ||
              record.hops.some((hop) => hop.response && !hop.response.read_complete)
            ? 'partial_capture'
            : 'captured'
      sealed = true
      return record
    },
    info() {
      return {
        available: true,
        ...(record.offline_probe ? { offline: true } : {}),
        status: record.status,
        hops_observed: record.hops_observed,
        hops_omitted: record.hops_omitted,
        bytes_retained: record.bytes_retained,
        truncated: record.truncated,
      }
    },
    release() {
      if (released) return
      released = true
      sealed = true
      if (admitted) active--
    },
  }
  return collector
}

/** Below parsers and commit gating, including rejected and partial reads. */
export async function* observedRawChunks(stream, hop) {
  let complete = false
  observeRaw(hop, 'startResponse', stream)
  try {
    for await (const chunk of stream) {
      observeRaw(hop, 'chunk', chunk)
      yield chunk
    }
    complete = true
  } finally {
    observeRaw(hop, 'endRead', complete, stream.trailers)
  }
}
