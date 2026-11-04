import test from 'node:test'
import assert from 'node:assert/strict'
import * as convert from '../../src/lib/protocol/convert.mjs'

const wire = (event) => `data: ${JSON.stringify(event)}`
const chunk = (state, event) => convert.claudeSSELineToOpenAIChatChunks(wire(event), state)
const stateFor = (options) => convert.createOpenAIChatStreamState('claude-opus-4-6', 'vm-test', options)

test('usage-only/null/blank stop deltas never terminate Chat output', () => {
  const state = stateFor()
  for (const delta of [{}, { stop_reason: null }, { stop_reason: '' }, { stop_reason: '  ' }]) {
    const out = chunk(state, { type: 'message_delta', delta, usage: { output_tokens: 10 } })
    assert.ok(out.every((c) => c.choices?.[0]?.finish_reason == null))
  }
  const text = chunk(state, {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'still generating' },
  })
  assert.equal(text[0].choices[0].delta.content, 'still generating')
  const finish = chunk(state, {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { output_tokens: 20 },
  })
  assert.equal(finish[0].choices[0].finish_reason, 'stop')
  const repeated = chunk(state, {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { output_tokens: 20 },
  })
  assert.ok(repeated.every((c) => c.choices?.[0]?.finish_reason == null))
})

test('stream usage retains start input/cache when later deltas report only output', () => {
  const state = stateFor()
  chunk(state, {
    type: 'message_start',
    message: {
      type: 'message',
      role: 'assistant',
      content: [],
      usage: { input_tokens: 138885, cache_read_input_tokens: 67215, cache_creation_input_tokens: 0, output_tokens: 0 },
    },
  })
  const out = chunk(state, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 185 } })
  assert.equal(out[0].usage.prompt_tokens, 206100)
  assert.equal(out[0].usage.prompt_tokens_details.cached_tokens, 67215)
  assert.equal(out[0].usage.completion_tokens, 185)
  assert.deepEqual(chunk(state, { type: 'message_stop' }), [])
})

test('opt-in trailing usage is finalized once after authoritative transport metadata', () => {
  const state = stateFor({ includeUsage: true })
  chunk(state, {
    type: 'message_start',
    message: { usage: { input_tokens: 80, cache_read_input_tokens: 20, output_tokens: 1 } },
  })
  const finish = chunk(state, {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { output_tokens: 6 },
  })
  assert.equal(finish[0].usage, null)
  assert.deepEqual(chunk(state, { type: 'message_stop' }), [])
  const tail = convert.finishOpenAIChatStream(state, {
    input_tokens: 10,
    cache_read_input_tokens: 90,
    output_tokens: 9,
  })
  assert.equal(tail.length, 1)
  assert.deepEqual(tail[0].choices, [])
  assert.equal(tail[0].usage.prompt_tokens, 100)
  assert.equal(tail[0].usage.prompt_tokens_details.cached_tokens, 90)
  assert.equal(tail[0].usage.total_tokens, 109)
  assert.deepEqual(convert.finishOpenAIChatStream(state), [])
  assert.deepEqual(convert.finishOpenAIChatStream(stateFor()), [])
})

test('non-empty initial text and thinking blocks are preserved', () => {
  const state = stateFor()
  const text = chunk(state, {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: 'full initial text' },
  })
  assert.equal(text[0]?.choices[0].delta.content, 'full initial text')
  const thought = chunk(state, {
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'thinking', thinking: 'initial thought' },
  })
  assert.equal(thought[0].choices[0].delta.reasoning_content, 'initial thought')
})

for (const hasDeltas of [false, true]) {
  test(`initial tool arguments ${hasDeltas ? 'yield to deltas' : 'survive without deltas'}`, () => {
    const state = stateFor()
    const output = chunk(state, {
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'tool_use', id: 't1', name: 'read', input: { path: 'a' } },
    })
    assert.deepEqual(output, [], 'CPA waits for block_stop before emitting a complete tool')
    if (hasDeltas) {
      for (const partial_json of ['{"path":', '"b"}'])
        output.push(
          ...chunk(state, { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json } }),
        )
    }
    output.push(...chunk(state, { type: 'content_block_stop', index: 2 }))
    assert.equal(output[0].choices[0].delta.tool_calls[0].id, 't1')
    const args = output
      .flatMap((c) => c.choices?.[0]?.delta?.tool_calls || [])
      .map((call) => call.function?.arguments || '')
      .join('')
    assert.deepEqual(JSON.parse(args), { path: hasDeltas ? 'b' : 'a' })
  })
}

