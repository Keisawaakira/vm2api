import { applyChatThinking } from './chat-thinking.mjs'
import {
  CHAT_RESPONSE,
  createChatResponseState,
  applyChatResponseEvent,
  finishChatResponse,
  chatResponseJSON,
} from './chat-response.mjs'
/**
 * Protocol conversion — passthrough-first.
 * Tools: OpenAI function tools ↔ Claude tools
 * Streaming: Claude SSE events → OpenAI Chat chunks / Responses events
 */

import {
  applyStructuredOutput,
  canonicalizeClaudeMessagesShape,
  openaiResponseFormatToOutputConfig,
  sanitizeAnthropicBody,
} from './sanitize.mjs'
import { defaultMaxTokensForModel } from './model-policy.mjs'
import { inboundHasOpenAIToolShape } from '../identity/crs-persona.mjs'
import { applyOpenAIReasoningToClaude } from './thinking.mjs'
import {
  openaiMessagesToClaude,
  normalizeClaudeToolInputSchema,
  openaiToolChoiceToClaude,
  applyChatToolChoice,
  chatToolsToClaude,
  appendChatResponseFormat,
} from './chat-messages.mjs'
export { openaiToolChoiceToClaude } from './chat-messages.mjs'
import { remapCodexTools } from './codex-tools.mjs'
import { CLAUDE_WEB_SEARCH_TOOL, isWebSearchTool } from './web-search.mjs'

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001'

function withCacheControl(node, source) {
  const control = source?.cache_control
  if (!control || !node || typeof node !== 'object') return node
  return { ...node, cache_control: control }
}

/** No aliases. Model must already be an official Claude id (validated upstream). */
export function mapModel(m, { allowMap = false } = {}) {
  const s = String(m || '').trim()
  if (!s) return DEFAULT_MODEL
  // Never remap third-party names
  return s
}

function contentToText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === 'string') return p
        if (p?.type === 'text' || p?.type === 'input_text' || p?.type === 'output_text') return p.text || ''
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return content?.text || ''
}

export function isClaudeMessagesShape(body) {
  return !!(
    body &&
    typeof body === 'object' &&
    Array.isArray(body.messages) &&
    typeof body.max_tokens === 'number' &&
    !('input' in body) &&
    !('choices' in body)
  )
}

/** OpenAI tools → Claude tools. Server search maps to web_search_20250305; function tools stay client tools. */
export function openaiToolsToClaude(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined
  const seenSearch = new Set()
  const out = []
  for (const t of remapCodexTools(tools)) {
    if (!t) continue
    if (isWebSearchTool(t)) {
      if (seenSearch.has('web_search')) continue
      seenSearch.add('web_search')
      out.push({ ...CLAUDE_WEB_SEARCH_TOOL })
      continue
    }
    if (!(t.type === 'function' || t.function || t.name)) continue
    if (t.type === 'function' && t.function) {
      if (!t.function.name) continue
      out.push(
        withCacheControl(
          {
            name: t.function.name,
            description: t.function.description || '',
            input_schema: normalizeClaudeToolInputSchema(t.function.parameters ?? t.function.parametersJsonSchema),
            ...(typeof (t.function.strict ?? t.strict) === 'boolean' ? { strict: t.function.strict ?? t.strict } : {}),
          },
          t.cache_control ? t : t.function,
        ),
      )
      continue
    }
    if (t.name && t.input_schema) {
      out.push(t)
      continue
    }
    const name = t.name || t.function?.name
    if (!name) continue
    out.push(
      withCacheControl(
        {
          name,
          description: t.description || '',
          input_schema: normalizeClaudeToolInputSchema(t.input_schema ?? t.parameters ?? t.parametersJsonSchema),
          ...(typeof t.strict === 'boolean' ? { strict: t.strict } : {}),
        },
        t,
      ),
    )
  }
  return out.length ? out : undefined
}

export { applyStructuredOutput, openaiResponseFormatToOutputConfig }

export function claudeStopReasonToOpenAIFinish(stopReason) {
  const sr = String(stopReason || '')
  if (sr === 'tool_use') return 'tool_calls'
  if (sr === 'max_tokens') return 'length'
  if (sr === 'refusal') return 'content_filter'
  return 'stop'
}

