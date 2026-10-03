import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { OFFLINE_CANDIDATE_MODES, offlineCandidateId } from '../../src/lib/transport/offline-native-candidate.mjs'
import { normalizeLoggingConfig, RequestLogStore } from '../../src/lib/admin/request-log.mjs'
import { createDatabase } from '../../src/lib/db/database.mjs'

const moduleUrl = new URL('../../src/lib/transport/offline-kernel-probe.mjs', import.meta.url)

test('offline diagnostics are strict opt-in and retain their selected pairing', () => {
  assert.equal(normalizeLoggingConfig({}).offline_kernel_probe, false)
  assert.equal(normalizeLoggingConfig({ offline_kernel_probe: 'true' }).offline_kernel_probe, false)
  const db = createDatabase({ dbPath: ':memory:' })
  try {
    const log = new RequestLogStore({ db })
    assert.equal(log.offlineKernelProbe, false)
    log.setConfig({ offlineKernelProbe: true, offlineKernelDataplane: 'crag' })
    assert.equal(log.snapshot().offline_kernel_probe, true)
    assert.equal(log.snapshot().offline_kernel_dataplane, 'crag')
    log.setConfig({ offlineKernelProbe: false })
    assert.equal(log.offlineKernelProbe, false)
  } finally {
    db.close()
  }
})

test('Docker sandbox cannot pull images, share production networks or mount credentials', async () => {
  const { offlineDockerCreateArgs } = await import(moduleUrl)
  const args = offlineDockerCreateArgs('kin-offline-test', 'sha256:' + 'a'.repeat(64))
  const value = (flag) => args[args.indexOf(flag) + 1]
  assert.equal(value('--network'), 'none')
  assert.equal(value('--pull'), 'never')
  assert.ok(args.includes('--read-only'))
  assert.ok(args.includes('--no-healthcheck'))
  assert.equal(value('--cap-drop'), 'ALL')
  assert.equal(value('--log-driver'), 'none')
  assert.equal(value('--user'), '65534:65534')
  assert.ok(args.includes('no-new-privileges'))
  assert.ok(!args.some((x) => ['--privileged', '--network=host', '-v', '--volume', '--volumes-from'].includes(x)))
  assert.equal(value('--mount'), 'type=volume,target=/probe,volume-nocopy')
  assert.ok(args.includes('--rm'))
  assert.equal(args.at(-1), '/probe/offline-kernel-probe.py')
})

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-offline-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const home = path.join(root, 'vms/vm-1/cli-home/.kin')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(path.join(root, 'vms/vm-1/run'), { recursive: true })
  fs.writeFileSync(path.join(root, 'vms/active.json'), JSON.stringify({ active_vm: 'vm-1' }))
  fs.writeFileSync(
    path.join(root, 'vms/vm-1.json'),
    JSON.stringify({
      id: 'vm-1',
      runtime: { type: 'docker', container: 'kin-1' },
      claude: { access_token: 'REAL_OAUTH_SECRET' },
    }),
  )
  fs.writeFileSync(
    path.join(root, 'vms/vm-1/run/kernel.json'),
    JSON.stringify({
      dataplane: 'wrap',
      system_layout: 'zero',
      persona_preset: 'zero',
      internal_token: 'REAL_INTERNAL_SECRET',
      proxy_url: 'http://SECRET_PROXY',
    }),
  )
  const elf = Buffer.alloc(128)
  elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1])
  elf.writeUInt16LE(62, 18)
  fs.writeFileSync(path.join(home, 'kin-kernel.bin'), elf)
  fs.writeFileSync(path.join(home, 'cli-node'), elf)
  return { root, home }
}

