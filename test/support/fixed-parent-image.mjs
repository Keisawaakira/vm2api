import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** Reconstruct only in memory; the pinned parent hash is an independent check,
 * not a claim that a deleted historical executable was read or restored. */
export function fixedParentImage(current, patches, expectedParentSha256) {
  const parent = Buffer.from(current)
  let end = 0
  for (const patch of patches) {
    assert.ok(Number.isSafeInteger(patch.offset) && patch.offset >= end)
    assert.ok(Number.isSafeInteger(patch.bytes) && patch.bytes > 0)
    end = patch.offset + patch.bytes
    assert.ok(end <= current.length)
    const before = Buffer.from(patch.before, 'utf8')
    assert.equal(before.length, patch.bytes)
    assert.equal(sha256(before), patch.before_sha256)
    assert.equal(sha256(current.subarray(patch.offset, end)), patch.after_sha256)
    before.copy(parent, patch.offset)
  }
  assert.equal(sha256(parent), expectedParentSha256, 'Reconstructed parent must match the locked original hash')
  return parent
}
