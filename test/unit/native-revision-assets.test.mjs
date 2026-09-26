import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { readWrapFixedRelease } from '../../src/lib/vm/wrap-fixed.mjs'
import { readOfflineCandidate, offlineCandidateId } from '../../src/lib/transport/offline-native-candidate.mjs'
const root = fileURLToPath(new URL('../../', import.meta.url))
const read = (p) => JSON.parse(fs.readFileSync(new URL('../../' + p, import.meta.url), 'utf8'))
const hash = (b) => crypto.createHash('sha256').update(b).digest('hex')
const r1 = read('share/offline-candidates/native-v155-r1/manifest.json')
const r2 = read('share/offline-candidates/native-v155-r2/manifest.json')
const fixed = read('share/wrap-fixed/v155-r1/manifest.json')
test('actual approved fixed pair is separate from original/candidate assets and exactly hashed', () => {
  const result = readWrapFixedRelease(root)
  assert.equal(result.ok, true, result.error)
  assert.equal(result.manifest.production_approved, true)
  assert.equal(result.manifest.local_validation.native_execution, false)
  assert.equal(hash(result.cli.bytes), fixed.artifacts['cli-node'].sha256)
  assert.equal(hash(result.kernel.bytes), r1.kernel_sha256.wrap)
  assert.match(result.cli.file, /wrap-fixed/)
  assert.notEqual(fixed.artifacts['cli-node'].sha256, r1.artifacts['cli-node'].sha256)
  assert.equal(
    hash(fs.readFileSync(new URL('../../share/wrap-cli/cli-node', import.meta.url))),
    r1.artifacts['cli-node'].source_packed_sha256,
  )
})
test('promotion retains both accepted system patches and restores the exact original entry span', () => {
  assert.equal(fixed.artifacts['cli-node'].patches.length, 2)
  for (const patch of fixed.artifacts['cli-node'].patches) {
    const original = r1.artifacts['cli-node'].patches.find((p) => p.id === patch.id)
    assert.deepEqual(patch, original)
  }
  assert.equal(
    fixed.entry.restored_sha256,
    r1.artifacts['cli-node'].patches.find((p) => p.id === 'offline-entry-guard').before_sha256,
  )
})
for (const pairing of ['cc', 'crag'])
  test(`actual ${pairing} r2 assets pass offline gates but remain unapproved`, () => {
    const kernelPath = pairing === 'cc' ? 'bin/kin-kernel' : 'share/crag/kin-kernel'
    const result = readOfflineCandidate(root, {
      candidateId: 'native-v155-r2',
      pairing,
      cliName: 'cc-node',
      layout: 'zero',
      kernelHash: hash(fs.readFileSync(new URL('../../' + kernelPath, import.meta.url))),
      baseCliHash: hash(fs.readFileSync(new URL('../../share/wrap-cli/cc-node', import.meta.url))),
    })
    assert.equal(hash(result.bytes), r2.artifacts['cc-node'].sha256)
    assert.equal(result.meta.id, 'native-v155-r2')
    assert.equal(result.meta.production_approved, false)
    assert.equal(result.meta.user_capture_accepted, false)
  })
test('r2 keeps prior system patches while explicitly correcting dependency/error spans', () => {
  for (const id of ['snapshot-caller-system', 'preserve-caller-api-blocks']) {
    assert.deepEqual(
      r2.artifacts['cc-node'].patches.find((p) => p.id === id),
      r1.artifacts['cc-node'].patches.find((p) => p.id === id),
    )
  }
  assert.ok(r2.artifacts['cc-node'].patches.some((p) => p.id === 'connect-existing-workload-context'))
  assert.ok(r2.artifacts['cc-node'].patches.some((p) => p.id === 'preserve-crag-api-error-detail'))
  assert.equal(r2.workload_context.unchanged_from_r1, true)
  assert.equal(hash(Buffer.from(r2.workload_context.source)), r2.workload_context.sha256)
})
test('r1 selectors keep their original revision and r2 cannot masquerade as promoted wrap', () => {
  assert.equal(offlineCandidateId('candidate-cc'), 'native-v155-r1')
  assert.equal(offlineCandidateId('candidate-cc-r2'), 'native-v155-r2')
  assert.throws(
    () => readOfflineCandidate(root, { candidateId: 'native-v155-r2', pairing: 'wrap', cliName: 'cli-node' }),
    (e) => e.code === 'offline_candidate_revision',
  )
})