test('request inspection separates missing root system from relocation into a user message', async () => {
  const { inspectOfflineRequests } = await import(moduleUrl)
  const body = {
    system: [
      { type: 'text', text: 'RULE_A' },
      { type: 'text', text: 'RULE_B' },
    ],
  }
  const native = {
    type: 'kin_job_start',
    request: {
      model: 'claude-opus-4-6',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'prefix RULE_A suffix' }] }],
      max_tokens: 128000,
    },
  }
  const httpBody = {
    system: [{ type: 'text', text: 'RULE_B' }],
    messages: [{ role: 'user', content: 'hi' }],
    thinking: { type: 'adaptive' },
    output_config: { effort: 'max' },
  }
  const result = inspectOfflineRequests(body, [
    { kind: 'cli_stdin', text: JSON.stringify(native) },
    { kind: 'anthropic_request', path: '/v1/messages?beta=true', text: JSON.stringify(httpBody) },
    { kind: 'cli_stdin', text: '{truncated', truncated: true },
  ])
  assert.equal(result.length, 2)
  assert.equal(result[0].system_blocks, 0)
  assert.deepEqual(result[0].node_system_text_locations[0].matches, [
    { path: '/messages/0/content/0/text', role: 'user', exact: false },
  ])
  assert.equal(result[0].node_system_text_locations[1].matches.length, 0)
  assert.equal(result[1].output_config.effort, 'max')
  assert.equal(result[1].node_system_text_locations[1].matches[0].role, 'system_root')
})

for (const plane of ['wrap', 'cc', 'crag'])
  test(`explicit ${plane} uses the selected distribution without rewriting the real slot`, async (t) => {
    const { runOfflineKernelProbe } = await import(moduleUrl)
    const fx = fixture(t)
    const elf = fs.readFileSync(path.join(fx.home, 'kin-kernel.bin'))
    for (const dir of ['bin', 'share/wrap-cli', 'share/crag'])
      fs.mkdirSync(path.join(fx.root, dir), { recursive: true })
    fs.writeFileSync(path.join(fx.root, 'bin/kin-kernel'), elf)
    const other = Buffer.from(elf)
    other[72] = 1
    fs.writeFileSync(path.join(fx.root, 'share/crag/kin-kernel'), other)
    for (const name of ['cli-node', 'cc-node']) fs.writeFileSync(path.join(fx.root, 'share/wrap-cli', name), elf)
    const before = fs.readFileSync(path.join(fx.root, 'vms/vm-1/run/kernel.json'), 'utf8')
    let input
    const report = await runOfflineKernelProbe({
      projectRoot: fx.root,
      plane,
      envelope: { body: { model: 'claude-opus-4-6', messages: [] } },
      command: async (args) => {
        if (args[0] === 'inspect') {
          assert.equal(args[args.indexOf('--format') + 1], '{{.Image}}')
          return 'sha256:' + 'a'.repeat(64)
        }
        if (args[0] === 'cp') input = JSON.parse(fs.readFileSync(path.join(args[1], 'input.json'), 'utf8'))
        if (args[0] === 'start')
          return JSON.stringify({
            version: 1,
            nonce: input.nonce,
            simulation: true,
            network_isolated: true,
            inputs_readonly: true,
            stages: [],
          })
        return ''
      },
    })
    assert.equal(report.meta.selected_pairing, plane)
    assert.equal(report.meta.cli_name, plane === 'wrap' ? 'cli-node' : 'cc-node')
    assert.equal(report.meta.configured_pairing, 'wrap')
    assert.equal(report.meta.source, 'distribution_files')
    assert.equal(report.meta.kernel_sha256 === report.meta.installed_kernel_sha256, plane !== 'crag')
    assert.equal(fs.readFileSync(path.join(fx.root, 'vms/vm-1/run/kernel.json'), 'utf8'), before)
  })

