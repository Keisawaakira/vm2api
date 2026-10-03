import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  resolveKernelDataplane,
  parseKernelDataplanePatch,
  normalizeInferenceConfig,
} from '../../src/lib/vm/slot-engine.mjs'
import {
  materializeSlotDataplane,
  materializeWrapCli,
  syncWrapSample,
  captureWrapSample,
} from '../../src/lib/vm/wrap-cli-runtime.mjs'
import { writeKernelConfig } from '../../src/lib/transport/rust-kernel-supervisor.mjs'
import { buildRecreatedVmRecord } from '../../src/lib/vm/vm-recreate.mjs'
import { ensureSlotInferenceRuntime } from '../../src/lib/vm/slot-runtime.mjs'
import { startRemoteSlot } from '../../src/lib/cluster/remote-slot.mjs'
import { dispatchStreamInference, resolveHopEngine } from '../../src/lib/transport/kernel-router.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { runOfflineKernelProbe } from '../../src/lib/transport/offline-kernel-probe.mjs'
import { fixedDataplaneSpec } from '../../src/lib/vm/wrap-fixed.mjs'
const RELEASE_DIR = fixedDataplaneSpec('wrap-fixed').directory
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
function elf(value) {
  const b = Buffer.alloc(96, value)
  Buffer.from([127, 69, 76, 70, 2, 1]).copy(b)
  b.writeUInt16LE(62, 18)
  return b
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrap-fixed-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const plain = elf(1),
    fixedCli = elf(2),
    fixedKernel = elf(3),
    crag = elf(4)
  const files = {
    'bin/kin-kernel': plain,
    'share/wrap-cli/kin-kernel.bin': plain,
    'share/wrap-cli/cli-node': plain,
    'share/wrap-cli/cc-node': plain,
    'share/crag/kin-kernel': crag,
    [`share/${RELEASE_DIR}/cli-node`]: fixedCli,
    [`share/${RELEASE_DIR}/kin-kernel.bin`]: fixedKernel,
  }
  for (const [name, bytes] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
    fs.writeFileSync(path.join(root, name), bytes)
  }
  const manifest = JSON.parse(
    fs.readFileSync(new URL(`../../share/${RELEASE_DIR}/manifest.json`, import.meta.url), 'utf8'),
  )
  manifest.kernel = { sha256: digest(fixedKernel), bytes: fixedKernel.length }
  Object.assign(manifest.artifacts['cli-node'], { sha256: digest(fixedCli), bytes: fixedCli.length })
  const manifestPath = path.join(root, 'share', RELEASE_DIR, 'manifest.json')
  const writeManifest = () => fs.writeFileSync(manifestPath, JSON.stringify(manifest))
  writeManifest()
  const vm = {
    id: 'vm-1',
    kernel: 'ubuntu-24.04',
    dataplane: 'wrap-fixed',
    persona_preset: 'zero',
    runtime: { type: 'docker' },
  }
  const home = path.join(root, 'vms/vm-1/cli-home/.kin')
  return {
    root,
    vm,
    home,
    plain,
    fixedCli,
    fixedKernel: plain,
    archivedKernel: fixedKernel,
    crag,
    manifest,
    writeManifest,
    manifestPath,
  }
}
test('wrap-fixed is explicit production selection; wrap stays the default and candidates stay forbidden', () => {
  assert.equal(normalizeInferenceConfig({}).dataplane, 'wrap')
  assert.equal(resolveKernelDataplane({}, {}), 'wrap')
  assert.equal(resolveKernelDataplane({ dataplane: 'wrap-fixed' }, {}), 'wrap-fixed')
  assert.equal(resolveKernelDataplane({}, { inference: { dataplane: 'wrap-fixed' } }), 'wrap-fixed')
  assert.deepEqual(parseKernelDataplanePatch('wrap-fixed'), { ok: true, value: 'wrap-fixed' })
  for (const value of ['candidate-wrap', 'candidate-cc-r2', 'candidate-crag-r2'])
    assert.equal(parseKernelDataplanePatch(value).ok, false)
})
test('fixed CLI installs as a separate executable with the shared native kernel', (t) => {
  const f = fixture(t)
  materializeWrapCli(f.root, { ...f.vm, dataplane: 'wrap' })
  const result = materializeSlotDataplane(f.root, f.vm, 'wrap-fixed')
  assert.equal(result.ok, true)
  assert.equal(result.dataplane, 'wrap-fixed')
  assert.deepEqual(fs.readFileSync(path.join(f.home, 'cli-node-fixed')), f.fixedCli)
  assert.deepEqual(fs.readFileSync(path.join(f.home, 'kin-kernel.bin')), f.fixedKernel)
  assert.deepEqual(fs.readFileSync(path.join(f.home, 'cli-node')), f.plain)
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'share/wrap-cli/cli-node')), f.plain)
})
test('kernel ABI remains wrap while selecting fixed executable and preserving zero/system parameters', (t) => {
  const f = fixture(t)
  const out = writeKernelConfig(f.root, f.vm, { routing: { compatibility: { persona_preset: 'zero' } } })
  const config = JSON.parse(fs.readFileSync(out.configPath, 'utf8'))
  assert.equal(config.dataplane, 'wrap')
  assert.equal(config.claude_bin, '/home/kincli/.kin/cli-node-fixed')
  assert.equal(config.system_layout, 'zero')
  assert.equal(config.provider, 'local_cli')
})
test('sync advances an installed old kernel without rewriting the unchanged CLI repair', (t) => {
  const f = fixture(t)
  assert.equal(materializeSlotDataplane(f.root, f.vm, 'wrap-fixed').ok, true)
  const cli = path.join(f.home, 'cli-node-fixed')
  fs.utimesSync(cli, new Date(1000), new Date(1000))
  const before = fs.statSync(cli).mtimeMs
  fs.writeFileSync(path.join(f.home, 'kin-kernel.bin'), elf(23))
  const report = syncWrapSample(f.root, [f.vm], { routing: {} })
  assert.equal(report.ok, true)
  assert.deepEqual(fs.readFileSync(path.join(f.home, 'kin-kernel.bin')), f.fixedKernel)
  assert.deepEqual(fs.readFileSync(cli), f.fixedCli)
  assert.equal(fs.statSync(cli).mtimeMs, before)
})

