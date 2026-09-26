import { observeRaw, observedRawChunks } from '../admin/raw-debug.mjs'
import { normalizeChatControls } from '../protocol/chat-thinking.mjs'
import { parseResetMs } from './quota-window.mjs'
import { StringDecoder } from 'node:string_decoder'
import { isCompleteAssistantMessage } from '../core/errors.mjs'
import { consumeClaudeSSEData, finishOpenAIChatStream, finishOpenAICompletionStream } from '../protocol/convert.mjs'
import { canWriteProtocolStream, writeProtocolStreamError, writeAnthropicStreamEvent } from '../protocol/stream-end.mjs'
import { hidePersonaUsage, hidePersonaUsageInEvent } from '../identity/crs-persona-usage.mjs'
import { officialMessagesBody } from '../protocol/anthropic-messages.mjs'
import { forwardApi, readApiJson } from '../transport/api-kernel-client.mjs'
import { messagesUrl, normalizeProtocol, resolvePreset, responsesUrl, upstreamAuthHeaders } from './api-presets.mjs'
import { claudeToOpenAIResponsesRequest } from './api-openai.mjs'
import {
  assembleCodexBodyFromSse,
  codexBodyToAnthropicMessage,
  createAnthropicSseState,
  responsesSseToAnthropicEvents,
  responsesSseToChatChunk,
} from '../protocol/codex-convert.mjs'
import { usageFromSseLine } from '../protocol/handle-codex.mjs'

