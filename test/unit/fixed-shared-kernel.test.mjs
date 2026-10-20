import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { fixedDataplaneSpec, readFixedRelease } from '../../src/lib/vm/wrap-fixed.mjs'
import {
  materializeSlotDataplane,
  materializeWrapCli,
  inspectKernelChanges,
  inspectSlotDataplane,
  preflightDataplane,
  syncWrapSample,
  describeWrapSample,
} from '../../src/lib/vm/wrap-cli-runtime.mjs'
import { KERNEL_DATAPLANES } from '../../src/lib/vm/slot-engine.mjs'
import { ensureSlotInferenceRuntime } from '../../src/lib/vm/slot-runtime.mjs'
import { writeKernelConfig } from '../../src/lib/transport/rust-kernel-supervisor.mjs'
import { slotHost } from '../../src/lib/vm/slot-host.mjs'
import { CC_TRACE_CONTAINER_BIN } from '../../src/lib/transport/cc-native-trace.mjs'

const repository = fileURLToPath(new URL('../../', import.meta.url))
const previousEnv = process.env.KIN_KERNEL_BIN
before(() => {
  delete process.env.KIN_KERNEL_BIN
})
after(() => {
  if (previousEnv === undefined) delete process.env.KIN_KERNEL_BIN
  else process.env.KIN_KERNEL_BIN = previousEnv
})
const hash = (b) => crypto.createHash('sha256').update(b).digest('hex')
function elf(value) {
  const bytes = Buffer.alloc(80)
  bytes.set([127, 69, 76, 70, 2, 1])
  bytes.writeUInt16LE(3, 16)
  bytes.writeUInt16LE(62, 18)
  bytes[64] = value
  return bytes
}
function fixture(t, plane) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-shared-kernel-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const spec = fixedDataplaneSpec(plane)
  const dir = path.join(root, 'share', spec.directory)
  const manifest = JSON.parse(fs.readFileSync(path.join(repository, 'share', spec.directory, 'manifest.json')))
  const cli = elf(7),
    archived = elf(8),
    shared = elf(9),
    sample = elf(10)
  Object.assign(manifest.artifacts[spec.artifact], { bytes: cli.length, sha256: hash(cli) })
  // An archived/foreign kernel field must remain ignored even in a CLI-only bundle.
  manifest.kernel = { bytes: archived.length, sha256: hash(archived) }
  const files = {
    [`share/${spec.directory}/${spec.artifact}`]: cli,
    [`share/${spec.directory}/kin-kernel.bin`]: archived,
    'bin/kin-kernel': shared,
    'share/wrap-cli/kin-kernel.bin': sample,
    'share/wrap-cli/cli-node': elf(11),
    'share/wrap-cli/cc-node': elf(12),
  }
  for (const [name, bytes] of Object.entries(files)) {
    const file = path.join(root, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, bytes)
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
  const vm = { id: 'vm-1', dataplane: plane, inference_engine: 'rust', status: 'stopped' }
  const home = path.join(root, 'vms', vm.id, 'cli-home/.kin')
  return { root, spec, dir, cli, archived, shared, sample, vm, home }
}
for (const plane of ['wrap-fixed', 'cc-fixed']) {
  test(`${plane} KVM uses the shared home, correct fixed binary, and relay socket ownership`, async (t) => {
    const f = fixture(t, plane)
    f.vm.runtime_type = 'kvm'
    f.vm.has_token = true
    const calls = []
    const result = await ensureSlotInferenceRuntime(f.vm, f.root, {
      routing: { inference: { dataplane: plane } },
      ops: {
        ensureRustKernel: async (exec) => {
          calls.push(exec)
          return { ok: true }
        },
        containerHasKernelMount() {
          throw Error('KVM must not inspect a Docker kernel bind mount')
        },
      },
    })
    assert.equal(result.ok, true, result.error)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].vm, f.vm)
    assert.deepEqual(fs.readFileSync(path.join(f.home, f.spec.slotCli)), f.cli)
    assert.deepEqual(fs.readFileSync(path.join(f.home, 'kin-kernel.bin')), f.shared)
    assert.equal(slotHost(f.vm).ownsSocketFiles, false)
    writeKernelConfig(f.root, f.vm, {
      routing: { inference: { dataplane: plane }, logging: { cc_native_trace: plane === 'cc-fixed' } },
    })
    const cfg = JSON.parse(fs.readFileSync(path.join(f.root, 'vms', f.vm.id, 'run/kernel.json')))
    assert.equal(cfg.claude_bin, plane === 'cc-fixed' ? CC_TRACE_CONTAINER_BIN : `/home/kincli/.kin/${f.spec.slotCli}`)
    if (plane === 'cc-fixed')
      assert.ok(
        fs
          .readFileSync(path.join(f.home, path.posix.basename(CC_TRACE_CONTAINER_BIN)), 'utf8')
          .includes(f.spec.slotCli),
      )
  })
  test(`${plane} installs the native kernel source, not its historical bundled kernel`, (t) => {
    const f = fixture(t, plane)
    const got = materializeSlotDataplane(f.root, f.vm)
    assert.equal(got.ok, true, got.error)
    assert.deepEqual(fs.readFileSync(path.join(f.home, 'kin-kernel.bin')), f.shared)
    assert.deepEqual(fs.readFileSync(path.join(f.home, f.spec.slotCli)), f.cli)
    assert.equal(got.kernel_source, path.join(f.root, 'bin/kin-kernel'))
  })
  test(`${plane} sync follows changed upstream kernel while retaining fixed CLI`, (t) => {
    const f = fixture(t, plane)
    assert.equal(materializeSlotDataplane(f.root, f.vm).ok, true)
    const cliFile = path.join(f.home, f.spec.slotCli)
    fs.utimesSync(cliFile, new Date(1000), new Date(1000))
    const before = fs.statSync(cliFile).mtimeMs
    const next = elf(22)
    fs.writeFileSync(path.join(f.root, 'bin/kin-kernel'), next)
    assert.equal(inspectSlotDataplane(f.root, f.vm, plane).ok, false)
    const synced = syncWrapSample(f.root, [f.vm], { routing: {} })
    assert.equal(synced.items[0].ok, true)
    assert.deepEqual(fs.readFileSync(path.join(f.home, 'kin-kernel.bin')), next)
    assert.deepEqual(fs.readFileSync(cliFile), f.cli)
    assert.equal(fs.statSync(cliFile).mtimeMs, before)
    assert.equal(inspectSlotDataplane(f.root, f.vm, plane).ok, true)
    const view = describeWrapSample(f.root)[plane === 'wrap-fixed' ? 'wrap_fixed' : 'cc_fixed']
    assert.equal(view.kernel.sha256, hash(next))
    assert.equal(view.kernel_policy, 'shared_upstream')
  })
  test(`${plane} CLI-only maintenance is visible to synchronization with an unchanged kernel`, (t) => {
    const f = fixture(t, plane)
    assert.equal(materializeSlotDataplane(f.root, f.vm).ok, true)
    fs.writeFileSync(path.join(f.home, f.spec.slotCli), elf(33))
    const before = fs.readFileSync(path.join(f.home, f.spec.slotCli))
    const inspection = inspectKernelChanges(f.root, [f.vm], { routing: {} })
    assert.equal(inspection.items[0].cli_changed, true)
    assert.equal(inspection.items[0].kernel_changed, false)
    assert.equal(inspection.changed_count, 1)
    assert.deepEqual(fs.readFileSync(path.join(f.home, f.spec.slotCli)), before)
    const synced = syncWrapSample(f.root, [f.vm], { routing: {} })
    assert.equal(synced.items[0].cli_changed, true)
    assert.equal(synced.items[0].kernel_changed, false)
    assert.equal(synced.changed_count, 1)
    assert.deepEqual(fs.readFileSync(path.join(f.home, f.spec.slotCli)), f.cli)
    assert.equal(syncWrapSample(f.root, [f.vm], { routing: {} }).changed_count, 0)
  })
  test(`${plane} inspection refuses unapproved fixed bytes without substituting stock CLI`, (t) => {
    const f = fixture(t, plane)
    assert.equal(materializeSlotDataplane(f.root, f.vm).ok, true)
    fs.writeFileSync(path.join(f.dir, f.spec.artifact), elf(34))
    const inspected = inspectKernelChanges(f.root, [f.vm], { routing: {} })
    assert.equal(inspected.ok, false)
    assert.match(inspected.items[0].code, /_hash$/)
    assert.deepEqual(fs.readFileSync(path.join(f.home, f.spec.slotCli)), f.cli)
  })
  test(`${plane} does not require or fall back to the old bundled kernel`, (t) => {
    const f = fixture(t, plane)
    fs.unlinkSync(path.join(f.dir, 'kin-kernel.bin'))
    assert.equal(readFixedRelease(f.root, plane).ok, true)
    assert.equal(materializeSlotDataplane(f.root, f.vm).ok, true)
    fs.unlinkSync(path.join(f.root, 'bin/kin-kernel'))
    assert.equal(materializeSlotDataplane(f.root, f.vm).ok, true)
    assert.deepEqual(fs.readFileSync(path.join(f.home, 'kin-kernel.bin')), f.sample)
    fs.unlinkSync(path.join(f.root, 'share/wrap-cli/kin-kernel.bin'))
    assert.equal(preflightDataplane(f.root, plane).ok, false)
  })
}
test('explicit native kernel override is shared with normal and fixed paths', (t) => {
  const f = fixture(t, 'cc-fixed')
  const file = path.join(f.root, 'custom-kernel')
  fs.writeFileSync(file, elf(31))
  process.env.KIN_KERNEL_BIN = file
  try {
    assert.equal(materializeSlotDataplane(f.root, f.vm).ok, true)
    assert.equal(materializeWrapCli(f.root, { ...f.vm, id: 'vm-2', dataplane: 'cc' }).ok, true)
    assert.deepEqual(fs.readFileSync(path.join(f.home, 'kin-kernel.bin')), elf(31))
    assert.deepEqual(fs.readFileSync(path.join(f.root, 'vms/vm-2/cli-home/.kin/kin-kernel.bin')), elf(31))
    fs.writeFileSync(file, 'not an ELF')
    assert.equal(preflightDataplane(f.root, 'cc-fixed').ok, false)
  } finally {
    delete process.env.KIN_KERNEL_BIN
  }
})
test('shared kernel policy introduces no new dataplane or candidate choices', () => {
  assert.deepEqual(KERNEL_DATAPLANES, ['wrap', 'wrap-fixed', 'cc', 'cc-fixed', 'crag'])
  const round = JSON.parse(fs.readFileSync(path.join(repository, 'src/lib/transport/offline-candidate-round.json')))
  assert.deepEqual(round.choices, [])
})
