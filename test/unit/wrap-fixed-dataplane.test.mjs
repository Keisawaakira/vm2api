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
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { runOfflineKernelProbe } from '../../src/lib/transport/offline-kernel-probe.mjs'
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
    'share/wrap-fixed/v155-r1/cli-node': fixedCli,
    'share/wrap-fixed/v155-r1/kin-kernel.bin': fixedKernel,
  }
  for (const [name, bytes] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
    fs.writeFileSync(path.join(root, name), bytes)
  }
  const manifest = JSON.parse(
    fs.readFileSync(new URL('../../share/wrap-fixed/v155-r1/manifest.json', import.meta.url), 'utf8'),
  )
  Object.assign(manifest.kernel, { sha256: digest(fixedKernel), bytes: fixedKernel.length })
  Object.assign(manifest.artifacts['cli-node'], { sha256: digest(fixedCli), bytes: fixedCli.length })
  const manifestPath = path.join(root, 'share/wrap-fixed/v155-r1/manifest.json')
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
  return { root, vm, home, plain, fixedCli, fixedKernel, crag, manifest, writeManifest, manifestPath }
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
test('fixed CLI installs as a separate executable with its own pinned kernel', (t) => {
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
test('normal distribution updates and sync do not replace the fixed pair', (t) => {
  const f = fixture(t)
  materializeSlotDataplane(f.root, f.vm, 'wrap-fixed')
  const newer = elf(9)
  fs.writeFileSync(path.join(f.root, 'bin/kin-kernel'), newer)
  fs.writeFileSync(path.join(f.root, 'share/wrap-cli/cli-node'), newer)
  const report = syncWrapSample(f.root, [f.vm], { routing: {} })
  assert.equal(report.ok, true)
  assert.deepEqual(fs.readFileSync(path.join(f.home, 'cli-node-fixed')), f.fixedCli)
  assert.deepEqual(fs.readFileSync(path.join(f.home, 'kin-kernel.bin')), f.fixedKernel)
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
  fs.writeFileSync(path.join(f.root, 'share/wrap-fixed/v155-r1/cli-node'), elf(8))
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

test('fixed slots cannot be promoted back into the original wrap distribution sample', (t) => {
  const f = fixture(t)
  materializeWrapCli(f.root, { ...f.vm, dataplane: 'wrap' })
  materializeSlotDataplane(f.root, f.vm, 'wrap-fixed')
  assert.equal(captureWrapSample(f.root, f.vm).ok, false)
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'share/wrap-cli/cli-node')), f.plain)
})