export function claudeRefusalText(claude = {}) {
  const parts = []
  for (const b of claude.content || []) {
    if (b?.type === 'refusal') parts.push(b.refusal || b.text || '')
  }
  return parts.filter(Boolean).join('\n') || null
}

export function claudeHasVisibleOutput(claude = {}) {
  for (const b of claude.content || []) {
    if (b?.type === 'text' && String(b.text || '').trim()) return true
    if (b?.type === 'tool_use') return true
  }
  return false
}

export function isClaudeRefusalStop(claude = {}) {
  return String(claude.stop_reason || '') === 'refusal'
}

/** OpenAI-compat: do not leave refusal as a silent empty completion. */
export function applyOpenAIRefusalFields(message, claude) {
  const refusal = claudeRefusalText(claude)
  if (refusal) message.refusal = refusal
  if (isClaudeRefusalStop(claude) && !String(message.content || '').trim() && !message.tool_calls) {
    message.content = refusal || '[content_filter]'
    if (!message.refusal) message.refusal = message.content
  }
  return message
}

/** Anthropic hop is always SSE. Client stream vs JSON is decided after the worker. */
function withUpstreamStream(claude) {
  if (claude && typeof claude === 'object') claude.stream = true
  return claude
}

/**
 * Downstream SSE only when the caller asked for it.
 * Anthropic / OpenAI default: omitted `stream` is JSON. NewAPI health probes
 * omit the field (Go omitempty) and then json.Unmarshal the body — SSE
 * (`event:…`) becomes `invalid character 'e' looking for beginning of value`.
 * Official Claude Code that omits `stream` still streams via Accept.
 */
export function isClientStream(body, headers = {}) {
  if (body?.stream === false || body?.stream === 0 || body?.stream === 'false') return false
  if (body?.stream === true || body?.stream === 1 || body?.stream === 'true') return true
  const accept = String(headers?.accept || headers?.Accept || '').toLowerCase()
  return accept.includes('text/event-stream')
}

/** Lift OpenAI function tools onto Anthropic Messages without treating the hop as official CC. */
export function normalizeOpenAIToolsOnMessages(body) {
  if (!body || typeof body !== 'object' || !inboundHasOpenAIToolShape(body)) return body
  const out = { ...body }
  const tools = openaiToolsToClaude(body.tools)
  if (tools) out.tools = tools
  const choice = openaiToolChoiceToClaude(body.tool_choice)
  if (choice) out.tool_choice = choice
  return out
}

export function toClaudeMessages(protocol, body, opts = { rewrite: false, model_map: true }) {
  if (protocol === 'anthropic.messages' && !opts.rewrite) {
    const normalized = normalizeOpenAIToolsOnMessages(body)
    const out = sanitizeAnthropicBody(normalized, { strictPassthrough: opts.strict_passthrough })
    if (!out.max_tokens) out.max_tokens = defaultMaxTokensForModel(out.model)
    return { claude: withUpstreamStream(out), mode: inboundHasOpenAIToolShape(body) ? 'convert' : 'passthrough' }
  }

  if (protocol === 'anthropic.messages' && opts.rewrite) {
    return {
      claude: withUpstreamStream({
        ...body,
        model: mapModel(body.model || DEFAULT_MODEL, { allowMap: opts.model_map }),
        max_tokens: body.max_tokens || 1024,
      }),
      mode: 'rewrite',
    }
  }

  if (protocol === 'openai.chat') {
    const claude = withUpstreamStream(openaiToClaude(body, opts))
    const format = openaiResponseFormatToOutputConfig(body.response_format)
    return {
      claude,
      mode: opts.rewrite ? 'rewrite' : 'convert',
      ...(format && claude.system?.length
        ? { cacheTitleHint: { instruction: claude.system.at(-1).text, outputConfig: format } }
        : {}),
    }
  }
  if (protocol === 'openai.completions') {
    return { claude: withUpstreamStream(completionsToClaude(body, opts)), mode: opts.rewrite ? 'rewrite' : 'convert' }
  }
  if (protocol === 'openai.responses') {
    return { claude: withUpstreamStream(responsesToClaude(body, opts)), mode: opts.rewrite ? 'rewrite' : 'convert' }
  }
  throw new Error(`unsupported protocol: ${protocol}`)
}

