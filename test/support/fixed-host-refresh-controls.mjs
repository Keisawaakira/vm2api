import assert from 'node:assert/strict'
import vm from 'node:vm'
import { verifyVerdictSource } from './fixed-verdict-controls.mjs'

export async function refreshControl(code, options = {}) {
  const events = []
  const token = {
    accessToken: 'old',
    refreshToken: 'refresh-fixture',
    expiresAt: 1,
    scopes: ['user:inference'],
    ...options.token,
  }
  const disk = options.noDisk ? null : { ...token, ...options.disk }
  const getter = () => token
  getter.cache = { clear: () => events.push('cache.clear') }
  const context = vm.createContext({
    process: {
      env:
        options.flag === undefined
          ? {}
          : {
              [code.includes('process.env.CLAUDE_CODE_HOST_REFRESH')
                ? 'CLAUDE_CODE_HOST_REFRESH'
                : 'CLAUDE_CODE_KIN_HOST_REFRESH']: options.flag,
            },
    },
    isEnvTruthy: (value) => ['1', 'true'].includes(value),
    invalidateOAuthCacheIfDiskChanged: async () => events.push('invalidate'),
    getClaudeAIOAuthTokens: getter,
    getClaudeAIOAuthTokensAsync: async () => {
      events.push('disk')
      if (options.diskError) throw Error('fixture read error')
      return disk
    },
    clearKeychainCache: () => events.push('keychain.clear'),
    isOAuthTokenExpired: (expires) => expires < 100,
    shouldUseClaudeAIAuth: (scopes) => !!scopes?.includes('user:inference'),
    getClaudeConfigHomeDir: () => '/fixture',
    mkdir4: async () => events.push('mkdir'),
    lock: async () => {
      events.push('lock')
      return async () => events.push('unlock')
    },
    refreshOAuthToken: async () => {
      events.push('refresh')
      return { accessToken: 'refreshed' }
    },
    saveOAuthTokensIfNeeded: () => events.push('save'),
    logEvent() {},
    logError2() {},
    errorMessage: (error) => error.message,
  })
  vm.runInContext(code, context)
  let value, error
  try {
    value = await context.checkAndRefreshOAuthTokenIfNeededImpl(0, options.force === true)
  } catch (e) {
    error = e.message
  }
  return { value, error, events }
}

export async function verifyHostRefreshSource(semantics, kind) {
  const h = semantics.host_refresh
  assert.ok(h?.after && h?.reference)
  let checks = 0
  for (const input of [
    { flag: '1' },
    { flag: '1', disk: { accessToken: 'new', expiresAt: 999 } },
    { flag: '1', force: true, token: { expiresAt: 999 }, disk: { accessToken: 'new' } },
    { flag: '1', force: true, token: { expiresAt: 999 } },
    { flag: '1', token: { refreshToken: null } },
    { flag: '1', token: { scopes: [] } },
    { flag: '1', noDisk: true },
    { flag: '1', diskError: true },
    { flag: '0' },
    {},
  ]) {
    const actual = await refreshControl(h.after, input)
    assert.deepEqual(actual, await refreshControl(h.reference, input))
    checks++
    if (input.flag === '1') {
      assert.equal(actual.events.includes('refresh'), false)
      assert.equal(actual.events.includes('save'), false)
      assert.equal(actual.events.includes('lock'), false)
    } else {
      assert.equal(actual.value, true)
      assert.ok(actual.events.includes('refresh') && actual.events.includes('save') && actual.events.includes('unlock'))
    }
  }
  const prior = await verifyVerdictSource(semantics, kind)
  return { ok: true, checks: checks + prior.checks, host_refresh_checks: checks, preserved_checks: prior.checks }
}
