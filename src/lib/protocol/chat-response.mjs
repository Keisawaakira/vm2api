// Chat-only CPA response adapter. The Messages assembler still verifies transport success.
// Raw tool arguments must come from SSE, never from a parsed/re-serialized input object.
export const CHAT_RESPONSE = Symbol('chat-response')
export const chatFinishReason = (reason) =>
  reason === 'tool_use'
    ? 'tool_calls'
    : reason === 'max_tokens'
      ? 'length'
      : ['refusal', 'sensitive'].includes(reason)
        ? 'content_filter'
        : 'stop'

export function chatUsage(usage) {
  const cached = Number(usage?.cache_read_input_tokens ?? usage?.cache_read_tokens) || 0
  const created = Number(usage?.cache_creation_input_tokens ?? usage?.cache_creation_tokens) || 0
  const prompt = (Number(usage?.input_tokens) || 0) + cached + created
  const completion = Number(usage?.output_tokens) || 0
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    ...(usage
      ? {
          prompt_tokens_details: {
            cached_tokens: cached,
            cached_creation_tokens: created,
            cache_write_tokens: created,
          },
        }
      : {}),
  }
}
function mergeUsage(current, next) {
  if (!next) return current
  const merged = { ...current }
  for (const [key, value] of Object.entries(next))
    if (value != null)
      merged[key] = typeof value === 'object' && !Array.isArray(value) ? { ...merged[key], ...value } : value
  return merged
}
export function createChatResponseState(model, { includeUsage = false, buffered = false } = {}) {
  return {
    id: '',
    model,
    upstreamModel: '',
    created: 0,
    includeUsage,
    buffered,
    started: false,
    terminal: false,
    stopped: false,
    sentFinish: false,
    sentTrailingUsage: false,
    errorSent: false,
    error: null,
    usage: null,
    dataBuf: '',
    text: '',
    reasoning: '',
    tools: [],
    toolMap: new Map(),
    nextToolIndex: 0,
    sequence: 0,
    stopReason: null,
  }
}
function base(state) {
  return { id: state.id, object: 'chat.completion.chunk', created: state.created, model: state.model || '' }
}
function chunk(state, delta = {}, finish_reason = null) {
  return { ...base(state), choices: [{ index: 0, delta, finish_reason }] }
}
function fail(state, message, upstream) {
  state.errorSent = true
  state.error = upstream || { type: 'api_error', code: 'invalid_chat_stream', message }
  return [{ error: state.error }]
}
function argumentsOf(tool) {
  return tool.arguments || tool.initial || '{}'
}
function toolCall(tool, streaming = false) {
  return {
    ...(streaming ? { index: tool.index } : {}),
    id: tool.id,
    type: 'function',
    function: { name: tool.name, arguments: argumentsOf(tool) },
  }
}
function startBlock(state, block, index, chunks, initialMessage = false) {
  if (block?.type === 'text' && block.text) {
    if (state.buffered) state.text += block.text
    chunks.push(chunk(state, { content: block.text }))
  } else if (block?.type === 'thinking' && block.thinking) {
    if (state.buffered) state.reasoning += block.thinking
    chunks.push(chunk(state, { reasoning_content: block.thinking }))
  } else if (block?.type === 'tool_use') {
    const tool = {
      id: block.id || '',
      name: block.name || '',
      index: state.nextToolIndex++,
      blockIndex: index,
      sequence: state.sequence,
      arguments: '',
      initial: block.input && Object.keys(block.input).length ? JSON.stringify(block.input) : '',
      completed: false,
      initialMessage,
    }
    state.toolMap.set(index, tool)
    if (state.buffered) state.tools.push(tool)
  } else if (block?.type === 'refusal' && (block.refusal || block.text)) {
    // Retained refusal extension: do not lose an upstream visible refusal block.
    state.refusal = (state.refusal || '') + (block.refusal || block.text)
    chunks.push(chunk(state, { refusal: block.refusal || block.text }))
  }
}