function openaiToClaude(body, opts) {
  const { system, messages } = openaiMessagesToClaude(body.messages || [], {
    preserveCaller: opts.chatPreserve !== false,
  })
  const out = {
    model: mapModel(body.model, { allowMap: opts.model_map !== false }),
    max_tokens: body.max_tokens ?? body.max_completion_tokens ?? 32000,
    messages,
  }
  if (system.length) out.system = system
  // CLIProxy drops temperature on Chat → Claude; thinking sampling is handled by the hop.
  if (body.top_p != null) out.top_p = body.top_p
  if (body.stop != null) {
    const stops = Array.isArray(body.stop) ? body.stop : [body.stop]
    if (stops.length) out.stop_sequences = stops.map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
  }
  if (opts.chatPreserve === false) {
    if (body.stop != null) out.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop]
    if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) out.stop_sequences = body.stop_sequences
  }
  const tools = opts.chatPreserve === false ? openaiToolsToClaude(body.tools) : chatToolsToClaude(body.tools)
  if (tools?.length) out.tools = tools
  applyChatToolChoice(out, body, { cpa: opts.chatPreserve !== false })
  if (opts.chatPreserve === false) applyStructuredOutput(out, body)
  else appendChatResponseFormat(out, body)
  if (opts.chatPreserve === false) applyOpenAIReasoningToClaude(out, body)
  else applyChatThinking(out, body, { model: opts.thinkingModel || out.model })
  if (body.stream) out.stream = true
  return canonicalizeClaudeMessagesShape(out)
}

/** Legacy OpenAI /v1/completions (prompt, not messages). */
function completionsToClaude(body, opts) {
  const prompt = Array.isArray(body.prompt)
    ? body.prompt.map((p) => (typeof p === 'string' ? p : String(p ?? ''))).join('\n')
    : body.prompt == null
      ? ''
      : String(body.prompt)
  const suffix = body.suffix ? String(body.suffix) : ''
  const user = suffix ? `${prompt}${suffix}` : prompt
  return openaiToClaude(
    {
      ...body,
      messages: [{ role: 'user', content: user || 'Hello' }],
    },
    { ...opts, chatPreserve: false },
  )
}

function responsesToClaude(body, opts) {
  const systemParts = []
  const messages = []
  if (body.instructions) systemParts.push(String(body.instructions))
  const input = body.input
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: [{ type: 'text', text: input }] })
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === 'string') {
        messages.push({ role: 'user', content: [{ type: 'text', text: item }] })
        continue
      }
      const role = item.role === 'assistant' ? 'assistant' : item.role === 'system' ? 'system' : 'user'
      const text = contentToText(item.content ?? item.text ?? item)
      if (role === 'system') {
        if (text) systemParts.push(text)
        continue
      }
      const block = withCacheControl({ type: 'text', text }, item)
      const last = messages[messages.length - 1]
      if (last?.role === role && Array.isArray(last.content)) last.content.push(block)
      else messages.push({ role, content: [block] })
    }
  }
  if (!messages.length) messages.push({ role: 'user', content: '' })
  if (messages[0].role !== 'user') messages.unshift({ role: 'user', content: '' })
  const out = {
    model: mapModel(body.model, { allowMap: opts.model_map !== false }),
    max_tokens: body.max_output_tokens || body.max_tokens || 1024,
    messages,
  }
  if (systemParts.length) out.system = systemParts.map((text) => ({ type: 'text', text }))
  const tools = openaiToolsToClaude(body.tools)
  if (tools?.length) out.tools = tools
  applyStructuredOutput(out, body)
  applyOpenAIReasoningToClaude(out, body)
  if (body.stream) out.stream = true
  return canonicalizeClaudeMessagesShape(out)
}

export function fromClaudeToOpenAIChat(claude, requestedModel, vmId, mode = 'convert') {
  return chatResponseJSON(claude)
}

