// CPA c404af96 amount -> SDK summary -> model-capability application.
// Scoped to Chat; vm routing and unmatched-model policy are deliberately separate.
import snapshot from './chat-cpa-capabilities.json' with { type: 'json' }
import { applyOpenAIReasoningToClaude, mapOpenAIEffortToClaudeEffort } from './thinking.mjs'
import { chatRequestError } from './chat-messages.mjs'

const budgets = { none: 0, auto: -1, minimal: 512, low: 1024, medium: 8192, high: 24576, xhigh: 32768, max: 128000 }
const levelOrder = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

// CPA cross-format suffix validation selects the closest level, preferring lower ties.
function clampSuffixLevel(level, supported) {
  if (supported.includes(level)) return level
  const position = levelOrder.indexOf(level)
  if (position < 0) return level
  let nearest = null
  for (const candidate of levelOrder) {
    if (!supported.includes(candidate)) continue
    const distance = Math.abs(position - levelOrder.indexOf(candidate))
    if (!nearest || distance < nearest.distance) nearest = { level: candidate, distance }
  }
  return nearest?.level || level
}
const at = (body, path) => path.split('.').reduce((value, key) => value?.[key], body)
const googlePaths = [
  'extra_body.google.thinking_config.include_thoughts',
  'extra_body.google.thinking_config.includeThoughts',
  'extra_body.google.thinkingConfig.include_thoughts',
  'extra_body.google.thinkingConfig.includeThoughts',
  'extra_body.extra_body.google.thinking_config.include_thoughts',
  'extra_body.extra_body.google.thinking_config.includeThoughts',
  'google.thinking_config.include_thoughts',
  'google.thinking_config.includeThoughts',
  'thinking.includeThoughts',
  'thinking.include_thoughts',
  'reasoning.includeThoughts',
  'reasoning.include_thoughts',
  'generationConfig.thinkingConfig.includeThoughts',
  'generationConfig.thinkingConfig.include_thoughts',
  'generation_config.thinking_config.include_thoughts',
  'generation_config.thinking_config.includeThoughts',
]

function summaryIntent(source) {
  for (const path of googlePaths) if (typeof at(source, path) === 'boolean') return at(source, path)
  for (const path of ['reasoning.summary', 'reasoning.generate_summary']) {
    const parent = source.reasoning
    const key = path.split('.')[1]
    if (!parent || !Object.hasOwn(parent, key)) continue
    const value = parent[key]
    if (value === null) return false
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase()
      if (normalized === 'none') return false
      if (['auto', 'concise', 'detailed'].includes(normalized)) return true
    }
  }
  if (typeof source.reasoning?.exclude === 'boolean') return !source.reasoning.exclude
  if (typeof source.include_reasoning === 'boolean') return source.include_reasoning
  if (typeof source.reasoning?.enabled === 'boolean') return source.reasoning.enabled
  if (typeof source.reasoning_effort === 'string' && source.reasoning_effort.trim())
    return source.reasoning_effort.trim().toLowerCase() !== 'none'
  return undefined
}

export function splitChatThinkingModel(model) {
  const text = String(model || '')
  const match = text.match(/^(.*)\(([^()]*)\)$/)
  return match ? { model: match[1], suffix: match[2].trim().toLowerCase() } : { model: text, suffix: null }
}

export function applyChatThinking(out, source, { model = out.model, capabilities = snapshot.models } = {}) {
  const parsed = splitChatThinkingModel(model)
  const info = capabilities[parsed.model]
  if (!info) {
    // Owner-approved extension: preserve existing vm capabilities for unlisted models.
    return applyOpenAIReasoningToClaude(out, source)
  }
  const support = info.thinking
  if (!support) return out
  const adaptive = !!support.levels?.length
  const raw = typeof source.reasoning_effort === 'string' ? source.reasoning_effort.trim().toLowerCase() : ''
  const summary = summaryIntent(source)
  let amount = parsed.suffix === '-1' ? 'auto' : (parsed.suffix ?? raw)
  let numeric = parsed.suffix != null && /^\d+$/.test(amount) ? Number(amount) : null
  // Unlike converter-produced body adaptive/auto, explicit suffix auto runs CPA validation.
  if (parsed.suffix != null && amount === 'auto' && !support.dynamic_allowed) {
    if (adaptive && !support.min && !support.max) amount = 'medium'
    else numeric = Math.floor(((support.min || 0) + (support.max || 0)) / 2)
  }
  let thinking
  if (amount === 'none' || numeric === 0) thinking = { type: 'disabled' }
  else if (numeric != null && !support.min && !support.max && adaptive) {
    amount =
      numeric <= 512
        ? 'low'
        : numeric <= 1024
          ? 'low'
          : numeric <= 8192
            ? 'medium'
            : numeric <= 24576
              ? 'high'
              : 'xhigh'
    numeric = null
  }
  if (!thinking && numeric != null) thinking = { type: 'enabled', budget_tokens: numeric }
  else if (!thinking && amount) {
    if (adaptive) {
      thinking = { type: 'adaptive' }
      if (amount !== 'auto') {
        const effort =
          parsed.suffix != null
            ? clampSuffixLevel(amount, support.levels)
            : mapOpenAIEffortToClaudeEffort(amount, { supportsMax: support.levels.includes('max') })
        if (!support.levels.includes(effort))
          throw chatRequestError(`Unsupported reasoning effort ${amount} for ${parsed.model}`)
        out.output_config = { ...(out.output_config || {}), effort }
      }
    } else if (Object.hasOwn(budgets, amount)) {
      thinking = {
        type: 'enabled',
        ...(amount === 'auto' && support.dynamic_allowed
          ? {}
          : {
              budget_tokens:
                amount === 'auto' ? Math.floor(((support.min || 0) + (support.max || 0)) / 2) : budgets[amount],
            }),
      }
    }
  }
  // SDK summary can activate thinking only when no amount explicitly disabled it.
  if (!thinking && summary === true) {
    if (adaptive) thinking = { type: 'adaptive' }
    else if (support.min > 0 && Number(out.max_tokens) > support.min)
      thinking = { type: 'enabled', budget_tokens: support.min }
  }
  if (!thinking) return out
  if (thinking.type === 'enabled' && thinking.budget_tokens != null) {
    let budget = thinking.budget_tokens
    if (support.min) budget = Math.max(support.min, budget)
    if (support.max) budget = Math.min(support.max, budget)
    const max = Number(out.max_tokens) > 0 ? Number(out.max_tokens) : info.max_completion_tokens
    if (!(Number(out.max_tokens) > 0) && max > 0) out.max_tokens = max
    const capped = max > 0 ? Math.min(budget, max - 1) : budget
    if (!(support.min > 0 && capped > 0 && capped < support.min)) budget = capped
    thinking.budget_tokens = budget
  }
  if (thinking.type !== 'disabled' && summary !== undefined) thinking.display = summary ? 'summarized' : 'omitted'
  out.thinking = thinking
  return out
}

/** Executor's translated-traffic controls, without its optional caller-text cloaking. */
export function normalizeChatControls(body) {
  const out = { ...body }
  if (out.tool_choice?.type === 'any' || out.tool_choice?.type === 'tool') {
    delete out.thinking
    if (out.output_config) {
      out.output_config = { ...out.output_config }
      delete out.output_config.effort
      if (!Object.keys(out.output_config).length) delete out.output_config
    }
  }
  delete out.temperature
  delete out.top_p
  delete out.top_k
  return out
}
