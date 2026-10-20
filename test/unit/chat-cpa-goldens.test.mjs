import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  toClaudeMessages,
  createOpenAIChatStreamState,
  claudeSSELineToOpenAIChatChunks,
  finishOpenAIChatStream,
  createClaudeMessageAssembler,
  applyClaudeSSELineToMessage,
  fromClaudeToOpenAIChat,
} from '../../src/lib/protocol/convert.mjs'
const inputs = JSON.parse(fs.readFileSync(new URL('../fixtures/cpa/inputs.json', import.meta.url)))
const goldens = JSON.parse(fs.readFileSync(new URL('../fixtures/cpa/goldens.json', import.meta.url)))
const clock = (value) => JSON.parse(JSON.stringify(value, (key, value) => (key === 'created' ? 0 : value)))

for (const input of inputs) {
  const golden = goldens.cases.find((g) => g.id === input.id)
  if (input.inputRawJSON && !input.exception)
    test(`CPA registered request/summary/thinking: ${input.id}`, {
      skip:
        !golden.capability && !input.model.includes('(')
          ? 'Unlisted CPA model: vm compatibility exception tested separately'
          : false,
    }, () => {
      const source = JSON.parse(input.inputRawJSON)
      // Unknown CPA aliases use vm's existing capability policy, not CPA's user-defined fallback.
      if (golden.thinkingError) {
        assert.throws(() => toClaudeMessages('openai.chat', source), { code: 'invalid_chat_request' })
        return
      }
      const actual = toClaudeMessages('openai.chat', source).claude
      // Named native identity exception: caller-controlled CPA metadata is not sent to a slot.
      assert.equal(actual.metadata, undefined)
      const { metadata, ...expected } = golden.thinking
      assert.ok(metadata.user_id)
      assert.deepEqual(actual, expected)
    })
  if (input.events && !input.exception) {
    test(`CPA registered streaming response: ${input.id}`, () => {
      const state = createOpenAIChatStreamState(input.model)
      const actual = input.events.flatMap((e) => claudeSSELineToOpenAIChatChunks(`data: ${JSON.stringify(e)}`, state))
      // Negotiated usage exception: CPA's unsolicited trailer is omitted without include_usage.
      assert.deepEqual(clock(actual), clock(golden.chunks.filter((c) => c.choices.length)))
      assert.deepEqual(finishOpenAIChatStream(state), [])
    })
    test(`CPA buffered SSE response: ${input.id}`, () => {
      const state = createClaudeMessageAssembler({ chat: true })
      for (const e of input.events) applyClaudeSSELineToMessage(`data: ${JSON.stringify(e)}`, state)
      assert.deepEqual(clock(fromClaudeToOpenAIChat(state.message, input.model)), clock(golden.buffered))
    })
  }
}

test('unsupported nontext caller systems fail explicitly, text extensions preserve empty blocks', () => {
  for (const content of [
    null,
    42,
    {},
    [{ type: 'image_url', image_url: { url: 'https://example.invalid/image' } }],
    [{ type: 'text', text: 42 }],
  ])
    assert.throws(() => toClaudeMessages('openai.chat', { messages: [{ role: 'system', content }] }), {
      code: 'invalid_chat_request',
    })
  const texts = ['', '  ', '\n\n']
  const { claude } = toClaudeMessages('openai.chat', {
    messages: [
      {
        role: 'developer',
        content: [texts[0], { type: 'input_text', text: texts[1] }, { type: 'output_text', text: texts[2] }],
      },
    ],
  })
  assert.deepEqual(
    claude.system.map((b) => b.text),
    texts,
  )
})

test('pinned capability snapshot is an exact projection of the executable CPA registry', async () => {
  const { default: snapshot } = await import('../../src/lib/protocol/chat-cpa-capabilities.json', {
    with: { type: 'json' },
  })
  assert.equal(snapshot.reference, goldens.reference)
  assert.deepEqual(
    snapshot.models,
    Object.fromEntries(
      goldens.capabilities.map((c) => [
        c.id,
        { thinking: c.thinking || null, max_completion_tokens: c.max_completion_tokens },
      ]),
    ),
  )
})
test('unlisted vm model uses existing capability mapping, not an invented CPA max capability', async () => {
  const { applyChatThinking } = await import('../../src/lib/protocol/chat-thinking.mjs')
  const { applyOpenAIReasoningToClaude } = await import('../../src/lib/protocol/thinking.mjs')
  const source = { reasoning_effort: 'max' }
  const expected = { model: 'claude-sonnet-4-5', max_tokens: 8000 }
  applyOpenAIReasoningToClaude(expected, source)
  assert.deepEqual(applyChatThinking({ model: 'claude-sonnet-4-5', max_tokens: 8000 }, source), expected)
  const configured = applyChatThinking({ model: 'limited' }, source, {
    capabilities: { limited: { thinking: { levels: ['low', 'medium', 'high'] } } },
  })
  assert.equal(configured.output_config.effort, 'high')
})
test('Haiku disabled is only a CLI exception and forced choices retain caller intent', async () => {
  const { prepareCliHopBody } = await import('../../src/lib/protocol/outbound-attempt.mjs')
  const input = JSON.parse(inputs.find((c) => c.id === 'claude-haiku-4-5-20251001-high').inputRawJSON)
  const body = toClaudeMessages('openai.chat', input).claude
  assert.equal(body.thinking.type, 'enabled')
  assert.deepEqual(prepareCliHopBody(body, { chatPreserve: true }).thinking, { type: 'disabled' })
})

test('initial message tool accepts raw deltas rather than losing or joining them with initial input', () => {
  const state = createOpenAIChatStreamState('claude-sonnet-4-6')
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'initial-tool',
        model: 'upstream',
        content: [{ type: 'tool_use', id: 't', name: 'f', input: { old: true } }],
      },
    },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{ "new": true }' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
  ]
  const tools = events
    .flatMap((e) => claudeSSELineToOpenAIChatChunks(`data: ${JSON.stringify(e)}`, state))
    .flatMap((c) => c.choices?.[0]?.delta?.tool_calls || [])
  assert.equal(tools.length, 1)
  assert.equal(tools[0].function.arguments, '{ "new": true }')
})
