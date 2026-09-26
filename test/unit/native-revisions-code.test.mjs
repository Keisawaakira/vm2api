import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { AsyncLocalStorage } from 'node:async_hooks'
import { fileURLToPath } from 'node:url'

const root = process.env.NATIVE_REVISIONS_ROOT || fileURLToPath(new URL('../../share/', import.meta.url))
const original = process.env.NATIVE_REVISIONS_ORIGINAL === '1'
const fixed = JSON.parse(fs.readFileSync(path.join(root, 'wrap-fixed/v155-r1/manifest.json'), 'utf8'))
const ccManifest = JSON.parse(
  fs.readFileSync(path.join(root, 'offline-candidates/native-v155-r2/manifest.json'), 'utf8'),
)
const ccPatches = JSON.parse(
  fs.readFileSync(path.join(root, 'offline-candidates/native-v155-r2/patches.json'), 'utf8'),
)['cc-node']
const source = (id) => ccPatches.find((p) => p.id === id)[original ? 'before' : 'after']
function httpContext(env = {}, initialize = true) {
  const dependency = ccManifest.workload_context.source.replace(
    /import\s*\{\s*AsyncLocalStorage\s+as\s+AsyncLocalStorage4\s*\}\s*from\s*["']async_hooks["'];?/,
    '',
  )
  const ctx = vm.createContext({
    AsyncLocalStorage4: AsyncLocalStorage,
    process: { env: { USER_TYPE: 'external', CLAUDE_CODE_ENTRYPOINT: 'sdk-cli', ...env } },
    officialCliVersion: () => '2.1.280',
    getClaudeCodeUserAgent: () => 'claude-code/2.1.280',
    __esm: (fn) => {
      let done = false
      return () => {
        if (!done) {
          done = true
          return fn()
        }
      }
    },
    isClaudeAISubscriber: () => true,
    getClaudeAIOAuthTokens: () => ({ accessToken: 'fixture-only' }),
    OAUTH_BETA_HEADER: 'oauth-fixture',
  })
  vm.runInContext(dependency + source('connect-existing-workload-context'), ctx, { timeout: 1000 })
  if (initialize) ctx.init_workloadContext()
  return ctx
}
function clone(x) {
  return JSON.parse(JSON.stringify(x))
}
for (const url of [undefined, 'https://provider.invalid'])
  test(`promoted CLI original entry allows --version without offline marker (${url || 'unset'})`, async () => {
    const printed = []
    const ctx = vm.createContext({
      process: { env: { ...(url ? { ANTHROPIC_BASE_URL: url } : {}) }, argv: ['cli', 'entry', '--version'] },
      console: { log: (x) => printed.push(x) },
      officialCliVersion: () => '2.1.280',
    })
    vm.runInContext(original ? fixed.entry.candidate : fixed.entry.promoted, ctx, { timeout: 1000 })
    await ctx.main2()
    assert.equal(printed.length, 1)
    // The pinned bundle's --version is 2.8.4; its HTTP attribution version
    // is separately overridden to 2.1.280. Promotion must not change either.
    assert.equal(String(printed[0]), '2.8.4 (Claude Code)')
  })
test('CC getUserAgent works outside a workload with exactly the original header format', () => {
  const ctx = httpContext()
  assert.equal(ctx.getWorkload2(), undefined)
  assert.equal(ctx.getUserAgent(), 'claude-cli/2.1.280 (external, sdk-cli)')
})
test('CC actual AsyncLocalStorage scopes retain their label across awaits without leaking', async () => {
  const ctx = httpContext({ CLAUDE_AGENT_SDK_VERSION: 'fixture-sdk', CLAUDE_AGENT_SDK_CLIENT_APP: 'fixture-app' })
  const values = await Promise.all(
    ['cron', 'foreground'].map((workload) =>
      ctx.runWithWorkload(workload, async () => {
        assert.equal(ctx.getWorkload2(), workload)
        await new Promise((resolve) => setTimeout(resolve, workload === 'cron' ? 2 : 1))
        assert.equal(ctx.getWorkload2(), workload)
        return ctx.getUserAgent()
      }),
    ),
  )
  assert.equal(
    values[0],
    'claude-cli/2.1.280 (external, sdk-cli, agent-sdk/fixture-sdk, client-app/fixture-app, workload/cron)',
  )
  assert.equal(
    values[1],
    'claude-cli/2.1.280 (external, sdk-cli, agent-sdk/fixture-sdk, client-app/fixture-app, workload/foreground)',
  )
  assert.equal(ctx.getWorkload2(), undefined)
})
test('CC nested workloads and exceptions restore their parent context', () => {
  const ctx = httpContext()
  ctx.runWithWorkload('outer', () => {
    assert.throws(
      () =>
        ctx.runWithWorkload('inner', () => {
          assert.equal(ctx.getWorkload2(), 'inner')
          throw new Error('probe')
        }),
      /probe/,
    )
    assert.equal(ctx.getWorkload2(), 'outer')
  })
  assert.equal(ctx.getWorkload2(), undefined)
})
test('CC user-agent dependency initialization is self-contained and idempotent', () => {
  const ctx = httpContext({}, false)
  assert.equal(ctx.getUserAgent(), 'claude-cli/2.1.280 (external, sdk-cli)')
  ctx.runWithWorkload('active', () => {
    assert.match(ctx.getUserAgent(), /workload\/active/)
    assert.equal(ctx.getWorkload2(), 'active')
  })
  assert.equal(ctx.getWorkload2(), undefined)
})
test('CC unrelated auth and MCP header helpers keep their existing behavior', () => {
  const ctx = httpContext()
  assert.deepEqual(clone(ctx.getAuthHeaders()), {
    headers: { Authorization: 'Bearer fixture-only', 'anthropic-beta': 'oauth-fixture' },
  })
  assert.equal(ctx.getMCPUserAgent(), 'claude-code/2.1.281 (sdk-cli)')
})
async function runCrag(events) {
  const frames = []
  const ctx = vm.createContext({
    AbortController,
    init_claude() {},
    toEngine: (x) => x,
    thinkingFor: () => ({ type: 'disabled' }),
    applyBlockEvent() {},
    exports_claude: {
      queryKinMessagesWithStreaming: async function* () {
        yield* events
      },
    },
    writeFrame: async (x) => {
      frames.push(clone(x))
    },
  })
  vm.runInContext(source('preserve-crag-api-error-detail'), ctx, { timeout: 1000 })
  const slot = { sessionId: 'fixture-session', transcript: [], tools: [], model: 'claude-opus-4-6', phase: 'running' }
  await ctx.runSlot(slot, '', false)
  return { frames, slot }
}
for (const [content, expected] of [
  [[{ type: 'text', text: 'API Error: getWorkload is not defined' }], 'API Error: getWorkload is not defined'],
  [
    [
      { type: 'text', text: '错误一' },
      { type: 'text', text: '错误二' },
    ],
    '错误一\n错误二',
  ],
  ['provider fixture rejection', 'provider fixture rejection'],
])
  test(`Crag preserves assistant API error detail: ${expected}`, async () => {
    const { frames, slot } = await runCrag([{ type: 'assistant', isApiErrorMessage: true, message: { content } }])
    assert.equal(frames.length, 1)
    assert.equal(frames[0].is_error, true)
    assert.equal(frames[0].result, expected)
    assert.equal(frames[0].session_id, 'fixture-session')
    assert.equal(slot.phase, 'idle')
    assert.equal(slot.sessionId, undefined)
  })
test('Crag empty error keeps a safe fallback and never reports success', async () => {
  const { frames } = await runCrag([{ type: 'assistant', isApiErrorMessage: true, message: { content: [] } }])
  assert.equal(frames[0].is_error, true)
  assert.equal(frames[0].result, 'api_error')
})
test('Crag successful events preserve the original terminal and usage behavior', async () => {
  const event = {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { input_tokens: 3, output_tokens: 148 },
  }
  const { frames, slot } = await runCrag([{ type: 'stream_event', event }])
  assert.deepEqual(frames[0], { type: 'stream_event', session_id: 'fixture-session', event })
  assert.equal(frames[1].is_error, false)
  assert.equal(frames[1].stop_reason, 'end_turn')
  assert.deepEqual(frames[1].usage, event.usage)
  assert.equal(slot.phase, 'idle')
})
test('r2 rejects an r1 marker and public destination before initializing anything', async () => {
  const text = ccPatches.find((p) => p.id === 'offline-guard-and-cc-initialization').after
  for (const env of [
    { VM2API_OFFLINE_CANDIDATE: 'native-v155-r1', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1234' },
    { VM2API_OFFLINE_CANDIDATE: 'native-v155-r2', ANTHROPIC_BASE_URL: 'https://provider.invalid' },
  ]) {
    const ctx = vm.createContext({ process: { env, argv: ['cli', 'entry', '--version'] } })
    vm.runInContext(text, ctx, { timeout: 1000 })
    await assert.rejects(ctx.main2(), /offline-only/)
  }
})