for (const plane of [
  'candidate-wrap',
  'candidate-cc',
  'candidate-crag',
  'candidate-cc-r2',
  'candidate-crag-r2',
  'candidate-cc-r3',
  'candidate-crag-r3',
])
  test(`${plane} uploads only the checked candidate and never rewrites the real slot`, async (t) => {
    const { runOfflineKernelProbe } = await import(moduleUrl)
    const candidateId = offlineCandidateId(plane)
    const fx = fixture(t)
    const digest = (b) => crypto.createHash('sha256').update(b).digest('hex')
    const base = fs.readFileSync(path.join(fx.home, 'kin-kernel.bin'))
    const candidate = Buffer.from(base)
    candidate[96] = 1
    const manifest = JSON.parse(
      fs.readFileSync(new URL(`../../share/offline-candidates/${candidateId}/manifest.json`, import.meta.url), 'utf8'),
    )
    for (const dir of ['bin', 'share/wrap-cli', 'share/crag', `share/offline-candidates/${candidateId}`])
      fs.mkdirSync(path.join(fx.root, dir), { recursive: true })
    fs.writeFileSync(path.join(fx.root, 'bin/kin-kernel'), base)
    fs.writeFileSync(path.join(fx.root, 'share/crag/kin-kernel'), base)
    for (const name of ['cli-node', 'cc-node']) {
      fs.writeFileSync(path.join(fx.root, 'share/wrap-cli', name), base)
      if (!manifest.artifacts[name]) continue
      fs.writeFileSync(path.join(fx.root, 'share/offline-candidates', candidateId, name), candidate)
      Object.assign(manifest.artifacts[name], {
        sha256: digest(candidate),
        bytes: candidate.length,
        source_packed_sha256: digest(base),
      })
    }
    for (const name of ['wrap', 'cc', 'crag']) manifest.kernel_sha256[name] = digest(base)
    fs.writeFileSync(
      path.join(fx.root, 'share/offline-candidates', candidateId, 'manifest.json'),
      JSON.stringify(manifest),
    )
    const original = fs.readFileSync(path.join(fx.root, 'vms/vm-1/run/kernel.json'), 'utf8')
    let input
    const report = await runOfflineKernelProbe({
      projectRoot: fx.root,
      plane,
      envelope: { body: { model: 'claude-opus-4-6' } },
      command: async (args) => {
        if (args[0] === 'inspect') return 'sha256:' + 'a'.repeat(64)
        if (args[0] === 'create') assert.equal(args[args.indexOf('--network') + 1], 'none')
        if (args[0] === 'cp') {
          input = JSON.parse(fs.readFileSync(path.join(args[1], 'input.json'), 'utf8'))
          assert.equal(digest(fs.readFileSync(path.join(args[1], 'real-cli'))), digest(candidate))
          assert.doesNotMatch(JSON.stringify(input), /REAL_OAUTH_SECRET|REAL_INTERNAL_SECRET|SECRET_PROXY/)
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
    assert.equal(report.meta.requested_pairing, plane)
    assert.equal(report.meta.selected_pairing, OFFLINE_CANDIDATE_MODES[plane])
    assert.equal(report.meta.source, 'offline_candidate_files')
    assert.equal(report.meta.candidate.id, candidateId)
    assert.equal(report.meta.candidate.production_approved, false)
    assert.equal(fs.readFileSync(path.join(fx.root, 'vms/vm-1/run/kernel.json'), 'utf8'), original)
    assert.equal(digest(fs.readFileSync(path.join(fx.home, 'cli-node'))), digest(base))
    await assert.rejects(
      runOfflineKernelProbe({
        projectRoot: fx.root,
        plane,
        envelope: { body: {} },
        command: async (args) => {
          if (args[0] === 'inspect') return 'sha256:' + 'a'.repeat(64)
          if (args[0] === 'cp') input = JSON.parse(fs.readFileSync(path.join(args[1], 'input.json'), 'utf8'))
          if (args[0] === 'start')
            return JSON.stringify({
              version: 1,
              nonce: input.nonce,
              simulation: true,
              network_isolated: true,
              inputs_readonly: true,
              binary_inputs_verified: false,
              observed_binary_hashes: { cli_sha256: 'wrong' },
              stages: [],
            })
          return ''
        },
      }),
      (e) => e.code === 'offline_candidate_uploaded_hash',
    )
  })

test('missing candidate cannot reach Docker or fall back to the released CLI', async (t) => {
  const { runOfflineKernelProbe } = await import(moduleUrl)
  const fx = fixture(t)
  for (const dir of ['bin', 'share/wrap-cli']) fs.mkdirSync(path.join(fx.root, dir), { recursive: true })
  const base = fs.readFileSync(path.join(fx.home, 'kin-kernel.bin'))
  fs.writeFileSync(path.join(fx.root, 'bin/kin-kernel'), base)
  fs.writeFileSync(path.join(fx.root, 'share/wrap-cli/cli-node'), base)
  await assert.rejects(
    runOfflineKernelProbe({
      projectRoot: fx.root,
      plane: 'candidate-wrap',
      envelope: { body: {} },
      command: () => assert.fail('Docker must not run'),
    }),
    (e) => e.code === 'offline_candidate_missing',
  )
})

test('cancellation removes only the private container and concurrent probes fail closed', async (t) => {
  const { runOfflineKernelProbe } = await import(moduleUrl)
  const fx = fixture(t)
  const signal = new AbortController()
  let notify,
    removed = false
  const started = new Promise((resolve) => {
    notify = resolve
  })
  const options = { projectRoot: fx.root, envelope: { body: { model: 'claude-opus-4-6' } } }
  const running = runOfflineKernelProbe({
    ...options,
    signal: signal.signal,
    command: async (args, opts) => {
      if (args[0] === 'inspect') return 'sha256:' + 'a'.repeat(64)
      if (args[0] === 'start') {
        notify()
        return await new Promise((resolve, reject) =>
          opts.signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true }),
        )
      }
      if (args[0] === 'rm') {
        assert.ok(args.at(-1).startsWith('kin-offline-'))
        assert.ok(args.includes('-v'))
        removed = true
      }
      return ''
    },
  })
  await started
  await assert.rejects(runOfflineKernelProbe(options), /already running/)
  signal.abort()
  await assert.rejects(running, /cancelled/)
  assert.equal(removed, true)
})

test('actual on-disk snapshot is isolated and removal occurs even when attach fails', async (t) => {
  const { runOfflineKernelProbe } = await import(moduleUrl)
  const fx = fixture(t)
  const calls = []
  let copied
  await assert.rejects(
    runOfflineKernelProbe({
      projectRoot: fx.root,
      envelope: {
        body: {
          model: 'claude-opus-4-6',
          system: [{ type: 'text', text: 'CALLER_KEEP' }],
          messages: [{ role: 'user', content: 'hello' }],
          stream: true,
        },
        stream: true,
      },
      command: async (args) => {
        calls.push(args)
        if (args[0] === 'inspect') return 'sha256:' + 'a'.repeat(64)
        if (args[0] === 'create') return 'b'.repeat(64)
        if (args[0] === 'cp') {
          copied = args[1]
          const input = fs.readFileSync(path.join(copied, 'input.json'), 'utf8')
          assert.match(input, /CALLER_KEEP/)
          assert.doesNotMatch(input, /REAL_OAUTH_SECRET|REAL_INTERNAL_SECRET|SECRET_PROXY/)
          assert.equal(fs.existsSync(path.join(copied, 'credentials.json')), false)
          return ''
        }
        if (args[0] === 'start') throw new Error('attach failed')
        if (args[0] === 'rm') return ''
        assert.fail('unexpected Docker command')
      },
    }),
    /attach failed/,
  )
  assert.ok(calls.some((a) => a[0] === 'rm' && a.includes('-f')))
  assert.ok(copied && !fs.existsSync(copied))
  assert.ok(!calls.some((a) => ['pull', 'exec', 'restart', 'stop'].includes(a[0])))
})
