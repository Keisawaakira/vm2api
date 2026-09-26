/**
 * Anthropic cache_control ttl for unofficial OAuth.
 * Default 1h (2× input). Customers may request 5m (1.25× input);
 * Explicit markers win. Billing uses upstream usage, never this request default.
 */
import fs from 'node:fs'
import { isAnthropicServerTool } from './web-search.mjs'
import { isApiKeyMode } from '../oauth/credential-mode.mjs'
import { usesShortClaudeCache } from './cache-request.mjs'

export const DEFAULT_CACHE_TTL = '1h'
export const CACHE_TTL_HEADER = 'x-kin-cache-ttl'

export function normalizeCacheTtl(value) {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
  if (!raw) return DEFAULT_CACHE_TTL
  if (
    raw === '1h' ||
    raw === '1hr' ||
    raw === '60m' ||
    raw === '3600' ||
    raw === 'hour' ||
    raw === '1hour' ||
    raw === 'default'
  )
    return '1h'
  if (raw === '5m' || raw === '5min' || raw === '300') return '5m'
  return DEFAULT_CACHE_TTL
}

export function cacheTtlFromRouting(routing = {}, { credentialMode = 'oauth' } = {}) {
  const selected = String(routing?.compatibility?.cache_ttl || 'auto')
    .trim()
    .toLowerCase()
  return selected === 'auto' ? (isApiKeyMode(credentialMode) ? '5m' : '1h') : normalizeCacheTtl(selected)
}

export function cacheTtlFromRoutingFile(filePath, options = {}) {
  if (!filePath) return cacheTtlFromRouting({}, options)
  try {
    return cacheTtlFromRouting(JSON.parse(fs.readFileSync(filePath, 'utf8')), options)
  } catch {
    return cacheTtlFromRouting({}, options)
  }
}

/** Highest explicit inbound TTL, for selecting newly added prefix markers only. */
export function bodyCacheTtl(body) {
  if (!body || typeof body !== 'object') return null
  const ttls = []
  const collect = (control) => {
    if (!control || typeof control !== 'object') return
    const raw = String(control.ttl || '').trim()
    if (raw) ttls.push(normalizeCacheTtl(raw))
  }
  collect(body.cache_control)
  if (Array.isArray(body.tools)) for (const tool of body.tools) collect(tool?.cache_control)
  if (Array.isArray(body.system)) for (const block of body.system) collect(block?.cache_control)
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (!Array.isArray(message?.content)) continue
      for (const block of message.content) collect(block?.cache_control)
    }
  }
  if (ttls.includes('1h')) return '1h'
  return ttls.includes('5m') ? '5m' : null
}

export function bodyRequestsHourCache(body) {
  return bodyCacheTtl(body) === '1h'
}

/** Header > explicit inbound TTL > menu/credential default, including official CC. */
export function resolveCacheTtl({
  headers = {},
  body,
  routing,
  routingFile,
  credentialMode = 'oauth',
  subagent = false,
} = {}) {
  if (usesShortClaudeCache({ headers, body, subagent })) return '5m'
  const hdr = headers[CACHE_TTL_HEADER] || headers['X-Kin-Cache-Ttl']
  if (hdr != null && String(hdr).trim()) return normalizeCacheTtl(hdr)
  const requested = bodyCacheTtl(body)
  if (requested) return requested
  if (routing) return cacheTtlFromRouting(routing, { credentialMode })
  return cacheTtlFromRoutingFile(routingFile, { credentialMode })
}

const CACHE_TTL_MS = Object.freeze({ '5m': 5 * 60_000, '1h': 60 * 60_000 })
const CONVERSATION_TTL_LIMIT = 10_000
const conversationTtls = new Map()

/**
 * One conversation writes one TTL. Switching mid-conversation re-prices the
 * whole prefix and Anthropic rejects 1h after 5m, so the first resolved value
 * wins until the conversation is idle past that TTL; by then its cache is gone
 * and nothing is lost by re-resolving.
 */