test('normal sync follows the native kernel update without replacing repaired CLI', (t) => {
  const f = fixture(t)
  materializeSlotDataplane(f.root, f.vm, 'wrap-fixed')
  const newer = elf(9)
  fs.writeFileSync(path.join(f.root, 'bin/kin-kernel'), newer)
  fs.writeFileSync(path.join(f.root, 'share/wrap-cli/cli-node'), newer)
  const report = syncWrapSample(f.root, [f.vm], { routing: {} })
  assert.equal(report.ok, true)
  assert.deepEqual(fs.readFileSync(path.join(f.home, 'cli-node-fixed')), f.fixedCli)
  assert.deepEqual(fs.readFileSync(path.join(f.home, 'kin-kernel.bin')), newer)
})
test('missing or unapproved promoted assets fail closed before installing a slot', (t) => {
  const f = fixture(t)
  f.manifest.production_approved = false
  f.writeManifest()
  const denied = materializeSlotDataplane(f.root, f.vm, 'wrap-fixed')
  assert.equal(denied.ok, false)
  assert.equal(fs.existsSync(f.home), false)
  fs.unlinkSync(f.manifestPath)
  assert.equal(materializeSlotDataplane(f.root, f.vm, 'wrap-fixed').ok, false)
})
test('tampered promoted CLI cannot silently fall back to the original', (t) => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.root, 'share', RELEASE_DIR, 'cli-node'), elf(8))
  assert.equal(materializeSlotDataplane(f.root, f.vm, 'wrap-fixed').ok, false)
  assert.equal(fs.existsSync(f.home), false)
})
test('factory-reset record retains the explicitly selected dataplane', (t) => {
  const f = fixture(t)
  const record = buildRecreatedVmRecord(
    { ...f.vm, name: 'fixture', timezone: 'UTC', policy: {} },
    { device_id: 'fixture', reset_at: '2026-09-26T00:00:00Z', timezone: 'UTC', locale: 'en_US.UTF-8' },
  )
  assert.equal(record.dataplane, 'wrap-fixed')
})
for (const dataplane of ['wrap-fixed', 'crag'])
  test(`startup recovery materializes the selected ${dataplane} instead of raw wrap`, async (t) => {
    const f = fixture(t)
    materializeWrapCli(f.root, { ...f.vm, dataplane: 'wrap' })
    let starts = 0
    const vm = { ...f.vm, dataplane, has_token: true }
    const result = await ensureSlotInferenceRuntime(vm, f.root, {
      ops: {
        ensureRustKernel: async () => {
          starts++
          assert.deepEqual(
            fs.readFileSync(path.join(f.home, 'kin-kernel.bin')),
            dataplane === 'crag' ? f.crag : f.fixedKernel,
          )
          if (dataplane === 'wrap-fixed')
            assert.deepEqual(fs.readFileSync(path.join(f.home, 'cli-node-fixed')), f.fixedCli)
          return { ok: true }
        },
      },
    })
    assert.equal(result.ok, true)
    assert.equal(starts, 1)
  })