export function resolveInferenceBackend(req) {
  if (req?.apiKeyKind === 'managed') {
    return String(req.apiKeyRecord?.category || 'oauth').toLowerCase() === 'api' ? 'api' : 'oauth'
  }
  if (req?.apiKeyKind === 'master') {
    return String(req.headers?.['x-kin-backend'] || '').toLowerCase() === 'api' ? 'api' : 'oauth'
  }
  return 'oauth'
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

async function readLines(stream, onLine, rawHop) {
  let buf = ''
  const decoder = new StringDecoder('utf8')
  for await (const chunk of rawHop ? observedRawChunks(stream, rawHop) : stream) {
    buf += Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk)
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      await onLine(line)
    }
  }
  buf += decoder.end()
  if (buf) await onLine(buf)
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
  const chatPreserve = protocol === 'openai.chat' && !isOpenAI
  if (chatPreserve) canonical = normalizeChatControls(canonical)
  else if (protocol === 'openai.chat') canonical = officialMessagesBody(canonical)
  const body = isOpenAI
    ? { ...claudeToOpenAIResponsesRequest({ ...canonical, model: picked.upstream_model }), stream: true }
    : { ...canonical, model: picked.upstream_model, stream: true }
  const headers = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    ...upstreamAuthHeaders(protocolKind, picked.key.api_key, {
      ...extraHeaders,
      auth_scheme: picked.endpoint.auth_scheme || extraHeaders.auth_scheme || extraHeaders.anthropic_apikey_auth_scheme,
    }),
  }

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
    return {
      ...resultBase,
      ok: false,
      body: { type: 'error', error: { type: 'api_error', message: String(message).slice(0, 300) } },
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
      rawHop: rawSend?.hop,
    })
  }

  const assembler = converters.createClaudeMessageAssembler({ chat: chatPreserve })
  const eventState = { dataBuf: '' }
  const options = { includeUsage: inbound.stream_options?.include_usage === true }
  let state
  if (clientStream && protocol === 'openai.chat')
    state = converters.createOpenAIChatStreamState(inbound.model || body.model, picked.endpoint.id, options)
  else if (clientStream && protocol === 'openai.completions')
    state = converters.createOpenAICompletionStreamState(inbound.model || body.model, picked.endpoint.id, options)
  else if (clientStream && protocol === 'openai.responses')
    state = converters.createResponsesStreamState(inbound.model || body.model, picked.endpoint.id)

  let committed = false
  const started = Date.now()
  let ttftMs = null
  const beginWrite = () => {
    committed = true
    if (!res.headersSent) converters.writeSSEHeaders(res)
  }
  const writeChunks = (chunks) => {
    for (const chunk of chunks) {
      if (signal?.aborted || !canWriteProtocolStream(res)) break
      beginWrite()
      if (chunk.error) writeProtocolStreamError(res, protocol, chunk)
      else {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`)
      }
    }
  }
  let readError = null
  try {
    await readLines(
      upstream,
      async (line) => {
        // Accounting observes raw provider usage; only the client copy is masked.
        converters.applyClaudeSSELineToMessage(line, assembler)
        const event = consumeClaudeSSEData(line, eventState)
        if (!event) return
        if (ttftMs == null) ttftMs = Date.now() - started
        if (!clientStream || signal?.aborted || !canWriteProtocolStream(res)) return
        if (event.type === 'error') {
          beginWrite()
          writeProtocolStreamError(res, protocol, event)
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
  const failure = assembler.error || state?.error || readError
  const complete = !failure && assembler.sawMessageStop && isCompleteAssistantMessage({ body: assembler.message })
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
    ok,
    body: ok
      ? assembler.message
      : {
          type: 'error',
          error: failure || {
            type: 'api_error',
            code: signal?.aborted ? 'client_aborted' : 'stream_incomplete',
            message: 'Upstream stream ended before a complete assistant message',
          },
        },
    usage,
    terminalState: ok ? 'verified' : readError ? 'transport_error' : 'incomplete',
    transportError: !!readError,
    committed,
    ttftMs,
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
  rawHop,
}) {
  const chunks = []
  const anthropicSse = protocol === 'anthropic.messages' ? createAnthropicSseState() : null
  let committed = false
  let completed = false
  let ttftMs = null
  let streamedUsage = null
  const started = Date.now()

  await readLines(
    upstream,
    async (line) => {
      const raw = String(line || '')
      const seen = usageFromSseLine(raw)
      if (seen) streamedUsage = seen
      if (raw.startsWith('data:') && ttftMs == null) ttftMs = Date.now() - started
      if (!committed && raw.startsWith('data:')) committed = true
      if (!clientStream) {
        chunks.push(raw)
        return
      }
      if (!res.headersSent) converters.writeSSEHeaders(res)
      if (protocol === 'openai.responses') {
        res.write(raw.endsWith('\n') ? raw : `${raw}\n`)
        if (/response\.(completed|done)/.test(raw)) completed = true
        return
      }
      if (protocol === 'openai.chat' || protocol === 'openai.completions') {
        const mapped = responsesSseToChatChunk(raw)
        if (mapped) {
          res.write(mapped)
          if (mapped.includes('[DONE]')) completed = true
        }
        return
      }
      const mapped = responsesSseToAnthropicEvents(raw, anthropicSse)
      if (mapped) {
        res.write(mapped)
        if (mapped.includes('message_stop')) completed = true
      }
    },
    rawHop,
  )

  if (!clientStream) {
    const assembled = assembleCodexBodyFromSse(chunks, {})
    const outBody =
      protocol === 'anthropic.messages'
        ? codexBodyToAnthropicMessage(assembled, inbound?.model || body?.model)
        : assembled
    return {
      ...resultBase,
      ok: resultBase.ok && !!(assembled && (assembled.output || assembled.id || outBody)),
      body: outBody,
      usage: assembled?.usage || streamedUsage || outBody?.usage || null,
      terminalState: resultBase.ok ? 'verified' : 'rejected',
      committed: true,
    }
  }

  return {
    ...resultBase,
    ok: resultBase.ok && (deliveryMode !== 'verified' || completed || committed),
    usage: streamedUsage,
    terminalState: completed ? 'verified' : committed ? 'incomplete' : 'rejected',
    committed,
    ttftMs,
  }
}
