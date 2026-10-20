import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { fixedDataplaneSpec } from '../../src/lib/vm/wrap-fixed.mjs'
import { inspectBunElf, sha256 } from '../../scripts/build-offline-native-candidates.mjs'
import { auditNativeBindings } from '../../scripts/refresh-fixed-cc-session.mjs'
import { CALLER_CACHE_CONTRACT } from '../../scripts/refresh-fixed-cli-caller-cache.mjs'
import { RUNTIME_BASES } from '../../scripts/refresh-fixed-cli-runtime.mjs'
import { sourceFunction } from '../../scripts/refresh-fixed-cli-lifecycle.mjs'
import { callerSystemControl, verifyCallerCacheSource } from '../support/fixed-caller-cache-controls.mjs'
import { fixedParentImage } from '../support/fixed-parent-image.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
for (const kind of ['wrap', 'cc']) {
  const spec = fixedDataplaneSpec(kind + '-fixed')
  const dir = path.join(root, 'share', spec.directory)
  const sem = JSON.parse(fs.readFileSync(path.join(dir, 'semantics.json'), 'utf8'))
  test(`${kind} caller blocks, cache ownership and actual native dispatch match the upstream cache contract`, async () => {
    const result = await verifyCallerCacheSource(sem, kind)
    assert.equal(result.ok, true)
    assert.equal(result.checks, 269)
    assert.equal(sem.caller_cache.contract, CALLER_CACHE_CONTRACT)
  })
  test(`${kind} old system prefix loses a caller marker while the current prefix preserves both fields`, async () => {
    const body = {
      model: 'claude-opus-4-6',
      system: [
        { type: 'text', text: '# Environment\nKEEP', cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'text', text: '  caller tail  ', cache_control: { type: 'ephemeral' } },
      ],
    }
    const previous = { ...sem, kernel_wire: { ...sem.kernel_wire, system: sem.caller_cache.previous_system } }
    const old = await callerSystemControl(previous, body)
    const current = await callerSystemControl(sem, body)
    assert.notDeepEqual(old.system.slice(-2), body.system)
    assert.deepEqual(current.system.slice(-2), body.system)
    assert.equal(Object.hasOwn(current.system.at(-1).cache_control, 'ttl'), false)
  })
  test(`${kind} caller-cache functions and their module bindings belong to the freshly unpacked CLI`, {
    skip: !process.env.UPX_BIN ? 'Existing UPX maintainer tool unavailable' : false,
  }, (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caller-cache-binding-'))
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }))
    const file = path.join(tmp, 'current')
    execFileSync(process.env.UPX_BIN, ['-d', '-o', file, path.join(dir, RUNTIME_BASES[kind].file)], {
      stdio: 'pipe',
      timeout: 60000,
    })
    const current = fs.readFileSync(file)
    const patches = JSON.parse(fs.readFileSync(path.join(dir, 'patches.json'), 'utf8'))[RUNTIME_BASES[kind].file]
    const parent = fixedParentImage(current, patches, RUNTIME_BASES[kind].unpacked)
    const source = inspectBunElf(current).source.toString('utf8')
    const before = inspectBunElf(parent).source.toString('utf8')
    const nowAudit = auditNativeBindings(source, root)
    const priorAudit = auditNativeBindings(before, root)
    assert.deepEqual(nowAudit.native_unresolved, [])
    assert.deepEqual(
      nowAudit.whole_unresolved.filter((name) => !priorAudit.whole_unresolved.includes(name)),
      [],
    )
    for (const name of ['__vm191CallerSystem', '__vm191WireSystem', 'applyKinOwnedCacheMarkers']) {
      const actual = sourceFunction(source, name).text.trim()
      const expected = sourceFunction(sem.system + '\n' + sem.cache, name).text.trim()
      assert.equal(actual, expected, `${name}: semantic control is bound to the executable body`)
    }
    assert.ok(source.includes(sem.caller_cache.prefix), 'API prefix is not a separately rewritten fixture')
    for (const patch of patches)
      assert.equal(sha256(current.subarray(patch.offset, patch.offset + patch.bytes)), patch.after_sha256)
    if (kind === 'cc')
      for (const binding of nowAudit.session_bindings) assert.equal(binding.declared, true, binding.name)
  })
  test(`${kind} caller-cache controls execute in a Bun1.3.14 compiled miniature`, {
    skip: !process.env.BUN_BIN ? 'Existing Bun maintainer tool unavailable' : false,
  }, (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caller-cache-compiled-'))
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }))
    const input = path.join(tmp, 'entry.mjs')
    const output = path.join(tmp, process.platform === 'win32' ? 'entry.exe' : 'entry')
    const controls = path.join(root, 'test/support/fixed-caller-cache-controls.mjs').replaceAll('\\', '/')
    fs.writeFileSync(
      input,
      `import{verifyCallerCacheSource}from ${JSON.stringify(controls)};console.log(JSON.stringify(await verifyCallerCacheSource(${JSON.stringify(sem)},${JSON.stringify(kind)})));`,
    )
    execFileSync(process.env.BUN_BIN, ['build', input, '--compile', '--outfile', output], {
      stdio: 'pipe',
      timeout: 60000,
    })
    const result = JSON.parse(
      execFileSync(output, [], { encoding: 'utf8', timeout: 60000, env: { ...process.env, BUN_OPTIONS: '' } }),
    )
    assert.equal(result.ok, true)
    assert.equal(result.checks, 269)
  })
}