function panelFixture(f) {
  fs.mkdirSync(path.join(f.root, 'vms'), { recursive: true })
  const inherited = { ...f.vm, status: 'stopped' }
  delete inherited.dataplane
  fs.writeFileSync(path.join(f.root, 'vms/vm-1.json'), JSON.stringify(inherited))
  fs.writeFileSync(path.join(f.root, 'vms/vm-2.json'), JSON.stringify({ ...inherited, id: 'vm-2', dataplane: 'cc' }))
  let persisted = 0
  const ctx = {
    cfg: { paths: { project: f.root, root: path.join(f.root, 'src') }, limits: { max_body_bytes: 1024 * 1024 } },
    routingConfig: { inference: { dataplane: 'wrap' } },
    stickyRouter: { reloadConfig() {} },
    accountQuota: { reloadConfig() {} },
    requireAuth(req) {
      req.panelRole = 'admin'
      req.panelUser = 'admin'
      req.panelUserId = 'admin'
      return true
    },
    readBody: async (req) => req.body,
    json(res, status, body) {
      res.status = status
      res.body = body
    },
    persistRoutingPatch(body) {
      persisted++
      ctx.routingConfig = {
        ...ctx.routingConfig,
        ...body,
        inference: { ...ctx.routingConfig.inference, ...body.inference },
      }
      return {}
    },
  }
  const handler = createPanelHandler(ctx)
  return {
    ctx,
    get persisted() {
      return persisted
    },
    async request(url, body) {
      const res = {}
      await handler(
        {
          url,
          method: url.startsWith('/admin') ? 'POST' : url === '/api/panel/routing' ? 'PUT' : 'POST',
          headers: {},
          body,
        },
        res,
        new URL(url, 'http://fixture'),
      )
      return res
    },
  }
}
for (const url of ['/api/panel/dataplane', '/api/panel/routing', '/admin/routing'])
  test(`${url} installs approved default only into inherited slots`, async (t) => {
    const f = fixture(t),
      p = panelFixture(f)
    const body =
      url === '/api/panel/dataplane'
        ? { dataplane: 'wrap-fixed', all: true, restart: false }
        : { inference: { dataplane: 'wrap-fixed' } }
    const response = await p.request(url, body)
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(p.ctx.routingConfig.inference.dataplane, 'wrap-fixed')
    const config = JSON.parse(fs.readFileSync(path.join(f.root, 'vms/vm-1/run/kernel.json'), 'utf8'))
    assert.equal(config.claude_bin, '/home/kincli/.kin/cli-node-fixed')
    assert.equal(config.dataplane, 'wrap')
    assert.deepEqual(fs.readFileSync(path.join(f.home, 'cli-node-fixed')), f.fixedCli)
    assert.equal(fs.existsSync(path.join(f.root, 'vms/vm-2/cli-home/.kin/cli-node-fixed')), false)
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'vms/vm-2.json'), 'utf8')).dataplane, 'cc')
  })
test('dataplane endpoint rejects missing approved assets before saving configuration', async (t) => {
  const f = fixture(t),
    p = panelFixture(f)
  fs.unlinkSync(f.manifestPath)
  const response = await p.request('/api/panel/dataplane', { dataplane: 'wrap-fixed', all: true })
  assert.equal(response.status, 503)
  assert.equal(p.persisted, 0)
  assert.equal(p.ctx.routingConfig.inference.dataplane, 'wrap')
  assert.equal(fs.existsSync(f.home), false)
})

