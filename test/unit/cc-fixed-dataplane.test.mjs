import test from 'node:test'
import { REQUEST_WIRE_BASES } from '../../scripts/refresh-fixed-cli-request-wire.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  materializeSlotDataplane,
  materializeWrapCli,
  syncWrapSample,
  captureWrapSample,
  preflightDataplane,
  readFixedDataplane,
} from '../../src/lib/vm/wrap-cli-runtime.mjs'
import { resolveKernelDataplane, parseKernelDataplanePatch } from '../../src/lib/vm/slot-engine.mjs'
import { writeKernelConfig } from '../../src/lib/transport/rust-kernel-supervisor.mjs'
import { ensureSlotInferenceRuntime } from '../../src/lib/vm/slot-runtime.mjs'
import { buildRecreatedVmRecord } from '../../src/lib/vm/vm-recreate.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { runOfflineKernelProbe } from '../../src/lib/transport/offline-kernel-probe.mjs'
import { readFixedRelease, fixedDataplaneSpec, CC_FIXED_ID } from '../../src/lib/vm/wrap-fixed.mjs'
const RELEASE_DIR = fixedDataplaneSpec('cc-fixed').directory

const sha = (x) => crypto.createHash('sha256').update(x).digest('hex')
function elf(value) {
  const b = Buffer.alloc(80, value)
  b.set([0x7f, 0x45, 0x4c, 0x46, 2, 1])
  b.writeUInt16LE(3, 16)
  b.writeUInt16LE(62, 18)
  return b
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-cc-fixed-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const cli = elf(7),
    kernel = elf(8),
    ordinary = elf(3)
  const manifest = JSON.parse(
    fs.readFileSync(new URL(`../../share/${RELEASE_DIR}/manifest.json`, import.meta.url), 'utf8'),
  )
  Object.assign(manifest.artifacts['cc-node'], { bytes: cli.length, sha256: sha(cli) })
  manifest.kernel = { bytes: kernel.length, sha256: sha(kernel) }
  for (const [file, bytes] of Object.entries({
    [`share/${RELEASE_DIR}/cc-node`]: cli,
    [`share/${RELEASE_DIR}/kin-kernel.bin`]: kernel,
    'share/wrap-cli/cli-node': ordinary,
    'share/wrap-cli/cc-node': ordinary,
    'share/wrap-cli/kin-kernel.bin': ordinary,
    'bin/kin-kernel': ordinary,
  })) {
    const full = path.join(root, file)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, bytes)
  }
  const manifestPath = path.join(root, 'share', RELEASE_DIR, 'manifest.json')
  fs.writeFileSync(manifestPath, JSON.stringify(manifest))
  const vm = { id: 'vm-1', dataplane: 'cc-fixed', inference_engine: 'rust', status: 'stopped' }
  return {
    root,
    cli,
    kernel: ordinary,
    archivedKernel: kernel,
    ordinary,
    manifest,
    manifestPath,
    vm,
    home: path.join(root, 'vms/vm-1/cli-home/.kin'),
  }
}
test('actual repaired CC is pinned while its runtime kernel follows the native source', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const result = readFixedRelease(root, 'cc-fixed')
  assert.equal(result.ok, true, result.error)
  assert.equal(result.id, CC_FIXED_ID)
  assert.equal(result.manifest.production_approved, true)
  assert.equal(result.manifest.local_validation.native_execution, false)
  assert.equal(result.kernel, undefined, 'the CLI loader must not load the historical kernel')
  const runtime = readFixedDataplane(root, 'cc-fixed')
  assert.equal(runtime.ok, true, runtime.error)
  assert.equal(runtime.kernel.sha256, sha(fs.readFileSync(path.join(root, 'bin/kin-kernel'))))
  assert.equal(result.manifest.lineage.source_sha256, REQUEST_WIRE_BASES.cc.packed)
  assert.equal(result.manifest.cache_contract, 'node_dual_anchor_v1')
})