/**
 * Claude usage → OpenAI Chat usage with cache detail
 * (sub2api apicompat ChatTokenDetails counterpart: cached_tokens / cache_creation_tokens).
 * Token totals keep the Anthropic input_tokens meaning — details are additive only.
 */
function chatUsage(usage) {
  const uncached = Number(usage?.input_tokens || 0)
  const cached = cacheReadTokens(usage)
  const created = cacheCreationTokens(usage)
  const prompt = uncached + cached + created
  const completion = Number(usage?.output_tokens || 0)
  const out = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  }
  const details = promptTokensDetails(usage)
  if (details) out.prompt_tokens_details = details
  return out
}

function cacheReadTokens(usage) {
  return Number(usage?.cache_read_input_tokens ?? usage?.cache_read_tokens) || 0
}

function cacheCreationTokens(usage) {
  return Number(usage?.cache_creation_input_tokens ?? usage?.cache_creation_tokens) || 0
}

function promptTokensDetails(usage) {
  const cached = cacheReadTokens(usage)
  const created = cacheCreationTokens(usage)
  if (!cached && !created) return null
  const details = {}
  if (cached) details.cached_tokens = cached
  if (created) details.cache_creation_tokens = created
  return details
}

export function fromClaudeToResponses(claude, requestedModel, vmId, mode = 'convert') {
  const text = (claude.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text || '')
    .join('')
  const output = [
    {
      type: 'message',
      id: 'msg_' + Math.random().toString(16).slice(2, 8),
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    },
  ]
  for (const b of claude.content || []) {
    if (b.type === 'tool_use') {
      output.push({
        type: 'function_call',
        id: b.id,
        name: b.name,
        arguments: JSON.stringify(b.input || {}),
      })
    }
  }
  const refused = isClaudeRefusalStop(claude)
  const refusal = claudeRefusalText(claude)
  if (refused && !text && refusal) {
    output[0].content = [{ type: 'output_text', text: refusal }]
  }
  return {
    id: 'resp_' + Math.random().toString(16).slice(2, 10),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: refused ? 'incomplete' : 'completed',
    incomplete_details: refused ? { reason: 'content_filter' } : undefined,
    model: requestedModel || claude.model,
    output,
    output_text: text || (refused ? refusal || '' : text),
    usage: responsesUsage(claude.usage),
  }
}

/** Claude usage → OpenAI Responses usage with input_tokens_details cache breakdown. */
function responsesUsage(usage) {
  const uncached = Number(usage?.input_tokens || 0)
  const cached = cacheReadTokens(usage)
  const created = cacheCreationTokens(usage)
  const input = uncached + cached + created
  const output = Number(usage?.output_tokens || 0)
  const out = {
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
  }
  const details = promptTokensDetails(usage)
  if (details) out.input_tokens_details = details
  return out
}

// ---------- Streaming: Claude SSE → OpenAI Chat chunks ----------
function createLegacyChatStreamState(model, vmId, { includeUsage = false } = {}) {
  return {
    id: 'chatcmpl-' + Math.random().toString(36).slice(2, 12),
    model,
    vmId,
    toolIndex: 0,
    toolMap: new Map(), // block index → tool call index
    pendingToolInput: new Map(),
    includeUsage,
    sentRole: false,
    sentFinish: false,
    sentTrailingUsage: false,
    errorSent: false,
    usage: null,
    dataBuf: '',
  }
}

/** Reassemble Anthropic SSE JSON that may be split across lines. */
export function consumeClaudeSSEData(line, state) {
  if (!state || typeof state !== 'object') return null
  if (typeof state.dataBuf !== 'string') state.dataBuf = ''
  const raw = String(line ?? '').replace(/\r$/, '')

  if (raw.startsWith('event:') || raw.startsWith(':')) return null

  if (raw.startsWith('data:')) {
    const piece = raw.slice(5).trim()
    if (!piece || piece === '[DONE]') {
      state.dataBuf = ''
      return null
    }
    state.dataBuf = state.dataBuf ? `${state.dataBuf}\n${piece}` : piece
    return takeParsedSseData(state)
  }

  if (raw === '') {
    if (!state.dataBuf) return null
    const evt = takeParsedSseData(state)
    state.dataBuf = ''
    return evt
  }

  if (state.dataBuf) {
    state.dataBuf = `${state.dataBuf}\n${raw}`
    return takeParsedSseData(state)
  }
  return null
}