export function pinConversationCacheTtl(conversationKey, ttl, now = Date.now()) {
  const wanted = normalizeCacheTtl(ttl)
  const key = String(conversationKey || '').trim()
  if (!key) return wanted
  const hit = conversationTtls.get(key)
  const pinned = hit && now - hit.at < CACHE_TTL_MS[hit.ttl] ? hit.ttl : wanted
  conversationTtls.delete(key)
  conversationTtls.set(key, { ttl: pinned, at: now })
  if (conversationTtls.size > CONVERSATION_TTL_LIMIT) {
    conversationTtls.delete(conversationTtls.keys().next().value)
  }
  return pinned
}

export function clearConversationCacheTtls() {
  conversationTtls.clear()
}

/**
 * Public Messages only accepts ephemeral { type, ttl }.
 * Official CC 2.1.241 may send `scope` with prompt-caching-scope beta;
 * Haiku and unofficial hops without that beta 400 Extra inputs.
 */
export function sanitizePublicCacheControl(control) {
  if (!control || typeof control !== 'object') return control
  if (control.type && control.type !== 'ephemeral') return control
  const out = { type: 'ephemeral' }
  if (control.ttl != null && String(control.ttl).trim()) out.ttl = control.ttl
  return out
}

export function dropCacheControlScope(control) {
  if (!control || typeof control !== 'object') return control
  if (!Object.prototype.hasOwnProperty.call(control, 'scope')) return control
  const { scope: _scope, ...rest } = control
  return rest
}

function mapCacheControl(node, mapFn) {
  if (!node || typeof node !== 'object' || !node.cache_control) return node
  return { ...node, cache_control: mapFn(node.cache_control) }
}

function sanitizeSystemCacheControl(control) {
  return sanitizePublicCacheControl(control)
}

/** Drop cache_control fields the public Messages schema rejects (scope, …). */
export function stripIllegalCacheControlFields(body) {
  if (!body || typeof body !== 'object') return body
  const out = { ...body }
  if (out.cache_control) out.cache_control = sanitizePublicCacheControl(out.cache_control)
  if (Array.isArray(out.system)) {
    out.system = out.system.map((block) => mapCacheControl(block, sanitizeSystemCacheControl))
  }
  if (Array.isArray(out.tools)) {
    out.tools = out.tools.map((tool) => mapCacheControl(tool, sanitizePublicCacheControl))
  }
  if (Array.isArray(out.messages)) {
    out.messages = out.messages.map((message) => {
      if (!Array.isArray(message?.content)) return message
      return {
        ...message,
        content: message.content.map((block) => mapCacheControl(block, sanitizePublicCacheControl)),
      }
    })
  }
  return out
}
/** Native Claude Code owns final cache markers; Node must not leak stale anchors. */
export function removeCacheControlFields(body) {
  if (!body || typeof body !== 'object') return body
  const out = { ...body }
  delete out.cache_control
  const clearNode = (node) => {
    if (!node || typeof node !== 'object') return node
    const next = { ...node }
    delete next.cache_control
    return next
  }
  if (Array.isArray(out.tools)) out.tools = out.tools.map(clearNode)
  if (Array.isArray(out.system)) out.system = out.system.map(clearNode)
  if (Array.isArray(out.messages)) {
    out.messages = out.messages.map((message) => {
      if (!Array.isArray(message?.content)) return message
      return { ...message, content: message.content.map(clearNode) }
    })
  }
  return out
}

function dropScopeOnNode(node) {
  if (!node || typeof node !== 'object' || !node.cache_control) return node
  if (!Object.prototype.hasOwnProperty.call(node.cache_control, 'scope')) return node
  return { ...node, cache_control: dropCacheControlScope(node.cache_control) }
}

export function stripCacheScopeFields(body) {
  if (!body || typeof body !== 'object') return body
  let changed = false
  const map = (node) => {
    const next = dropScopeOnNode(node)
    if (next !== node) changed = true
    return next
  }
  const out = { ...body }
  if (out.cache_control && Object.prototype.hasOwnProperty.call(out.cache_control, 'scope')) {
    out.cache_control = dropCacheControlScope(out.cache_control)
    changed = true
  }
  if (Array.isArray(out.system)) out.system = out.system.map(map)
  if (Array.isArray(out.tools)) out.tools = out.tools.map(map)
  if (Array.isArray(out.messages)) {
    out.messages = out.messages.map((message) => {
      if (!Array.isArray(message?.content)) return message
      const content = message.content.map(map)
      if (content.some((block, i) => block !== message.content[i])) {
        changed = true
        return { ...message, content }
      }
      return message
    })
  }
  return changed ? out : body
}

