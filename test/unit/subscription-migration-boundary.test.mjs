import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { vmNodeId } from '../../src/lib/cluster/placement.mjs'

// Exercise the exact new caller blocks with observation-only file operations.
// No credentials, Docker, SSH or real worker process is accessed.
const server = fs.readFileSync(new URL('../../src/server.mjs', import.meta.url), 'utf8')
const start = server.indexOf('for (const vm of listVms(cfg.paths.project)) {')
const end = server.indexOf('\ncliNodeGuard =', start)
assert.ok(start >= 0 && end > start)
const startup = new Function(
  'listVms',
  'cfg',
  'isCodexVm',
  'vmNodeId',
  'path',
  'ensureSlotSubscriptionType',
  'console',
  server.slice(start, end),
)

test('startup subscription migration only writes locally owned Claude files', () => {
  const calls = []
  startup(
    () => [
      { id: 'vm-local', account_tier: 'max' },
      { id: 'vm-remote', node_id: 'fixture-node', account_tier: 'max' },
      { id: 'vm-codex', kind: 'codex' },
    ],
    { paths: { project: 'fixture-only' } },
    (vm) => vm.kind === 'codex',
    vmNodeId,
    path,
    (...args) => calls.push(args),
    { warn() {} },
  )
  assert.deepEqual(calls, [[path.join('fixture-only', 'vms', 'vm-local', 'cli-home'), 'max']])
})

const supervisor = fs.readFileSync(
  new URL('../../src/lib/transport/rust-kernel-supervisor.mjs', import.meta.url),
  'utf8',
)
const from = supervisor.indexOf('  if (exec?.homeDir) {', supervisor.indexOf('async function startRustKernel'))
const to = supervisor.indexOf('  const paths = rustKernelPaths(exec)', from)
assert.ok(from >= 0 && to > from)
const beforeStart = new Function(
  'exec',
  'slotUidGidFromHomeDir',
  'ensureOfficialCredentialLink',
  'ensureSlotSubscriptionType',
  'slotHost',
  supervisor.slice(from, to),
)

test('kernel start does not stamp the remote credential cache as local authority', () => {
  for (const kind of ['local', 'node']) {
    const calls = []
    beforeStart(
      { homeDir: 'fixture-home', vm: { claude: { account_tier: 'max' } } },
      () => ({}),
      () => {},
      (...args) => calls.push(args),
      () => ({ kind }),
    )
    assert.equal(calls.length, kind === 'local' ? 1 : 0)
  }
})
