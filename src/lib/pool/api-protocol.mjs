import { OFFICIAL_CLAUDE_CLI_UA } from '../identity/vm-identity.mjs'
import { observeRaw, observedRawChunks } from '../admin/raw-debug.mjs'
import { normalizeChatControls } from '../protocol/chat-thinking.mjs'
import { parseResetMs } from './quota-window.mjs'
import { StringDecoder } from 'node:string_decoder'
import { isCompleteAssistantMessage, mapUpstreamError } from '../core/errors.mjs'
import { consumeClaudeSSEData, finishOpenAIChatStream, finishOpenAICompletionStream } from '../protocol/convert.mjs'
import { canWriteProtocolStream, writeProtocolStreamError, writeAnthropicStreamEvent } from '../protocol/stream-end.mjs'
import { hidePersonaUsage, hidePersonaUsageInEvent } from '../identity/crs-persona-usage.mjs'
import { officialMessagesBody } from '../protocol/anthropic-messages.mjs'
import { prepareClassifierBody } from '../protocol/request-purpose.mjs'
import { semanticStatusForStreamError } from '../protocol/stream-error-status.mjs'
import { remapAnthropicStreamError } from '../protocol/stream-truncation.mjs'
import { isContentPolicyErrorCode } from '../core/refusal-guard.mjs'
import { forwardApi, readApiJson } from '../transport/api-kernel-client.mjs'
import { messagesUrl, normalizeProtocol, resolvePreset, responsesUrl, upstreamAuthHeaders } from './api-presets.mjs'
import { claudeToOpenAIResponsesRequest } from './api-openai.mjs'
import {
  assembleCodexBodyFromSse,
  codexBodyToAnthropicMessage,
  createAnthropicSseState,
  createChatSseState,
  responsesSseToAnthropicEvents,
  isToolArgumentsError,
  responsesSseToChatChunk,
} from '../protocol/codex-convert.mjs'
import { usageFromSseLine } from '../protocol/handle-codex.mjs'
import { BETA_CONTEXT_1M } from '../protocol/claude-code-betas.mjs'
import { shouldPassContext1mByPolicy } from '../protocol/model-policy.mjs'
import { createStreamTiming } from '../protocol/stream-timing.mjs'
import { mergeUsage } from '../protocol/openai-usage.mjs'

export function resolveInferenceBackend(req) {
  if (req?.apiKeyKind !== 'managed') return 'oauth'
  return String(req.apiKeyRecord?.category || '')
    .trim()
    .toLowerCase() === 'api'
    ? 'api'
    : 'oauth'
}

export { messagesUrl, responsesUrl } from './api-presets.mjs'

function joinHeaderMap(headers = {}) {
  const out = {}
  for (const [k, v] of Object.entries(headers)) {
    if (v == null || v === '') continue
    out[k] = String(v)
  }
  return out
}

/**
 * Native Anthropic Messages is a compatibility boundary.  Keep protocol
 * headers supplied by the caller, including beta names this gateway does not
 * know yet.  Headers the operator configured on the endpoint win; anthropic-beta
 * is the union of endpoint and caller tokens so neither opt-in is dropped.
 */
function forwardAnthropicProtocolHeaders(headers = {}, protocol = '', protocolKind = '', { passthrough = false } = {}) {
  if (protocol !== 'anthropic.messages' || protocolKind !== 'anthropic') return {}
  const out = {}
  for (const [rawName, rawValue] of Object.entries(headers || {})) {
    const name = String(rawName || '').toLowerCase()
    if (name === 'user-agent' && !passthrough) continue
    if (
      !name.startsWith('anthropic-') &&
      !name.startsWith('x-claude-code-') &&
      !name.startsWith('x-stainless-') &&
      name !== 'x-app' &&
      name !== 'x-client-request-id' &&
      name !== 'user-agent' &&
      name !== 'accept-language' &&
      name !== 'sec-fetch-mode'
    )
      continue
    if (rawValue == null || rawValue === '') continue
    out[name] = Array.isArray(rawValue) ? rawValue.join(',') : String(rawValue)
  }
  return out
}

