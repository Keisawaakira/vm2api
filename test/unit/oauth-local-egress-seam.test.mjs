import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const key = 'vm2api-local-egress-oauth-test'
const calls = []
globalThis[Symbol.for(key)] = calls
const hook = registerHooks({
  load(url, context, nextLoad) {
    if (url === 'node:child_process')
      return {
        format: 'module',
        shortCircuit: true,
        source: `
      import {EventEmitter} from 'node:events';
      export function spawn() {
        const child = new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();
        child.stdin={end(text){
          const request=JSON.parse(text);globalThis[Symbol.for(${JSON.stringify(key)})].push(request);
          queueMicrotask(()=>{
            child.stdout.emit('data',Buffer.from(JSON.stringify({ok:true,credential:{access_token:'fixture-access',refresh_token:'fixture-refresh',scope:'user:inference user:profile',expires_at:4102444800}})+'\\n'));
            child.emit('close',0);
          });
        }};return child;
      }
    `,
      }
    return nextLoad(url, context)
  },
})
const { sessionKeyToOAuth, exchangeTokenViaCookieAuth } = await import(
  '../../src/lib/oauth/cookie-auth.mjs?local-exit-contract'
)
hook.deregister()

for (const op of ['exchange', 'session']) {
  const run = (proxyUrl) =>
    op === 'exchange'
      ? exchangeTokenViaCookieAuth({ code: 'fixture-code', codeVerifier: 'fixture-verifier', proxyUrl })
      : sessionKeyToOAuth('sk-ant-sid01-fixture-only', { proxyUrl })
  test(`${op} explicit local exit reaches the real helper envelope as empty string`, async () => {
    const before = calls.length
    const credential = await run('')
    assert.equal(credential.access_token, 'fixture-access')
    assert.equal(calls.length, before + 1)
    assert.equal(calls.at(-1).proxy_url, '')
  })
  test(`${op} bound SOCKS stays unchanged instead of downgrading to direct`, async () => {
    const credential = await run('socks5h://127.0.0.1:9')
    assert.equal(credential.access_token, 'fixture-access')
    assert.equal(calls.at(-1).proxy_url, 'socks5h://127.0.0.1:9')
  })
  test(`${op} unbound/whitespace exit is rejected before helper spawn`, async () => {
    const before = calls.length
    for (const value of [null, undefined, '   ', '\t'])
      await assert.rejects(
        () => run(value),
        (error) => error.code === 'proxy_required',
      )
    assert.equal(calls.length, before)
  })
}
