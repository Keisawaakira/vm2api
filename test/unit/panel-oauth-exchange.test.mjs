import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerHooks } from 'node:module'

// Only replace the HTTP boundary. Run the real panel route, authorization-code
// session bookkeeping, setup-token classifier and identity enrichment.
const fetchKey = Symbol.for('vm2api.test.panel-oauth-exchange.fetch')
const fetchModule = new URL('../../src/lib/protocol/codex-models.mjs', import.meta.url).href
const hooks = registerHooks({
  load(url, context, next) {
    const result = next(url, context)
    if (url !== fetchModule) return result
    const source = String(result.source)
    const original = "import fetch from 'node-fetch'"
    assert.equal(source.split(original).length, 2)
    return {
      ...result,
      source: source.replace(
        original,
        `const fetch = (...args) => globalThis[Symbol.for('${Symbol.keyFor(fetchKey)}')](...args)`,
      ),
    }
  },
})
const { createPanelHandler } = await import('../../src/lib/admin/panel-routes.mjs')
const { generateAuthUrl, peekAuthUrlSession, resetAuthUrlSessions } = await import(
  '../../src/lib/oauth/oauth-auth-url.mjs'
)
const { CLAUDE_CLI_BOOTSTRAP_URL } = await import('../../src/lib/oauth/oauth-identity.mjs')
const { credentialModeFromOauth } = await import('../../src/lib/oauth/credential-mode.mjs')
const { AUTH_SCHEME_BEARER } = await import('../../src/lib/oauth/auth-scheme.mjs')

after(() => {
  hooks.deregister()
  delete globalThis[fetchKey]
  resetAuthUrlSessions()
})

function fixture(t, { bootstrapStatus = 200, role = 'admin', proxyOk = true, commitResult } = {}) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-oauth-route-'))
  const previousFake = process.env.KIN_FAKE_SESSION_OAUTH
  process.env.KIN_FAKE_SESSION_OAUTH = '1'
  resetAuthUrlSessions()
  t.after(() => {
    if (previousFake === undefined) delete process.env.KIN_FAKE_SESSION_OAUTH
    else process.env.KIN_FAKE_SESSION_OAUTH = previousFake
    resetAuthUrlSessions()
    delete globalThis[fetchKey]
    fs.rmSync(project, { recursive: true, force: true })
  })
  fs.mkdirSync(path.join(project, 'vms'))
  fs.writeFileSync(
    path.join(project, 'vms', 'vm-01.json'),
    JSON.stringify({ id: 'vm-01', status: 'stopped', claude: {} }),
  )
  const bootstrap = []
  globalThis[fetchKey] = async (url, init) => {
    assert.equal(url, CLAUDE_CLI_BOOTSTRAP_URL)
    assert.equal(init.method, 'GET')
    assert.equal(init.headers.authorization, `Bearer sk-ant-oat01-${'F'.repeat(96)}`)
    bootstrap.push({ url, init })
    return {
      ok: bootstrapStatus === 200,
      status: bootstrapStatus,
      json: async () => ({
        oauth_account: {
          account_email: 'route@example.test',
          account_uuid: 'acct-route',
          organization_uuid: 'org-route',
        },
      }),
    }
  }
  const commits = []
  let reads = 0
  const handle = createPanelHandler({
    cfg: { paths: { project } },
    requireAuth(req) {
      req.panelUser = 'fixture-admin'
      req.panelRole = role
      return true
    },
    readBody: async (req) => {
      reads++
      return req.body
    },
    requireSlotProxy: () =>
      proxyOk ? { ok: true, proxyUrl: '' } : { ok: false, status: 400, message: 'fixture proxy unavailable' },
    async commitImportedOauth(args) {
      commits.push(structuredClone(args))
      if (commitResult) return commitResult
      // Credential persistence/runtime activation is intentionally outside this
      // route regression. Check the exact grant handed to that existing seam.
      args.existing.claude = {
        mode: credentialModeFromOauth(args.oauth),
        email: args.oauth.email,
        account_uuid: args.oauth.account_uuid,
        has_refresh: !!args.oauth.refresh_token,
      }
      return { ok: true, official_cc_bootstrap: { scheduled: false, reason: 'test-boundary' } }
    },
    json(res, status, body) {
      Object.assign(res, { status, body })
    },
  })
  return {
    bootstrap,
    commits,
    reads: () => reads,
    authorize: (flavor = 'cai') => generateAuthUrl({ vmId: 'vm-01', proxyUrl: '', flavor }),
    async exchange(body) {
      const pathname = '/api/panel/vms/vm-01/oauth/exchange-code'
      const res = {}
      await handle({ method: 'POST', url: pathname, headers: {}, body }, res, new URL(pathname, 'http://test'))
      return res
    },
  }
}

