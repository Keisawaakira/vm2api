// Ported from CLIProxyAPI c404af96ebacedf8168b3c2bdbf4449a21cd1c1e.
// See CLIProxyAPI-LICENSE.txt; Caller preservation and native identity are explicit exceptions.
import { randomUUID } from 'node:crypto'
import { openaiContentToClaudeContent } from './images.mjs'

const isObject = (value) => value != null && typeof value === 'object' && !Array.isArray(value)
const cacheControl = (node) => (node?.cache_control?.type === 'ephemeral' ? node.cache_control : undefined)
const toolID = (id) => String(id || `toolu_${randomUUID()}`).replace(/[^a-zA-Z0-9_-]/gu, '_')

function attachMessageCache(content, message) {
  const last = content.at(-1)
  const cc = cacheControl(message)
  if (last && cc && !last.cache_control) last.cache_control = cc
  return content
}

function toolInput(args) {
  try {
    const parsed = typeof args === 'string' ? JSON.parse(args) : args
    return isObject(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function toolResultContent(content, preserveCaller) {
  if (content === undefined) return ''
  if (content === null) return preserveCaller ? 'null' : ''
  if (typeof content === 'string') return content
  const parts = openaiContentToClaudeContent(Array.isArray(content) ? content : [content]).map(
    ({ cache_control: _cache, ...part }) => part,
  )
  if (parts.length || (Array.isArray(content) && !content.length)) return parts
  return JSON.stringify(content)
}

/** CLIProxy's role accumulator, duplicate-result handling and cache placement. */
export function openaiMessagesToClaude(messages = [], { preserveCaller = true } = {}) {
  const system = []
  const out = []
  const lastToolMessage = new Map()
  const emitted = new Set()
  for (const m of messages) {
    if (m?.role === 'tool' && m.tool_call_id) lastToolMessage.set(m.tool_call_id, m)
  }
  function append(role, content) {
    if (!content.length) return
    const last = out.at(-1)
    if (last?.role === role) last.content.push(...content)
    else out.push({ role, content })
  }
  for (const m of messages) {
    if (!m) continue
    if (m.role === 'system' || m.role === 'developer') {
      const parts = preserveCaller
        ? chatSystemBlocks(m.content)
        : openaiContentToClaudeContent(m.content).filter((p) => p.type === 'text')
      system.push(...attachMessageCache(parts, m))
    } else if (m.role === 'user' || m.role === 'assistant') {
      const content = openaiContentToClaudeContent(m.content)
      // Unsigned reasoning_content is not replayable on the official Messages API.
      if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
        for (const call of m.tool_calls) {
          if (call?.type !== 'function') continue
          content.push({
            type: 'tool_use',
            id: toolID(call.id),
            name: call.function?.name || '',
            input: toolInput(call.function?.arguments),
          })
        }
      }
      append(m.role, attachMessageCache(content, m))
    } else if (m.role === 'tool') {
      const id = m.tool_call_id || ''
      if (id && emitted.has(id)) continue
      if (id) emitted.add(id)
      const target = lastToolMessage.get(id) || m
      const result = {
        type: 'tool_result',
        tool_use_id: toolID(id),
        content: toolResultContent(target.content, preserveCaller),
      }
      const parts = Array.isArray(target.content) ? target.content : [target.content]
      const cc = parts.map(cacheControl).find(Boolean) || cacheControl(target)
      if (cc) result.cache_control = cc
      append('user', [result])
    }
  }
  for (const message of out) {
    if (message.role === 'assistant') {
      message.content = [
        ...message.content.filter((p) => p.type !== 'tool_use'),
        ...message.content.filter((p) => p.type === 'tool_use'),
      ]
    }
  }
  if (!out.length && system.length) out.push({ role: 'user', content: [{ type: 'text', text: '' }] })
  // Keep vm2api's first-user invariant for the CLI hop.
  if (!preserveCaller && out.length && out[0].role !== 'user')
    out.unshift({ role: 'user', content: [{ type: 'text', text: '' }] })
  return { system, messages: out }
}

/** Claude tool input roots are objects, without root unions (nested unions stay intact). */
export function normalizeClaudeToolInputSchema(schema, { cpa = false } = {}) {
  if (!isObject(schema)) return { type: 'object', properties: {} }
  const root = { ...schema }
  const properties = isObject(root.properties) ? { ...root.properties } : {}
  for (const union of ['anyOf', 'oneOf', 'allOf']) {
    const branches = root[union]
    delete root[union]
    if (!Array.isArray(branches)) continue
    for (const branch of branches) {
      if (!isObject(branch)) continue
      if (
        (cpa ? Object.hasOwn(branch, 'type') : branch.type != null) &&
        branch.type !== 'object' &&
        !(Array.isArray(branch.type) && branch.type.includes('object'))
      )
        continue
      for (const [key, value] of Object.entries(isObject(branch.properties) ? branch.properties : {})) {
        if (!Object.hasOwn(properties, key))
          Object.defineProperty(properties, key, { value, enumerable: true, configurable: true, writable: true })
      }
      if (
        union === 'allOf' &&
        Array.isArray(branch.required) &&
        (!cpa || branch.required.every((v) => typeof v === 'string'))
      ) {
        const required =
          Array.isArray(root.required) && (!cpa || root.required.every((v) => typeof v === 'string'))
            ? root.required
            : []
        if (!cpa || required.length || branch.required.length)
          root.required = [...new Set([...required, ...branch.required])]
      }
    }
  }
  return { ...root, type: 'object', properties }
}

export function openaiToolChoiceToClaude(choice) {
  if (choice == null) return undefined
  const type = typeof choice === 'string' ? choice : choice.type
  if (type === 'none' || type === 'auto') return { type }
  if (type === 'required' || type === 'any') return { type: 'any' }
  if (type === 'function') {
    const name = choice.function?.name || choice.name
    return name ? { type: 'tool', name } : { type: 'none' }
  }
  return undefined
}

export function applyChatToolChoice(out, source, { cpa = true } = {}) {
  const choice = source.tool_choice
  if (choice?.type === 'allowed_tools') {
    const nested = choice.allowed_tools
    const tools = nested?.tools?.length ? nested.tools : choice.tools || []
    const allowed = new Set(tools.map((t) => String(t.function?.name || t.name || '').trim()).filter(Boolean))
    out.tools = (out.tools || []).filter((t) => allowed.has(t.name))
    const mode = String((cpa ? String(nested?.mode || '').trim() : nested?.mode) || choice.mode || 'auto')
      .trim()
      .toLowerCase()
    out.tool_choice = { type: out.tools.length ? (mode === 'required' ? 'any' : 'auto') : 'none' }
    if (!out.tools.length) delete out.tools
  } else {
    const mapped = cpa && choice === 'any' ? undefined : openaiToolChoiceToClaude(choice)
    if (mapped) out.tool_choice = mapped
  }
  if (source.parallel_tool_calls === false) {
    if (!out.tool_choice && out.tools?.length) out.tool_choice = { type: 'auto' }
    if (out.tool_choice && out.tool_choice.type !== 'none') out.tool_choice.disable_parallel_tool_use = true
  }
}

/** Caller blocks are data, never guessed CLI boilerplate. Empty text is a block. */
export function chatSystemBlocks(content) {
  const parts = typeof content === 'string' ? [content] : content
  if (!Array.isArray(parts))
    throw chatRequestError('System/developer content must be a string or an array of text blocks')
  return parts.map((part) => {
    if (typeof part === 'string') return { type: 'text', text: part }
    if (!['text', 'input_text', 'output_text'].includes(part?.type) || typeof part.text !== 'string')
      throw chatRequestError('System/developer content only supports string text blocks')
    return { type: 'text', text: part.text, ...(cacheControl(part) ? { cache_control: cacheControl(part) } : {}) }
  })
}

export function chatRequestError(message) {
  return Object.assign(new Error(message), { status: 400, code: 'invalid_chat_request' })
}

/** Chat only: no built-ins or inferred native declarations. */
export function chatToolsToClaude(tools) {
  return (Array.isArray(tools) ? tools : [])
    .filter((t) => t?.type === 'function')
    .map((t) => {
      const fn = t.function || {}
      const out = { name: fn.name || '', description: fn.description || '' }
      if (fn.parameters != null || fn.parametersJsonSchema != null)
        out.input_schema = normalizeClaudeToolInputSchema(fn.parameters ?? fn.parametersJsonSchema, { cpa: true })
      const cc = cacheControl(t) || cacheControl(fn)
      if (cc) out.cache_control = cc
      const strict = fn.strict ?? t.strict
      if (typeof strict === 'boolean') out.strict = strict
      return out
    })
}

export function appendChatResponseFormat(out, source) {
  const format = source.response_format
  const type = String(format?.type || '')
    .trim()
    .toLowerCase()
  if (type !== 'json_object' && type !== 'json_schema') return
  const suffix =
    'Do not include any explanations, markdown code blocks (such as ```json), or any text outside of the JSON object.'
  let text = 'You must format your entire response as a valid JSON object. ' + suffix
  const schema = format.json_schema?.schema ?? format.schema
  if (type === 'json_schema' && schema != null) {
    text = 'You must format your entire response as valid JSON that conforms strictly to the following JSON schema:\n'
    const name = String(format.json_schema?.name || '').trim() || String(format.name || '').trim()
    const description = String(format.json_schema?.description || '').trim() || String(format.description || '').trim()
    if (name) text += `Schema Name: ${name}\n`
    if (description) text += `Schema Description: ${description}\n`
    // Parsed ingress no longer carries lexical schema whitespace.
    text += 'JSON Schema:\n' + JSON.stringify(schema) + '\n' + suffix
  }
  out.system = [...(out.system || []), { type: 'text', text }]
}
