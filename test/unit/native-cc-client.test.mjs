import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { AsyncLocalStorage } from 'node:async_hooks'
import { fileURLToPath } from 'node:url'
const dir =
  process.env.NATIVE_CC_CANDIDATE_DIR ||
  fileURLToPath(new URL('../../share/offline-candidates/native-v155-r3/', import.meta.url))
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
const patches = JSON.parse(fs.readFileSync(path.join(dir, 'patches.json'), 'utf8'))['cc-node']
const clientPatch = patches.find((p) => p.id === 'connect-existing-api-debug-bindings')
const original = process.env.NATIVE_CC_CLIENT_ORIGINAL === '1'
function createClientContext({
  before = original,
  stderr = false,
  subscriber = true,
  provider = 'firstParty',
  aliases = false,
  loggerAliasOnly = false,
} = {}) {
  const lines = [],
    sends = [],
    instances = [],
    trace = []
  let debugReady = false,
    refreshes = 0
  const env = {
    USER_TYPE: 'external',
    CLAUDE_CODE_ENTRYPOINT: 'sdk-cli',
    CLAUDE_AGENT_SDK_CLIENT_APP: 'fixture-app',
    API_TIMEOUT_MS: '1234',
    ANTHROPIC_CUSTOM_HEADERS: 'X-Fixture: kept\nAuthorization: TEST_HEADER_SECRET',
  }
  if (provider === 'bedrock') {
    env.CLAUDE_CODE_USE_BEDROCK = '1'
    env.CLAUDE_CODE_SKIP_BEDROCK_AUTH = '1'
  }
  if (provider === 'foundry') {
    env.CLAUDE_CODE_USE_FOUNDRY = '1'
    env.ANTHROPIC_FOUNDRY_API_KEY = 'TEST_FOUNDRY_KEY'
  }
  if (provider === 'vertex') {
    env.CLAUDE_CODE_USE_VERTEX = '1'
    env.CLAUDE_CODE_SKIP_VERTEX_AUTH = '1'
  }
  class SDK {
    constructor(options) {
      this.options = options
      instances.push(options)
    }
  }
  const inner = async (input, init) => {
    sends.push({ url: String(input), headers: Object.fromEntries(init.headers), body: init.body })
    return new Response('MOCK_REPLY:中文🙂', { status: 200 })
  }
  const context = vm.createContext({
    AsyncLocalStorage4: AsyncLocalStorage,
    Headers,
    Request,
    Response,
    URL,
    Uint8Array,
    TextDecoder,
    TextEncoder,
    process: { env, argv: ['cli', ...(stderr ? ['--debug-to-stderr'] : [])] },
    console: { error() {}, warn() {}, info() {}, debug() {} },
    Date: class extends Date {
      toISOString() {
        return '2026-09-26T00:00:00.000Z'
      }
    },
    __esm: (fn) => {
      let done = false
      return () => {
        if (!done) {
          done = true
          return fn()
        }
      }
    },
    memoize_default: (fn) => {
      let done = false,
        value
      return () => {
        if (!done) {
          done = true
          value = fn()
        }
        return value
      }
    },
    LEVEL_ORDER: { debug: 0, info: 1, warn: 2, error: 3 },
    getMinDebugLogLevel: () => {
      assert.ok(debugReady)
      return 'debug'
    },
    shouldLogDebugMessage: () => true,
    hasFormattedOutput: false,
    jsonStringify: JSON.stringify,
    writeToStderr: (text) => lines.push({ channel: 'stderr', text }),
    getDebugWriter: () => ({ write: (text) => lines.push({ channel: 'file', text }) }),
    init_debug() {
      if (debugReady) return
      debugReady = true
      trace.push('init_debug')
      vm.runInContext('var isDebugToStdErr2;' + manifest.debug_dependencies.stderr_getter, context)
    },
    officialCliVersion: () => '2.1.280',
    getClaudeCodeUserAgent: () => 'claude-code/2.1.280',
    getSessionId: () => 'fixture-session',
    isEnvTruthy: (x) => x === '1' || x === 'true',
    isClaudeAISubscriber: () => subscriber,
    getClaudeAIOAuthTokens: () => ({ accessToken: 'TEST_OAUTH_SECRET' }),
    getAnthropicApiKey: () => 'TEST_API_KEY',
    OAUTH_BETA_HEADER: 'fixture-oauth',
    getIsNonInteractiveSession: () => true,
    getApiKeyFromApiKeyHelper: async () => 'TEST_HELPER_SECRET',
    checkAndRefreshOAuthTokenIfNeeded: async () => {
      refreshes++
    },
    getProxyFetchOptions: () => ({ fixtureProxy: true }),
    officialH2Fetch: () => null,
    getAPIProvider: () => provider,
    isFirstPartyAnthropicBaseUrl: () => true,
    applyOfficialOutboundHeaders: (headers, userAgent) => headers.set('User-Agent', userAgent),
    randomUUID2: () => '00000000-0000-4000-8000-000000000003',
    stampCchBody: (text) => text,
    sdk_default: SDK,
    exports_bedrock_sdk: { AnthropicBedrock: SDK },
    exports_foundry_sdk: { AnthropicFoundry: SDK },
    exports_vertex_sdk: { AnthropicVertex: SDK },
    require_src6: () => ({ GoogleAuth: class {} }),
    __toESM: (x) => x,
    getSmallFastModel: () => 'other',
    getAWSRegion: () => 'fixture-region',
    getVertexRegionForModel: () => 'fixture-region',
    fetch: () => {
      throw Error('Unexpected external fetch')
    },
  })
  for (const name of [
    'init_sdk',
    'init_auth',
    'init_model',
    'init_providers',
    'init_proxy',
    'init_state',
    'init_oauth',
    'init_cch',
    'init_officialFingerprint',
    'init_envUtils',
    'init_axios2',
    'init_userAgent',
    'init_bedrock_sdk',
    'init_foundry_sdk',
    'init_vertex_sdk',
  ])
    context[name] = () => {}
  const workload = manifest.workload_context.source.replace(
    /import\s*\{\s*AsyncLocalStorage\s+as\s+AsyncLocalStorage4\s*\}\s*from\s*["']async_hooks["'];?/,
    '',
  )
  const http = patches.find((p) => p.id === 'connect-existing-workload-context').after
  vm.runInContext(workload + http + '\n' + manifest.debug_dependencies.log_function, context, { timeout: 1000 })
  const client = (before ? clientPatch.before : clientPatch.after).replace(
    /import\s*\{\s*randomUUID\s+as\s+randomUUID2\s*\}\s*from\s*["']crypto["'];?/,
    '',
  )
  vm.runInContext(client, context, { timeout: 1000 })
  if (aliases || loggerAliasOnly) {
    context.init_debug()
    context.logForDebugging = context.logForDebugging2
  }
  if (aliases) context.isDebugToStdErr = context.isDebugToStdErr2
  context.init_client2()
  return {
    context,
    lines,
    sends,
    instances,
    trace,
    get refreshes() {
      return refreshes
    },
    async build() {
      return context.getAnthropicClient({
        model: 'claude-opus-4-6',
        apiKey: 'EXPLICIT_API_KEY',
        maxRetries: 2,
        source: 'agent:kin',
        fetchOverride: inner,
      })
    },
  }
}
function snapshot(options) {
  return JSON.parse(JSON.stringify(options, (_key, value) => (typeof value === 'function' ? '[function]' : value)))
}
test('R2 observed logger failure is reproduced without network', async () => {
  const c = createClientContext({ before: true })
  await assert.rejects(c.build(), /logForDebugging is not defined/)
  assert.equal(c.sends.length, 0)
})
test('fixing only the logger exposes the second missing stderr binding', async () => {
  const c = createClientContext({ before: true, loggerAliasOnly: true })
  await assert.rejects(c.build(), /isDebugToStdErr is not defined/)
  assert.equal(c.sends.length, 0)
})
for (const stderr of [false, true])
  test(`API constructor preserves OAuth arguments with actual logging, stderr=${stderr}`, async () => {
    const c = createClientContext({ stderr }),
      client = await c.build(),
      o = client.options
    assert.equal(o.apiKey, null)
    assert.equal(o.authToken, 'TEST_OAUTH_SECRET')
    assert.equal(o.maxRetries, 2)
    assert.equal(o.timeout, 1234)
    assert.equal(o.dangerouslyAllowBrowser, true)
    assert.deepEqual(snapshot(o.fetchOptions), { fixtureProxy: true })
    assert.equal(o.defaultHeaders['X-Fixture'], 'kept')
    assert.equal(o.defaultHeaders['x-client-app'], 'fixture-app')
    assert.equal(o.defaultHeaders['x-claude-code-request-class'], 'main')
    assert.equal(o.defaultHeaders['User-Agent'], 'claude-cli/2.1.280 (external, sdk-cli, client-app/fixture-app)')
    assert.equal(Boolean(o.logger), stderr)
    assert.equal(c.refreshes, 1)
    assert.deepEqual(c.trace, ['init_debug'])
    assert.equal(c.lines.length, 3)
    assert.ok(c.lines.every((x) => x.channel === (stderr ? 'stderr' : 'file')))
    assert.ok(c.lines.some((x) => x.text.includes('[API:auth] OAuth token check complete')))
    assert.ok(c.lines.every((x) => !x.text.includes('TEST_HEADER_SECRET') && !x.text.includes('TEST_OAUTH_SECRET')))
  })
test('API-key path retains its header helper and explicit API-key behavior', async () => {
  const c = createClientContext({ subscriber: false }),
    client = await c.build()
  assert.equal(client.options.apiKey, 'EXPLICIT_API_KEY')
  assert.equal(client.options.authToken, undefined)
  assert.equal(client.options.defaultHeaders.Authorization, 'Bearer TEST_HELPER_SECRET')
})
for (const provider of ['bedrock', 'foundry', 'vertex'])
  test(`shared debug bindings resolve in ${provider} constructor branch`, async () => {
    const c = createClientContext({ provider, stderr: true }),
      client = await c.build()
    assert.equal(client.options.maxRetries, 2)
    assert.ok(client.options.logger)
    assert.equal(c.sends.length, 0)
  })
for (const binary of [false, true])
  test(`actual fetch wrapper preserves headers/body/reply for binary=${binary}`, async () => {
    const c = createClientContext(),
      client = await c.build()
    const text = JSON.stringify({
      system: [{ type: 'text', text: 'RULE' }],
      messages: [{ role: 'user', content: '汉字🙂'.repeat(7000) }],
    })
    const body = binary ? new TextEncoder().encode(text) : text
    const response = await client.options.fetch('http://127.0.0.1:1234/v1/messages', {
      method: 'POST',
      headers: client.options.defaultHeaders,
      body,
    })
    assert.equal(await response.text(), 'MOCK_REPLY:中文🙂')
    assert.equal(c.sends.length, 1)
    const sent = c.sends[0]
    assert.equal(typeof sent.body === 'string' ? sent.body : new TextDecoder().decode(sent.body), text)
    assert.equal(sent.headers['x-client-request-id'], '00000000-0000-4000-8000-000000000003')
    assert.equal(sent.headers['x-fixture'], 'kept')
    assert.ok(c.lines.some((x) => x.text.includes('[API REQUEST] /v1/messages')))
  })
test('correct bindings do not change factory arguments versus R2 with its intended dependencies supplied', async () => {
  const old = createClientContext({ before: true, aliases: true }),
    next = createClientContext()
  const a = await old.build(),
    b = await next.build()
  assert.deepEqual(snapshot(a.options), snapshot(b.options))
  await a.options.fetch('http://127.0.0.1:1234/v1/messages', {
    method: 'POST',
    headers: a.options.defaultHeaders,
    body: '{"fixture":true}',
  })
  await b.options.fetch('http://127.0.0.1:1234/v1/messages', {
    method: 'POST',
    headers: b.options.defaultHeaders,
    body: '{"fixture":true}',
  })
  assert.deepEqual(old.sends, next.sends)
})
test('r3 entry remains offline-only and rejects an r2 marker', async () => {
  const text = patches.find((p) => p.id === 'offline-guard-and-cc-initialization').after
  const context = vm.createContext({
    process: {
      env: { VM2API_OFFLINE_CANDIDATE: 'native-v155-r2', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1234' },
      argv: ['cli', 'entry', '--version'],
    },
  })
  vm.runInContext(text, context, { timeout: 1000 })
  await assert.rejects(context.main2(), /offline-only/)
})
