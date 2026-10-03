import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { readWrapFixedRelease, fixedDataplaneSpec } from '../../src/lib/vm/wrap-fixed.mjs'
import { readFixedDataplane, describeKernelPayload } from '../../src/lib/vm/wrap-cli-runtime.mjs'
import { readOfflineCandidate, offlineCandidateId } from '../../src/lib/transport/offline-native-candidate.mjs'
const root = fileURLToPath(new URL('../../', import.meta.url))
const read = (p) => JSON.parse(fs.readFileSync(new URL('../../' + p, import.meta.url), 'utf8'))
const hash = (b) => crypto.createHash('sha256').update(b).digest('hex')
const r1 = read('share/offline-candidates/native-v155-r1/manifest.json')
const r2 = read('share/offline-candidates/native-v155-r2/manifest.json')
const fixed = read('share/wrap-fixed/v155-r1/manifest.json')
test('approved repaired CLI keeps exact hashes while the runtime kernel comes from the native source', () => {
  const result = readWrapFixedRelease(root)
  assert.equal(result.ok, true, result.error)
  assert.equal(result.manifest.production_approved, true)
  assert.equal(result.manifest.local_validation.native_execution, false)
  const current = read('share/' + fixedDataplaneSpec('wrap-fixed').directory + '/manifest.json')
  assert.equal(hash(result.cli.bytes), current.artifacts['cli-node'].sha256)
  assert.equal(current.cache_contract, 'node_dual_anchor_v1')
  assert.equal(current.kernel, undefined)
  assert.equal(result.kernel, undefined)
  assert.equal(
    hash(fs.readFileSync(new URL('../../share/wrap-fixed/v155-r1/kin-kernel.bin', import.meta.url))),
    r1.kernel_sha256.wrap,
  )
  const runtime = readFixedDataplane(root, 'wrap-fixed')
  assert.equal(runtime.ok, true, runtime.error)
  assert.equal(runtime.kernel.file, describeKernelPayload(root).path)
  assert.equal(runtime.kernel_policy, 'shared_upstream')
  assert.match(result.cli.file, /wrap-fixed/)
  assert.notEqual(fixed.artifacts['cli-node'].sha256, r1.artifacts['cli-node'].sha256)
  assert.equal(fixed.artifacts['cli-node'].source_packed_sha256, r1.artifacts['cli-node'].source_packed_sha256)
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
const r2Available = fs.existsSync(new URL('../../share/offline-candidates/native-v155-r2/cc-node', import.meta.url))
for (const pairing of ['cc', 'crag'])
  test(`archived ${pairing} r2 CLI matches its recorded baseline when available`, {
    skip: r2Available ? false : 'closed-round native-v155-r2 executable was removed from this checkout',
  }, () => {
    const result = readOfflineCandidate(root, {
      candidateId: 'native-v155-r2',
      pairing,
      cliName: 'cc-node',
      layout: 'zero',
      kernelHash: r2.kernel_sha256[pairing],
      baseCliHash: r2.artifacts['cc-node'].source_packed_sha256,
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
