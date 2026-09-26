// Claude cache request classification adapted from CLIProxyAPI; see CLIProxyAPI-LICENSE.txt.
const header = (headers, name) =>
  String(Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name)?.[1] || '')
const texts = (content) =>
  typeof content === 'string' ? [content] : Array.isArray(content) ? content.map((p) => String(p?.text || '')) : []

export function isClaudeCacheProbe(body = {}) {
  if (Number(body.max_tokens) !== 1 || body.tools?.length) return false
  if (!body.messages?.length) return true
  if (body.messages.length !== 1 || body.messages[0]?.role !== 'user') return false
  const content = body.messages[0].content
  const matches = (t) => ['quota', 'test', '.', 'probe'].includes(t.trim())
  if (typeof content === 'string') return matches(content)
  if (!Array.isArray(content)) return false
  const parts = content.filter((p) => !String(p?.text || '').includes('<system-reminder>'))
  return (
    parts.length === 1 &&
    (matches(String(parts[0]?.text || '')) ||
      (String(parts[0]?.text || '').trim() === 'Hi' && !!parts[0].cache_control))
  )
}

export function isClaudeCacheTitleHelper(body = {}) {
  const instructions = [
    'Return a short title',
    'naming a coding session',
    'Write the title in the predominant language',
  ]
  const matches = (text, schema = false) =>
    instructions.some((s) => text.includes(s)) || (schema && text.includes('<session>'))
  const properties = body.output_config?.format?.schema?.properties
  if (properties) {
    if (Object.keys(properties).length !== 1 || !Object.hasOwn(properties, 'title')) return false
    return [...texts(body.system), ...(body.messages || []).flatMap((m) => texts(m.content))].some((t) =>
      matches(t, true),
    )
  }
  return [
    ...texts(body.system),
    ...(body.messages || []).filter((m) => m.role === 'system').flatMap((m) => texts(m.content)),
  ].some((t) => matches(t))
}

export function isClaudeCacheSubagent(headers = {}, body = {}) {
  if (header(headers, 'x-claude-code-agent-id') || header(headers, 'x-claude-code-parent-agent-id')) return true
  const id = body.metadata?.user_id
  if (id && typeof id === 'object' && Object.hasOwn(id, 'parent_session_id')) return true
  if (typeof id === 'string' && id.includes('"parent_session_id"')) return true
  const first = typeof body.system === 'string' ? body.system : body.system?.[0]?.text || ''
  return first.includes('cc_is_subagent=true')
}

export function usesShortClaudeCache({ headers = {}, body = {}, subagent = false } = {}) {
  if (isClaudeCacheProbe(body) || isClaudeCacheTitleHelper(body)) return true
  if (!subagent && !isClaudeCacheSubagent(headers, body)) return false
  if (
    header(headers, 'anthropic-beta').includes('extended-cache-ttl-2025-04-11') ||
    header(headers, 'x-kin-cache-ttl') === '1h'
  )
    return false
  const nodes = [
    body, // Messages automatic caching can opt into 1h at the root.
    ...(body.tools || []),
    ...(Array.isArray(body.system) ? body.system : []),
    ...(body.messages || []).flatMap((m) => (Array.isArray(m.content) ? m.content : [])),
  ]
  return !nodes.some((n) => n?.cache_control?.ttl === '1h')
}