function takeParsedSseData(state) {
  try {
    const evt = JSON.parse(state.dataBuf)
    if (evt && typeof evt === 'object') {
      state.dataBuf = ''
      return evt
    }
  } catch {}
  return null
}

function mergeStreamUsage(current, next) {
  if (!next || typeof next !== 'object') return current
  const out = { ...(current || {}) }
  for (const [key, value] of Object.entries(next)) {
    if (value == null) continue
    out[key] =
      value && typeof value === 'object' && !Array.isArray(value)
        ? { ...(out[key] && typeof out[key] === 'object' ? out[key] : {}), ...value }
        : value
  }
  return out
}

function claudeStreamError(evt) {
  return {
    type: evt.error?.type || 'api_error',
    message: evt.error?.message || evt.message || 'Upstream stream failed',
    ...(evt.error?.code ? { code: evt.error.code } : {}),
  }
}

export function createClaudeMessageAssembler({ chat = false } = {}) {
  return {
    message: null,
    dataBuf: '',
    sawMessageStop: false,
    error: null,
    ...(chat ? { chat: createChatResponseState('', { buffered: true }) } : {}),
  }
}

function ensureAssemblerMessage(state) {
  if (!state.message || typeof state.message !== 'object') {
    state.message = { type: 'message', role: 'assistant', content: [] }
  }
  if (!Array.isArray(state.message.content)) state.message.content = []
  return state.message
}

/** Fold Anthropic SSE into one Messages JSON for non-stream clients. */
export function applyClaudeSSELineToMessage(line, state) {
  const evt = consumeClaudeSSEData(line, state)
  if (!evt) return state.message
  if (state.chat) {
    applyChatResponseEvent(evt, state.chat)
    if (state.chat.error) state.error = state.chat.error
  }
  const message = applyClaudeSSEEventToMessage(evt, state)
  if (message && state.chat) message[CHAT_RESPONSE] = state.chat
  return message
}

function applyClaudeSSEEventToMessage(evt, state) {
  if (evt.type === 'error') {
    state.error = claudeStreamError(evt)
    return state.message
  }
  if (evt.type === 'message_stop') {
    state.sawMessageStop = true
    return state.message
  }

  if (evt.type === 'message_start' && evt.message) {
    const started = evt.message
    if (state.chat) state.sawMessageStop = false
    state.message = {
      ...started,
      type: started.type || 'message',
      role: started.role || 'assistant',
      content: Array.isArray(started.content) ? started.content.map((block) => ({ ...block })) : [],
    }
    return state.message
  }

  const message = ensureAssemblerMessage(state)

  if (evt.type === 'content_block_start' && evt.content_block) {
    const block = { ...evt.content_block }
    if (block.type === 'text' && block.text == null) block.text = ''
    if (block.type === 'thinking' && block.thinking == null) block.thinking = ''
    if (block.type === 'refusal' && block.refusal == null) block.refusal = ''
    const idx = Number.isInteger(evt.index) ? evt.index : message.content.length
    message.content[idx] = block
    return message
  }

  if (evt.type === 'content_block_delta' && evt.delta) {
    const idx = Number.isInteger(evt.index) ? evt.index : 0
    const block = message.content[idx]
    if (!block) return message
    if (evt.delta.type === 'text_delta') {
      block.text = (block.text || '') + (evt.delta.text || '')
    } else if (evt.delta.type === 'thinking_delta') {
      block.thinking = (block.thinking || '') + (evt.delta.thinking || '')
    } else if (evt.delta.type === 'signature_delta' && evt.delta.signature) {
      block.signature = evt.delta.signature
    } else if (evt.delta.type === 'input_json_delta') {
      block._inputJson = (block._inputJson || '') + (evt.delta.partial_json || '')
    } else if (evt.delta.type === 'refusal_delta') {
      block.refusal = (block.refusal || '') + (evt.delta.refusal || evt.delta.text || '')
    }
    return message
  }

  if (evt.type === 'content_block_stop') {
    const idx = Number.isInteger(evt.index) ? evt.index : 0
    const block = message.content[idx]
    if (block && typeof block._inputJson === 'string' && block._inputJson) {
      try {
        block.input = JSON.parse(block._inputJson)
      } catch {
        block.input = block.input || {}
      }
      delete block._inputJson
    }
    return message
  }

  if (evt.type === 'message_delta') {
    if (evt.delta?.stop_reason) message.stop_reason = evt.delta.stop_reason
    if (evt.delta && Object.prototype.hasOwnProperty.call(evt.delta, 'stop_sequence')) {
      message.stop_sequence = evt.delta.stop_sequence
    }
    if (evt.delta && Object.prototype.hasOwnProperty.call(evt.delta, 'stop_details')) {
      message.stop_details = evt.delta.stop_details
    }
    if (evt.delta && Object.prototype.hasOwnProperty.call(evt.delta, 'safeguard_results')) {
      message.safeguard_results = evt.delta.safeguard_results
    }
    if (evt.delta && Object.prototype.hasOwnProperty.call(evt.delta, 'diagnostics')) {
      message.diagnostics = evt.delta.diagnostics
    }
    if (evt.usage) message.usage = mergeStreamUsage(message.usage, evt.usage)
  }
  return message
}

