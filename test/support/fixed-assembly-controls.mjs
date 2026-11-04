import assert from 'node:assert/strict'
import vm from 'node:vm'
import { requestWireApiControl } from './fixed-request-wire-api.mjs'
import { verifyRequestWireSource } from './fixed-request-wire-controls.mjs'

const plain = (value) => JSON.parse(JSON.stringify(value))

function referenceAssembler(source) {
  const init = source.indexOf('var init_requestBody ='),
    brace = source.indexOf('{', init),
    end = source.lastIndexOf('});')
  assert.ok(init > 0 && brace > init && end > brace)
  const ctx = vm.createContext({ Object, Array })
  vm.runInContext(source.slice(0, init) + source.slice(brace + 1, end), ctx)
  return (input) => plain(ctx.assembleMessageRequest(input))
}

/** The reference assembler and each current native constructor execute actual
 * extracted code. Only SDK/config/runtime boundaries are mocked. */
export async function verifyAssemblySource(sem, kind) {
  assert.equal(sem.request_wire.assembly_contract, 'caller_optional_fields_v1')
  const assemble = referenceAssembler(sem.request_wire.reference_assembly)
  const coreBody = {
    model: 'claude-opus-4-6',
    max_tokens: 128000,
    system: [
      { type: 'text', text: '# Environment\nKEEP_CALLER' },
      { type: 'text', text: '  格式规则  ' },
    ],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'neutral fixture' }] }],
  }
  let checks = 1
  const variants = [
    {},
    { thinking: { type: 'enabled', budget_tokens: 60000, display: 'summarized' } },
    { thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'max' } },
    { thinking: { type: 'disabled' }, output_config: { effort: 'high' } },
    { tools: [], tool_choice: { type: 'auto' }, thinking: { type: 'adaptive' } },
    { tools: null, tool_choice: null, thinking: null, output_config: null, context_management: null, safeguards: null },
    {
      tools: [{ name: 'KeepTool', input_schema: { type: 'object' }, eager_input_streaming: false }],
      tool_choice: { type: 'tool', name: 'KeepTool' },
    },
    { stop_sequences: [], temperature: 0, top_p: 0, top_k: 0 },
    { stop_sequences: null, temperature: null, top_p: null, top_k: null },
    {
      context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] },
      thinking: { type: 'adaptive' },
    },
    { fallbacks: 'default', fallback_credit_token: 'fixture-credit' },
    { fallbacks: ['claude-sonnet-4-6'] },
    { fallbacks: [], fallback_credit_token: '' },
    { speed: 'fast', model: 'claude-opus-5-5', diagnostics: { cache: true } },
    {
      output_config: {
        effort: 'max',
        task_budget: { type: 'tokens', total: 15 },
        format: { type: 'json_schema', schema: { type: 'object' } },
      },
    },
    {
      messages: [
        { role: 'system', content: [], output_config: { effort: 'low' } },
        ...coreBody.messages,
        { role: 'system', content: [], output_config: { effort: 'max' } },
      ],
      model: 'claude-opus-5-5',
    },
    { metadata: { user_id: 'caller-id', ordinary: 'keep', __vm2api_cc_trace: 'private-control' } },
    { safeguards: [], stop_sequences: ['</content>'], service_tier: 'standard', thread: { id: 'fixture' } },
  ]
  for (const variant of variants) {
    const body = { ...structuredClone(coreBody), ...structuredClone(variant) }
    const before = JSON.stringify(body)
    const { result, calls } = requestWireApiControl(sem, { body })
    const outputConfig = body.output_config && typeof body.output_config === 'object' ? body.output_config : {}
    const metadata = { ...(body.metadata || {}), user_id: 'fixture-host-identity' }
    if (kind === 'cc') delete metadata.__vm2api_cc_trace
    const expected = assemble({
      model: body.model,
      messages: body.messages,
      system: body.system,
      tools: body.tools || [],
      tool_choice: body.tool_choice,
      betas: result.betas,
      metadata,
      max_tokens: body.max_tokens,
      thinking: body.thinking,
      temperature: body.temperature,
      top_p: body.top_p,
      top_k: body.top_k,
      stop_sequences: body.stop_sequences,
      context_management: body.context_management,
      extraBodyParams: {},
      wireBody: body,
      safeguards: body.safeguards,
      outputConfig,
      speed: undefined,
    })
    assert.deepEqual(result, expected, `${kind} native assembly ${JSON.stringify(variant)}`)
    checks++
    assert.equal(JSON.stringify(body), before, 'The reference and native constructor cannot mutate caller input')
    checks++
    assert.equal(calls.configureEffort, 0)
    checks++
    for (const key of [
      'tools',
      'tool_choice',
      'thinking',
      'temperature',
      'top_p',
      'top_k',
      'stop_sequences',
      'context_management',
      'output_config',
      'safeguards',
    ]) {
      assert.equal(Object.hasOwn(result, key), Object.hasOwn(expected, key), key)
      checks++
    }
    if (body.fallbacks === 'default') assert.ok(result.betas.includes('server-side-fallback-2026-07-01'))
    else if (Array.isArray(body.fallbacks) && body.fallbacks.length)
      assert.ok(result.betas.includes('server-side-fallback-2026-06-01'))
    if (body.fallback_credit_token) assert.ok(result.betas.includes('fallback-credit-2026-06-01'))
    if (body.messages.some((m) => m.output_config)) {
      assert.ok(result.betas.includes('mid-conversation-output-config-2026-07-01'))
      assert.ok(result.betas.includes('effort-2025-11-24'))
      assert.deepEqual(result.messages, body.messages)
      checks += 3
    }
    assert.equal(Object.hasOwn(result, 'wireBody'), false)
    checks++
    assert.equal(Object.hasOwn(result, 'request_context'), false)
    checks++
  }
  const operatorExtra = {
    temperature: 0.7,
    tools: [{ name: 'extra-only', input_schema: {} }],
    context_management: null,
    service_tier: 'priority',
  }
  const extraResult = requestWireApiControl(sem, { body: coreBody, extraBody: operatorExtra }).result
  const extraExpected = assemble({
    ...coreBody,
    tools: [],
    betas: extraResult.betas,
    metadata: { user_id: 'fixture-host-identity' },
    outputConfig: {},
    extraBodyParams: operatorExtra,
    wireBody: coreBody,
  })
  assert.deepEqual(extraResult, extraExpected, 'Operator extra-body precedence follows the exact reference')
  checks++
  if (kind === 'cc') {
    assert.ok(sem.request_wire.previous_params)
    const previous = {
      ...sem,
      request_wire: {
        ...sem.request_wire,
        params: sem.request_wire.previous_params,
        helpers: sem.request_wire.previous_helpers,
      },
    }
    for (const variant of [
      {},
      { thinking: { type: 'disabled' } },
      { thinking: { type: 'enabled', budget_tokens: 4096 } },
      { output_config: { effort: 'high' }, stop_sequences: ['END'] },
    ]) {
      const body = { ...coreBody, ...variant }
      const options = { wireBody: undefined, wireMessages: undefined, honorCallerThinking: false }
      const old = requestWireApiControl(previous, { body, options })
      const current = requestWireApiControl(sem, { body, options })
      assert.deepEqual(current, old, 'CC non-native path retains its previous construction')
      checks++
    }
  }
  const preserved = await verifyRequestWireSource(sem, kind)
  return {
    ok: true,
    kind,
    checks: checks + preserved.checks,
    assembly_checks: checks,
    preserved_checks: preserved.checks,
    scope: 'actual stock assembler, current native constructor and retained controls; no real SDK/provider/Linux ELF',
  }
}