for (const flavor of ['cai', 'claude_code', 'setup_token']) {
  test(`panel ${flavor} exchange commits the enriched grant once without exposing tokens`, async (t) => {
    const fx = fixture(t)
    const session = fx.authorize(flavor)
    const res = await fx.exchange({
      session_id: session.session_id,
      code: 'fixture-code',
      flavor,
      auth_scheme: 'x_api_key',
      name: 'kept-name',
    })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.ok, true)
    assert.equal(fx.commits.length, 1)
    const { oauth, vmId, name } = fx.commits[0]
    assert.equal(vmId, 'vm-01')
    assert.equal(name, 'kept-name')
    assert.equal(oauth.email, 'fake-oauth@kin.test')
    assert.equal(oauth.account_uuid, 'acct-fake-auth-url')
    assert.equal(oauth.org_uuid, 'org-fake-auth-url')
    assert.equal(oauth.access_token, 'sk-ant-oat01-FAKE-AUTH-URL')
    assert.equal(oauth.refresh_token, 'sk-ant-ort01-FAKE-AUTH-URL')
    assert.equal(oauth.auth_scheme, 'x_api_key')
    assert.equal(credentialModeFromOauth(oauth), flavor === 'setup_token' ? 'setup-token' : 'oauth')
    assert.equal(res.body.data.oauth_email, oauth.email)
    assert.equal(res.body.data.has_refresh, true)
    assert.equal(fx.bootstrap.length, 0)
    assert.equal(peekAuthUrlSession(session.session_id), null)
    assert.ok(!JSON.stringify(res.body).includes('sk-ant-'))
    const replay = await fx.exchange({ session_id: session.session_id, code: 'fixture-code', flavor })
    assert.equal(replay.status, 400)
    assert.equal(replay.body.error.code, 'session_expired')
    assert.equal(fx.commits.length, 1)
  })
}

for (const bootstrapStatus of [200, 403]) {
  test(`panel pasted setup-token survives identity bootstrap status ${bootstrapStatus}`, async (t) => {
    const fx = fixture(t, { bootstrapStatus })
    const res = await fx.exchange({ code: `sk-ant-oat01-${'P'.repeat(96)}` })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(fx.commits.length, 1)
    assert.equal(fx.bootstrap.length, 1)
    const { oauth } = fx.commits[0]
    assert.equal(oauth.type, 'setup-token')
    assert.equal(oauth.mode, 'setup-token')
    assert.equal(oauth.auth_scheme, AUTH_SCHEME_BEARER)
    assert.equal(oauth.scope, 'user:inference')
    assert.equal(oauth.access_token, `sk-ant-oat01-${'F'.repeat(96)}`)
    assert.equal(oauth.refresh_token, '')
    assert.equal(oauth.email ?? null, bootstrapStatus === 200 ? 'route@example.test' : null)
    assert.equal(oauth.account_uuid ?? null, bootstrapStatus === 200 ? 'acct-route' : null)
    assert.equal(oauth.org_uuid ?? null, bootstrapStatus === 200 ? 'org-route' : null)
    assert.equal(res.body.data.has_refresh, false)
    assert.ok(!JSON.stringify(res.body).includes('sk-ant-'))
  })
}

test('panel exchange preserves the existing credential-commit failure', async (t) => {
  const error = { code: 'fixture_commit_failed', message: 'fixture credential store unavailable' }
  const fx = fixture(t, { commitResult: { ok: false, status: 503, error } })
  const session = fx.authorize()
  const res = await fx.exchange({ session_id: session.session_id, code: 'fixture-code' })
  assert.equal(res.status, 503, JSON.stringify(res.body))
  assert.deepEqual(res.body.error, error)
  assert.equal(fx.commits.length, 1)
})

test('panel exchange rejects an expired session without committing a credential', async (t) => {
  const fx = fixture(t)
  const res = await fx.exchange({ session_id: 'missing', code: 'fixture-code' })
  assert.equal(res.status, 400)
  assert.equal(res.body.error.code, 'session_expired')
  assert.equal(fx.commits.length, 0)
  assert.equal(fx.bootstrap.length, 0)
})

test('panel exchange permission denial occurs before reading or consuming the code', async (t) => {
  const fx = fixture(t, { role: 'super' })
  const session = fx.authorize()
  const res = await fx.exchange({ session_id: session.session_id, code: 'fixture-code' })
  assert.equal(res.status, 403)
  assert.equal(fx.reads(), 0)
  assert.ok(peekAuthUrlSession(session.session_id))
  assert.equal(fx.commits.length, 0)
  assert.equal(fx.bootstrap.length, 0)
})

test('panel exchange proxy rejection leaves the authorization session available', async (t) => {
  const fx = fixture(t, { proxyOk: false })
  const session = fx.authorize()
  const res = await fx.exchange({ session_id: session.session_id, code: 'fixture-code' })
  assert.equal(res.status, 400)
  assert.equal(res.body.error.code, 'proxy_required')
  assert.ok(peekAuthUrlSession(session.session_id))
  assert.equal(fx.commits.length, 0)
  assert.equal(fx.bootstrap.length, 0)
})
