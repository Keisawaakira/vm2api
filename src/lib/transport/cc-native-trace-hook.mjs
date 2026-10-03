// Opt-in Bun preload for the unchanged cc-fixed executable.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import http2 from 'node:http2'
import { StringDecoder } from 'node:string_decoder'
import { syncBuiltinESMExports } from 'node:module'
import { fileURLToPath } from 'node:url'

export const CC_TRACE_VERSION = 1
export const CC_TRACE_KEY = '__vm2api_cc_trace'
export const CC_TRACE_DIR = 'cc-native-traces'
export const CC_TRACE_LAUNCHER = 'cc-native-trace'
export const CC_TRACE_HOOK = 'cc-native-trace-hook.mjs'
export const CC_TRACE_PRELOAD = 'cc-native-trace-preload.mjs'
export const CC_TRACE_MAX_BYTES = 8 * 1024 * 1024
export const CC_TRACE_MAX_INPUT = 16 * 1024 * 1024
export const CC_TRACE_GRACE_MS = 300
export const validTraceId = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const allowedHeader =
  /^(content-type|content-encoding|content-length|accept|accept-encoding|user-agent|anthropic-(version|beta|ratelimit-[a-z-]+)|request-id|x-request-id|x-client-request-id|x-app|x-claude-code-[a-z-]+|x-stainless-[a-z-]+|retry-after|:status)$/i
const noFollow = fs.constants.O_NOFOLLOW || 0