function legacyChatChunks(line, state) {
  const evt = consumeClaudeSSEData(line, state)
  if (!evt || state.errorSent) return []
  if (evt.type === 'error') {
    state.errorSent = true
    return [{ error: claudeStreamError(evt) }]
  }

  const chunks = []
  const base = {
    id: state.id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: state.model,
  }

  if (evt.type === 'message_start') {
    state.usage = mergeStreamUsage(state.usage, evt.message?.usage)
    chunks.push({
      ...base,
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    })
    state.sentRole = true
  }

  if (evt.type === 'content_block_start' && evt.content_block?.type === 'text' && evt.content_block.text) {
    chunks.push({ ...base, choices: [{ index: 0, delta: { content: evt.content_block.text }, finish_reason: null }] })
  }

  if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
    const idx = state.toolIndex++
    state.toolMap.set(evt.index, idx)
    if (evt.content_block.input && Object.keys(evt.content_block.input).length) {
      state.pendingToolInput.set(evt.index, JSON.stringify(evt.content_block.input))
    }
    chunks.push({
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: idx,
                id: evt.content_block.id,
                type: 'function',
                function: { name: evt.content_block.name, arguments: '' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })
  }

  if (
    evt.type === 'content_block_start' &&
    (evt.content_block?.type === 'thinking' || evt.content_block?.type === 'redacted_thinking')
  ) {
    // OpenAI-compat: announce reasoning channel
    chunks.push({
      ...base,
      choices: [{ index: 0, delta: { reasoning_content: evt.content_block.thinking || '' }, finish_reason: null }],
    })
  }

  if (evt.type === 'content_block_delta') {
    if (evt.delta?.type === 'text_delta') {
      chunks.push({
        ...base,
        choices: [{ index: 0, delta: { content: evt.delta.text || '' }, finish_reason: null }],
      })
    }
    // Claude thinking → OpenAI-compat reasoning_content (原样文本)
    if (evt.delta?.type === 'thinking_delta') {
      chunks.push({
        ...base,
        choices: [{ index: 0, delta: { reasoning_content: evt.delta.thinking || '' }, finish_reason: null }],
      })
    }
    // signature kept as opaque delta for clients that want full fidelity
    if (evt.delta?.type === 'signature_delta' && evt.delta.signature) {
      chunks.push({
        ...base,
        choices: [{ index: 0, delta: { reasoning_signature: evt.delta.signature }, finish_reason: null }],
      })
    }
    if (evt.delta?.type === 'input_json_delta') {
      // Deltas replace the initial input representation, never concatenate with it.
      state.pendingToolInput.delete(evt.index)
      const idx = state.toolMap.get(evt.index) ?? 0
      chunks.push({
        ...base,
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: idx, function: { arguments: evt.delta.partial_json || '' } }] },
            finish_reason: null,
          },
        ],
      })
    }
    if (evt.delta?.type === 'refusal_delta') {
      chunks.push({
        ...base,
        choices: [
          {
            index: 0,
            delta: { refusal: evt.delta.refusal || evt.delta.text || '' },
            finish_reason: null,
          },
        ],
      })
    }
  }

  if (evt.type === 'content_block_start' && evt.content_block?.type === 'refusal') {
    chunks.push({
      ...base,
      choices: [
        {
          index: 0,
          delta: { refusal: evt.content_block.refusal || '' },
          finish_reason: null,
        },
      ],
    })
  }

  const flushToolInput = (index) => {
    if (!state.pendingToolInput.has(index)) return
    chunks.push({
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: state.toolMap.get(index), function: { arguments: state.pendingToolInput.get(index) } },
            ],
          },
          finish_reason: null,
        },
      ],
    })
    state.pendingToolInput.delete(index)
  }
  if (evt.type === 'content_block_stop') flushToolInput(evt.index)

  if (evt.type === 'message_delta') {
    state.usage = mergeStreamUsage(state.usage, evt.usage)
    const reason = typeof evt.delta?.stop_reason === 'string' ? evt.delta.stop_reason.trim() : ''
    const finish = reason && !state.sentFinish ? claudeStopReasonToOpenAIFinish(reason) : null
    if (finish) {
      for (const index of state.pendingToolInput.keys()) flushToolInput(index)
      state.sentFinish = true
    }
    chunks.push({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: finish }],
      usage: state.usage ? chatUsage(state.usage) : undefined,
    })
  }
  if (evt.type === 'message_stop') {
    for (const index of state.pendingToolInput.keys()) flushToolInput(index)
  }

  return state.includeUsage ? chunks.map((chunk) => ({ ...chunk, usage: null })) : chunks
}

