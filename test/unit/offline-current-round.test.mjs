import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  CURRENT_OFFLINE_ROUND,
  OFFLINE_CC_R3_ID,
  isCurrentOfflineChoice,
  OFFLINE_CANDIDATE_MODES,
  offlineCandidateId,
  readOfflineCandidate,
} from '../../src/lib/transport/offline-native-candidate.mjs'
import { parseKernelDataplanePatch } from '../../src/lib/vm/slot-engine.mjs'
const root = fileURLToPath(new URL('../../', import.meta.url))
const hash = (b) => crypto.createHash('sha256').update(b).digest('hex')
const read = (p) => {
  const file = new URL('../../' + p, import.meta.url)
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
}
const manifest = read('share/offline-candidates/native-v155-r3/manifest.json')
const previous = read('share/offline-candidates/native-v155-r2/manifest.json')
const archiveSkip = (revision) =>
  CURRENT_OFFLINE_ROUND.choices.length === 0 &&
  !fs.existsSync(new URL(`../../share/offline-candidates/${revision}/cc-node`, import.meta.url))
    ? `closed-round ${revision} executable was removed from this checkout`
    : false
test('catalog exposes only this round and registrations resolve to its exact revision', () => {
  assert.equal(CURRENT_OFFLINE_ROUND.id, OFFLINE_CC_R3_ID)
  assert.deepEqual(CURRENT_OFFLINE_ROUND.choices, [])
  for (const value of ['candidate-cc-r3', 'candidate-crag-r3']) {
    assert.equal(isCurrentOfflineChoice(value), false)
    assert.equal(offlineCandidateId(value), OFFLINE_CC_R3_ID)
    assert.ok(['cc', 'crag'].includes(OFFLINE_CANDIDATE_MODES[value]))
    assert.equal(parseKernelDataplanePatch(value).ok, false)
  }
  for (const old of ['current', 'wrap', 'wrap-fixed', 'candidate-wrap', 'candidate-cc-r2'])
    assert.equal(isCurrentOfflineChoice(old), false)
})
for (const pairing of ['cc', 'crag'])
  test(`archived R3 ${pairing} candidate matches its pinned artifact and remains unapproved`, {
    skip: archiveSkip('native-v155-r3'),
  }, () => {
    const kernel = pairing === 'cc' ? 'share/cc-fixed/v155-r3/kin-kernel.bin' : 'share/crag/kin-kernel'
    const candidate = readOfflineCandidate(root, {
      candidateId: manifest.id,
      pairing,
      cliName: 'cc-node',
      layout: 'zero',
      kernelHash: hash(fs.readFileSync(new URL('../../' + kernel, import.meta.url))),
      baseCliHash: hash(fs.readFileSync(new URL('../../share/wrap-cli/cc-node', import.meta.url))),
    })
    assert.equal(hash(candidate.bytes), manifest.artifacts['cc-node'].sha256)
    assert.equal(candidate.meta.production_approved, false)
    assert.equal(candidate.meta.user_capture_accepted, false)
  })
test('historical R3 preserves prior functional patches except the explicit revision guard', {
  skip: !manifest || !previous ? 'Owner removed historical r2/r3 metadata' : false,
}, () => {
  for (const patch of previous.artifacts['cc-node'].patches) {
    if (patch.id === 'offline-guard-and-cc-initialization') continue
    assert.deepEqual(
      manifest.artifacts['cc-node'].patches.find((p) => p.id === patch.id),
      patch,
    )
  }
  assert.ok(manifest.artifacts['cc-node'].patches.some((p) => p.id === 'connect-existing-api-debug-bindings'))
})
test('available archived R2 executable matches its recorded hash', { skip: archiveSkip('native-v155-r2') }, () => {
  assert.equal(
    hash(fs.readFileSync(new URL('../../share/offline-candidates/native-v155-r2/cc-node', import.meta.url))),
    previous.artifacts['cc-node'].sha256,
  )
})
