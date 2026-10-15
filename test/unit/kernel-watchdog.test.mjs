import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createKernelWatchdog, isKernelWatchdogTarget } from '../../src/lib/transport/kernel-watchdog.mjs'
import { kernelFaults } from '../../src/lib/transport/rust-kernel-client.mjs'

test('server binds telemetry healing only outside the mock gateway', () => {
  const source = fs.readFileSync(new URL('../../src/server.mjs', import.meta.url), 'utf8')
  const expression = source.match(/ensureTelemetry:\s*([\s\S]*?),\n\s*onFault:/)?.[1]
  assert.ok(expression)
  const bind = new Function('isCrsMock', 'ensureTelemetrySidecar', 'cfg', `return (${expression})`)
  const calls = []
  const ensure = (options) => calls.push(options)
  const cfg = { paths: { project: '/fixture-project' } }
  assert.equal(
    bind(() => true, ensure, cfg),
    null,
  )
  assert.equal(calls.length, 0)
  const vm = { id: 'fixture-vm' }
  bind(() => false, ensure, cfg)(vm)
  assert.deepEqual(calls, [{ projectRoot: '/fixture-project', vm }])
})

test('watchdog targets inherited rust; stored go is rust; skips Codex and stopped', () => {
  const rustRouting = { inference: { engine: 'rust' } }
  assert.equal(isKernelWatchdogTarget({ id: 'vm-01' }, rustRouting), true)
  assert.equal(isKernelWatchdogTarget({ id: 'vm-01' }), true, 'empty routing still defaults to rust')
  assert.equal(isKernelWatchdogTarget({ id: 'vm-01', inference_engine: 'rust' }), true)
  assert.equal(isKernelWatchdogTarget({ id: 'vm-01', runtime: { engine: 'rust' } }), true)
  assert.equal(isKernelWatchdogTarget({ id: 'vm-01', inference_engine: 'go' }), true)
  assert.equal(isKernelWatchdogTarget({ id: 'vm-01', status: 'stopped' }, rustRouting), false)
  assert.equal(isKernelWatchdogTarget({ id: 'vm-01', status: 'dead' }, rustRouting), false)
  assert.equal(isKernelWatchdogTarget({ id: 'vm-kvm', runtime_kind: 'kvm' }, rustRouting), true)
  assert.equal(isKernelWatchdogTarget({ id: 'gpt-01', platform: 'openai' }, rustRouting), false)
  assert.equal(isKernelWatchdogTarget({ id: 'gpt-01', family: 'codex', inference_engine: 'rust' }, rustRouting), false)
})

test('watchdog restarts only a dead kernel or one that gave up on its CLI', async () => {
  const ensured = []
  let now = 0
  const wd = createKernelWatchdog({
    now: () => now,
    listTargets: () => [
      { id: 'vm-up', inference_engine: 'rust' },
      { id: 'vm-busy', inference_engine: 'rust' },
      { id: 'vm-recovering', inference_engine: 'rust' },
      { id: 'vm-partial', inference_engine: 'rust' },
      { id: 'vm-gave-up', inference_engine: 'rust' },
      { id: 'vm-down', inference_engine: 'rust' },
    ],
    homeDirFor: (vm) => `/tmp/${vm.id}`,
    health: async (exec) => {
      if (exec.vmId === 'vm-up') return { ok: true, healthy: true, ready_slots: 1, cli_pid: 1 }
      if (exec.vmId === 'vm-busy') return { ok: true, healthy: true, ready_slots: 0, cli_pid: 9 }
      // The kernel is restarting its own CLI: a container restart would cut it off.
      if (exec.vmId === 'vm-recovering')
        return { ok: true, healthy: true, recovering: true, ready_slots: 0, cli_pid: 0 }
      // Closed slots are the kernel's own L1 business.
      if (exec.vmId === 'vm-partial') return { ok: true, healthy: true, ready_slots: 2, closed_slots: 18, cli_pid: 3 }
      if (exec.vmId === 'vm-gave-up') return { ok: true, healthy: false, unhealthy_reason: 'cli restarts spent' }
      return null
    },
    ensure: async (exec) => {
      ensured.push(exec.vmId)
      return { ok: true }
    },
  })
  await wd.tick()
  assert.deepEqual(ensured, [], 'even process failure waits before the first restart')
  now = 60_000
  await wd.tick()
  assert.deepEqual(ensured, ['vm-gave-up', 'vm-down'])
})

test('container restarts are bounded, spaced out, then the VM is faulted until healthy', async () => {
  let now = 0
  let health = { ok: true, healthy: false, unhealthy_reason: 'cli restarts spent' }
  const ensured = []
  const faults = []
  const wd = createKernelWatchdog({
    config: { restart_backoff_sec: [60, 300], restart_window_sec: 3600 },
    listTargets: () => [{ id: 'vm-loop', inference_engine: 'rust' }],
    homeDirFor: () => '/tmp/vm-loop',
    health: async () => health,
    ensure: async () => {
      ensured.push(now)
      return { ok: true }
    },
    onFault: (vm, reason) => faults.push([vm.id, reason]),
    now: () => now,
  })
  try {
    await wd.tick()
    now = 30_000
    await wd.tick()
    assert.deepEqual(ensured, [], 'first restart waits out the initial backoff')
    now = 60_000
    await wd.tick()
    assert.deepEqual(ensured, [60_000])
    now = 360_000
    await wd.tick()
    assert.deepEqual(ensured, [60_000, 360_000])
    assert.equal(faults.length, 0, 'last restart gets a health observation before exhaustion')
    now = 380_000
    await wd.tick()
    assert.deepEqual(ensured, [60_000, 360_000], 'budget spent: no third restart')
    assert.equal(faults.length, 1)
    assert.match(faults[0][1], /2 container restarts: cli restarts spent/)
    assert.ok(kernelFaults.has('vm-loop'), 'faulted VM is skipped by scheduling')
    now = 10_000_000
    await wd.tick()
    assert.deepEqual(ensured, [60_000, 360_000], 'a faulted VM is not restarted again')
    assert.equal(faults.length, 1, 'fault is reported once')

    health = { ok: true, healthy: true, ready_slots: 20, cli_pid: 7 }
    await wd.tick()
    assert.equal(kernelFaults.has('vm-loop'), false, 'healthy again clears the fault')
    health = { ok: true, healthy: false, unhealthy_reason: 'again' }
    await wd.tick()
    assert.deepEqual(ensured, [60_000, 360_000], 'fresh recovery also respects the first backoff')
    now += 60_000
    await wd.tick()
    assert.deepEqual(ensured, [60_000, 360_000, 10_060_000])
  } finally {
    kernelFaults.delete('vm-loop')
  }
})

