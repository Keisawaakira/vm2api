import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  OFFLINE_CANDIDATE_ID,
  OFFLINE_CANDIDATE_MODES,
  readOfflineCandidate,
} from '../../src/lib/transport/offline-native-candidate.mjs'
import { parseKernelDataplanePatch, resolveKernelDataplane } from '../../src/lib/vm/slot-engine.mjs'
import { normalizeLoggingConfig } from '../../src/lib/admin/request-log.mjs'
const root = fileURLToPath(new URL('../../', import.meta.url))
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const manifestFile = path.join(root, 'share/offline-candidates', OFFLINE_CANDIDATE_ID, 'manifest.json')
const released = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-candidate-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const assets = path.join(dir, 'share/offline-candidates', OFFLINE_CANDIDATE_ID)
  fs.mkdirSync(assets, { recursive: true })
  const bytes = Buffer.alloc(80)
  Buffer.from([127, 69, 76, 70, 2, 1]).copy(bytes)
  bytes.writeUInt16LE(62, 18)
  const manifest = structuredClone(released)
  manifest.artifacts['cli-node'].sha256 = hash(bytes)
  manifest.artifacts['cli-node'].bytes = bytes.length
  fs.writeFileSync(path.join(assets, 'cli-node'), bytes)
  const write = () => fs.writeFileSync(path.join(assets, 'manifest.json'), JSON.stringify(manifest))
  write()
  const options = {
    pairing: 'wrap',
    cliName: 'cli-node',
    kernelHash: manifest.kernel_sha256.wrap,
    baseCliHash: manifest.artifacts['cli-node'].source_packed_sha256,
    layout: 'zero',
  }
  return { dir, assets, manifest, bytes, write, options }
}
for (const pairing of ['wrap', 'cc', 'crag'])
  test(`real packaged ${pairing} candidate is locally checked but not production approved`, () => {
    const cliName = pairing === 'wrap' ? 'cli-node' : 'cc-node'
    const result = readOfflineCandidate(root, {
      pairing,
      cliName,
      kernelHash: released.kernel_sha256[pairing],
      baseCliHash: hash(fs.readFileSync(path.join(root, 'share/wrap-cli', cliName))),
      layout: 'zero',
    })
    assert.equal(hash(result.bytes), released.artifacts[cliName].sha256)
    assert.equal(result.meta.id, OFFLINE_CANDIDATE_ID)
    assert.equal(result.meta.production_approved, false)
    assert.equal(result.meta.user_capture_accepted, false)
    assert.equal(result.meta.local_validation.completed, true)
    assert.equal(result.meta.local_validation.native_execution, false)
  })
test('candidate selection is absent from production dataplane choices and never the logging default', () => {
  for (const mode of Object.keys(OFFLINE_CANDIDATE_MODES)) {
    assert.equal(parseKernelDataplanePatch(mode).ok, false)
    assert.equal(resolveKernelDataplane({}, { logging: { offline_kernel_dataplane: mode } }), 'wrap')
  }
  assert.equal(normalizeLoggingConfig({}).offline_kernel_probe, false)
  assert.equal(normalizeLoggingConfig({}).offline_kernel_dataplane, 'current')
})
for (const [name, change, code] of [
  [
    'kernel drift',
    (fx) => {
      fx.options.kernelHash = 'a'.repeat(64)
    },
    'kernel_mismatch',
  ],
  [
    'released CLI drift',
    (fx) => {
      fx.options.baseCliHash = 'a'.repeat(64)
    },
    'base_cli_mismatch',
  ],
  [
    'unsupported stock layout',
    (fx) => {
      fx.options.layout = 'stock'
    },
    'layout',
  ],
  [
    'local tests not completed',
    (fx) => {
      fx.manifest.local_validation.completed = false
    },
    'unverified',
  ],
  [
    'truthy local check string',
    (fx) => {
      fx.manifest.local_validation.completed = 'true'
    },
    'unverified',
  ],
  [
    'claimed promotion',
    (fx) => {
      fx.manifest.production_approved = true
    },
    'unverified',
  ],
  [
    'claimed runtime acceptance',
    (fx) => {
      fx.manifest.local_validation.user_capture_accepted = true
    },
    'unverified',
  ],
  [
    'guard mismatch',
    (fx) => {
      fx.manifest.execution_guard.value = 'other'
    },
    'manifest',
  ],
  [
    'path traversal',
    (fx) => {
      fx.manifest.artifacts['cli-node'].file = '../cli-node'
    },
    'manifest',
  ],
  [
    'missing binary',
    (fx) => {
      fs.unlinkSync(path.join(fx.assets, 'cli-node'))
    },
    'binary_missing',
  ],
  [
    'same-size binary tamper',
    (fx) => {
      const b = Buffer.from(fx.bytes)
      b[79] = 1
      fs.writeFileSync(path.join(fx.assets, 'cli-node'), b)
    },
    'hash',
  ],
])
  test(`candidate ${name} fails closed`, (t) => {
    const fx = fixture(t)
    change(fx)
    fx.write()
    assert.throws(
      () => readOfflineCandidate(fx.dir, fx.options),
      (error) => error.code === `offline_candidate_${code}`,
    )
  })
test('missing assets do not silently choose a release binary', (t) => {
  const fx = fixture(t)
  fs.unlinkSync(path.join(fx.assets, 'manifest.json'))
  assert.throws(() => readOfflineCandidate(fx.dir, fx.options), /released CLI was not substituted/)
})
test('immutable Docker image candidate fallback is supported, but a broken explicit copy does not fall through', (t) => {
  const fx = fixture(t)
  const image = path.join(fx.dir, 'image-offline-candidates', OFFLINE_CANDIDATE_ID)
  fs.mkdirSync(path.dirname(image), { recursive: true })
  fs.renameSync(fx.assets, image)
  assert.match(readOfflineCandidate(fx.dir, fx.options).meta.file, /image-offline-candidates/)
  fs.mkdirSync(fx.assets, { recursive: true })
  fs.writeFileSync(path.join(fx.assets, 'manifest.json'), '{broken')
  assert.throws(
    () => readOfflineCandidate(fx.dir, fx.options),
    (error) => error.code === 'offline_candidate_manifest',
  )
})