test('cc-fixed is explicit while normal defaults and candidate refusal stay intact', () => {
  assert.equal(resolveKernelDataplane({}, {}), 'wrap')
  assert.deepEqual(parseKernelDataplanePatch('cc-fixed'), { ok: true, value: 'cc-fixed' })
  assert.equal(resolveKernelDataplane({ dataplane: 'cc-fixed' }, {}), 'cc-fixed')
  assert.equal(parseKernelDataplanePatch('candidate-cc-r3').ok, false)
})
test('CC fixed installs the repaired CLI and shared kernel without replacing original CC', (t) => {
  const f = fixture(t)
  materializeWrapCli(f.root, { ...f.vm, dataplane: 'cc' })
  const result = materializeSlotDataplane(f.root, f.vm)
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(fs.readFileSync(path.join(f.home, 'cc-node-fixed')), f.cli)
  assert.deepEqual(fs.readFileSync(path.join(f.home, 'cc-node')), f.ordinary)
  assert.deepEqual(fs.readFileSync(path.join(f.home, 'kin-kernel.bin')), f.kernel)
  writeKernelConfig(f.root, f.vm, { routing: {} })
  const config = JSON.parse(fs.readFileSync(path.join(f.root, 'vms/vm-1/run/kernel.json'), 'utf8'))
  assert.equal(config.dataplane, 'cc')
  assert.equal(config.claude_bin, '/home/kincli/.kin/cc-node-fixed')
})
test('cold cc-fixed install supplies the stock bootstrap companion while API stays repaired CC', (t) => {
  const f = fixture(t)
  assert.equal(materializeSlotDataplane(f.root, f.vm, 'cc-fixed').ok, true)
  assert.deepEqual(fs.readFileSync(path.join(f.home, 'cli-node')), f.ordinary)
  const written = writeKernelConfig(f.root, f.vm, {})
  assert.equal(JSON.parse(fs.readFileSync(written.configPath)).claude_bin, '/home/kincli/.kin/cc-node-fixed')
})

test('sync advances an installed old kernel without rewriting the unchanged CC repair', (t) => {
  const f = fixture(t)
  assert.equal(materializeSlotDataplane(f.root, f.vm).ok, true)
  const cli = path.join(f.home, 'cc-node-fixed')
  fs.utimesSync(cli, new Date(1000), new Date(1000))
  const before = fs.statSync(cli).mtimeMs
  fs.writeFileSync(path.join(f.home, 'kin-kernel.bin'), elf(23))
  const report = syncWrapSample(f.root, [f.vm], { routing: {} })
  assert.equal(report.items[0].ok, true)
  assert.deepEqual(fs.readFileSync(path.join(f.home, 'kin-kernel.bin')), f.kernel)
  assert.deepEqual(fs.readFileSync(cli), f.cli)
  assert.equal(fs.statSync(cli).mtimeMs, before)
})