export function traceHeaders(headers) {
  const out = {}
  const entries = typeof headers?.entries === 'function' ? headers.entries() : Object.entries(headers || {})
  for (const [name, value] of entries) {
    if (
      !allowedHeader.test(name) ||
      /authorization|api[-_]?key|cookie|secret|access[-_]?token|refresh[-_]?token/i.test(name) ||
      value == null
    )
      continue
    out[name.toLowerCase()] = String(value).slice(0, 8192)
  }
  return out
}
function safeUrl(value) {
  try {
    const url = new URL(String(value))
    return (
      url.origin +
      url.pathname +
      (url.searchParams.has('beta') ? '?beta=' + encodeURIComponent(url.searchParams.get('beta')) : '')
    )
  } catch {
    return 'unavailable'
  }
}
function isMessagesRequest(value, method) {
  try {
    return (
      String(method || 'GET').toUpperCase() === 'POST' &&
      /\/v1\/messages(?:\/count_tokens)?$/.test(new URL(String(value)).pathname)
    )
  } catch {
    return false
  }
}
const safeError = (error) => String(error?.code || error?.name || 'trace_error').slice(0, 100)
function bytes(value, encoding) {
  if (typeof value === 'string') return Buffer.from(value, typeof encoding === 'string' ? encoding : 'utf8')
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  return null
}
function hashFile(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const hash = crypto.createHash('sha256'),
      block = Buffer.allocUnsafe(256 * 1024)
    let read
    while ((read = fs.readSync(fd, block, 0, block.length, null))) hash.update(block.subarray(0, read))
    return hash.digest('hex')
  } finally {
    fs.closeSync(fd)
  }
}
function recordTicketReuse(root, id) {
  try {
    fs.writeFileSync(path.join(root, `${id}.reused`), JSON.stringify({ id, at: Date.now() }), {
      flag: 'wx',
      mode: 0o600,
    })
  } catch {}
}
function readTicket(root, id, parse) {
  if (!validTraceId(id)) return null
  let fd
  try {
    const directory = fs.lstatSync(root)
    if (!directory.isDirectory() || directory.isSymbolicLink()) return null
    const source = path.join(root, `${id}.ticket`),
      claimed = path.join(root, `${id}.claimed`)
    // A same-hop retry in another host must not certify only the first capture.
    const recordReuse = () => recordTicketReuse(root, id)
    if (fs.existsSync(claimed)) {
      recordReuse()
      return null
    }
    try {
      fs.renameSync(source, claimed)
    } catch {
      // Another process can win after both observed the claim as absent.
      if (fs.existsSync(claimed)) recordReuse()
      return null
    }
    fd = fs.openSync(claimed, fs.constants.O_RDONLY | noFollow)
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096) return null
    const ticket = parse(fs.readFileSync(fd, 'utf8'))
    if (
      ticket.version !== CC_TRACE_VERSION ||
      ticket.id !== id ||
      !Number.isFinite(ticket.expires_at) ||
      ticket.expires_at <= Date.now()
    )
      return null
    return ticket
  } catch {
    return null
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/** No async-context mutation: older compiled Bun crashes when enterWith is used
 * inside its readline/JSON path. Correlate preserved message object identities,
 * then exact serialized bodies and the native CCH literal string replacement.
 * Indistinguishable simultaneous bodies are explicitly omitted, never guessed. */
export function installCCNativeTrace({ root = process.env.VM2API_CC_TRACE_ROOT } = {}) {
  if (!root || !path.isAbsolute(root)) throw new Error('CC native trace requires an absolute private root')
  const parse = JSON.parse,
    stringify = JSON.stringify,
    stringReplace = String.prototype.replace
  const stdinEmit = process.stdin.emit,
    stdoutWrite = process.stdout.write
  const originalFetch = globalThis.fetch,
    originalConnect = http2.connect
  const jobs = new Map(),
    bodyOwners = new Map(),
    retiredBodies = new Set(),
    objectOwners = new WeakMap(),
    sessions = new WeakSet()
  const unknown = { ctx: null, hashes: new Set(), closed: false }
  const inputDecoder = new StringDecoder('utf8'),
    outputDecoder = new StringDecoder('utf8')
  const inputLines = new Map()
  let input = '',
    inputOversized = false,
    output = '',
    outputOversized = false
  let ownershipComplete = true
  let runningImage,
    hookHash = null,
    http2Binding = 'standard_exports',
    undiciBinding = 'unavailable'
  try {
    hookHash = hashFile(fileURLToPath(import.meta.url))
  } catch {}
  // Readiness is metadata only, even when no request has a trace ticket.
  const runtimeState = {
    version: CC_TRACE_VERSION,
    pid: process.pid,
    started_at: Date.now(),
    native_host_ready: false,
    stdin_chunks: 0,
    stdin_lines: 0,
    native_jobs: 0,
    jobs_with_trace_id: 0,
    admitted_jobs: 0,
    last_ticket_status: null,
    last_error_code: null,
  }
  function publishRuntime(stage) {
    let tmp
    try {
      const directory = fs.lstatSync(root)
      if (!directory.isDirectory() || directory.isSymbolicLink()) return
      const file = path.join(root, `runtime-${process.pid}.json`)
      tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`
      const value = {
        ...runtimeState,
        stage,
        updated_at: Date.now(),
        hook_sha256: hookHash,
        bun: process.versions.bun || null,
        http2_binding: http2Binding,
        undici_binding: undiciBinding,
        uid: process.getuid?.() ?? null,
        disable_nonstreaming_fallback: /^(1|true)$/i.test(process.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK || ''),
      }
      fs.writeFileSync(tmp, stringify(value), { flag: 'wx', mode: 0o600 })
      fs.renameSync(tmp, file)
    } catch {
    } finally {
      if (tmp)
        try {
          fs.unlinkSync(tmp)
        } catch {}
    }
  }
  const active = () => [...jobs.values()].some((owner) => owner.ctx && !owner.ctx.closed)
  function digest(value) {
    if (typeof value === 'string')
      return Buffer.byteLength(value) <= CC_TRACE_MAX_INPUT
        ? crypto.createHash('sha256').update(value).digest('hex')
        : null
    const data = bytes(value)
    if (!data || data.length > CC_TRACE_MAX_INPUT) return null
    return crypto.createHash('sha256').update(data).digest('hex')
  }
  function associate(value, owners) {
    if (!value || typeof value !== 'object') return
    const messages = Object.getOwnPropertyDescriptor(value, 'messages')?.value
    if (!Array.isArray(messages)) return
    objectOwners.set(value, owners)
    objectOwners.set(messages, owners)
    for (const message of messages) if (message && typeof message === 'object') objectOwners.set(message, owners)
  }
  function noteGap(reason, transport) {
    for (const owner of jobs.values()) owner.ctx?.write('correlation_gap', { reason, transport })
  }
  function retireBody(key) {
    if (retiredBodies.has(key)) return
    if (retiredBodies.size < 2048) retiredBodies.add(key)
    else {
      ownershipComplete = false
      noteGap('ownership_registry_exhausted')
    }
  }
  function retainBody(text, owners) {
    if (!ownershipComplete) return
    const key = digest(text)
    if (!key) return
    const existing = bodyOwners.get(key) || new Set()
    for (const owner of owners) {
      if (owner.closed) {
        retireBody(key)
        continue
      }
      existing.add(owner)
      owner.hashes.add(key)
    }
    bodyOwners.set(key, existing)
    while (bodyOwners.size > 256) {
      const first = bodyOwners.keys().next().value
      retireBody(first)
      for (const owner of bodyOwners.get(first)) {
        owner.hashes.delete(first)
        owner.ctx?.write('correlation_evicted')
      }
      bodyOwners.delete(first)
    }
  }
  function lookupDigest(key) {
    const owners = key ? bodyOwners.get(key) : null
    if (!owners) return null
    const live = new Set([...owners].filter((owner) => !owner.closed && !owner.ctx?.closed))
    return live.size ? live : null
  }
  const lookupBody = (value) => {
    const key = digest(value)
    return retiredBodies.has(key) ? new Set([unknown]) : lookupDigest(key)
  }
  function contextForDigest(key, transport) {
    if (!ownershipComplete || retiredBodies.has(key)) {
      noteGap(ownershipComplete ? 'retired_serialization' : 'ownership_registry_exhausted', transport)
      return null
    }
    const owners = lookupDigest(key)
    if (!owners || owners.has(unknown)) {
      noteGap('unowned_api_send', transport)
      return null
    }
    if (owners.size !== 1) {
      for (const owner of owners) owner.ctx?.write('correlation_ambiguous')
      return null
    }
    return [...owners][0].ctx
  }
  const contextForBody = (value, transport) => contextForDigest(digest(value), transport)
  function release(owner) {
    owner.closed = true
    for (const key of owner.hashes) {
      retireBody(key)
      const set = bodyOwners.get(key)
      set?.delete(owner)
      if (!set?.size) bodyOwners.delete(key)
    }
    owner.hashes.clear()
    if (jobs.get(owner.job) === owner) jobs.delete(owner.job)
  }
  function image() {
    if (!runningImage) {
      try {
        runningImage = {
          pid: process.pid,
          ppid: process.ppid,
          executable_sha256: hashFile(process.platform === 'linux' ? '/proc/self/exe' : process.execPath),
          source: process.platform === 'linux' ? 'proc_self_exe' : 'process_exec_path',
          bun: process.versions.bun || null,
          node: process.versions.node,
          http2_binding: http2Binding,
          undici_binding: undiciBinding,
        }
      } catch {
        runningImage = { pid: process.pid, ppid: process.ppid, unavailable: true }
      }
    }
    return runningImage
  }
  function createTrace(frame, line, ticket, owner) {
    let fd
    try {
      fd = fs.openSync(
        path.join(root, `${ticket.id}.jsonl`),
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
        0o600,
      )
    } catch (error) {
      // Windows can let two already-open rename operations both succeed.
      // The exclusive trace-file create is the final ownership boundary.
      if (error?.code === 'EEXIST') recordTicketReuse(root, ticket.id)
      return null
    }
    const limit = Math.max(4096, Math.min(Number(ticket.max_bytes) || CC_TRACE_MAX_BYTES, CC_TRACE_MAX_BYTES))
    let used = 0,
      sequence = 0,
      dropped = 0,
      failed = false,
      limited = false,
      closed = false,
      terminal = false,
      batch = '',
      apiSeq = 0
    const pending = new Set()
    let closeTimer
    function flush() {
      if (!batch) return
      try {
        const data = Buffer.from(batch)
        for (let offset = 0; offset < data.length; ) {
          const written = fs.writeSync(fd, data, offset, data.length - offset)
          if (!written) throw Error('trace_write_incomplete')
          offset += written
        }
        batch = ''
      } catch {
        failed = true
        batch = ''
      }
    }
    function write(type, data = {}, reserved = false) {
      if (closed || failed) return false
      if (limited && !reserved) {
        dropped++
        return false
      }
      try {
        const row = stringify({ n: ++sequence, at: Date.now(), type, ...data }) + '\n'
        const size = Buffer.byteLength(row)
        if (used + size > limit - (reserved ? 0 : 4096)) {
          dropped++
          if (!reserved) limited = true
          return false
        }
        used += size
        batch += row
        if (reserved || Buffer.byteLength(batch) >= 65536) flush()
        return true
      } catch {
        failed = true
        return false
      }
    }
    function closeTrace() {
      if (closed) return
      clearTimeout(closeTimer)
      clearTimeout(expiry)
      write(
        'trace_end',
        {
          id: ticket.id,
          api_calls: apiSeq,
          dropped_records: dropped,
          pending_responses: pending.size,
          producer_error: failed,
          observation_grace_ms: CC_TRACE_GRACE_MS,
        },
        true,
      )
      flush()
      closed = true
      try {
        fs.closeSync(fd)
      } catch {}
      try {
        fs.writeFileSync(
          path.join(root, `${ticket.id}.done`),
          stringify({ id: ticket.id, bytes: used, complete: !failed && !dropped && !pending.size }),
          { flag: 'wx', mode: 0o600 },
        )
      } catch {}
      release(owner)
    }
    function closeWhenIdle() {
      if (!terminal || closed || pending.size) return
      clearTimeout(closeTimer)
      closeTimer = setTimeout(closeTrace, CC_TRACE_GRACE_MS)
      closeTimer.unref?.()
    }
    const ctx = {
      get closed() {
        return closed
      },
      write,
      api(transport, method, url, headers, decoded) {
        if (closed) return null
        clearTimeout(closeTimer)
        const api = ++apiSeq
        pending.add(api)
        write('api_request', {
          api,
          transport,
          method,
          url: safeUrl(url),
          headers: traceHeaders(headers),
          after_terminal: terminal,
          response_content_decoded: decoded,
        })
        return api
      },
      chunk(type, api, chunk, encoding) {
        const value = bytes(chunk, encoding)
        if (value) write(type, { api, bytes: value.length, b64: value.toString('base64') })
        else if (chunk != null) write('unsupported_body', { api, direction: type })
      },
      end(api, complete, captureKind = 'body_bytes') {
        if (pending.delete(api)) write('api_end', { api, complete, capture_kind: captureKind })
        closeWhenIdle()
      },
      finish(reason) {
        if (closed) return
        if (!terminal) {
          terminal = true
          write('native_terminal', { reason }, true)
        }
        if (!['kin_job_done', 'kin_job_error', 'kin_cancel_ack'].includes(reason)) {
          write('observer_error', { code: reason }, true)
          closeTrace()
        } else closeWhenIdle()
      },
    }
    const expiry = setTimeout(
      () => ctx.finish('capture_window_expired'),
      Math.min(Math.max(ticket.expires_at - Date.now(), 1), 3600000),
    )
    expiry.unref?.()
    const fallback = process.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK
    write(
      'trace_start',
      {
        version: CC_TRACE_VERSION,
        id: ticket.id,
        job_id: frame.job_id,
        slot_id: frame.slot_id,
        request_id: ticket.request_id,
        hook_sha256: hookHash,
        runtime: image(),
        correlation: 'message_identity_and_exact_serialization',
        correlation_registry_complete: ownershipComplete,
        execution_options: {
          disable_nonstreaming_fallback:
            fallback == null ? null : /^(?:1|0|true|false|yes|no|on|off)$/i.test(fallback) ? fallback : 'other',
          extra_body_override_present: !!process.env.CLAUDE_CODE_EXTRA_BODY,
          scope: 'allowlisted environment only; cached SDK feature gates are not measured',
        },
      },
      true,
    )
    write('native_input', { text: line })
    return ctx
  }
  function inputChunk(chunk, final = false) {
    runtimeState.stdin_chunks++
    const previousLines = runtimeState.stdin_lines
    input += Buffer.isBuffer(chunk) ? inputDecoder.write(chunk) : String(chunk || '')
    if (final) input += inputDecoder.end()
    let index
    while ((index = input.indexOf('\n')) >= 0) {
      const raw = input.slice(0, index + 1),
        line = input.slice(0, index).replace(/\r$/, '')
      input = input.slice(index + 1)
      runtimeState.stdin_lines++
      if (!inputOversized && Buffer.byteLength(line) <= CC_TRACE_MAX_INPUT) inputLines.set(line, raw)
      inputOversized = false
    }
    if (Buffer.byteLength(input) > CC_TRACE_MAX_INPUT) {
      input = ''
      inputOversized = true
    }
    if (final && input && !inputOversized) {
      inputLines.set(input.replace(/\r$/, ''), input)
      input = ''
    }
    while (inputLines.size > 64) inputLines.delete(inputLines.keys().next().value)
    if (runtimeState.stdin_lines !== previousLines) publishRuntime('stdin')
  }
  process.stdin.emit = function (event, ...args) {
    try {
      if (event === 'data') inputChunk(args[0])
      if (event === 'end') inputChunk('', true)
    } catch {}
    return Reflect.apply(stdinEmit, this, [event, ...args])
  }
  JSON.parse = function (text, ...args) {
    const value = Reflect.apply(parse, this, [text, ...args])
    try {
      const nativeLine = inputLines.get(text)
      if (nativeLine !== undefined) {
        inputLines.delete(text)
        if (value?.type === 'kin_job_start') {
          runtimeState.native_jobs++
          const marker = value.request?.metadata?.[CC_TRACE_KEY]
          if (validTraceId(marker)) runtimeState.jobs_with_trace_id++
          const ticket = readTicket(root, marker, parse)
          runtimeState.last_ticket_status = ticket ? 'claimed' : validTraceId(marker) ? 'not_claimed' : 'missing_nonce'
          // Observer failures must not prevent removal of our private marker.
          if (value.request?.metadata && Object.hasOwn(value.request.metadata, CC_TRACE_KEY))
            delete value.request.metadata[CC_TRACE_KEY]
          const prior = jobs.get(value.job_id)
          if (prior) {
            prior.ctx?.finish('duplicate_job_id')
            if (!prior.ctx) release(prior)
          }
          const owner = { job: value.job_id, ctx: null, hashes: new Set(), closed: false }
          if (ticket && [...jobs.values()].filter((x) => x.ctx && !x.ctx.closed).length < 4)
            owner.ctx = createTrace(value, nativeLine, ticket, owner)
          jobs.set(value.job_id, owner)
          if (owner.ctx) runtimeState.admitted_jobs++
          associate(value.request, new Set([owner]))
          owner.ctx?.write('native_request_cleaned', { request: value.request })
          publishRuntime('native_job')
        } else if (value?.type === 'kin_cancel')
          jobs.get(value.job_id)?.ctx?.write('native_cancel', { job_id: value.job_id })
      } else if (typeof text === 'string') {
        const owners = lookupBody(text)
        if (owners) associate(value, owners)
      }
    } catch (error) {
      runtimeState.last_error_code = safeError(error)
      publishRuntime('observer_error')
    }
    return value
  }
  JSON.stringify = function (value, ...args) {
    const text = Reflect.apply(stringify, this, [value, ...args])
    try {
      if (typeof text === 'string' && value && typeof value === 'object') {
        const messages = Object.getOwnPropertyDescriptor(value, 'messages')?.value
        if (Array.isArray(messages)) {
          const owners =
            objectOwners.get(value) || objectOwners.get(messages) || objectOwners.get(messages[0]) || new Set([unknown])
          retainBody(text, owners)
        }
      }
    } catch {}
    return text
  }
  // Native stampCchBody replaces five characters AFTER JSON serialization.
  // Follow that observed operation, not a fuzzy/canonicalized body match. This
  // also propagates unknown/retired ownership before admission; otherwise late
  // unadmitted work could borrow an admitted request's identical stamped bytes.
  // The all-zero checksum can leave bytes unchanged; ownership still matters.
  const tracedReplace = function (...args) {
    const result = Reflect.apply(stringReplace, this, args)
    try {
      if (
        typeof this === 'string' &&
        args[0] === 'cch=00000' &&
        typeof args[1] === 'string' &&
        /^cch=[0-9a-f]{5}$/.test(args[1])
      ) {
        retainBody(result, lookupBody(this) || new Set([unknown]))
      }
    } catch {}
    return result
  }
  String.prototype.replace = tracedReplace
  process.stdout.write = function (chunk, ...args) {
    try {
      output += Buffer.isBuffer(chunk) ? outputDecoder.write(chunk) : String(chunk)
      let index
      while ((index = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, index + 1)
        output = output.slice(index + 1)
        if (outputOversized) {
          outputOversized = false
          continue
        }
        let frame
        try {
          frame = parse(line)
        } catch {
          continue
        }
        if (frame.type === 'kin_host_ready') {
          runtimeState.native_host_ready = true
          publishRuntime('native_host_ready')
        }
        const owner = jobs.get(frame.job_id)
        if (!owner) continue
        owner.ctx?.write('native_stdout', { text: line })
        if (['kin_job_done', 'kin_job_error', 'kin_cancel_ack'].includes(frame.type)) {
          if (owner.ctx) owner.ctx.finish(frame.type)
          else release(owner)
        }
      }
      if (Buffer.byteLength(output) > CC_TRACE_MAX_INPUT) {
        output = ''
        outputOversized = true
        for (const owner of jobs.values()) owner.ctx?.write('observer_error', { code: 'stdout_frame_limit' })
      }
    } catch {}
    return Reflect.apply(stdoutWrite, this, [chunk, ...args])
  }
  function wrapFetch(fetchImpl, transport = 'fetch') {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch observer requires a function')
    return function (input, init) {
      let ctx
      try {
        if (isMessagesRequest(input?.url || input, init?.method || input?.method))
          ctx = contextForBody(init?.body, transport)
      } catch {}
      if (!ctx || ctx.closed) return Reflect.apply(fetchImpl, this, [input, init])
      let api
      try {
        api = ctx.api(
          transport,
          init?.method || input?.method || 'GET',
          input?.url || input,
          init?.headers || input?.headers,
          true,
        )
        ctx.chunk('api_request_body', api, init?.body)
      } catch {}
      let promise
      try {
        promise = Reflect.apply(fetchImpl, this, [input, init])
      } catch (error) {
        ctx.write('api_error', { api, code: safeError(error) })
        ctx.end(api, false)
        throw error
      }
      const watch = (pending, success) => {
        Promise.resolve(pending).then(
          (value) => {
            try {
              success(value)
            } catch (error) {
              ctx.write('observer_error', { api, code: safeError(error) })
            }
          },
          (error) => {
            ctx.write('api_error', { api, code: safeError(error) })
            ctx.end(api, false)
          },
        )
        return pending
      }
      watch(promise, (response) => {
        ctx.write('api_response', { api, status: response.status, headers: traceHeaders(response.headers) })
        const body = response.body
        if (!body) {
          ctx.end(api, true)
          return
        }
        let mode = null
        const observeRead = (result) => {
          if (result.done) ctx.end(api, true, 'sdk_body_read')
          else ctx.chunk('api_response_body', api, result.value)
        }
        const getReader = body.getReader
        if (typeof getReader === 'function')
          body.getReader = function (...args) {
            const reader = Reflect.apply(getReader, this, args)
            if (mode && mode !== 'reader') return reader
            mode = 'reader'
            const read = reader.read,
              cancel = reader.cancel
            reader.read = function (...args) {
              return watch(Reflect.apply(read, this, args), observeRead)
            }
            if (cancel)
              reader.cancel = function (...args) {
                ctx.end(api, false, 'sdk_cancel')
                return Reflect.apply(cancel, this, args)
              }
            return reader
          }
        const iterate = body[Symbol.asyncIterator]
        if (typeof iterate === 'function')
          body[Symbol.asyncIterator] = function (...args) {
            if (!mode) mode = 'iterator'
            const iterator = Reflect.apply(iterate, this, args)
            if (mode !== 'iterator') return iterator
            const next = iterator.next,
              stop = iterator.return
            iterator.next = function (...args) {
              return watch(Reflect.apply(next, this, args), observeRead)
            }
            if (stop)
              iterator.return = function (...args) {
                ctx.end(api, false, 'sdk_iterator_return')
                return Reflect.apply(stop, this, args)
              }
            return iterator
          }
        const cancel = body.cancel
        if (cancel)
          body.cancel = function (...args) {
            ctx.end(api, false, 'sdk_cancel')
            return Reflect.apply(cancel, this, args)
          }
        for (const method of ['text', 'arrayBuffer', 'json']) {
          const original = response[method]
          if (typeof original !== 'function') continue
          response[method] = function (...args) {
            if (!mode) mode = method
            const result = Reflect.apply(original, this, args)
            return mode !== method
              ? result
              : watch(result, (value) => {
                  if (method === 'json') ctx.write('api_parsed_response', { api, value })
                  else if (method === 'text') ctx.write('api_decoded_text', { api, text: value })
                  else ctx.chunk('api_response_body', api, new Uint8Array(value))
                  ctx.end(
                    api,
                    true,
                    method === 'json'
                      ? 'parsed_json_only'
                      : method === 'text'
                        ? 'decoded_text_only'
                        : 'response_arrayBuffer',
                  )
                })
          }
        }
      })
      return promise
    }
  }
  if (typeof originalFetch === 'function') globalThis.fetch = wrapFetch(originalFetch)
  http2.connect = function (...args) {
    const session = Reflect.apply(originalConnect, this, args)
    if (sessions.has(session)) return session
    try {
      sessions.add(session)
      const request = session.request
      session.request = function (headers, options) {
        const stream = Reflect.apply(request, this, [headers, options])
        try {
          const url = `${headers?.[':scheme'] || String(args[0]).split(':')[0]}://${headers?.[':authority'] || new URL(args[0]).host}${headers?.[':path'] || '/'}`
          if (!active() || !isMessagesRequest(url, headers?.[':method'])) return stream
          const emit = stream.emit,
            write = stream.write,
            end = stream.end
          let ctx,
            api,
            ending = false,
            completed = false,
            size = 0,
            limited = false,
            requestChunks = [],
            early = false
          const requestHash = crypto.createHash('sha256')
          function append(chunk, encoding) {
            const data = bytes(chunk, encoding)
            if (!data) return
            requestHash.update(data)
            size += data.length
            // Unenrolled concurrent streams must not add an unbounded second body buffer.
            if (size > 2 * 1024 * 1024) {
              requestChunks = []
              limited = true
              return
            }
            if (!limited) requestChunks.push(Buffer.from(data))
          }
          stream.write = function (chunk, ...rest) {
            try {
              if (!ending) append(chunk, rest[0])
            } catch {}
            return Reflect.apply(write, this, [chunk, ...rest])
          }
          stream.end = function (chunk, ...rest) {
            try {
              if (typeof chunk !== 'function') append(chunk, rest[0])
              ctx = contextForDigest(requestHash.digest('hex'), 'http2')
              if (ctx && !ctx.closed) {
                api = ctx.api('http2', headers?.[':method'] || 'GET', url, headers, false)
                if (limited)
                  ctx.write('unsupported_body', {
                    api,
                    direction: 'api_request_body',
                    bytes: size,
                    reason: 'http2_capture_limit',
                  })
                else ctx.chunk('api_request_body', api, Buffer.concat(requestChunks))
                if (early) ctx.write('observer_error', { api, code: 'response_before_body_correlation' })
              }
              requestChunks = []
            } catch {}
            ending = true
            try {
              return Reflect.apply(end, this, [chunk, ...rest])
            } finally {
              ending = false
            }
          }
          stream.emit = function (event, ...rest) {
            try {
              if (!ctx) {
                if (['response', 'data', 'end'].includes(event)) early = true
              } else {
                if (event === 'response')
                  ctx.write('api_response', {
                    api,
                    status: Number(rest[0]?.[':status']) || 0,
                    headers: traceHeaders(rest[0]),
                  })
                if (event === 'data') ctx.chunk('api_response_body', api, rest[0])
                if (event === 'end') {
                  completed = true
                  ctx.end(api, true)
                }
                if (event === 'error') ctx.write('api_error', { api, code: safeError(rest[0]) })
                if (event === 'close' && !completed) ctx.end(api, false)
                if (event === 'trailers') ctx.write('api_trailers', { api, headers: traceHeaders(rest[0]) })
              }
            } catch {}
            return Reflect.apply(emit, this, [event, ...rest])
          }
        } catch {}
        return stream
      }
    } catch {}
    return session
  }
  try {
    syncBuiltinESMExports()
  } catch {}
  publishRuntime('preload')
  return {
    wrapFetch,
    setUndiciBinding(value) {
      undiciBinding = value
      publishRuntime('bindings')
    },
    setHttp2Binding(value) {
      http2Binding = value
      publishRuntime('bindings')
    },
    restore() {
      process.stdin.emit = stdinEmit
      process.stdout.write = stdoutWrite
      JSON.parse = parse
      JSON.stringify = stringify
      if (String.prototype.replace === tracedReplace) String.prototype.replace = stringReplace
      globalThis.fetch = originalFetch
      http2.connect = originalConnect
      try {
        syncBuiltinESMExports()
      } catch {}
      for (const owner of jobs.values())
        if (owner.ctx) owner.ctx.finish('observer_uninstall')
        else release(owner)
    },
  }
}
