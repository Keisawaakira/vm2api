import test from 'node:test'
import assert from 'node:assert/strict'
import { toClaudeMessages } from '../../src/lib/protocol/convert.mjs'
import { prepareAnthropicRequest } from '../../src/lib/protocol/anthropic-policy.mjs'
import { prepareCliHopBody } from '../../src/lib/protocol/outbound-attempt.mjs'
import { applyOpenAIReasoningToClaude, openaiReasoningToClaudeThinking } from '../../src/lib/protocol/thinking.mjs'

function chat(model, extra = {}) {
  return toClaudeMessages('openai.chat', {
    model,
    messages: [{ role: 'user', content: 'hi' }],
    ...extra,
  }).claude
}

test('chat reasoning_effort max on Sonnet 5 is adaptive + output_config.effort max', () => {
  const claude = chat('claude-sonnet-5', { reasoning_effort: 'max' })
  assert.equal(claude.thinking.type, 'adaptive')
  assert.equal(claude.thinking.display, 'summarized')
  assert.equal(claude.output_config.effort, 'max')
  assert.equal(claude.thinking.budget_tokens, undefined)
})

test('CPA Chat accepts top-level effort only; nested reasoning.effort does not enable thinking', () => {
  const claude = chat('claude-opus-5', { reasoning: { effort: 'max' } })
  assert.equal(claude.thinking, undefined)
  assert.equal(claude.output_config, undefined)
})

test('chat reasoning_effort xhigh on Fable 5 maps to effort max', () => {
  const claude = chat('claude-fable-5', { reasoning_effort: 'xhigh' })
  assert.equal(claude.thinking.type, 'adaptive')
  assert.equal(claude.output_config.effort, 'max')
})

test('chat reasoning_effort high stays high on Sonnet 4.6', () => {
  const claude = chat('claude-sonnet-4-6', { reasoning_effort: 'high' })
  assert.equal(claude.thinking.type, 'adaptive')
  assert.equal(claude.output_config.effort, 'high')
})

test('chat reasoning_effort none disables thinking', () => {
  const claude = chat('claude-sonnet-5', { reasoning_effort: 'none' })
  assert.equal(claude.thinking.type, 'disabled')
  assert.equal(claude.output_config?.effort, undefined)
})

test('chat reasoning_effort max survives unofficial fill and cli-hop fill', () => {
  const claude = chat('claude-sonnet-5', { reasoning_effort: 'max', max_tokens: 128000 })
  const unofficial = prepareAnthropicRequest(claude, { unofficial: true })
  assert.equal(unofficial.thinking.type, 'adaptive')
  assert.equal(unofficial.thinking.display, 'summarized')
  assert.equal(unofficial.output_config.effort, 'max')

  const hop = prepareCliHopBody(claude)
  assert.equal(hop.thinking.type, 'adaptive')
  assert.equal(hop.thinking.display, 'summarized')
  assert.equal(hop.output_config.effort, 'max')
})

test('chat reasoning_effort max on Haiku stays enabled+budget and strips effort', () => {
  const claude = chat('claude-haiku-4-5-20251001', { reasoning_effort: 'max' })
  assert.equal(claude.thinking.type, 'enabled')
  assert.equal(claude.thinking.budget_tokens, claude.max_tokens - 1)
  assert.equal(claude.thinking.display, 'summarized')
  const unofficial = prepareAnthropicRequest(claude, { unofficial: true })
  assert.equal(unofficial.thinking.type, 'enabled')
  assert.equal(unofficial.output_config?.effort, undefined)
})

test('CPA Chat response_format is a separate generated instruction, effort remains output_config', () => {
  const claude = chat('claude-sonnet-5', {
    reasoning_effort: 'max',
    response_format: { type: 'json_object' },
  })
  assert.equal(claude.output_config.effort, 'max')
  assert.equal(claude.output_config.format, undefined)
  assert.match(claude.system.at(-1).text, /^You must format your entire response as a valid JSON object\./)
})

test('responses reasoning_effort max uses the same adaptive mapping', () => {
  const { claude } = toClaudeMessages('openai.responses', {
    model: 'claude-sonnet-5',
    input: 'hi',
    reasoning_effort: 'max',
  })
  assert.equal(claude.thinking.type, 'adaptive')
  assert.equal(claude.output_config.effort, 'max')
})

test('openaiReasoningToClaudeThinking still returns the thinking object', () => {
  const thinking = openaiReasoningToClaudeThinking({
    model: 'claude-sonnet-5',
    reasoning_effort: 'max',
  })
  assert.equal(thinking.type, 'adaptive')
  assert.equal(thinking.display, 'summarized')
  const disabled = openaiReasoningToClaudeThinking({ reasoning_effort: 'off' })
  assert.equal(disabled.type, 'disabled')
  assert.equal(openaiReasoningToClaudeThinking({}), null)
})

test('applyOpenAIReasoningToClaude is a no-op without effort', () => {
  const out = { model: 'claude-sonnet-5' }
  applyOpenAIReasoningToClaude(out, { messages: [] })
  assert.equal(out.thinking, undefined)
  assert.equal(out.output_config, undefined)
})
