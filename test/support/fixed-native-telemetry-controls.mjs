import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

const esm = init => {
  let started = false, value
  return () => { if (!started) { started = true; value = init() } return value }
}
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Real native owner/context/schema/HTTP code; filesystem is temporary and transport is an observed fixture. */
export async function telemetryFactoryControl(source, imports, { root = process.cwd() } = {}) {
  const require = createRequire(path.join(root, 'web/package.json'))
  const zod = require('zod/v3')
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-native-telemetry-'))
  const home = path.join(temp, 'home'), config = path.join(temp, 'kernel.json')
  fs.mkdirSync(home)
  const previous = { KERNEL_CONFIG: process.env.KERNEL_CONFIG, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }
  const sent = [], published = []
  let destroyed = 0, checks = 0
  const write = (file, body) => fs.writeFileSync(file, JSON.stringify(body))
  const stamp = ['1','2','3','4','5','6','7','8','9','10','11','12','13','14','15','16','17','18','19','123'].join(' ')
  const actualFs = {
    ...fs,
    // Windows cannot fsync a directory. File writes/fsync stay real; Linux directory durability is outside this host control.
    fsyncSync(fd) { if (process.platform !== 'win32' || !fs.fstatSync(fd).isDirectory()) fs.fsyncSync(fd) },
    readFileSync(file, ...args) {
      if (file === '/proc/sys/kernel/random/boot_id') return 'fixture-boot\n'
      if (/^\/proc\/\d+\/stat$/.test(String(file))) return '12 (fixture worker) S ' + stamp
      return fs.readFileSync(file, ...args)
    },
  }
  const modules = { fs: actualFs, path, crypto, os, http, net, async_hooks: { AsyncLocalStorage } }
  const builtins = Object.fromEntries(imports.map(item => [item.local, item.imported === 'default' || item.imported === '*' ? modules[item.module] : modules[item.module]?.[item.imported]]))
  for (const [key, value] of Object.entries(builtins)) assert.notEqual(value, undefined, 'Missing fixture builtin: ' + key)
  const factory = Function('return (' + source + ')')()
  const transport = {
    Agent: class { constructor(options) { this.options = options } destroy() { destroyed++ } },
    async request(url, options) {
      sent.push({ url, options, body: options.body ? JSON.parse(options.body) : null })
      return { statusCode: 200, body: { async *[Symbol.asyncIterator]() { yield Buffer.from('{}') } } }
    },
  }
  const account = 'fixture-account', credential = path.join(home, 'credentials.json')
  const kernel = {
    vm_id: 'fixture-vm', credential_path: credential, socket_path: '/fixture/kernel.sock', internal_token: 'fixture-internal',
    runtime_kind: 'docker', cli_version: '2.1.303', test_endpoints: true,
    telemetry: { upload_interval_seconds: 600, proxy_id: 'fixture-proxy', proxy_url: '', proxy_required: false,
      event_logging_url: 'http://127.0.0.1:9/api/event_logging/batch', geo_url: 'http://127.0.0.1:9/geo' },
  }
  const creds = { access_token: 'fixture-access-token-not-real', expires_at: Date.now() + 3600000,
    scope: 'user:profile user:inference', account_uuid: account, org_uuid: 'fixture-org' }
  write(config, kernel)
  write(credential, creds)
  write(path.join(home, '.claude.json'), { userID: 'fixture-user', oauthAccount: { accountUuid: account } })
  write(path.join(home, 'kin-seed.json'), { seed_policy: { telemetry_disabled: true } })
  write(path.join(home, 'settings.json'), { thinkingEnabled: true, env: { ANTHROPIC_API_KEY: 'fixture-secret-never-log' } })
  process.env.KERNEL_CONFIG = config
  process.env.CLAUDE_CONFIG_DIR = home
  const sdk = {
    esm, builtins, zod, undici: transport,
    initZod() {}, initState() {}, initConfig() {}, initExporter() {}, userId() { return 'fixture-user' },
    sessionId: () => '00000000-0000-4000-8000-000000000001', userAgent: () => 'fixture-native-agent', stringify: JSON.stringify,
    claudeEvent: { toJSON: value => value }, growthEvent: { toJSON: value => value },
    formatEvent(core, user, metadata) { return { additional: metadata, auth: { account_uuid: user.accountUuid }, core: { session_id: core.sessionId }, env: core.envContext, process: core.processMetrics } },
    stripProto: value => value, debug() {},
  }
  let owner
  try {
    const api = factory(sdk)
    await api.load()
    const context = api.context()
    assert.equal(context.enabled, false)
    assert.equal(context.validCredentials, true)
    assert.equal(context.safeSettings['env.ANTHROPIC_API_KEY'], true)
    assert.ok(!JSON.stringify(context.safeSettings).includes('fixture-secret-never-log'))
    checks += 4
    owner = api.start(state => published.push(state))
    owner.start()
    await owner.tick()
    assert.equal(owner.state.state, 'disabled')
    assert.equal(sent.length, 0)
    checks += 2
    write(path.join(home, 'kin-seed.json'), { seed_policy: { telemetry_disabled: false } })
    owner.synchronize()
    await owner.tick()
    owner.notify()
    assert.equal(owner.state.state, 'waiting_egress')
    assert.equal(sent.length, 0, 'no controller proxy or direct fallback before published egress')
    checks += 2
    const binding = api.context().binding
    fs.mkdirSync(path.join(home, 'telemetry'), { recursive: true })
    write(path.join(home, 'telemetry', 'egress.json'), { vm_id: kernel.vm_id, binding, epoch: hash([binding, '127.0.0.1']), ip: '127.0.0.1', timezone: 'UTC', checked_at: Date.now(), error: null })
    owner.retryProbeAt = 0
    owner.sendSlotStart('00000000-0000-4000-8000-000000000002', 'claude-opus-4-6')
    for (let i = 0; i < 20 && owner.busy; i++) await new Promise(resolve => setImmediate(resolve))
    await owner.tick()
    assert.equal(sent.length, 1)
    assert.equal(sent[0].options.method, 'POST')
    assert.equal(sent[0].url, kernel.telemetry.event_logging_url)
    assert.equal(sent[0].body.events.length, 1)
    assert.equal(sent[0].body.events[0].event_data.event_name, 'tengu_init')
    assert.equal(sent[0].options.headers.Authorization, 'Bearer fixture-access-token-not-real')
    assert.ok(!JSON.stringify(published).includes('fixture-access-token-not-real'))
    assert.ok(!JSON.stringify(sent[0].body).includes('fixture-access-token-not-real'))
    checks += 8
    const headers = new Headers({ Authorization: 'secret-header', 'Content-Length': '321', 'User-Agent': 'fixture-agent', 'unknown-custom': 'secret-custom' })
    const reports = []
    await Promise.all([api.withHeaders(value => reports.push(['a', value]), () => api.reportHeaders(headers)), api.withHeaders(value => reports.push(['b', value]), () => api.reportHeaders(new Headers({ 'Content-Length': '456' })))])
    assert.equal(reports.length, 2)
    assert.equal(reports.find(([id]) => id === 'a')[1].authorization, '***REDACTED***')
    assert.equal(reports.find(([id]) => id === 'a')[1]['unknown-custom'], '***REDACTED***')
    assert.equal(reports.find(([id]) => id === 'a')[1]['content-length'], '321')
    assert.equal(reports.find(([id]) => id === 'b')[1]['content-length'], '456')
    checks += 5
    const event = { event_id: '00000000-0000-4000-8000-000000000003', kind: 'setting', setting: 'thinkingEnabled', value: true }
    assert.equal(api.event(event).success, true)
    assert.equal(api.event({ ...event, value: 'not-boolean' }).success, false)
    assert.equal(api.event({ ...event, password: 'unaccepted-field' }).success, false)
    checks += 3
    write(credential, { ...creds, scope: 'user:inference' })
    assert.equal(api.context().validCredentials, false)
    owner.synchronize()
    assert.equal(owner.context.accessToken, null)
    checks += 2
    write(path.join(home, 'kin-seed.json'), { seed_policy: { telemetry_disabled: true } })
    owner.synchronize()
    owner.notify()
    assert.equal(owner.records.length, 0)
    assert.equal(owner.state.state, 'disabled')
    assert.equal(sent.length, 1)
    checks += 3
    owner.close(); owner = null
    assert.equal(fs.existsSync(path.join(home, 'telemetry', 'owner.lock')), false)
    assert.ok(destroyed >= 1)
    checks += 2
    return { ok: true, checks, observed_uploads: sent.length, external_sdk_proto_seam: true, real_provider_requests: 0 }
  } finally {
    owner?.close()
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 })
  }
}
