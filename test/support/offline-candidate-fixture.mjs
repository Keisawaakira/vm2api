import { createHash } from 'node:crypto'
const hash = (value) => createHash('sha256').update(value).digest('hex')

// Synthetic validator input, not a production artifact or runtime approval.
// Real loader checks still execute; no deleted release metadata is required.
export function offlineCandidateFixture(id) {
  const artifact = (file) => ({
    file,
    bytes: 80,
    sha256: hash('synthetic packed ' + file),
    source_packed_sha256: hash('synthetic original ' + file),
    unpacked_sha256: hash('synthetic unpacked ' + file),
    patches: [],
    validations: {
      exact_unpack_roundtrip: true,
      upx_integrity: true,
      no_bytecode: true,
      unchanged_outside_js_spans: true,
      syntax: { syntax: true },
    },
  })
  return {
    version: 1,
    id,
    status: 'offline_only_pending_runtime',
    production_approved: false,
    local_validation: { completed: true, native_execution: false, user_capture_accepted: false },
    execution_guard: { env: 'VM2API_OFFLINE_CANDIDATE', value: id },
    supported_layouts: ['zero', 'identity'],
    kernel_sha256: Object.fromEntries(
      ['wrap', 'cc', 'crag'].map((plane) => [plane, hash('synthetic kernel ' + plane)]),
    ),
    artifacts: Object.fromEntries(['cli-node', 'cc-node'].map((file) => [file, artifact(file)])),
  }
}
