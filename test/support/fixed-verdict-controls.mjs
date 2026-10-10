import assert from 'node:assert/strict'
import vm from 'node:vm'
import path from 'node:path'
import { lifecycleContext, nativeWireType } from './fixed-lifecycle-controls.mjs'
import { verifyClassifierSource } from './fixed-classifier-controls.mjs'
import { verifyCCSessionSource } from './fixed-cc-session-controls.mjs'

export function nativeValidator(helpers, kind) {
  const context = vm.createContext({ structuredClone })
  vm.runInContext(
    helpers + `\nglobalThis.validate=${kind === 'cc' ? '__vm2apiClassifier194.valid' : 'validClassifierContext'}`,
    context,
  )
  return context.validate
}

export async function verifyVerdictSource(semantics, kind) {
  const cls = semantics.classifier
  const validate = nativeValidator(cls.classifierHelpers, kind)
  const context = { purpose: 'auto_mode_classifier', format: 'xml', stage: 'xml_s1' }
  const request = {
    model: 'claude-sonnet-4-6',
    system: [{ type: 'text', text: 'Use <severity>N</severity>' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: '<transcript>\nRead {}\n</transcript>' }] }],
    max_tokens: 64,
    thinking: { type: 'disabled' },
    stop_sequences: ['</severity>'],
  }
  let checks = 0
  const reference = semantics.verdict?.reference_helpers
    ? nativeValidator(semantics.verdict.reference_helpers, 'wrap')
    : null
  for (const stage of [undefined, 'xml_s1', 'xml_s2', 'fast']) {
    assert.equal(validate({ ...context, stage }, request), true)
    checks++
    if (reference) assert.equal(validate({ ...context, stage }, request), reference({ ...context, stage }, request))
    assert.equal(
      validate({ ...context, stage }, { ...request, system: [{ type: 'text', text: 'Use <block>yes</block>' }] }),
      true,
    )
    checks++
  }
  for (const invalid of [
    { ...context, extra: true },
    { ...context, stage: 'unknown' },
    { ...context, purpose: 'ordinary' },
    { ...context, format: 'json' },
  ]) {
    assert.equal(validate(invalid, request), false)
    checks++
  }
  assert.equal(validate(context, { ...request, messages: [{ role: 'user', content: 'ordinary' }] }), false)
  checks++
  assert.equal(validate(context, { ...request, tool_choice: { type: 'auto' } }), false)
  checks++
  const calls = []
  const fixture = lifecycleContext(cls.native, {
    globals: { structuredClone },
    sdk: async function* (args) {
      calls.push(args)
      yield { type: 'stream_event', event: { type: 'message_stop' } }
    },
    lines: [
      { type: 'kin_job_start', slot_id: 's00', job_id: 'severity', request, request_context: context },
      { type: 'kin_job_start', slot_id: 's01', job_id: 'bad', request, request_context: { ...context, extra: true } },
    ],
  })
  await fixture.context.runNativeMessagesLoop({ options: {} })
  for (let i = 0; i < 12; i++) await new Promise((resolve) => setImmediate(resolve))
  await fixture.context.writeChain2
  assert.equal(calls.length, 1)
  checks++
  assert.equal(calls[0].maxTokens, 64)
  checks++
  assert.equal(calls[0].wireThinking.type, 'disabled')
  checks++
  assert.deepEqual(Array.from(calls[0].stopSequences), ['</severity>'])
  checks++
  assert.ok(fixture.frames.some((f) => f.type === nativeWireType(cls.native, 'job_error') && f.job_id === 'bad'))
  checks++
  assert.ok(fixture.frames.some((f) => f.type === nativeWireType(cls.native, 'job_done') && f.job_id === 'severity'))
  checks++
  if (semantics.verdict) {
    let mtime = 1,
      token = 'fixture-old',
      cached = null,
      clears = 0,
      fail = false
    const getTokens = () => (cached ||= { accessToken: token })
    getTokens.cache = {
      clear() {
        cached = null
        clears++
      },
    }
    const ctx = vm.createContext({
      getClaudeConfigHomeDir: () => '/fixture',
      join22: path.posix.join,
      join24: path.posix.join,
      stat6: async (file) => {
        assert.equal(file, '/fixture/.credentials.json')
        if (fail) throw Error('fixture stat failed')
        return { mtimeMs: mtime }
      },
      lastCredentialsMtimeMs: 0,
      clearOAuthTokenCache: () => getTokens.cache.clear(),
      getClaudeAIOAuthTokens: getTokens,
    })
    vm.runInContext(semantics.verdict.disk_invalidation + '\n' + semantics.verdict.refresh_impl, ctx)
    await ctx.checkAndRefreshOAuthTokenIfNeededImpl(0, false)
    assert.equal(getTokens().accessToken, 'fixture-old')
    checks++
    await ctx.checkAndRefreshOAuthTokenIfNeededImpl(0, false)
    assert.equal(clears, 1)
    checks++
    mtime = 2
    token = 'fixture-new'
    await ctx.checkAndRefreshOAuthTokenIfNeededImpl(0, false)
    assert.equal(getTokens().accessToken, 'fixture-new')
    checks++
    fail = true
    await ctx.checkAndRefreshOAuthTokenIfNeededImpl(0, false)
    assert.equal(clears, 3)
    checks++
  }
  const preserved =
    kind === 'cc'
      ? await verifyCCSessionSource(semantics.session, semantics)
      : await verifyClassifierSource(cls, semantics, kind)
  return { ok: true, checks: checks + preserved.checks, verdict_checks: checks, preserved_checks: preserved.checks }
}
