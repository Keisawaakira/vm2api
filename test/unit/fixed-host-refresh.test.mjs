import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { fixedDataplaneSpec, readFixedRelease } from '../../src/lib/vm/wrap-fixed.mjs'
import { REQUEST_WIRE_BASES } from '../../scripts/refresh-fixed-cli-request-wire.mjs'
import { refreshControl, verifyHostRefreshSource } from '../support/fixed-host-refresh-controls.mjs'
const root = fileURLToPath(new URL('../../', import.meta.url))
for (const kind of ['wrap', 'cc']) {
  const dir = process.env.FIXED_HOST_REFRESH_ROOT
    ? path.join(process.env.FIXED_HOST_REFRESH_ROOT, fixedDataplaneSpec(kind + '-fixed').directory)
    : path.join(root, 'share', fixedDataplaneSpec(kind + '-fixed').directory)
  const sem = JSON.parse(fs.readFileSync(path.join(dir, 'semantics.json')))
  test(`${kind} original host-mode bug is discriminated without real credentials/network`, async () => {
    const before = await refreshControl(sem.host_refresh.before, { flag: '1' })
    assert.equal(before.events.includes('refresh'), true)
    assert.equal(before.events.includes('save'), true)
    const after = await refreshControl(sem.host_refresh.after, { flag: '1' })
    assert.equal(after.events.includes('refresh'), false)
    assert.equal(after.events.includes('save'), false)
  })
  test(`${kind} exact refresh source matches upstream and keeps all prior controls`, async () => {
    const result = await verifyHostRefreshSource(sem, kind)
    assert.equal(result.ok, true)
    assert.equal(result.host_refresh_checks, 10)
    assert.equal(result.preserved_checks, kind === 'wrap' ? 159 : 181)
  })
  test(`${kind} current wire revision retains host-refresh policy and CLI-only packaging`, () => {
    const result = process.env.FIXED_HOST_REFRESH_ROOT
      ? { ok: true, manifest: JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'))) }
      : readFixedRelease(root, kind + '-fixed')
    assert.equal(result.ok, true, result.error)
    assert.equal(result.manifest.id, REQUEST_WIRE_BASES[kind].id)
    assert.equal(result.manifest.native_wire_contract, 'unprefixed_native_v2')
    assert.equal(result.manifest.artifacts[REQUEST_WIRE_BASES[kind].file].patches.length, kind === 'wrap' ? 2 : 8)
    assert.equal(result.manifest.kernel, undefined)
  })
  test(`${kind} host refresh and native controls run in a Bun1.3.14 compiled miniature`, {
    skip: !process.env.BUN_BIN,
  }, (t) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'host-refresh-compiled-'))
    t.after(() => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }))
    const input = path.join(temp, 'entry.mjs'),
      output = path.join(temp, process.platform === 'win32' ? 'entry.exe' : 'entry')
    const helper = path.join(root, 'test/support/fixed-host-refresh-controls.mjs').replaceAll('\\', '/')
    fs.writeFileSync(
      input,
      `import{verifyHostRefreshSource}from ${JSON.stringify(helper)};console.log(JSON.stringify(await verifyHostRefreshSource(${JSON.stringify(sem)},${JSON.stringify(kind)})));`,
    )
    execFileSync(process.env.BUN_BIN, ['build', input, '--compile', '--outfile', output], {
      stdio: 'pipe',
      timeout: 60000,
    })
    const result = JSON.parse(
      execFileSync(output, [], { encoding: 'utf8', timeout: 60000, env: { ...process.env, BUN_OPTIONS: '' } }),
    )
    assert.equal(result.ok, true)
  })
}