function splitBetas(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Caller context-1m follows the model-page 1M policy, same as the slot path. */
function callerBetaTokens(value, model) {
  const tokens = splitBetas(value)
  if (!tokens.includes(BETA_CONTEXT_1M) || shouldPassContext1mByPolicy(model)) return tokens
  return tokens.filter((t) => t !== BETA_CONTEXT_1M)
}

function mergeCallerProtocolHeaders(base = {}, caller = {}, configured = {}, model = '') {
  const out = { ...base }
  const configuredNames = new Set(Object.keys(configured).map((k) => k.toLowerCase()))
  for (const [name, value] of Object.entries(caller)) {
    const existing = Object.keys(out).filter((k) => k.toLowerCase() === name)
    if (name === 'anthropic-beta') {
      const merged = new Set([...existing.flatMap((k) => splitBetas(out[k])), ...callerBetaTokens(value, model)])
      for (const k of existing) delete out[k]
      if (merged.size) out[name] = [...merged].join(',')
      continue
    }
    if (configuredNames.has(name)) continue
    for (const k of existing) delete out[k]
    out[name] = value
  }
  return out
}

async function readLines(stream, onLine, rawHop) {
  let buf = ''
  let receivedAt = null
  const decoder = new StringDecoder('utf8')
  for await (const chunk of rawHop ? observedRawChunks(stream, rawHop) : stream) {
    receivedAt = Date.now()
    buf += Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk)
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      await onLine(line, receivedAt)
    }
  }
  buf += decoder.end()
  if (buf) await onLine(buf, receivedAt)
}

function openAIResponsesSseEvent(line) {
  const raw = String(line || '').trim()
  if (!raw.startsWith('data:')) return null
  const payload = raw.slice(5).trim()
  if (!payload || payload === '[DONE]') return null
  try {
    return JSON.parse(payload)
  } catch {
    return null
  }
}

function openAIResponsesItemHasOutput(item) {
  if (!item || typeof item !== 'object') return false
  if (item.arguments || item.input || item.result || item.encrypted_content) return true
  for (const value of [item.content, item.summary]) {
    if (!Array.isArray(value)) continue
    if (
      value.some(
        (part) =>
          part &&
          typeof part === 'object' &&
          (part.text || part.transcript || part.arguments || part.input || part.result || part.encrypted_content),
      )
    )
      return true
  }
  return false
}

/** Lifecycle events are transport metadata, not downstream model output. */
export function isOpenAIResponsesCommitEvent(event) {
  if (!event || typeof event !== 'object') return false
  const type = String(event.type || '').trim()
  if (
    !type ||
    type === 'error' ||
    type === 'response.failed' ||
    type === 'response.created' ||
    type === 'response.queued' ||
    type === 'response.in_progress' ||
    type === 'response.metadata' ||
    type === 'keepalive'
  )
    return false
  if (type === 'response.output_item.added' || type === 'response.output_item.done')
    return openAIResponsesItemHasOutput(event.item)
  if (
    type === 'response.content_part.added' ||
    type === 'response.content_part.done' ||
    type === 'response.reasoning_summary_part.added' ||
    type === 'response.reasoning_summary_part.done'
  )
    return !!(event.part?.text || event.part?.transcript)
  if (type === 'response.function_call_arguments.done') return !!event.arguments
  if (type === 'response.custom_tool_call_input.done') return !!event.input
  if (type === 'response.image_generation_call.partial_image') return !!event.partial_image_b64
  return type.startsWith('response.output_') || (type.startsWith('response.') && /\.(delta|done)$/.test(type))
}

function openAIResponsesFailure(event) {
  if (!event || typeof event !== 'object') return null
  if (event.type === 'error') return event
  if (event.type !== 'response.failed') return null
  return {
    type: 'error',
    error: event.response?.error || event.error || { type: 'server_error', message: 'Response failed' },
  }
}

function mappedOpenAIResponsesFailure(resultBase, event, committed, extras = {}) {
  const declared = Number(event?.error?.status || event?.status)
  const mapped = mapUpstreamError(declared >= 400 && declared < 600 ? declared : 500, event)
  return {
    ...resultBase,
    ...mapped,
    ok: false,
    terminalState: committed ? 'incomplete' : 'rejected',
    committed,
    ...extras,
  }
}

