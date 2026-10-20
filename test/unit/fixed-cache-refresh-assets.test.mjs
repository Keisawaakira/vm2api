import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { fixedDataplaneSpec, readFixedRelease } from '../../src/lib/vm/wrap-fixed.mjs'
import { refreshFixedBytes } from '../../scripts/refresh-fixed-cli-cache.mjs'
import { LIFECYCLE_ORIGINAL_CC } from '../../scripts/refresh-fixed-cli-lifecycle.mjs'
import { RUNTIME_BASES, RUNTIME_REFERENCE } from '../../scripts/refresh-fixed-cli-runtime.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex')
for (const kind of ['wrap', 'cc']) {
  const plane = `${kind}-fixed`,
    spec = fixedDataplaneSpec(plane),
    base = RUNTIME_BASES[kind]
  const dir = path.join(root, 'share', spec.directory)
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
  test(`${plane} activates the verified CLI-only cache and terminal revision`, () => {
    const result = readFixedRelease(root, plane)
    assert.equal(result.ok, true, result.error)
    assert.equal(result.id, base.id)
    assert.equal(result.kernel_policy, 'shared_upstream')
    assert.equal(result.manifest.cache_contract, spec.cacheContract)
    assert.equal(result.manifest.local_validation.native_execution, false)
    assert.equal(manifest.kernel, undefined)
    assert.equal(fs.existsSync(path.join(dir, 'kin-kernel.bin')), false)
    // Stock files in a source checkout are ignored download caches, not release
    // inputs. Verify the pinned source and, when supplied, the isolated payload.
    if (kind === 'wrap') {
      const payload = JSON.parse(fs.readFileSync(path.join(root, 'deploy/payload.json')))
      assert.equal(payload.files.find((entry) => entry.path === base.input)?.sha256, base.packed)
      if (process.env.VM2API_PAYLOAD_ROOT)
        assert.equal(hash(fs.readFileSync(path.join(process.env.VM2API_PAYLOAD_ROOT, base.input))), base.packed)
    } else if (fs.existsSync(path.join(root, base.input)))
      assert.equal(hash(fs.readFileSync(path.join(root, base.input))), base.packed)
    assert.equal(manifest.lineage.source_sha256, base.packed)
    assert.equal(manifest.lineage.classifier_reference_commit, 'fe4b23a')
    assert.equal(manifest.lineage.upstream_cli_sha256, RUNTIME_REFERENCE.packed)
    assert.equal(manifest.lineage.runtime_reference_commit, RUNTIME_REFERENCE.commit)
    assert.equal(manifest.runtime_wire_contract, spec.runtimeContract)
    if (kind === 'cc') assert.equal(manifest.lineage.original_cc_sha256, LIFECYCLE_ORIGINAL_CC)
    const artifact = manifest.artifacts[base.file]
    assert.equal(hash(result.cli.bytes), artifact.sha256)
    assert.equal(artifact.validations.exact_unpack_roundtrip, true)
    assert.equal(artifact.validations.unchanged_outside_js_spans, true)
    for (const field of ['packed', 'unpacked']) assert.match(base[field], /^[a-f0-9]{64}$/)
    assert.equal(hash(fs.readFileSync(path.join(dir, 'patches.json'))), manifest.patches_sha256)
    assert.equal(hash(fs.readFileSync(path.join(dir, 'semantics.json'))), manifest.semantics_sha256)
  })
  test(`${plane} patch records have valid bounded before/after bytes`, () => {
    const patches = JSON.parse(fs.readFileSync(path.join(dir, 'patches.json'), 'utf8'))[base.file]
    assert.equal(patches.length, kind === 'wrap' ? 6 : 9)
    assert.equal(manifest.native_lifecycle_contract, 'nonblocking_cancel_v1')
    if (kind === 'cc') assert.ok(manifest.inherited_repairs.length >= 2)
    let end = 0
    for (const patch of patches) {
      assert.ok(patch.offset >= end)
      assert.equal(Buffer.byteLength(patch.before), patch.bytes)
      assert.equal(Buffer.byteLength(patch.after), patch.replacement_bytes)
      assert.ok(patch.replacement_bytes <= patch.bytes)
      assert.equal(hash(Buffer.from(patch.before)), patch.before_sha256)
      const padded = Buffer.concat([Buffer.from(patch.after), Buffer.alloc(patch.bytes - patch.replacement_bytes, 32)])
      assert.equal(hash(padded), patch.after_sha256)
      end = patch.offset + patch.bytes
    }
  })
  test(`${plane} rejects a manifest without the matching cache contract before fallback`, (t) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-contract-'))
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
    const dest = path.join(temp, 'share', spec.directory)
    fs.mkdirSync(dest, { recursive: true })
    for (const value of [undefined, 'legacy']) {
      fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify({ ...manifest, cache_contract: value }))
      const result = readFixedRelease(temp, plane)
      assert.equal(result.ok, false)
      assert.equal(result.code, `${plane.replaceAll('-', '_')}_unapproved`)
    }
  })
  test(`${plane} historical cache repacker still refuses unrecognized baseline bytes`, () => {
    assert.throws(() => refreshFixedBytes(Buffer.alloc(128), kind, '', () => ''), /unpacked baseline/)
  })
}