test('normal release sync updates the shared kernel but retains repaired CC and original-sample protection', (t) => {
  const f = fixture(t)
  fs.mkdirSync(path.join(f.root, 'vms'), { recursive: true })
  fs.writeFileSync(path.join(f.root, 'vms/vm-1.json'), JSON.stringify(f.vm))
  assert.equal(materializeSlotDataplane(f.root, f.vm).ok, true)
  fs.writeFileSync(path.join(f.root, 'share/wrap-cli/cc-node'), elf(9))
  fs.writeFileSync(path.join(f.root, 'bin/kin-kernel'), elf(10))
  const result = syncWrapSample(f.root, [f.vm], { routing: {} })
  assert.equal(result.items[0].ok, true)
  assert.deepEqual(fs.readFileSync(path.join(f.home, 'cc-node-fixed')), f.cli)
  assert.deepEqual(fs.readFileSync(path.join(f.home, 'kin-kernel.bin')), elf(10))
  assert.equal(captureWrapSample(f.root, f.vm).ok, false)
})
test('missing or unapproved fixed CC assets refuse without original fallback', (t) => {
  const f = fixture(t)
  f.manifest.production_approved = false
  fs.writeFileSync(f.manifestPath, JSON.stringify(f.manifest))
  assert.equal(preflightDataplane(f.root, 'cc-fixed').ok, false)
  assert.equal(materializeSlotDataplane(f.root, f.vm).ok, false)
  assert.equal(fs.existsSync(f.home), false)
  fs.unlinkSync(f.manifestPath)
  assert.equal(materializeSlotDataplane(f.root, f.vm).ok, false)
})
test('tampered CLI and conflicting binary override are refused', (t) => {
  const f = fixture(t),
    prev = process.env.KIN_CLAUDE_BIN
  try {
    process.env.KIN_CLAUDE_BIN = '/wrong/cc'
    assert.equal(preflightDataplane(f.root, 'cc-fixed').ok, false)
    assert.throws(() => writeKernelConfig(f.root, f.vm, { routing: {} }), /cc-fixed/)
  } finally {
    if (prev === undefined) delete process.env.KIN_CLAUDE_BIN
    else process.env.KIN_CLAUDE_BIN = prev
  }
  fs.writeFileSync(path.join(f.root, 'share', RELEASE_DIR, 'cc-node'), elf(11))
  assert.equal(materializeSlotDataplane(f.root, f.vm).ok, false)
})
test('reset and startup recovery retain the CC fixed selection', async (t) => {
  const f = fixture(t)
  assert.equal(buildRecreatedVmRecord(f.vm).dataplane, 'cc-fixed')
  materializeWrapCli(f.root, { ...f.vm, dataplane: 'cc' })
  let starts = 0
  const result = await ensureSlotInferenceRuntime({ ...f.vm, has_token: true }, f.root, {
    ops: {
      ensureRustKernel: async () => {
        starts++
        assert.deepEqual(fs.readFileSync(path.join(f.home, 'cc-node-fixed')), f.cli)
        return { ok: true }
      },
    },
  })
  assert.equal(result.ok, true)
  assert.equal(starts, 1)
})
for (const plane of ['current', 'cc-fixed'])
  test(`low-level ${plane} snapshot observes promoted CC, not the original executable`, async (t) => {
    const f = fixture(t)
    fs.mkdirSync(path.join(f.root, 'vms'), { recursive: true })
    fs.writeFileSync(path.join(f.root, 'vms/vm-1.json'), JSON.stringify(f.vm))
    assert.equal(materializeSlotDataplane(f.root, f.vm).ok, true)
    writeKernelConfig(f.root, f.vm, { routing: {} })
    let input
    const report = await runOfflineKernelProbe({
      projectRoot: f.root,
      vmId: 'vm-1',
      plane,
      envelope: { body: { model: 'claude-opus-4-6' } },
      command: async (args) => {
        if (args[0] === 'inspect') return 'sha256:' + 'a'.repeat(64)
        if (args[0] === 'cp') {
          input = JSON.parse(fs.readFileSync(path.join(args[1], 'input.json'), 'utf8'))
          assert.deepEqual(fs.readFileSync(path.join(args[1], 'real-cli')), f.cli)
        }
        if (args[0] === 'start')
          return JSON.stringify({
            version: 1,
            nonce: input.nonce,
            simulation: true,
            network_isolated: true,
            inputs_readonly: true,
            binary_inputs_verified: true,
            observed_binary_hashes: { kernel_sha256: input.meta.kernel_sha256, cli_sha256: input.meta.cli_sha256 },
            stages: [],
          })
        return ''
      },
    })
    assert.equal(report.meta.selected_pairing, 'cc-fixed')
    assert.equal(report.meta.cli_name, 'cc-node-fixed')
    assert.equal(report.meta.fixed_release.id, CC_FIXED_ID)
    assert.equal(report.meta.candidate, undefined)
  })

test('public default switch installs fixed CC only for inherited slots and writes config without restart', async (t) => {
  const f = fixture(t)
  fs.mkdirSync(path.join(f.root, 'vms'), { recursive: true })
  const inherited = { ...f.vm }
  delete inherited.dataplane
  fs.writeFileSync(path.join(f.root, 'vms/vm-1.json'), JSON.stringify(inherited))
  fs.writeFileSync(path.join(f.root, 'vms/vm-2.json'), JSON.stringify({ ...inherited, id: 'vm-2', dataplane: 'wrap' }))
  const ctx = {
    cfg: { paths: { project: f.root, root: path.join(f.root, 'src') } },
    routingConfig: { inference: { dataplane: 'wrap' } },
    requireAuth(req) {
      req.panelRole = 'admin'
      req.panelUser = 'admin'
      return true
    },
    readBody: async (req) => req.body,
    json(res, status, body) {
      res.status = status
      res.body = body
    },
    persistRoutingPatch(body) {
      ctx.routingConfig = {
        ...ctx.routingConfig,
        ...body,
        inference: { ...ctx.routingConfig.inference, ...body.inference },
      }
      return {}
    },
  }
  const res = {}
  await createPanelHandler(ctx)(
    {
      url: '/api/panel/dataplane',
      method: 'POST',
      headers: {},
      body: { dataplane: 'cc-fixed', all: true, restart: false },
    },
    res,
    new URL('http://fixture/api/panel/dataplane'),
  )
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(ctx.routingConfig.inference.dataplane, 'cc-fixed')
  assert.equal(fs.existsSync(path.join(f.root, 'vms/vm-2/cli-home/.kin/cc-node-fixed')), false)
  const config = JSON.parse(fs.readFileSync(path.join(f.root, 'vms/vm-1/run/kernel.json'), 'utf8'))
  assert.equal(config.claude_bin, '/home/kincli/.kin/cc-node-fixed')
})