export function applyChatResponseEvent(event, state) {
  if (!event || state.errorSent) return []
  if (event.type === 'error')
    return fail(state, '', {
      type: event.error?.type || 'api_error',
      message: event.error?.message || event.message || 'Upstream stream failed',
      ...(event.error?.code ? { code: event.error.code } : {}),
    })
  const chunks = []
  if (event.type === 'message_start') {
    if (state.started && (!state.buffered || !state.terminal)) return fail(state, 'Unexpected second message_start')
    state.started = true
    state.sequence++
    state.terminal = false
    state.stopped = false
    state.stopReason = null
    state.toolMap = new Map()
    state.id = event.message?.id || ''
    state.upstreamModel = event.message?.model || ''
    if (!state.created) state.created = Math.floor(Date.now() / 1000)
    state.usage = mergeUsage(state.usage, event.message?.usage)
    chunks.push(chunk(state, { role: 'assistant' }))
    for (const [index, block] of (event.message?.content || []).entries()) startBlock(state, block, index, chunks, true)
  } else if (
    (state.terminal || state.stopped) &&
    ['content_block_start', 'content_block_delta', 'content_block_stop'].includes(event.type)
  ) {
    return fail(state, 'Content received after terminal marker')
  } else if (event.type === 'content_block_start') {
    startBlock(state, event.content_block, event.index, chunks)
  } else if (event.type === 'content_block_delta') {
    const delta = event.delta || {}
    if (delta.type === 'text_delta') {
      if (state.buffered) state.text += delta.text || ''
      chunks.push(chunk(state, { content: delta.text || '' }))
    } else if (delta.type === 'thinking_delta') {
      if (state.buffered) state.reasoning += delta.thinking || ''
      chunks.push(chunk(state, { reasoning_content: delta.thinking || '' }))
    } else if (delta.type === 'input_json_delta') {
      const tool = state.toolMap.get(event.index)
      if (tool && !tool.completed) {
        tool.initial = ''
        tool.arguments += delta.partial_json || ''
      }
    } else if (delta.type === 'refusal_delta') {
      const text = delta.refusal || delta.text || ''
      state.refusal = (state.refusal || '') + text
      chunks.push(chunk(state, { refusal: text }))
    }
  } else if (event.type === 'content_block_stop') {
    const tool = state.toolMap.get(event.index)
    if (tool && !tool.completed) {
      tool.completed = true
      chunks.push(chunk(state, { tool_calls: [toolCall(tool, true)] }))
    }
  } else if (event.type === 'message_delta') {
    state.usage = mergeUsage(state.usage, event.usage)
    const reason = typeof event.delta?.stop_reason === 'string' ? event.delta.stop_reason.trim() : ''
    const finish = reason && !state.sentFinish ? chatFinishReason(reason) : null
    if (reason) {
      // Initial input is already a complete object, unlike partial JSON deltas.
      for (const tool of state.toolMap.values())
        if (!tool.completed && (tool.initial || tool.initialMessage) && !tool.arguments) {
          tool.completed = true
          chunks.push(chunk(state, { tool_calls: [toolCall(tool, true)] }))
        }
    }
    if (reason) {
      state.terminal = true
      state.stopReason = reason
      state.sentFinish = true
    }
    const next = chunk(state, {}, finish)
    if (state.usage) next.usage = chatUsage(state.usage)
    chunks.push(next)
  } else if (event.type === 'message_stop') {
    state.stopped = true
  }
  return state.includeUsage ? chunks.map((c) => ({ ...c, usage: null })) : chunks
}

/** EOF metadata is authoritative; success is decided by the existing worker/verifier. */
export function finishChatResponse(state, usage, stopReason) {
  if (!state || state.errorSent || state.sentTrailingUsage) return []
  state.usage = mergeUsage(state.usage, usage)
  const reason = typeof stopReason === 'string' ? stopReason.trim() : ''
  const chunks =
    reason && !state.sentFinish
      ? applyChatResponseEvent({ type: 'message_delta', delta: { stop_reason: reason } }, state)
      : []
  if (!state.includeUsage || !state.sentFinish) return chunks
  state.sentTrailingUsage = true
  chunks.push({ ...base(state), choices: [], usage: chatUsage(state.usage) })
  return chunks
}

export function chatResponseJSON(claude) {
  let state = claude?.[CHAT_RESPONSE]
  if (!state) {
    // Public Message-object helper compatibility. The active Chat handler uses SSE state.
    state = createChatResponseState(claude?.model, { buffered: true })
    applyChatResponseEvent({ type: 'message_start', message: claude }, state)
  }
  const message = { role: 'assistant', content: state.text }
  if (state.reasoning) message.reasoning_content = state.reasoning
  if (state.refusal) message.refusal = state.refusal
  const tools = [...state.tools].sort((a, b) => a.sequence - b.sequence || a.blockIndex - b.blockIndex)
  if (tools.length) message.tool_calls = tools.map((t) => toolCall(t))
  return {
    id: state.id,
    object: 'chat.completion',
    created: state.created,
    model: state.upstreamModel,
    choices: [{ index: 0, message, finish_reason: chatFinishReason(claude?.stop_reason || state.stopReason) }],
    usage: chatUsage(claude?.usage || state.usage),
  }
}