test('interleaved tool blocks keep pending initial input isolated', () => {
  const state = stateFor()
  const input = [
    {
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'tool_use', id: 't1', name: 'read', input: { path: 'a' } },
    },
    { type: 'content_block_start', index: 4, content_block: { type: 'tool_use', id: 't2', name: 'read', input: {} } },
    { type: 'content_block_delta', index: 4, delta: { type: 'input_json_delta', partial_json: '{"path":"b"}' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'content_block_stop', index: 4 },
  ]
  const calls = input.flatMap((event) => chunk(state, event)).flatMap((c) => c.choices?.[0]?.delta?.tool_calls || [])
  for (const [index, path] of [
    [0, 'a'],
    [1, 'b'],
  ]) {
    const args = calls
      .filter((call) => call.index === index)
      .map((call) => call.function.arguments || '')
      .join('')
    assert.deepEqual(JSON.parse(args), { path })
  }
})

test('upstream SSE error is forwarded once, with no later success/usage', () => {
  const state = stateFor({ includeUsage: true })
  const event = { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }
  const out = chunk(state, event)
  assert.equal(out[0]?.error.type, 'overloaded_error')
  assert.equal(out[0]?.error.message, 'Overloaded')
  assert.deepEqual(chunk(state, event), [])
  assert.deepEqual(chunk(state, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }), [])
  assert.deepEqual(convert.finishOpenAIChatStream(state, { output_tokens: 2 }), [])
})

test('legacy completions preserve provider error chunks', () => {
  const out = convert.claudeSSELineToOpenAICompletionChunks(
    wire({ type: 'error', error: { type: 'api_error', message: 'provider failed' } }),
    convert.createOpenAICompletionStreamState('claude-opus-4-6', 'vm-test'),
  )
  assert.equal(out[0]?.error.message, 'provider failed')
})

test('assembler records actual stop/error events and merges nested usage', () => {
  const state = convert.createClaudeMessageAssembler()
  convert.applyClaudeSSELineToMessage(
    wire({
      type: 'message_start',
      message: {
        type: 'message',
        role: 'assistant',
        content: [],
        usage: { input_tokens: 5, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 0 } },
      },
    }),
    state,
  )
  convert.applyClaudeSSELineToMessage(
    wire({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'message_stop is just text' } }),
    state,
  )
  assert.equal(state.sawMessageStop, false)
  convert.applyClaudeSSELineToMessage(
    wire({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { cache_creation: { ephemeral_1h_input_tokens: 10 }, output_tokens: 2 },
    }),
    state,
  )
  assert.deepEqual(state.message.usage.cache_creation, {
    ephemeral_5m_input_tokens: 100,
    ephemeral_1h_input_tokens: 10,
  })
  convert.applyClaudeSSELineToMessage(wire({ type: 'error', error: { type: 'api_error', message: 'failure' } }), state)
  convert.applyClaudeSSELineToMessage(wire({ type: 'message_stop' }), state)
  assert.equal(state.sawMessageStop, true)
  assert.equal(state.error?.message, 'failure')
})

test('terminal stop safely flushes pending initial tool input once without block_stop', () => {
  const state = stateFor()
  const out = chunk(state, {
    type: 'content_block_start',
    index: 3,
    content_block: { type: 'tool_use', id: 't1', name: 'read', input: { path: 'a' } },
  })
  out.push(...chunk(state, { type: 'message_delta', delta: { stop_reason: 'tool_use' } }))
  out.push(...chunk(state, { type: 'message_stop' }))
  const args = out
    .flatMap((c) => c.choices?.[0]?.delta?.tool_calls || [])
    .map((call) => call.function.arguments || '')
    .join('')
  assert.deepEqual(JSON.parse(args), { path: 'a' })
  assert.equal(out.filter((c) => c.choices?.[0]?.finish_reason).length, 1)
})

test('EOF finalization bridges only an actual reported stop and never duplicates it', () => {
  const state = stateFor({ includeUsage: true })
  chunk(state, { type: 'message_start', message: { usage: { input_tokens: 5 } } })
  assert.deepEqual(convert.finishOpenAIChatStream(state, { output_tokens: 2 }), [])
  assert.deepEqual(convert.finishOpenAIChatStream(state, undefined, '  '), [])
  const out = convert.finishOpenAIChatStream(state, undefined, 'max_tokens')
  assert.equal(out.length, 2)
  assert.equal(out[0].choices[0].finish_reason, 'length')
  assert.equal(out[0].usage, null)
  assert.deepEqual(out[1].choices, [])
  assert.equal(out[1].usage.total_tokens, 7)
  assert.deepEqual(convert.finishOpenAIChatStream(state, undefined, 'max_tokens'), [])
})
