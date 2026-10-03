import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { patchLifecycleBytes } from '../../scripts/refresh-fixed-cli-lifecycle.mjs'
import { CLASSIFIER_BASES } from '../../scripts/refresh-fixed-cli-classifier.mjs'
import { CC_SESSION_BASE } from '../../scripts/refresh-fixed-cc-session.mjs'
import { inspectBunElf } from '../../scripts/build-offline-native-candidates.mjs'
import { fixedDataplaneSpec, readFixedRelease } from '../../src/lib/vm/wrap-fixed.mjs'
const root = fileURLToPath(new URL('../../', import.meta.url))
const hash = (x) => crypto.createHash('sha256').update(x).digest('hex')
for (const [kind, base] of Object.entries({ wrap: CLASSIFIER_BASES.wrap, cc: CC_SESSION_BASE })) {
  const plane = kind + '-fixed',
    spec = fixedDataplaneSpec(plane),
    dir = path.join(root, 'share', spec.directory)
  test(`${plane} activates a hash-bound CLI-only lifecycle revision`, () => {
    const result = readFixedRelease(root, plane)
    assert.equal(result.ok, true, result.error)
    assert.equal(result.id, base.id)
    assert.equal(result.manifest.native_lifecycle_contract, 'nonblocking_cancel_v1')
    assert.equal(result.manifest.cache_contract, 'node_dual_anchor_v1')
    assert.equal(result.kernel, undefined)
    assert.equal(result.kernel_policy, 'shared_upstream')
    assert.equal(fs.existsSync(path.join(dir, 'kin-kernel.bin')), false)
    assert.equal(hash(fs.readFileSync(path.join(root, base.input))), base.packed)
    assert.equal(result.manifest.lineage.source_sha256, base.packed)
    assert.equal(result.manifest.local_validation.native_execution, false)
    for (const [name, key] of [
      ['patches.json', 'patches_sha256'],
      ['semantics.json', 'semantics_sha256'],
    ])
      assert.equal(hash(fs.readFileSync(path.join(dir, name))), result.manifest[key])
  })
  test(`${plane} freshly unpacked bytes preserve layout, unaffected intervals and inherited repairs`, {
    skip: !process.env.UPX_BIN,
  }, (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-assets-'))
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
    const patches = JSON.parse(fs.readFileSync(path.join(dir, 'patches.json'), 'utf8'))[base.file]
    assert.equal(patches.length, kind === 'wrap' ? 2 : 3)
    for (const [file, target] of [
      [path.join(root, base.input), 'before'],
      [path.join(dir, base.file), 'after'],
    ])
      execFileSync(process.env.UPX_BIN, ['-d', '-o', path.join(tmp, target), file], { stdio: 'pipe', timeout: 60000 })
    const before = fs.readFileSync(path.join(tmp, 'before')),
      after = fs.readFileSync(path.join(tmp, 'after'))
    assert.equal(hash(before), base.unpacked)
    assert.equal(hash(after), manifest.artifacts[base.file].unpacked_sha256)
    assert.equal(before.length, after.length)
    const a = inspectBunElf(before),
      b = inspectBunElf(after)
    assert.deepEqual({ ...a, source: null }, { ...b, source: null })
    let cursor = 0
    for (const p of patches) {
      assert.ok(p.offset >= cursor)
      assert.ok(p.bytes < 25000)
      assert.ok(before.subarray(cursor, p.offset).equals(after.subarray(cursor, p.offset)))
      assert.equal(hash(before.subarray(p.offset, p.offset + p.bytes)), p.before_sha256)
      assert.equal(hash(after.subarray(p.offset, p.offset + p.bytes)), p.after_sha256)
      assert.equal(after.subarray(p.offset, p.offset + p.replacement_bytes).toString(), p.after)
      cursor = p.offset + p.bytes
    }
    assert.ok(before.subarray(cursor).equals(after.subarray(cursor)))
    for (const p of manifest.inherited_repairs) {
      assert.equal(hash(before.subarray(p.offset, p.offset + p.bytes)), p.previous_after_sha256 || p.after_sha256)
      assert.equal(hash(after.subarray(p.offset, p.offset + p.bytes)), p.after_sha256)
      if (p.preserved)
        assert.ok(before.subarray(p.offset, p.offset + p.bytes).equals(after.subarray(p.offset, p.offset + p.bytes)))
    }
    if (kind === 'cc') {
      assert.ok(
        manifest.inherited_repairs.every((p) => p.preserved),
        'all v194 repairs stay byte-identical',
      )
      for (const id of [
        'native-cache-continuity',
        'connect-existing-api-debug-bindings',
        'connect-existing-workload-context',
        'preserve-crag-api-error-detail',
        'native-no-nonstream-fallback',
        'cc-loop-initialization',
        'native-max-tokens-terminal',
      ])
        assert.equal(manifest.inherited_repairs.find((p) => p.id === id).preserved, true)
    }
  })
  test(`${plane} rejects missing lifecycle contract instead of silently using older behavior`, (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-contract-'))
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')),
      dest = path.join(tmp, 'share', spec.directory)
    fs.mkdirSync(dest, { recursive: true })
    for (const value of [undefined, 'legacy']) {
      fs.writeFileSync(
        path.join(dest, 'manifest.json'),
        JSON.stringify({ ...manifest, native_lifecycle_contract: value }),
      )
      const result = readFixedRelease(tmp, plane)
      assert.equal(result.ok, false)
      assert.match(result.code, /unapproved$/)
    }
  })
  test(`${plane} transformation refuses an unknown image before examining offsets`, () => {
    assert.throws(() => patchLifecycleBytes(Buffer.alloc(256), kind, '', () => ''), /Unrecognized/)
  })
}