export async function runApiInference(options = {}) {
  const rawSend = options.rawDebug ? { ...options.rawDebug } : null
  const responseState = { upstream: null }
  try {
    const result = await runApiInferenceImpl({ ...options, rawSend, responseState })
    observeRaw(rawSend?.hop, 'outcome', result)
    return result
  } catch (error) {
    observeRaw(rawSend?.hop, 'outcome', {
      ok: false,
      error_code: 'api_response_processing_error',
      terminalState: 'processing_error',
    })
    throw error
  } finally {
    const upstream = responseState.upstream
    // Own a received response even if bookkeeping throws before its reader starts.
    // This cleanup is transport correctness, independent of diagnostic enrollment.
    if (upstream && !upstream.readableEnded && !upstream.destroyed) upstream.destroy?.()
    observeRaw(rawSend?.hop, 'endRead', false, upstream?.trailers)
  }
}

async function runApiInferenceImpl({
  req,
  res,
  cfg,
  scheduler,
  store,
  protocol,
  inbound,
  convertedBody,
  clientStream,
  deliveryMode,
  signal,
  timeoutMs,
  personaHideTokens,
  cacheTtl,
  converters,
  rawSend,
  responseState,
  requestContext = null,
  passthrough = false,
} = {}) {
  let canonical = protocol === 'openai.chat' ? structuredClone(convertedBody) : officialMessagesBody(convertedBody)
  const model = canonical.model
  const picked = scheduler.pick(model)
  if (!picked.ok) {
    return {
      ok: false,
      status: picked.code === 'model_not_found' ? 404 : 503,
      via: 'api-kernel',
      body: { type: 'error', error: { type: 'api_error', code: picked.code, message: picked.message } },
      terminalState: 'exhausted',
    }
  }

  const preset = resolvePreset(picked.endpoint.kind, picked.endpoint)
  const protocolKind = normalizeProtocol(picked.endpoint.protocol || preset.protocol, preset.kind)
  const extraHeaders = joinHeaderMap(picked.endpoint.headers)
  const isOpenAI = protocolKind === 'openai'
  if (requestContext && (isOpenAI || picked.upstream_model !== canonical.model)) {
    return {
      ok: false,
      status: 400,
      terminalState: 'rejected',
      upstreamExecutions: 0,
      body: {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          code: 'classifier_model_incompatible',
          message: 'Classifier requests require the selected Anthropic model without endpoint model substitution.',
        },
      },
    }
  }
  const chatPreserve = protocol === 'openai.chat' && !isOpenAI
  if (chatPreserve) canonical = normalizeChatControls(canonical)
  else if (protocol === 'openai.chat') canonical = officialMessagesBody(canonical)
  const body = isOpenAI
    ? { ...claudeToOpenAIResponsesRequest({ ...canonical, model: picked.upstream_model }), stream: true }
    : { ...canonical, model: picked.upstream_model, stream: true }
  if (requestContext) Object.assign(body, prepareClassifierBody(body))
  const callerProtocolHeaders = forwardAnthropicProtocolHeaders(req?.headers, protocol, protocolKind, {
    passthrough,
  })
  const authHeaders = upstreamAuthHeaders(protocolKind, picked.key.api_key, {
    ...extraHeaders,
    auth_scheme: picked.endpoint.auth_scheme || extraHeaders.auth_scheme || extraHeaders.anthropic_apikey_auth_scheme,
  })
  if (
    protocolKind === 'anthropic' &&
    !passthrough &&
    !Object.keys(authHeaders).some((key) => key.toLowerCase() === 'user-agent')
  ) {
    authHeaders['user-agent'] = OFFICIAL_CLAUDE_CLI_UA
  }
  const headers = mergeCallerProtocolHeaders(
    {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...authHeaders,
    },
    callerProtocolHeaders,
    extraHeaders,
    canonical.model,
  )

  const timing = createStreamTiming()
  if (rawSend)
    rawSend.context = { attemptNo: 1, repaired: false, accountId: picked.key.id, endpointId: picked.endpoint.id }
  let upstream
  try {
    upstream = await forwardApi({
      cfg,
      url: isOpenAI ? responsesUrl(preset.base_url) : messagesUrl(preset.base_url),
      headers,
      body,
      proxyUrl: picked.key.proxy_url,
      signal,
      timeoutMs,
      rawSend,
    })
  } catch (error) {
    return {
      ok: false,
      status: 502,
      via: 'api-kernel',
      body: {
        type: 'error',
        error: {
          type: 'api_error',
          code: error.code || 'api_kernel_transport',
          message: String(error.message || error).slice(0, 300),
        },
      },
      terminalState: 'transport_error',
      transportError: true,
    }
  }

  responseState.upstream = upstream
  observeRaw(rawSend?.hop, 'startResponse', upstream)
  const status = Number(upstream.statusCode) || 502
  if (status === 429 && !picked.endpoint.disable_cooling) {
    const now = Date.now()
    const rawRetry = upstream.headers['retry-after']
    const seconds = Number(rawRetry ?? 30)
    const reset = Number.isFinite(seconds)
      ? now + Math.max(1, seconds) * 1000
      : Math.max(now + 1000, parseResetMs(rawRetry) || now + 30000)
    const until = new Date(Number.isFinite(new Date(reset).getTime()) ? reset : now + 30000).toISOString()
    try {
      store.setKeyCooldown(picked.key.id, until)
    } catch {}
    scheduler.reload(store.listRaw())
  }

  const resultBase = {
    ok: status >= 200 && status < 300,
    status,
    via: 'api-kernel',
    vmId: null,
    accountId: picked.key.id,
    endpointId: picked.endpoint.id,
    model: picked.upstream_model,
    headers: { ...upstream.headers },
  }

  if (status >= 400) {
    const payload = await readApiJson(upstream, undefined, rawSend?.hop).catch(() => ({}))
    const message = payload?.error?.message || payload?.message || `upstream ${status}`
    const upstreamCode = String(payload?.error?.code || payload?.code || '').trim()
    const contentCode = isContentPolicyErrorCode(upstreamCode) ? upstreamCode.toLowerCase() : ''
    return {
      ...resultBase,
      ok: false,
      body: {
        type: 'error',
        error: {
          ...(requestContext ? payload?.error : {}),
          ...(requestContext && payload?.error?.code ? { upstream_code: payload.error.code } : {}),
          ...(!requestContext && contentCode ? { code: contentCode } : {}),
          type: requestContext ? payload?.error?.type || 'api_error' : 'api_error',
          message: String(message).slice(0, 300),
        },
      },
      terminalState: 'rejected',
    }
  }

  if (isOpenAI) {
    return await runOpenAIResponsesUpstream({
      upstream,
      resultBase,
      protocol,
      inbound,
      clientStream,
      deliveryMode,
      res,
      converters,
      body,
      timing,
      rawHop: rawSend?.hop,
    })
  }

  const assembler = converters.createClaudeMessageAssembler({ chat: chatPreserve })
  const eventState = { dataBuf: '' }
  let classifierError = null
  let classifierStopped = false
  let terminalError = null
  const options = { includeUsage: inbound.stream_options?.include_usage === true }
  let state
  if (clientStream && protocol === 'openai.chat')
    state = converters.createOpenAIChatStreamState(inbound.model || body.model, picked.endpoint.id, options)
  else if (clientStream && protocol === 'openai.completions')
    state = converters.createOpenAICompletionStreamState(inbound.model || body.model, picked.endpoint.id, options)
  else if (clientStream && protocol === 'openai.responses')
    state = converters.createResponsesStreamState(inbound.model || body.model, picked.endpoint.id)

  let committed = false
  const beginWrite = () => {
    committed = true
    if (!res.headersSent) converters.writeSSEHeaders(res)
  }
  const writeChunks = (chunks) => {
    for (const chunk of chunks) {
      if (signal?.aborted || !canWriteProtocolStream(res)) break
      beginWrite()
      if (chunk.error) writeProtocolStreamError(res, protocol, chunk)
      else res.write(`data: ${JSON.stringify(chunk)}\n\n`)
    }
  }
  let readError = null
  try {
    await readLines(
      upstream,
      async (line, receivedAt) => {
        // Accounting and performance observe provider events, not the masked client copy.
        converters.applyClaudeSSELineToMessage(line, assembler)
        const event = consumeClaudeSSEData(line, eventState)
        if (!event) return
        timing.observe(event, receivedAt)
        if (event.type === 'error') terminalError ||= event
        if (requestContext) {
          if (event.type === 'error')
            classifierError = {
              ...event,
              error: { ...event.error, ...(event.error?.code ? { upstream_code: event.error.code } : {}) },
            }
          if (event.type === 'message_stop') classifierStopped = true
        }
        if (!clientStream || signal?.aborted || !canWriteProtocolStream(res)) return
        if (event.type === 'error') {
          beginWrite()
          const clientError =
            protocol === 'anthropic.messages' && !requestContext
              ? remapAnthropicStreamError(event, { headers: resultBase.headers })
              : classifierError || event
          writeProtocolStreamError(res, protocol, clientError)
          return
        }
        const clientEvent = chatPreserve ? event : hidePersonaUsageInEvent(event, personaHideTokens, cacheTtl)
        if (protocol === 'anthropic.messages') {
          beginWrite()
          writeAnthropicStreamEvent(res, clientEvent)
          return
        }
        const clientLine = `data: ${JSON.stringify(clientEvent)}`
        if (protocol === 'openai.chat') writeChunks(converters.claudeSSELineToOpenAIChatChunks(clientLine, state))
        else if (protocol === 'openai.completions')
          writeChunks(converters.claudeSSELineToOpenAICompletionChunks(clientLine, state))
        else writeChunks(converters.claudeSSELineToResponsesEvents(clientLine, state))
      },
      rawSend?.hop,
    )
  } catch (error) {
    readError = {
      type: 'api_error',
      code: signal?.aborted ? 'client_aborted' : error.code || 'api_kernel_transport',
      message: String(error.message || error).slice(0, 300),
    }
  }
  if (requestContext && !signal?.aborted && (classifierError || readError || !classifierStopped)) {
    const failureBody = classifierError || {
      type: 'error',
      error: {
        type: 'api_error',
        code: 'upstream_stream_interrupted',
        status: 502,
        message: readError?.message || 'Classifier stream ended before message_stop',
      },
    }
    const declared = Number(failureBody.error?.status)
    return {
      ...resultBase,
      ok: false,
      status: declared >= 400 && declared < 600 ? declared : mapUpstreamError(200, failureBody).status,
      body: failureBody,
      headers: {
        ...resultBase.headers,
        ...(failureBody.error?.retry_after ? { 'retry-after': String(failureBody.error.retry_after) } : {}),
      },
      usage: assembler.message?.usage || null,
      terminalState: 'rejected',
      transportError: !!readError,
      committed,
      sawMessageStop: assembler.sawMessageStop,
      ...timing.snapshot(),
    }
  }
  const failure = terminalError?.error || assembler.error || state?.error || readError
  const complete =
    !failure &&
    assembler.sawMessageStop &&
    isCompleteAssistantMessage({ body: assembler.message, sawMessageStop: assembler.sawMessageStop })
  const ok = resultBase.ok && complete && !signal?.aborted
  const usage = assembler.message?.usage || null
  if (ok && clientStream) {
    const clientUsage = chatPreserve ? usage : hidePersonaUsage(usage, personaHideTokens, cacheTtl)
    if (protocol === 'openai.chat')
      writeChunks(finishOpenAIChatStream(state, clientUsage, assembler.message.stop_reason))
    else if (protocol === 'openai.completions')
      writeChunks(finishOpenAICompletionStream(state, clientUsage, assembler.message.stop_reason))
  }
  return {
    ...resultBase,
    ...timing.snapshot(),
    status: terminalError ? semanticStatusForStreamError(terminalError) : resultBase.status,
    ok,
    body:
      terminalError ||
      (ok || (!failure && !signal?.aborted)
        ? assembler.message
        : {
            type: 'error',
            error: failure || {
              type: 'api_error',
              code: signal?.aborted ? 'client_aborted' : 'stream_incomplete',
              message: 'Upstream stream ended before a complete assistant message',
            },
          }),
    usage,
    terminalState: ok ? 'verified' : terminalError ? 'rejected' : readError ? 'transport_error' : 'incomplete',
    transportError: !!readError,
    committed,
    sawMessageStop: assembler.sawMessageStop,
  }
}