for (const plane of ['wrap-fixed', 'current'])
  test(`offline ${plane} uses the approved fixed bytes without changing real slot selection`, async (t) => {
    const f = fixture(t)
    fs.mkdirSync(path.join(f.root, 'vms'), { recursive: true })
    fs.writeFileSync(path.join(f.root, 'vms/vm-1.json'), JSON.stringify(f.vm))
    materializeSlotDataplane(f.root, f.vm, 'wrap-fixed')
    writeKernelConfig(f.root, f.vm, { routing: {} })
    const previous = fs.readFileSync(path.join(f.root, 'vms/vm-1/run/kernel.json'), 'utf8')
    let input
    const result = await runOfflineKernelProbe({
      projectRoot: f.root,
      vmId: f.vm.id,
      plane,
      envelope: { body: { model: 'claude-opus-4-6' } },
      command: async (args) => {
        if (args[0] === 'inspect') return 'sha256:' + 'a'.repeat(64)
        if (args[0] === 'cp') {
          input = JSON.parse(fs.readFileSync(path.join(args[1], 'input.json'), 'utf8'))
          assert.deepEqual(fs.readFileSync(path.join(args[1], 'real-cli')), f.fixedCli)
          assert.deepEqual(fs.readFileSync(path.join(args[1], 'kin-kernel.bin')), f.fixedKernel)
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
    assert.equal(result.meta.selected_pairing, 'wrap-fixed')
    assert.equal(result.meta.cli_name, 'cli-node-fixed')
    assert.equal(result.meta.fixed_release.production_approved, true)
    assert.equal(result.meta.candidate, undefined)
    assert.equal(fs.readFileSync(path.join(f.root, 'vms/vm-1/run/kernel.json'), 'utf8'), previous)
  })

for (const dataplane of ['wrap-fixed', 'cc-fixed', 'crag']) {
  test(`baked node refuses ${dataplane} before config or runtime mutations`, async (t) => {
    const f = fixture(t)
    const vm = { ...f.vm, node_id: 'node-fixture', dataplane, has_token: true }
    assert.throws(
      () => writeKernelConfig(f.root, vm, { routing: {}, token: 'test-token' }),
      (e) => e.code === 'remote_unsupported',
    )
    assert.equal(fs.existsSync(path.join(f.root, 'vms', vm.id)), false)
    let starts = 0
    const result = await ensureSlotInferenceRuntime(vm, f.root, {
      routing: {},
      ops: {
        ensureRustKernel: async () => {
          starts++
          return { ok: true }
        },
      },
    })
    assert.equal(result.code, 'remote_unsupported')
    assert.equal(starts, 0)
  })
  test(`remote ${dataplane} start rejects before asking for a node connection`, async (t) => {
    const f = fixture(t)
    const result = await startRemoteSlot({ ...f.vm, dataplane, node_id: 'node-fixture' }, f.root, { routing: {} })
    assert.equal(result.code, 'remote_unsupported')
  })
}

test('remote original CLI cannot be replaced via local materialization', (t) => {
  const f = fixture(t)
  const result = materializeSlotDataplane(f.root, { ...f.vm, node_id: 'node-fixture' }, 'wrap-fixed')
  assert.equal(result.code, 'remote_unsupported')
  assert.equal(fs.existsSync(f.home), false)
})

for (const dataplane of ['wrap-fixed', 'cc-fixed'])
  test(`router blocks remote ${dataplane} before readiness/credentials/dispatch`, async (t) => {
    const f = fixture(t)
    let prepared = 0
    const result = await dispatchStreamInference({
      exec: { vmId: f.vm.id, vm: { ...f.vm, node_id: 'node-fixture', dataplane } },
      routing: {},
      ensureRust: async () => {
        prepared++
        return { ok: false, reason: 'unexpected_fixture_prepare' }
      },
    })
    assert.equal(result.engine_reason, 'remote_dataplane_unsupported')
    assert.equal(result.rust_execution_count, 0)
    assert.equal(prepared, 0)
  })

test('remote original wrap and cc still use baked binaries without local materialization', async (t) => {
  const f = fixture(t)
  for (const dataplane of ['wrap', 'cc']) {
    const vm = { ...f.vm, node_id: 'node-fixture', dataplane, has_token: true }
    assert.equal(resolveHopEngine(vm, {}, { binPath: '' }).blocked, undefined)
    let started = 0
    const result = await ensureSlotInferenceRuntime(vm, f.root, {
      routing: {},
      ops: {
        ensureRustKernel: async () => {
          started++
          return { ok: true }
        },
      },
    })
    assert.equal(result.ok, true)
    assert.equal(started, 1)
    assert.equal(fs.existsSync(f.home), false)
  }
})

for (const url of ['/api/panel/dataplane', '/api/panel/routing', '/admin/routing'])
  test(`${url} cannot change an inherited remote slot to a nonexistent fixed image`, async (t) => {
    const f = fixture(t),
      p = panelFixture(f)
    const file = path.join(f.root, 'vms/vm-1.json')
    const vm = { ...JSON.parse(fs.readFileSync(file, 'utf8')), node_id: 'node-fixture' }
    fs.writeFileSync(file, JSON.stringify(vm))
    const body =
      url === '/api/panel/dataplane'
        ? { dataplane: 'wrap-fixed', all: true, restart: false }
        : { inference: { dataplane: 'wrap-fixed' } }
    const response = await p.request(url, body).catch((error) => ({ status: error.status, body: { error } }))
    assert.equal(response.status, 409)
    assert.equal(response.body.error.code, 'remote_unsupported')
    assert.equal(p.persisted, 0)
    assert.equal(p.ctx.routingConfig.inference.dataplane, 'wrap')
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), vm)
    assert.equal(fs.existsSync(f.home), false)
  })

for (const policy of [false, true])
  test(`remote per-slot dataplane selection is rejected before saving, policy=${policy}`, async (t) => {
    const f = fixture(t),
      p = panelFixture(f)
    const file = path.join(f.root, 'vms/vm-1.json')
    const vm = { ...JSON.parse(fs.readFileSync(file, 'utf8')), node_id: 'node-fixture' }
    fs.writeFileSync(file, JSON.stringify(vm))
    const response = await p.request(policy ? '/api/panel/vms/slot-policy' : '/api/panel/dataplane', {
      dataplane: 'wrap-fixed',
      ids: ['vm-1'],
      restart: false,
    })
    assert.equal(policy ? response.body.data.failed[0].code : response.body.error.code, 'remote_unsupported')
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), vm)
    assert.equal(fs.existsSync(f.home), false)
  })