/** Call only after a successful transport EOF/trailer reconciliation, before DONE. */
function finishLegacyChatStream(state, usage, stopReason) {
  if (!state || state.errorSent || state.sentTrailingUsage) return []
  state.usage = mergeStreamUsage(state.usage, usage)
  // Some workers report the actual stop only in EOF metadata. Bridge that
  // observation, never invent a stop or duplicate a finish already sent by SSE.
  const reason = typeof stopReason === 'string' ? stopReason.trim() : ''
  const chunks =
    reason && !state.sentFinish
      ? legacyChatChunks(`data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: reason } })}`, state)
      : []
  if (!state.includeUsage || !state.sentFinish) return chunks
  state.sentTrailingUsage = true
  chunks.push({
    id: state.id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: state.model,
    choices: [],
    usage: chatUsage(state.usage),
  })
  return chunks
}

// ---------- Streaming: Claude SSE → OpenAI Responses-like events ----------
export function createResponsesStreamState(model, vmId) {
  return {
    id: 'resp_' + Math.random().toString(36).slice(2, 10),
    model,
    vmId,
    text: '',
    dataBuf: '',
  }
}

export function claudeSSELineToResponsesEvents(line, state) {
  const evt = consumeClaudeSSEData(line, state)
  if (!evt) return []
  const out = []

  if (evt.type === 'message_start') {
    state.outputIndex = 0
    state.contentIndex = 0
    state.itemId = 'msg_' + Math.random().toString(36).slice(2, 10)
    out.push({
      type: 'response.created',
      response: { id: state.id, object: 'response', model: state.model, status: 'in_progress' },
    })
    out.push({ type: 'response.in_progress', response: { id: state.id, status: 'in_progress' } })
  }

  if (evt.type === 'content_block_start' && evt.content_block?.type === 'text') {
    out.push({
      type: 'response.output_item.added',
      output_index: state.outputIndex || 0,
      item: {
        type: 'message',
        id: state.itemId,
        role: 'assistant',
        content: [],
        status: 'in_progress',
      },
    })
    out.push({
      type: 'response.content_part.added',
      output_index: state.outputIndex || 0,
      content_index: state.contentIndex || 0,
      part: { type: 'output_text', text: '' },
    })
  }

  if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
    state.text += evt.delta.text || ''
    out.push({
      type: 'response.output_text.delta',
      output_index: state.outputIndex || 0,
      content_index: state.contentIndex || 0,
      delta: evt.delta.text || '',
    })
  }

  if (evt.type === 'content_block_stop') {
    out.push({
      type: 'response.output_text.done',
      output_index: state.outputIndex || 0,
      content_index: state.contentIndex || 0,
      text: state.text,
    })
    out.push({
      type: 'response.content_part.done',
      output_index: state.outputIndex || 0,
      content_index: state.contentIndex || 0,
      part: { type: 'output_text', text: state.text },
    })
    out.push({
      type: 'response.output_item.done',
      output_index: state.outputIndex || 0,
      item: {
        type: 'message',
        id: state.itemId,
        role: 'assistant',
        content: [{ type: 'output_text', text: state.text }],
        status: 'completed',
      },
    })
  }

  if (evt.type === 'message_delta' && evt.delta?.stop_reason === 'refusal') {
    state.refused = true
    state.refusalText = state.refusalText || ''
  }

  if (evt.type === 'content_block_start' && evt.content_block?.type === 'refusal') {
    state.refusalText = (state.refusalText || '') + (evt.content_block.refusal || '')
  }

  if (evt.type === 'content_block_delta' && evt.delta?.type === 'refusal_delta') {
    state.refusalText = (state.refusalText || '') + (evt.delta.refusal || evt.delta.text || '')
  }

  if (evt.type === 'message_stop') {
    const refused = !!state.refused
    const text = state.text || (refused ? state.refusalText || '' : '')
    out.push({
      type: refused ? 'response.incomplete' : 'response.completed',
      response: {
        id: state.id,
        object: 'response',
        model: state.model,
        status: refused ? 'incomplete' : 'completed',
        incomplete_details: refused ? { reason: 'content_filter' } : undefined,
        output: [
          {
            type: 'message',
            id: state.itemId,
            role: 'assistant',
            content: [{ type: 'output_text', text }],
          },
        ],
        output_text: text,
      },
    })
  }
  return out
}