async function runOpenAIResponsesUpstream({
  upstream,
  resultBase,
  protocol,
  inbound,
  clientStream,
  deliveryMode,
  res,
  converters,
  body,
  timing,
  rawHop,
}) {
  const chunks = []
  const anthropicSse = protocol === 'anthropic.messages' ? createAnthropicSseState() : null
  const chatSse = createChatSseState()
  let conversionError = null
  let committed = false
  let completed = false
  let sawTerminal = false
  let streamedUsage = null
  let terminalFailure = null
  const pendingLines = []

  const writeStreamLine = (raw) => {
    if (!res.headersSent) converters.writeSSEHeaders(res)
    if (protocol === 'openai.responses') {
      res.write(raw.endsWith('\n') ? raw : raw + '\n')
      if (/response\.(completed|done)/.test(raw)) completed = true
      return
    }
    try {
      const mapped =
        protocol === 'anthropic.messages'
          ? responsesSseToAnthropicEvents(raw, anthropicSse)
          : responsesSseToChatChunk(raw, 'codex', chatSse)
      if (mapped) {
        res.write(mapped)
        if (mapped.includes('[DONE]') || mapped.includes('event: message_stop\n')) completed = true
      }
    } catch (error) {
      if (error.code !== 'tool_arguments_mismatch') throw error
      conversionError = { type: 'upstream_protocol_error', code: error.code, message: error.message }
      const payload = JSON.stringify({ error: conversionError })
      res.write(
        protocol === 'anthropic.messages'
          ? 'event: error\ndata: ' + JSON.stringify({ type: 'error', error: conversionError }) + '\n\n'
          : 'data: ' + payload + '\n\ndata: [DONE]\n\n',
      )
    }
  }

  await readLines(upstream, async (line, receivedAt) => {
    if (conversionError) return
    const raw = String(line || '')
    const event = openAIResponsesSseEvent(raw)
    timing.observe(event, receivedAt)
    const failure = openAIResponsesFailure(event)
    if (failure) terminalFailure = failure
    const seen = usageFromSseLine(raw)
    if (seen) streamedUsage = mergeUsage(streamedUsage, seen)
    const startsOutput = isOpenAIResponsesCommitEvent(event)
    const completes = event?.type === 'response.completed' || event?.type === 'response.done'
    const wasCommitted = committed
    if (!committed && (startsOutput || completes)) committed = true
    if (!clientStream) {
      chunks.push(raw)
      if (/response\.(completed|done)/.test(raw) || raw.trim() === 'data: [DONE]') sawTerminal = true
      return
    }
    if (!wasCommitted) {
      pendingLines.push(raw)
      if (!committed) return
      for (const pending of pendingLines.splice(0)) writeStreamLine(pending)
      return
    }
    writeStreamLine(raw)
  }, rawHop)

  if (!clientStream) {
    if (terminalFailure)
      return mappedOpenAIResponsesFailure(resultBase, terminalFailure, committed, {
        usage: streamedUsage,
        ...timing.snapshot(),
      })
    let assembled
    let outBody
    try {
      assembled = assembleCodexBodyFromSse(chunks, {})
      outBody =
        protocol === 'anthropic.messages'
          ? codexBodyToAnthropicMessage(assembled, inbound?.model || body?.model)
          : assembled
    } catch (error) {
      if (!isToolArgumentsError(error)) throw error
      return {
        ...resultBase,
        ...timing.snapshot(),
        ok: false,
        status: 502,
        body: { error: { type: 'upstream_protocol_error', code: error.code, message: error.message } },
        terminalState: 'incomplete',
        committed,
        usage: streamedUsage,
      }
    }
    const hasBody = !!(assembled && (assembled.output || assembled.id || outBody))
    const complete = resultBase.ok && sawTerminal && hasBody
    return {
      ...resultBase,
      ...timing.snapshot(),
      ok: complete,
      body: outBody,
      usage: mergeUsage(streamedUsage, assembled?.usage || outBody?.usage),
      terminalState: complete ? 'verified' : hasBody ? 'incomplete' : 'rejected',
      committed,
    }
  }
  if (terminalFailure)
    return mappedOpenAIResponsesFailure(resultBase, terminalFailure, committed, {
      usage: streamedUsage,
      ...timing.snapshot(),
    })
  if (conversionError)
    return {
      ...resultBase,
      ok: false,
      status: 502,
      body: { error: conversionError },
      terminalState: 'incomplete',
      committed,
      usage: streamedUsage,
      ...timing.snapshot(),
    }

  return {
    ...resultBase,
    ok: resultBase.ok && (deliveryMode !== 'verified' || completed || committed),
    usage: streamedUsage,
    terminalState: completed ? 'verified' : committed ? 'incomplete' : 'rejected',
    committed,
    ...timing.snapshot(),
  }
}
