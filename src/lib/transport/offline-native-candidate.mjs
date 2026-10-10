import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import activeRound from './offline-candidate-round.json' with { type: 'json' }

export const CURRENT_OFFLINE_ROUND = activeRound
export function isCurrentOfflineChoice(value) {
  return activeRound.choices.some((choice) => choice.value === value)
}

export const OFFLINE_CANDIDATE_ID = 'native-v155-r1'
export const OFFLINE_CC_R2_ID = 'native-v155-r2'
export const OFFLINE_CC_R3_ID = 'native-v155-r3'
export const OFFLINE_CANDIDATE_MODES = Object.freeze({
  'candidate-wrap': 'wrap',
  'candidate-cc': 'cc',
  'candidate-crag': 'crag',
  'candidate-cc-r2': 'cc',
  'candidate-crag-r2': 'crag',
  'candidate-cc-r3': 'cc',
  'candidate-crag-r3': 'crag',
})
export function offlineCandidateId(plane) {
  if (plane === 'candidate-cc-r3' || plane === 'candidate-crag-r3') return OFFLINE_CC_R3_ID
  return plane === 'candidate-cc-r2' || plane === 'candidate-crag-r2' ? OFFLINE_CC_R2_ID : OFFLINE_CANDIDATE_ID
}
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const failure = (code, message) => Object.assign(new Error(message), { code: `offline_candidate_${code}` })
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

/** No runtime install and no fallback to released binaries. Only the private diagnostic caller uses this. */
export function readOfflineCandidate(
  projectRoot,
  { pairing, cliName, kernelHash, baseCliHash, layout, candidateId = OFFLINE_CANDIDATE_ID },
) {
  if (
    ![OFFLINE_CANDIDATE_ID, OFFLINE_CC_R2_ID, OFFLINE_CC_R3_ID].includes(candidateId) ||
    (candidateId !== OFFLINE_CANDIDATE_ID && pairing === 'wrap')
  )
    throw failure('revision', 'Unsupported offline candidate revision/pairing')
  if (!['wrap', 'cc', 'crag'].includes(pairing) || cliName !== (pairing === 'wrap' ? 'cli-node' : 'cc-node'))
    throw failure('pairing', 'Unsupported candidate pairing')
  const locations = [
    path.join(projectRoot, 'share', 'offline-candidates', candidateId),
    path.join(projectRoot, 'image-offline-candidates', candidateId),
  ]
  const dir = locations.find((p) => fs.existsSync(path.join(p, 'manifest.json')))
  if (!dir) throw failure('missing', 'Offline candidate assets are not installed; released CLI was not substituted')
  let manifest, manifestBytes
  try {
    const file = path.join(dir, 'manifest.json')
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > 65536) throw Error('size')
    manifestBytes = fs.readFileSync(file)
    manifest = JSON.parse(manifestBytes.toString('utf8'))
  } catch {
    throw failure('manifest', 'Offline candidate manifest is unreadable or invalid')
  }
  if (
    manifest.version !== 1 ||
    manifest.id !== candidateId ||
    manifest.status !== 'offline_only_pending_runtime' ||
    manifest.production_approved !== false ||
    manifest.local_validation?.completed !== true ||
    manifest.local_validation?.native_execution !== false ||
    manifest.local_validation?.user_capture_accepted !== false
  )
    throw failure('unverified', 'Candidate does not have the required local-only verification state')
  if (manifest.execution_guard?.env !== 'VM2API_OFFLINE_CANDIDATE' || manifest.execution_guard?.value !== candidateId)
    throw failure('manifest', 'Candidate execution guard is not declared')
  if (!['zero', 'identity'].includes(layout) || !manifest.supported_layouts?.includes(layout))
    throw failure('layout', 'This candidate only covers zero/identity layouts; no layout was changed')
  if (!sha(kernelHash) || manifest.kernel_sha256?.[pairing] !== kernelHash)
    throw failure('kernel_mismatch', 'Selected kernel differs from the locally checked candidate baseline')
  const artifact = manifest.artifacts?.[cliName]
  if (
    !artifact ||
    artifact.file !== cliName ||
    !sha(artifact.sha256) ||
    !sha(artifact.source_packed_sha256) ||
    !sha(artifact.unpacked_sha256) ||
    artifact.validations?.exact_unpack_roundtrip !== true ||
    artifact.validations?.upx_integrity !== true ||
    artifact.validations?.no_bytecode !== true ||
    artifact.validations?.unchanged_outside_js_spans !== true ||
    artifact.validations?.syntax?.syntax !== true
  )
    throw failure('manifest', 'Candidate artifact validation metadata is incomplete')
  if (!sha(baseCliHash) || artifact.source_packed_sha256 !== baseCliHash)
    throw failure('base_cli_mismatch', 'Released CLI differs from the candidate source baseline')
  let bytes
  try {
    const file = path.join(dir, cliName)
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size < 64 || stat.size > 128 * 1024 * 1024 || stat.size !== artifact.bytes)
      throw Error('size')
    bytes = fs.readFileSync(file)
  } catch {
    throw failure('binary_missing', 'Candidate CLI is missing or has the wrong size; no fallback was used')
  }
  if (hash(bytes) !== artifact.sha256) throw failure('hash', 'Candidate CLI does not match its checked SHA256')
  if (bytes.subarray(0, 6).toString('hex') !== '7f454c460201' || bytes.readUInt16LE(18) !== 62)
    throw failure('format', 'Candidate is not a Linux x64 ELF')
  return {
    bytes,
    meta: {
      id: manifest.id,
      status: manifest.status,
      production_approved: false,
      user_capture_accepted: false,
      local_validation: manifest.local_validation,
      manifest_sha256: hash(manifestBytes),
      source_cli_sha256: artifact.source_packed_sha256,
      cli_sha256: artifact.sha256,
      cli_unpacked_sha256: artifact.unpacked_sha256,
      expected_kernel_sha256: kernelHash,
      file: path.relative(projectRoot, path.join(dir, cliName)),
      patches: Array.isArray(artifact.patches) ? artifact.patches.map((p) => String(p.id)).slice(0, 8) : [],
    },
  }
}