export function fromClaudeToOpenAICompletions(claude, requestedModel) {
  let text = (claude.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text || '')
    .join('')
  if (isClaudeRefusalStop(claude) && !String(text).trim()) {
    text = claudeRefusalText(claude) || '[content_filter]'
  }
  const finish = claudeStopReasonToOpenAIFinish(claude.stop_reason)
  return {
    id: 'cmpl-' + (claude.id || 'kin'),
    object: 'text_completion',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel || claude.model,
    choices: [{ text, index: 0, finish_reason: finish, logprobs: null }],
    usage: chatUsage(claude.usage),
  }
}

export function createOpenAICompletionStreamState(model, vmId, options) {
  return {
    id: 'cmpl-' + Math.random().toString(36).slice(2, 12),
    model,
    vmId,
    chat: createLegacyChatStreamState(model, vmId, options),
  }
}

export function claudeSSELineToOpenAICompletionChunks(line, state) {
  return completionChunks(legacyChatChunks(line, state.chat), state)
}

export function finishOpenAICompletionStream(state, usage, stopReason) {
  return completionChunks(finishLegacyChatStream(state?.chat, usage, stopReason), state)
}

function completionChunks(chats, state) {
  return chats
    .map((c) =>
      c.error
        ? c
        : {
            id: state.id,
            object: 'text_completion',
            created: c.created,
            model: state.model,
            ...(c.usage !== undefined ? { usage: c.usage } : {}),
            choices:
              c.choices?.length === 0
                ? []
                : [
                    {
                      text: c.choices?.[0]?.delta?.content || '',
                      index: 0,
                      finish_reason: c.choices?.[0]?.finish_reason ?? null,
                      logprobs: null,
                    },
                  ],
          },
    )
    .filter((c) => c.error || c.choices?.[0]?.text || c.choices?.[0]?.finish_reason || c.usage)
}

export function createOpenAIChatStreamState(model, vmId, options = {}) {
  return createChatResponseState(model, options)
}
export function claudeSSELineToOpenAIChatChunks(line, state) {
  return applyChatResponseEvent(consumeClaudeSSEData(line, state), state)
}
export function finishOpenAIChatStream(state, usage, stopReason) {
  return finishChatResponse(state, usage, stopReason)
}