test('watchdog does not restart a live crag slot', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-wd-crag-'))
  const home = path.join(root, 'vms', 'vm-crag', 'cli-home')
  const run = path.join(root, 'vms', 'vm-crag', 'run')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(run, { recursive: true })
  fs.writeFileSync(path.join(run, 'kernel.json'), JSON.stringify({ dataplane: 'crag' }))
  const ensured = []
  const wd = createKernelWatchdog({
    listTargets: () => [{ id: 'vm-crag', inference_engine: 'rust' }],
    homeDirFor: () => home,
    health: async () => ({ ok: true, engine: 'rust', ready_slots: 0, cli_pid: 0 }),
    ensure: async (exec) => {
      ensured.push(exec.vmId)
      return { ok: true }
    },
  })
  await wd.tick()
  assert.deepEqual(ensured, [])
  fs.rmSync(root, { recursive: true, force: true })
})

test('telemetry sidecar is checked once per window on every running slot', async () => {
  let now = 0
  const checked = []
  const wd = createKernelWatchdog({
    now: () => now,
    telemetryEveryMs: 600_000,
    listTargets: () => [
      // Inherited rust slots (no inference_engine) are now restart targets too;
      // telemetry still runs on every running slot, not only those.
      { id: 'vm-live', status: 'running', runtime: { type: 'docker', worker: 'rust' } },
      { id: 'vm-stopped', status: 'stopped' },
      { id: 'vm-kvm', runtime_kind: 'kvm' },
    ],
    homeDirFor: (vm) => `/tmp/${vm.id}`,
    health: async () => null,
    ensure: async () => ({ ok: true }),
    ensureTelemetry: async (vm) => {
      checked.push(vm.id)
      return { ok: true, action: 'started' }
    },
  })
  await wd.tick()
  now = 599_999
  await wd.tick()
  assert.deepEqual(checked, ['vm-live', 'vm-kvm'])
  now = 600_000
  await wd.tick()
  assert.deepEqual(checked, ['vm-live', 'vm-kvm', 'vm-live', 'vm-kvm'])
})

test('inherited rust slot reaches the restart ladder after CLI budget is spent', async () => {
  const ensured = []
  const faults = []
  let now = 0
  const wd = createKernelWatchdog({
    now: () => now,
    getRouting: () => ({ inference: { engine: 'rust' } }),
    listTargets: () => [{ id: 'vm-inherit' }],
    homeDirFor: () => '/tmp/vm-inherit',
    health: async () => ({
      ok: true,
      healthy: false,
      unhealthy_reason: 'native cli stdout closed',
    }),
    ensure: async (exec) => {
      ensured.push(exec.vmId)
      return { ok: true }
    },
    onFault: (vm, reason) => faults.push([vm.id, reason]),
  })
  try {
    await wd.tick()
    assert.deepEqual(ensured, [], 'first restart waits out the initial backoff')
    now = 60_000
    await wd.tick()
    assert.deepEqual(ensured, ['vm-inherit'])
    now = 360_000
    await wd.tick()
    assert.deepEqual(ensured, ['vm-inherit', 'vm-inherit'])
    now = 1_260_000
    await wd.tick()
    assert.deepEqual(ensured, ['vm-inherit', 'vm-inherit', 'vm-inherit'])
    now = 1_280_000
    await wd.tick()
    assert.deepEqual(ensured, ['vm-inherit', 'vm-inherit', 'vm-inherit'], 'budget spent: no fourth restart')
    assert.equal(faults.length, 1)
    assert.match(faults[0][1], /3 container restarts: native cli stdout closed/)
    assert.ok(kernelFaults.has('vm-inherit'))
  } finally {
    kernelFaults.delete('vm-inherit')
  }
})

test('watchdog rereads routing each tick; Codex stays out of the restart path', async () => {
  const probed = []
  let routingCalls = 0
  let routing = { inference: { engine: 'rust' } }
  const wd = createKernelWatchdog({
    getRouting: () => {
      routingCalls += 1
      return routing
    },
    listTargets: () => [{ id: 'vm-inherit' }, { id: 'gpt-01', platform: 'openai' }],
    health: async (exec) => {
      probed.push(exec.vmId)
      return { ok: true, healthy: true, ready_slots: 1, cli_pid: 1 }
    },
    ensure: async () => ({ ok: true }),
  })
  await wd.tick()
  assert.deepEqual(probed, ['vm-inherit'])
  assert.equal(routingCalls, 1)
  probed.length = 0
  // Historical go aliases to rust; inherited Claude slots stay kernel-watchdog targets.
  routing = { inference: { engine: 'go' } }
  await wd.tick()
  assert.deepEqual(probed, ['vm-inherit'])
  assert.equal(routingCalls, 2)
})