function setEphemeralTtlUnlessPinned(control, ttl) {
  if (!control || typeof control !== 'object' || control.type !== 'ephemeral') return control
  if (Object.hasOwn(control, 'ttl') || ttl !== '1h') return control
  return { ...control, ttl: '1h' }
}

/** Anthropic treats a missing ttl as 5m. */
export function ephemeralCacheTtl(control) {
  if (!control || typeof control !== 'object') return null
  return String(control.ttl || '5m').toLowerCase() === '1h' ? '1h' : '5m'
}

function walkCacheNodes(body, mapFn) {
  const out = { ...body }
  if (Array.isArray(out.tools)) out.tools = out.tools.map(mapFn)
  if (Array.isArray(out.system)) out.system = out.system.map(mapFn)
  if (Array.isArray(out.messages)) {
    out.messages = out.messages.map((message) => {
      if (!Array.isArray(message?.content)) return message
      const content = message.content.map(mapFn)
      return content.some((block, i) => block !== message.content[i]) ? { ...message, content } : message
    })
  }
  // Top-level automatic caching is a tail boundary, after explicit block markers.
  if (out.cache_control) out.cache_control = mapFn({ cache_control: out.cache_control })?.cache_control
  return out
}

/** CLIProxy ordering: preserve early 1h; downgrade only 1h after a 5m marker. */
export function enforceCacheTtlOrder(body) {
  if (!body || typeof body !== 'object') return body
  let seen5m = false
  let changed = false
  const fix = (node) => {
    if (!node?.cache_control) return node
    if (ephemeralCacheTtl(node.cache_control) !== '1h') {
      seen5m = true
      return node
    }
    if (!seen5m) return node
    changed = true
    return { ...node, cache_control: { ...node.cache_control, ttl: '5m' } }
  }
  const out = walkCacheNodes(body, fix)
  return changed ? out : body
}

/** Fill TTL only while the gateway owns defaults; never overwrite explicit values. */
export function applyCacheTtlToBody(body, ttl = DEFAULT_CACHE_TTL, { short = false } = {}) {
  if (!body || typeof body !== 'object') return body
  if (short)
    return walkCacheNodes(body, (node) => {
      if (!node?.cache_control || !Object.hasOwn(node.cache_control, 'ttl')) return node
      const { ttl: _ttl, ...control } = node.cache_control
      return { ...node, cache_control: control }
    })
  if (ttl == null) return body
  const target = normalizeCacheTtl(ttl)
  return walkCacheNodes(body, (node) =>
    node?.cache_control ? { ...node, cache_control: setEphemeralTtlUnlessPinned(node.cache_control, target) } : node,
  )
}

export const MESSAGES_BREAKPOINT_MODES = Object.freeze(['off', 'fill', 'rewrite', 'tail', 'cli-hop'])

/**
 * Anthropic only caches a prefix that ends at a breakpoint, so a body with no
 * cache_control at all is billed full price every turn no matter what cache_ttl
 * says. `cache_ttl` fills missing TTL only; this config creates markers.
 */
export const DEFAULT_CACHE_BREAKPOINTS = Object.freeze({
  enabled: true,
  preserve_client: true,
  system_tail: true,
  tools_tail: true,
  messages: 'fill',
})

export function normalizeMessagesBreakpointMode(value) {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
  if (raw === 'off' || raw === 'none' || raw === 'false' || raw === '0' || raw === 'disabled') return 'off'
  if (raw === 'cli-hop' || raw === 'cli' || raw === 'leftover') return 'cli-hop'
  if (raw === 'tail' || raw === 'current-tail' || raw === 'single') return 'tail'
  if (raw === 'rewrite' || raw === 'replace' || raw === 'restamp' || raw === 'auto') return 'rewrite'
  if (raw === 'fill' || raw === 'true' || raw === '1') return 'fill'
  return DEFAULT_CACHE_BREAKPOINTS.messages
}

const bool = (value, fallback) => (value == null ? fallback : value !== false && String(value) !== 'false')

