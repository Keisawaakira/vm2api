import test from 'node:test'
import assert from 'node:assert/strict'
import { toClaudeMessages } from '../../src/lib/protocol/convert.mjs'
import { prepareCliHopBody } from '../../src/lib/protocol/outbound-attempt.mjs'

const cc = { type: 'ephemeral' }
const longCC = { type: 'ephemeral', ttl: '1h' }
const chat = (body) => toClaudeMessages('openai.chat', { model: 'claude-sonnet-5', ...body }).claude
const fn = (name, extra = {}) => ({ type: 'function', function: { name, ...extra } })

test('CLIProxy message accumulation keeps system blocks/cache and puts tool uses last', () => {
  const body = {
    messages: [
      {
        role: 'developer',
        content: [
          { type: 'text', text: 'a', cache_control: longCC },
          { type: 'text', text: 'b' },
        ],
        cache_control: cc,
      },
      { role: 'user', content: 'hi', cache_control: cc },
      { role: 'assistant', content: 'first', tool_calls: [{ ...fn('read', { arguments: '[]' }), id: 'call.bad/1' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'second', cache_control: longCC }] },
      { role: 'tool', tool_call_id: 'call.bad/1', content: 'stale' },
      {
        role: 'tool',
        tool_call_id: 'call.bad/1',
        content: [
          { type: 'text', text: 'new', cache_control: longCC },
          { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
        ],
        cache_control: cc,
      },
    ],
  }
  const snapshot = structuredClone(body)
  const out = chat(body)
  assert.deepEqual(out.system, [
    { type: 'text', text: 'a', cache_control: longCC },
    { type: 'text', text: 'b', cache_control: cc },
  ])
  assert.equal(out.messages.length, 3)
  assert.deepEqual(out.messages[0].content[0].cache_control, cc)
  assert.deepEqual(
    out.messages[1].content.map((b) => b.type),
    ['text', 'text', 'tool_use'],
  )
  assert.deepEqual(out.messages[1].content[2], { type: 'tool_use', id: 'call_bad_1', name: 'read', input: {} })
  const result = out.messages[2].content[0]
  assert.equal(out.messages[2].content.length, 1)
  assert.equal(result.tool_use_id, 'call_bad_1')
  assert.deepEqual(result.cache_control, longCC)
  assert.deepEqual(result.content, [
    { type: 'text', text: 'new' },
    { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
  ])
  assert.deepEqual(body, snapshot)
})

test('CLIProxy file parts and assistant multimodal blocks survive conversion', () => {
  const file = { type: 'file', file: { file_data: 'data:application/pdf;base64,YQ==' }, cache_control: cc }
  const out = chat({
    messages: [
      { role: 'user', content: [file] },
      { role: 'assistant', content: [file] },
    ],
  })
  for (const msg of out.messages)
    assert.deepEqual(msg.content, [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'YQ==' }, cache_control: cc },
    ])
})

test('CLIProxy tool schemas/strict/allowed_tools/parallel flags map together', () => {
  const out = chat({
    messages: [{ role: 'user', content: 'hi' }],
    tools: [
      fn('drop'),
      fn('keep', {
        parametersJsonSchema: { allOf: [{ type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }] },
        strict: true,
      }),
    ],
    tool_choice: {
      type: 'allowed_tools',
      allowed_tools: { mode: 'required', tools: [{ type: 'function', function: { name: 'keep' } }] },
    },
    parallel_tool_calls: false,
  })
  assert.equal(out.tools.length, 1)
  assert.deepEqual(out.tools[0].input_schema, {
    type: 'object',
    properties: { q: { type: 'string' } },
    required: ['q'],
  })
  assert.equal(out.tools[0].strict, true)
  assert.deepEqual(out.tool_choice, { type: 'any', disable_parallel_tool_use: true })
  assert.deepEqual(
    chat({ tools: [fn('a')], tool_choice: { type: 'function' }, parallel_tool_calls: false }).tool_choice,
    { type: 'none' },
  )
  assert.deepEqual(chat({ tools: [fn('a')], parallel_tool_calls: false }).tool_choice, {
    type: 'auto',
    disable_parallel_tool_use: true,
  })
  const empty = chat({ tools: [fn('a')], tool_choice: { type: 'allowed_tools', tools: [] } })
  assert.equal(empty.tools, undefined)
  assert.deepEqual(empty.tool_choice, { type: 'none' })
})

test('CLIProxy system-only input has a conversational turn; unsigned reasoning is not replayed', () => {
  assert.equal(chat({ messages: [{ role: 'system', content: 'rules' }] }).messages.length, 1)
  const out = chat({
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'answer', reasoning_content: 'unsigned' },
    ],
  })
  assert.deepEqual(out.messages[1].content, [{ type: 'text', text: 'answer' }])
})

test('effort normalizes whitespace, keeps max at the CLI hop and respects summary exclusion', () => {
  const out = chat({
    messages: [{ role: 'user', content: 'hi' }],
    reasoning_effort: ' MAX ',
    reasoning: { exclude: true },
  })
  const hop = prepareCliHopBody(out)
  assert.equal(hop.output_config.effort, 'max')
  assert.deepEqual(hop.thinking, { type: 'adaptive', display: 'omitted' })
})

test('adaptive model/effort matrix survives the complete CLI body preparation', () => {
  for (const model of [
    'claude-sonnet-4-6',
    'claude-opus-4-6',
    'claude-opus-4-7',
    'claude-opus-4-8',
    'claude-sonnet-5',
    'claude-opus-5',
    'claude-fable-5',
  ]) {
    for (const [reasoning_effort, effort] of Object.entries({
      minimal: 'low',
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'max',
      max: 'max',
    })) {
      const out = prepareCliHopBody(chat({ model, reasoning_effort, messages: [{ role: 'user', content: 'hi' }] }))
      assert.equal(out.output_config.effort, effort, `${model}/${reasoning_effort}`)
      assert.deepEqual(out.thinking, { type: 'adaptive', display: 'summarized' })
    }
  }
})

test('Chat token/stop/sampling parameters follow CLIProxy; explicit token ceilings win', () => {
  assert.equal(chat({}).max_tokens, 32000)
  const out = chat({ max_tokens: 1234, max_completion_tokens: 5678, temperature: 0.4, top_p: 0.7, stop: 'END' })
  assert.equal(out.max_tokens, 1234)
  assert.equal(out.temperature, undefined)
  assert.equal(out.top_p, 0.7)
  assert.deepEqual(out.stop_sequences, ['END'])
})

test('tool argument fallback never emits arrays, null, or raw invalid JSON as input', () => {
  for (const args of ['null', '[]', '123', '{broken', '{}', '{"x":1}']) {
    const out = chat({ messages: [{ role: 'assistant', tool_calls: [{ ...fn('f', { arguments: args }), id: 'a' }] }] })
    assert.deepEqual(out.messages.at(-1).content[0].input, args === '{"x":1}' ? { x: 1 } : {})
  }
})

test('legacy budget matches CLIProxy and fits the total max_tokens without raising caller ceiling', () => {
  const out = chat({ model: 'claude-haiku-4-5-20251001', reasoning_effort: 'high', max_completion_tokens: 32000 })
  assert.equal(out.thinking.budget_tokens, 24576)
  const limited = chat({ model: 'claude-haiku-4-5-20251001', reasoning_effort: 'max', max_tokens: 8000 })
  assert.equal(limited.max_tokens, 8000)
  assert.equal(limited.thinking.budget_tokens, 7999)
  assert.equal(chat({ reasoning_effort: 'auto' }).output_config?.effort, undefined)
})
