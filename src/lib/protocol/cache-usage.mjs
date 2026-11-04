/** Upstream cache-write evidence. A configured TTL is never a usage measurement. */
export function cacheCreationUsage(usage = {}) {
  const number = (value) =>
    value != null && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null
  const nested = usage.cache_creation || {}
  const five = number(nested.ephemeral_5m_input_tokens) ?? number(usage.cache_creation_5m_tokens)
  const hour = number(nested.ephemeral_1h_input_tokens) ?? number(usage.cache_creation_1h_tokens)
  const total = number(usage.cache_creation_input_tokens ?? usage.cache_creation_tokens) ?? (five || 0) + (hour || 0)
  const unclassified = Math.max(0, total - (five || 0) - (hour || 0))
  return {
    cache_creation_5m_tokens: five,
    cache_creation_1h_tokens: hour,
    cache_creation_unclassified_tokens: unclassified,
    cache_creation_estimated: unclassified > 0,
  }
}