export function normalizeCacheBreakpoints(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  return {
    enabled: bool(src.enabled, DEFAULT_CACHE_BREAKPOINTS.enabled),
    preserve_client: bool(src.preserve_client, DEFAULT_CACHE_BREAKPOINTS.preserve_client),
    system_tail: bool(src.system_tail, DEFAULT_CACHE_BREAKPOINTS.system_tail),
    tools_tail: bool(src.tools_tail, DEFAULT_CACHE_BREAKPOINTS.tools_tail),
    messages: normalizeMessagesBreakpointMode(src.messages),
  }
}

export function cacheBreakpointsFromRouting(routing = {}) {
  return normalizeCacheBreakpoints(routing?.compatibility?.cache_breakpoints)
}

export function cacheBreakpointsFromRoutingFile(filePath) {
  if (!filePath) return normalizeCacheBreakpoints(null)
  try {
    return cacheBreakpointsFromRouting(JSON.parse(fs.readFileSync(filePath, 'utf8')))
  } catch {
    return normalizeCacheBreakpoints(null)
  }
}

/**
 * enforceCacheTtlOrder downgrades a 1h block that lands after a 5m one, so
 * injecting 5m ahead of a caller's 1h breakpoint would silently kill the
 * caller's intent. Inject at the highest tier the body already asks for.
 *
 * Read this from the inbound body: persona rebuilds `system` from a template and
 * drops the caller's blocks, so by outbound time the 1h marker may be gone.
 */
export function highestInboundCacheTtl(body, fallback = DEFAULT_CACHE_TTL) {
  return bodyRequestsHourCache(body) ? '1h' : normalizeCacheTtl(fallback)
}

/**
 * The caller's own system breakpoint, which persona drops when it rebuilds the
 * array. sub2api keeps the last original marker as the closest equivalent
 * boundary; the outbound tail block is that boundary here.
 */
export function callerSystemCacheControl(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.system)) return null
  let found = null
  for (const block of body.system) {
    if (block?.cache_control && typeof block.cache_control === 'object') found = block.cache_control
  }
  return found
}

/** Keep a caller-selected ttl, fill only what is missing. null means "not cacheable". */
function politeEphemeral(control, ttl) {
  if (!control || typeof control !== 'object') return { type: 'ephemeral', ttl }
  if (control.type && control.type !== 'ephemeral') return null
  if (String(control.ttl || '').trim()) return control
  return { ...control, type: 'ephemeral', ttl }
}

function stampNode(node, ttl) {
  if (!node || typeof node !== 'object') return node
  const next = politeEphemeral(node.cache_control, ttl)
  if (!next || next === node.cache_control) return node
  return { ...node, cache_control: next }
}

/** Only the literal boolean enables deferred loading. */
function isDeferredLoadingTool(tool) {
  return tool?.defer_loading === true || tool?.custom?.defer_loading === true
}

/**
 * The tail block is the only position that covers the whole system prefix, and
 * KIN keeps the caller's own system inside the array rather than moving it into
 * messages, so a breakpoint on an earlier block would exclude it.
 */
export function injectSystemTailBreakpoint(body, ttl = DEFAULT_CACHE_TTL) {
  if (typeof body?.system === 'string' && body.system.trim()) {
    return {
      ...body,
      system: [{ type: 'text', text: body.system, cache_control: { type: 'ephemeral', ttl: normalizeCacheTtl(ttl) } }],
    }
  }
  if (!body || typeof body !== 'object' || !Array.isArray(body.system) || body.system.length === 0) return body
  const idx = body.system.length - 1
  const stamped = stampNode(body.system[idx], normalizeCacheTtl(ttl))
  if (stamped === body.system[idx]) return body
  const system = body.system.slice()
  system[idx] = stamped
  return { ...body, system }
}

/**
 * Anthropic silently refuses to cache a prefix shorter than the model minimum,
 * so a breakpoint below it buys nothing while still being visible upstream —
 * and the official 4-block system carries no breakpoint of its own once the
 * agent slot is empty. Ordered longest-match-first; bare `opus-4` must not
 * swallow `opus-4-6`.
 */
