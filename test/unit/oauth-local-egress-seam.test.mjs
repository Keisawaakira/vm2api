// The v1.4 auth importer is VM-owned. A controller proxy (including local '')
// is not authority to run an OAuth helper without a selected persisted VM.
import test from 'node:test'
import assert from 'node:assert/strict'
import { exchangeTokenViaCookieAuth, sessionKeyToOAuth } from '../../src/lib/oauth/cookie-auth.mjs'

for (const op of ['exchange', 'session']) {
  const run = proxyUrl => op === 'exchange'
    ? exchangeTokenViaCookieAuth({ code: 'fixture-code', codeVerifier: 'fixture-verifier', proxyUrl })
    : sessionKeyToOAuth('sk-ant-sid01-fixture-only', { proxyUrl })
  test(`${op} unbound/whitespace exit is rejected before a helper`, async () => {
    for (const proxyUrl of [null, undefined, ' ', '\t'])
      await assert.rejects(() => run(proxyUrl), error => error.code === 'proxy_required')
  })
  test(`${op} a controller local exit cannot substitute for target VM authority`, async () => {
    await assert.rejects(() => run(''), error => error.code === 'oauth_vm_required')
  })
  test(`${op} a controller SOCKS URL cannot substitute for target VM authority`, async () => {
    await assert.rejects(() => run('socks5h://127.0.0.1:9'), error => error.code === 'oauth_vm_required')
  })
}