test('explicit remote CLI sync is refused rather than reporting an empty successful install', async (t) => {
  const f = fixture(t),
    p = panelFixture(f)
  const file = path.join(f.root, 'vms/vm-1.json')
  const vm = { ...JSON.parse(fs.readFileSync(file, 'utf8')), node_id: 'node-fixture' }
  fs.writeFileSync(file, JSON.stringify(vm))
  const response = await p.request('/api/panel/wrap-cli/sync', { ids: ['vm-1'], restart: false })
  assert.equal(response.status, 409)
  assert.equal(response.body.error.code, 'remote_unsupported')
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), vm)
  assert.equal(fs.existsSync(f.home), false)
})

test('a remote explicit original override does not block the local fixed default', async (t) => {
  const f = fixture(t),
    p = panelFixture(f)
  const file = path.join(f.root, 'vms/vm-2.json')
  const vm = { ...JSON.parse(fs.readFileSync(file, 'utf8')), node_id: 'node-fixture' }
  fs.writeFileSync(file, JSON.stringify(vm))
  const response = await p.request('/api/panel/dataplane', { dataplane: 'wrap-fixed', all: true, restart: false })
  assert.equal(response.status, 200)
  assert.equal(p.ctx.routingConfig.inference.dataplane, 'wrap-fixed')
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), vm)
  assert.equal(fs.existsSync(path.join(f.root, 'vms/vm-2/cli-home/.kin')), false)
})

test('fixed slots cannot be promoted back into the original wrap distribution sample', (t) => {
  const f = fixture(t)
  materializeWrapCli(f.root, { ...f.vm, dataplane: 'wrap' })
  materializeSlotDataplane(f.root, f.vm, 'wrap-fixed')
  assert.equal(captureWrapSample(f.root, f.vm).ok, false)
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'share/wrap-cli/cli-node')), f.plain)
})
