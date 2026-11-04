import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { verifyNativeRefreshSource } from '../support/fixed-native-refresh-controls.mjs'
import { telemetryFactoryControl } from '../support/fixed-native-telemetry-controls.mjs'
import { auditNativeBindings } from '../../scripts/refresh-fixed-cc-session.mjs'
import { inspectBunElf, sha256 } from '../../scripts/build-offline-native-candidates.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const sourceRoot = process.env.FIXED_NATIVE_SOURCE_ROOT || path.join(root, 'share')
for (const kind of ['wrap','cc']) {
  const dir = path.join(sourceRoot, kind + '-fixed/v1437-r1')
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json')))
  const sem = JSON.parse(fs.readFileSync(path.join(dir, 'semantics.json')))
  test(`${kind} current native request/CCH/session/owner controls`, async () => {
    const result = await verifyNativeRefreshSource(sem, kind)
    assert.equal(result.ok, true)
    assert.equal(result.checks, kind === 'cc' ? 411 : 380)
  })
  test(`${kind} current source controls also execute in compiled Bun1.3.14`, {
    skip: !process.env.BUN_BIN ? 'Existing Bun maintainer tool unavailable' : false,
  }, t => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'native-refresh-compiled-'))
    t.after(() => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }))
    const file = path.join(temp, 'main.mjs'), output = path.join(temp, process.platform === 'win32' ? 'main.exe' : 'main')
    const helper = path.join(root, 'test/support/fixed-native-refresh-controls.mjs').replaceAll('\\', '/')
    fs.writeFileSync(file, `import{verifyNativeRefreshSource}from ${JSON.stringify(helper)};console.log(JSON.stringify(await verifyNativeRefreshSource(${JSON.stringify(sem)},${JSON.stringify(kind)})));`)
    execFileSync(process.env.BUN_BIN, ['build', file, '--compile', '--outfile', output], { stdio: 'pipe', timeout: 120000 })
    const value = JSON.parse(execFileSync(output, [], { cwd: root, encoding: 'utf8', env: { ...process.env, BUN_OPTIONS: '' }, timeout: 120000 }))
    assert.equal(value.ok, true)
    assert.equal(value.checks, kind === 'cc' ? 411 : 380)
  })
  test(`${kind} current native controls are bound to the complete unpacked package`, {
    skip: !process.env.UPX_BIN ? 'Existing UPX maintainer tool unavailable' : false,
  }, t => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'native-refresh-package-'))
    t.after(() => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }))
    const cli = kind === 'cc' ? 'cc-node' : 'cli-node', packed = path.join(dir, cli), unpacked = path.join(temp, 'cli')
    assert.equal(sha256(fs.readFileSync(packed)), manifest.artifacts[cli].sha256)
    execFileSync(process.env.UPX_BIN, ['-d', '-o', unpacked, packed], { stdio: 'pipe', timeout: 60000 })
    const bytes = fs.readFileSync(unpacked), source = inspectBunElf(bytes).source.toString('utf8')
    assert.equal(sha256(bytes), manifest.artifacts[cli].unpacked_sha256)
    const audit = auditNativeBindings(source, root)
    assert.deepEqual(audit.native_unresolved, [])
    for (const code of [sem.native_refresh.fetch, sem.native_refresh.fetch_implementation, sem.native_refresh.helpers])
      for (const line of code.split('\n').filter(line => line.trim())) assert.ok(source.includes(line), 'stored native fragment is absent from full source')
    const patches = JSON.parse(fs.readFileSync(path.join(dir, 'patches.json')))[cli]
    for (const entry of patches) assert.equal(sha256(bytes.subarray(entry.offset, entry.offset + entry.bytes)), entry.after_sha256)
  })
  if (kind === 'cc') test('CC compiled capsule and original native module factory have the same owner behavior', async () => {
    const original = await telemetryFactoryControl(sem.native_refresh.telemetry_source, sem.native_refresh.telemetry_bindings)
    const packaged = await telemetryFactoryControl(sem.native_refresh.telemetry_factory, sem.native_refresh.telemetry_bindings)
    assert.deepEqual(packaged, original)
  })
}
