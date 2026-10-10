import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { fixedDataplaneSpec, readFixedRelease } from '../../src/lib/vm/wrap-fixed.mjs'
import { REQUEST_WIRE_BASES, patchRequestWireBytes } from '../../scripts/refresh-fixed-cli-request-wire.mjs'
import { inspectBunElf } from '../../scripts/build-offline-native-candidates.mjs'
import { sourceFunction, sourceRange } from '../../scripts/refresh-fixed-cli-lifecycle.mjs'
import { fixedParentImage } from '../support/fixed-parent-image.mjs'
import { verifyRequestWireSource } from '../support/fixed-request-wire-controls.mjs'
const root = fileURLToPath(new URL('../../', import.meta.url))
for (const kind of ['wrap', 'cc']) {
  const spec = fixedDataplaneSpec(kind + '-fixed'),
    dir = path.join(root, 'share', spec.directory)
  const sem = JSON.parse(fs.readFileSync(path.join(dir, 'semantics.json')))
  test(`${kind} actual request fields/gates and preserved controls`, async () => {
    const result = await verifyRequestWireSource(sem, kind)
    assert.equal(result.ok, true)
    assert.equal(result.request_checks, kind === 'cc' ? 384 : 382)
    assert.equal(result.preserved_checks, kind === 'wrap' ? 215 : 237)
  })
  test(`${kind} request wire contract fails closed before loading an incompatible CLI`, (t) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'request-wire-contract-'))
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'))),
      dest = path.join(temp, 'share', spec.directory)
    fs.mkdirSync(dest, { recursive: true })
    for (const contract of [undefined, 'old']) {
      fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify({ ...m, request_wire_contract: contract }))
      assert.match(readFixedRelease(temp, kind + '-fixed').code, /unapproved$/)
    }
    assert.throws(() => patchRequestWireBytes(Buffer.alloc(128), kind, {}), /Unknown request-wire baseline/)
  })
  test(`${kind} actual request constructor executes in compiled Bun1.3.14`, { skip: !process.env.BUN_BIN }, (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'request-wire-compiled-'))
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }))
    const input = path.join(tmp, 'entry.mjs'),
      output = path.join(tmp, process.platform === 'win32' ? 'entry.exe' : 'entry')
    fs.writeFileSync(
      input,
      `import {verifyRequestWireSource} from ${JSON.stringify(path.join(root, 'test/support/fixed-request-wire-controls.mjs').replaceAll('\\', '/'))};console.log(JSON.stringify(await verifyRequestWireSource(${JSON.stringify(sem)},${JSON.stringify(kind)})))`,
    )
    execFileSync(process.env.BUN_BIN, ['build', input, '--compile', '--outfile', output], {
      stdio: 'pipe',
      timeout: 60000,
    })
    const result = JSON.parse(
      execFileSync(output, [], { encoding: 'utf8', timeout: 60000, env: { ...process.env, BUN_OPTIONS: '' } }),
    )
    assert.equal(result.ok, true)
    assert.equal(result.request_checks, kind === 'cc' ? 384 : 382)
  })
}
test('freshly unpacked CC preserves actual API/debug/session/cache functions and refusal text', {
  skip: !process.env.UPX_BIN,
}, (t) => {
  const spec = fixedDataplaneSpec('cc-fixed'),
    dir = path.join(root, 'share', spec.directory),
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'request-wire-preservation-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }))
  const file = path.join(temp, 'cc')
  execFileSync(process.env.UPX_BIN, ['-d', '-o', file, path.join(dir, 'cc-node')], { stdio: 'pipe', timeout: 60000 })
  const after = fs.readFileSync(file),
    patches = JSON.parse(fs.readFileSync(path.join(dir, 'patches.json')))['cc-node']
  const before = fixedParentImage(after, patches, REQUEST_WIRE_BASES.cc.unpacked)
  const a = inspectBunElf(before).source.toString(),
    b = inspectBunElf(after).source.toString()
  for (const name of [
    'getAnthropicClient',
    'getUserAgent',
    'getWorkload2',
    'runWithWorkload',
    'getJobSessionId',
    'runWithJobSession',
    'getSessionId',
    'checkAndRefreshOAuthTokenIfNeededImpl',
    'officialH2Fetch',
    'stampCchBody',
  ])
    assert.equal(sourceFunction(a, name).text.trim(), sourceFunction(b, name).text.trim(), name)
  const ca = sourceRange(a, '// src/kin/cacheTtl.ts', '// src/kin/querySource.ts').text
  const cb = sourceRange(b, '// src/kin/cacheTtl.ts', '// src/kin/querySource.ts').text
  for (const name of [
    'normalizePanelCacheTtl',
    'cacheControlTtl',
    'noteExplicitTtl',
    'explicitCacheTtl',
    'readPanelCacheTtl',
    'resolveKinCacheTtl',
    'stampBlock',
    'fillMissingCacheTtl',
    'mergeOfficialExtraBetas',
  ])
    assert.equal(sourceFunction(ca, name).text.trim(), sourceFunction(cb, name).text.trim(), name)
  const position = a.indexOf('Claude Code is unable to respond to this request')
  assert.ok(position > 0)
  assert.equal(
    a.slice(position - 200, position + 800),
    b.slice(position - 200, position + 800),
    'refusal handling is not bypassed',
  )
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json')))
  for (const id of [
    'classifier-safe-caller-system',
    'complete-job-session-bootstrap',
    'read-active-job-session',
    'initialize-job-session-with-state',
    'connect-existing-workload-context',
    'cc-loop-initialization',
    'native-no-nonstream-fallback',
    'preserve-crag-api-error-detail',
  ])
    assert.equal(m.inherited_repairs.find((p) => p.id === id)?.preserved, true, id)
})