const MIN_CACHEABLE_TOKEN_RULES = Object.freeze([
  [/mythos[-_](?:preview|beta)|preview[-_]mythos/, 2048],
  [/opus[-_]?4[-_.]8/, 1024],
  [/opus[-_]?4[-_.]7/, 2048],
  [/opus[-_]?4[-_.]6/, 4096],
  [/opus[-_]?4[-_.]5/, 4096],
  [/opus[-_]?4[-_.]1/, 1024],
  [/opus[-_]?4(?![-_.]?\d)/, 1024],
  [/opus[-_]?5/, 512],
  [/fable[-_]?5/, 512],
  [/mythos[-_]?5/, 512],
  [/sonnet[-_]?5/, 1024],
  [/sonnet[-_]?4(?:[-_.][56])?(?![-_.]?\d)/, 1024],
  [/haiku[-_]?4[-_.]5/, 4096],
  [/3[-_]5[-_]haiku|haiku[-_]?3[-_.]5/, 2048],
])

/** 1024 covers most of the catalog, so an unknown id lands on the common tier. */
export const DEFAULT_MIN_CACHEABLE_TOKENS = 1024

export function minCacheableTokens(model) {
  const id = String(model || '')
    .trim()
    .toLowerCase()
    .replace(/\[1m\]$/, '')
  if (!id) return DEFAULT_MIN_CACHEABLE_TOKENS
  for (const [re, min] of MIN_CACHEABLE_TOKEN_RULES) {
    if (re.test(id)) return min
  }
  return DEFAULT_MIN_CACHEABLE_TOKENS
}

function blockChars(block) {
  if (typeof block === 'string') return block.length
  if (!block || typeof block !== 'object') return 0
  if (typeof block.text === 'string') return block.text.length
  try {
    return JSON.stringify(block).length
  } catch {
    return 0
  }
}

/**
 * Everything upstream hashes ahead of a system breakpoint: tools first, then
 * system. 4 chars per token under-counts CJK, which errs toward not marking —
 * the cheap mistake, since a missed breakpoint only costs a cache miss while a
 * useless one is a permanent shape difference from the official client.
 */
export function estimateCachePrefixTokens(body) {
  let chars = 0
  if (Array.isArray(body?.tools)) for (const tool of body.tools) chars += blockChars(tool)
  if (Array.isArray(body?.system)) for (const block of body.system) chars += blockChars(block)
  else chars += blockChars(body?.system)
  return Math.floor(chars / 4)
}

export function systemPrefixReachesCacheMinimum(body) {
  return estimateCachePrefixTokens(body) >= minCacheableTokens(body?.model)
}

function hasSystemBreakpoint(system) {
  return Array.isArray(system) && system.some((block) => block?.cache_control)
}

/** Anthropic rejects cache_control on a deferred tool. */
function stripDeferredToolCacheControl(body) {
  if (!Array.isArray(body.tools)) return body
  let changed = false
  const tools = body.tools.map((tool) => {
    if (!isDeferredLoadingTool(tool) || !tool?.cache_control) return tool
    changed = true
    const { cache_control: _drop, ...rest } = tool
    return rest
  })
  return changed ? { ...body, tools } : body
}

export function injectToolsTailBreakpoint(body, ttl = DEFAULT_CACHE_TTL) {
  if (!body || typeof body !== 'object') return body
  const out = stripDeferredToolCacheControl(body)
  if (!Array.isArray(out.tools) || out.tools.length === 0) return out
  if (out.tools.some((tool) => tool?.cache_control)) return out
  let idx = -1
  for (let i = 0; i < out.tools.length; i++) {
    const tool = out.tools[i]
    if (!tool || typeof tool !== 'object') continue
    // KIN injects web_search as a server tool and it is often last; server
    // tools and deferred tools both reject the marker.
    if (isDeferredLoadingTool(tool) || isAnthropicServerTool(tool)) continue
    idx = i
  }
  if (idx < 0) return out
  const stamped = stampNode(out.tools[idx], normalizeCacheTtl(ttl))
  if (stamped === out.tools[idx]) return out
  const tools = out.tools.slice()
  tools[idx] = stamped
  return { ...out, tools }
}

function hasMessageBreakpoint(messages) {
  if (!Array.isArray(messages)) return false
  return messages.some(
    (message) => Array.isArray(message?.content) && message.content.some((block) => block?.cache_control),
  )
}

