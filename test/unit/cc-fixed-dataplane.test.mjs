import test from 'node:test'
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
} from '../../src/lib/vm/wrap-cli-runtime.mjs'
import { resolveKernelDataplane, parseKernelDataplanePatch } from '../../src/lib/vm/slot-engine.mjs'
import { writeKernelConfig } from '../../src/lib/transport/rust-kernel-supervisor.mjs'
import { ensureSlotInferenceRuntime } from '../../src/lib/vm/slot-runtime.mjs'
import { buildRecreatedVmRecord } from '../../src/lib/vm/vm-recreate.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { runOfflineKernelProbe } from '../../src/lib/transport/offline-kernel-probe.mjs'
import { readFixedRelease } from '../../src/lib/vm/wrap-fixed.mjs'

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
    fs.readFileSync(new URL('../../share/cc-fixed/v155-r3/manifest.json', import.meta.url), 'utf8'),
  )
  Object.assign(manifest.artifacts['cc-node'], { bytes: cli.length, sha256: sha(cli) })
  Object.assign(manifest.kernel, { bytes: kernel.length, sha256: sha(kernel) })
  for (const [file, bytes] of Object.entries({
    'share/cc-fixed/v155-r3/cc-node': cli,
    'share/cc-fixed/v155-r3/kin-kernel.bin': kernel,
    'share/wrap-cli/cli-node': ordinary,
    'share/wrap-cli/cc-node': ordinary,
    'share/wrap-cli/kin-kernel.bin': ordinary,
    'bin/kin-kernel': ordinary,
  })) {
    const full = path.join(root, file)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, bytes)
  }
  const manifestPath = path.join(root, 'share/cc-fixed/v155-r3/manifest.json')
  fs.writeFileSync(manifestPath, JSON.stringify(manifest))
  const vm = { id: 'vm-1', dataplane: 'cc-fixed', inference_engine: 'rust', status: 'stopped' }
  return { root, cli, kernel, ordinary, manifest, manifestPath, vm, home: path.join(root, 'vms/vm-1/cli-home/.kin') }
}
test('actual promoted CC bundle matches its manifest and preserves the accepted kernel', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const result = readFixedRelease(root, 'cc-fixed')
  assert.equal(result.ok, true, result.error)
  assert.equal(result.id, 'cc-fixed-v155-r3')
  assert.equal(result.manifest.production_approved, true)
  assert.equal(result.manifest.local_validation.native_execution, false)
  const candidate = JSON.parse(
    fs.readFileSync(new URL('../../share/offline-candidates/native-v155-r3/manifest.json', import.meta.url), 'utf8'),
  )
  assert.equal(result.kernel.sha256, candidate.kernel_sha256.cc)
  assert.equal(result.manifest.artifacts['cc-node'].source_candidate_sha256, candidate.artifacts['cc-node'].sha256)
})

test('cc-fixed is explicit while normal defaults and candidate refusal stay intact', () => {
  assert.equal(resolveKernelDataplane({}, {}), 'wrap')
  assert.deepEqual(parseKernelDataplanePatch('cc-fixed'), { ok: true, value: 'cc-fixed' })
  assert.equal(resolveKernelDataplane({ dataplane: 'cc-fixed' }, {}), 'cc-fixed')
  assert.equal(parseKernelDataplanePatch('candidate-cc-r3').ok, false)
})
test('CC fixed installs a coherent pinned pair without replacing the original CC', (t) => {
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
test('normal release sync respects the fixed CC selection and cannot promote it into the original sample', (t) => {
  const f = fixture(t)
  fs.mkdirSync(path.join(f.root, 'vms'), { recursive: true })
  fs.writeFileSync(path.join(f.root, 'vms/vm-1.json'), JSON.stringify(f.vm))
  assert.equal(materializeSlotDataplane(f.root, f.vm).ok, true)
  fs.writeFileSync(path.join(f.root, 'share/wrap-cli/cc-node'), elf(9))
  fs.writeFileSync(path.join(f.root, 'bin/kin-kernel'), elf(10))
  const result = syncWrapSample(f.root, [f.vm], { routing: {} })
  assert.equal(result.items[0].ok, true)
  assert.deepEqual(fs.readFileSync(path.join(f.home, 'cc-node-fixed')), f.cli)
  assert.deepEqual(fs.readFileSync(path.join(f.home, 'kin-kernel.bin')), f.kernel)
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
  fs.writeFileSync(path.join(f.root, 'share/cc-fixed/v155-r3/cc-node'), elf(11))
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
    assert.equal(report.meta.fixed_release.id, 'cc-fixed-v155-r3')
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