function dropMessageBreakpoints(messages) {
  let changed = false
  const next = messages.map((message) => {
    if (!Array.isArray(message?.content)) return message
    let touched = false
    const content = message.content.map((block) => {
      if (!block || typeof block !== 'object' || !block.cache_control) return block
      touched = true
      const { cache_control: _drop, ...rest } = block
      return rest
    })
    if (!touched) return message
    changed = true
    return { ...message, content }
  })
  return changed ? next : messages
}

/** Promote strings and stamp the last non-thinking content block. */
function stampMessageTail(messages, idx, ttl) {
  const message = messages[idx]
  if (!message || typeof message !== 'object') return messages
  const content = message.content
  if (typeof content === 'string') {
    const next = messages.slice()
    next[idx] = { ...message, content: [{ type: 'text', text: content, cache_control: { type: 'ephemeral', ttl } }] }
    return next
  }
  if (!Array.isArray(content) || content.length === 0) return messages
  let target = -1
  for (let i = content.length - 1; i >= 0; i--) {
    if (content[i]?.type === 'thinking' || content[i]?.type === 'redacted_thinking') continue
    target = i
    break
  }
  if (target < 0) return messages
  const stamped = stampNode(content[target], ttl)
  if (stamped === content[target]) return messages
  const nextContent = content.slice()
  nextContent[target] = stamped
  const next = messages.slice()
  next[idx] = { ...message, content: nextContent }
  return next
}

/** HTTP fill/rewrite preserve anchors; explicit tail replaces message markers. Native CLI bypasses this helper. */
export function applyMessageBreakpoints(body, ttl = DEFAULT_CACHE_TTL, mode = DEFAULT_CACHE_BREAKPOINTS.messages) {
  const resolved = normalizeMessagesBreakpointMode(mode)
  if (resolved === 'off' || resolved === 'cli-hop') return body
  if (!body || !Array.isArray(body.messages) || !body.messages.length) return body
  if (resolved === 'tail') {
    const messages = dropMessageBreakpoints(body.messages)
    const next = stampMessageTail(messages, messages.length - 1, normalizeCacheTtl(ttl))
    return next === body.messages ? body : { ...body, messages: next }
  }
  const messages = body.messages
  let idx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!['user', 'assistant'].includes(message?.role)) continue
    const content = message.content
    if (typeof content !== 'string' && (!Array.isArray(content) || !content.length)) continue
    if (message.role === 'assistant' && ['thinking', 'redacted_thinking'].includes(content?.at?.(-1)?.type)) continue
    idx = i
    break
  }
  if (idx < 0) return body
  const final = messages.at(-1)
  if (final.role === 'system' && typeof final.content === 'string' && final.content.trim()) idx = messages.length - 1
  if (hasMessageBreakpoint([messages[idx]])) return body
  const next = stampMessageTail(messages, idx, normalizeCacheTtl(ttl))
  return next === messages ? body : { ...body, messages: next }
}

/** Fill missing section markers; final outbound assembly handles TTL ordering. */
export function applyCacheBreakpoints(body, { ttl = DEFAULT_CACHE_TTL, config, inbound } = {}) {
  const cfg = normalizeCacheBreakpoints(config)
  if (!cfg.enabled) return body
  const source = inbound && typeof inbound === 'object' ? inbound : body
  const target = highestInboundCacheTtl(source, ttl)
  let out = stripDeferredToolCacheControl(body)
  const hasSystem = Array.isArray(out.system)
    ? out.system.length > 0
    : typeof out.system === 'string' && out.system.trim() !== ''
  if (cfg.tools_tail && !hasSystem) out = injectToolsTailBreakpoint(out, target)
  const caller = cfg.preserve_client ? callerSystemCacheControl(source) : null
  // A template that marks its own boundary (the official agent slot) already has
  // the prefix it wants; a second marker on the tail would only widen it over the
  // caller's --system leftover and burn one of the four slots.
  if (!hasSystemBreakpoint(out.system)) {
    if (caller) {
      out = injectSystemTailBreakpoint(out, caller.ttl ? normalizeCacheTtl(caller.ttl) : target)
    } else if (cfg.system_tail) {
      out = injectSystemTailBreakpoint(out, target)
    }
  }
  out = applyMessageBreakpoints(out, target, cfg.messages)
  return out
}

/** Compatibility export: requested TTL is not evidence of upstream cache usage. */
export function applyCacheTtlToUsage(usage) {
  return usage
}
