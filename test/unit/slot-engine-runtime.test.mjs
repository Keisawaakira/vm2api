import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ensureSlotInferenceRuntime,
  switchInheritedInferenceEngines,
  switchSlotInferenceEngine,
} from '../../src/lib/vm/slot-runtime.mjs'

function seedVmRecords(records) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-slot-engine-'))
  const vmsDir = path.join(projectRoot, 'vms')
  fs.mkdirSync(vmsDir)
  for (const vm of records) {
    fs.writeFileSync(path.join(vmsDir, `${vm.id}.json`), JSON.stringify(vm))
  }
  return projectRoot
}

function wrapOk() {
  return { materializeWrapCli: () => ({ ok: true, dest: '/tmp/wrap-cli' }) }
}

test('ensureSlotInferenceRuntime starts rust when engine resolves to rust', async () => {
  const bin = path.join(os.tmpdir(), `kin-kernel-dummy-${process.pid}`)
  fs.writeFileSync(bin, 'x')
  fs.chmodSync(bin, 0o755)
  let starts = 0
  try {
    const result = await ensureSlotInferenceRuntime(
      { id: 'vm-09', inference_engine: 'rust', has_token: true },
      '/tmp/kin-project',
      {
        routing: { inference: { engine: 'go', eager_start: true } },
        ops: {
          ...wrapOk(),
          kernelBinPath: () => bin,
          containerHasKernelMount: () => true,
          ensureRustKernel: async () => {
            starts += 1
            return { ok: true, health: { engine: 'rust' } }
          },
        },
      },
    )
    assert.equal(starts, 1)
    assert.equal(result.ok, true)
    assert.equal(result.engine, 'rust')
  } finally {
    fs.rmSync(bin, { force: true })
  }
})

test('ensureSlotInferenceRuntime wrap glibc shim skips host kernel mount and starts kernel', async () => {
  let starts = 0
  let mountChecks = 0
  const result = await ensureSlotInferenceRuntime(
    { id: 'vm-10', inference_engine: 'rust', has_token: true },
    '/tmp/kin-project',
    {
      routing: { inference: { engine: 'rust', eager_start: true } },
      ops: {
        materializeWrapCli: () => ({ ok: true, dest: '/tmp/wrap', glibc_shim: true, wrapper: true, kernel_bin: true }),
        kernelBinPath: () => '',
        containerHasKernelMount: () => {
          mountChecks += 1
          return false
        },
        ensureRustKernel: async () => {
          starts += 1
          return { ok: true, health: { engine: 'rust' } }
        },
      },
    },
  )
  assert.equal(mountChecks, 0)
  assert.equal(starts, 1)
  assert.equal(result.ok, true)
  assert.equal(result.engine, 'rust')
})

test('ensureSlotInferenceRuntime skips uncredentialed, eager_start=false, and empty unused slots', async () => {
  let starts = 0
  const ops = {
    ensureRustKernel: async () => {
      starts += 1
      return { ok: true }
    },
  }
  const go = await ensureSlotInferenceRuntime({ id: 'vm-10' }, '/tmp/kin-project', {
    routing: { inference: { engine: 'go' } },
    ops,
  })
  const off = await ensureSlotInferenceRuntime(
    { id: 'vm-11', inference_engine: 'rust', has_token: true },
    '/tmp/kin-project',
    {
      routing: { inference: { engine: 'rust', eager_start: false } },
      ops,
    },
  )
  const empty = await ensureSlotInferenceRuntime({ id: 'vm-88', inference_engine: 'rust' }, '/tmp/kin-project', {
    routing: { inference: { engine: 'rust', eager_start: true } },
    ops: { ...wrapOk(), ...ops },
  })
  assert.equal(starts, 0)
  assert.equal(go.skipped, true)
  assert.equal(go.reason, 'no_credential')
  assert.equal(off.skipped, true)
  assert.equal(off.reason, 'eager_start_off')
  assert.equal(empty.skipped, true)
  assert.equal(empty.reason, 'no_credential')
})

test('ensureSlotInferenceRuntime starts Codex kernel for GPT slots and skips wrap', async () => {
  let rustStarts = 0
  let wrapCalls = 0
  let codexStarts = 0
  let writes = 0
  const result = await ensureSlotInferenceRuntime(
    { id: 'vm-codex-02', platform: 'openai', family: 'codex', proxy: { url: 'socks5h://127.0.0.1:1080' } },
    '/tmp/kin-project',
    {
      routing: { inference: { engine: 'rust', eager_start: true } },
      ops: {
        materializeWrapCli: () => {
          wrapCalls += 1
          return { ok: true }
        },
        ensureRustKernel: async () => {
          rustStarts += 1
          return { ok: true }
        },
        writeCodexKernelConfig: () => {
          writes += 1
          return { configPath: '/tmp/codex-kernel.json' }
        },
        ensureCodexKernel: async () => {
          codexStarts += 1
          return { ok: true }
        },
      },
    },
  )
  assert.equal(result.ok, true)
  assert.equal(result.engine, 'codex')
  assert.equal(codexStarts, 1)
  assert.equal(writes, 1)
  assert.equal(rustStarts, 0)
  assert.equal(wrapCalls, 0)
})

test('rust switch recreates a slot missing the kernel mount before health commit', async () => {
  const bin = path.join(os.tmpdir(), `kin-kernel-switch-${process.pid}`)
  fs.writeFileSync(bin, 'x')
  fs.chmodSync(bin, 0o755)
  const vm = { id: 'vm-01' }
  let mounted = false
  let recreated = false
  let reloaded = false
  let result
  try {
    result = await switchSlotInferenceEngine(vm, '/tmp/kin-project', 'rust', {
      timeoutMs: 300,
      ops: {
        ...wrapOk(),
        kernelBinPath: () => bin,
        inspectContainer: () => ({ running: true }),
        containerHasKernelMount: () => mounted,
        startVmRuntime: (_vm, _root, options) => {
          assert.equal(options.recreate, true)
          recreated = true
          mounted = true
          return { ok: true, action: 'created' }
        },
        reloadSlotWorker: () => {
          reloaded = true
          return { ok: true }
        },
        ensureRustKernel: async () => ({
          ok: true,
          health: { ok: true, status: 200, engine: 'rust', worker_version: 'rust-test' },
        }),
      },
    })

    assert.equal(recreated, true)
    assert.equal(reloaded, false)
    assert.equal(result.ok, true)
    assert.equal(result.active_engine, 'rust')
    assert.equal(result.runtime.rust.reachable, true)
  } finally {
    fs.rmSync(bin, { force: true })
  }
})

test('go switch is rejected because Go HTTP forwarding is disabled', async () => {
  const result = await switchSlotInferenceEngine({ id: 'vm-02' }, '/tmp/kin-project', 'go', {
    timeoutMs: 300,
    ops: {
      inspectContainer: () => ({ running: true }),
      containerHasKernelMount: () => true,
      reloadSlotWorker: () => ({ ok: true, action: 'reloaded' }),
      workerHealth: async () => ({ status: 200, version: 'go-test' }),
      ensureRustKernel: async () => ({ ok: true }),
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'go_engine_disabled')
})

test('rust switch fails before touching the VM when the binary is missing', async () => {
  let touched = false
  const result = await switchSlotInferenceEngine({ id: 'vm-03' }, '/tmp/kin-project', 'rust', {
    ops: {
      ...wrapOk(),
      kernelBinPath: () => '/definitely/missing/kin-kernel',
      inspectContainer: () => {
        touched = true
        return null
      },
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'kernel_binary_missing')
  assert.equal(touched, false)
})

for (const failedHealth of [false, true]) {
  test(`fixed engine switch waits for asynchronous reload and rollback (failed health=${failedHealth})`, async () => {
    const calls = []
    const routing = { compatibility: { cch_enabled: false, auto_compact_window: 250000 } }
    const waiting = []
    let settled = false
    const promise = switchSlotInferenceEngine({ id: 'vm-async-fixed' }, '/fixture-only', 'rust', {
      routing,
      ops: {
        kernelBinPath: () => '',
        materializeSlotDataplane: () => ({ ok: true, wrapper: true, kernel_bin: true }),
        writeKernelConfig: (_root, _vm, opts) => {
          assert.equal(opts.routing, routing)
          calls.push('config')
        },
        inspectContainer: () => ({ running: true }),
        containerHasKernelMount: () => false,
        reloadSlotWorker: (_vm, _root, opts) => {
          assert.equal(opts.routing, routing)
          calls.push('reload')
          return new Promise((resolve) => waiting.push(resolve))
        },
        restartRustKernel: async () => {
          calls.push('kernel')
          return failedHealth
            ? { ok: false, reason: 'health_timeout', health: { status: 503 } }
            : { ok: true, health: { status: 200 } }
        },
      },
    }).then((result) => {
      settled = true
      return result
    })
    assert.deepEqual(calls, ['config', 'reload'])
    assert.equal(settled, false)
    waiting.shift()({ ok: true, action: 'reloaded' })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(calls[2], 'kernel')
    if (failedHealth) {
      assert.equal(settled, false, 'failure must await the asynchronous rollback too')
      assert.deepEqual(calls, ['config', 'reload', 'kernel', 'reload'])
      waiting.shift()({ ok: true, action: 'rolled_back' })
    }
    const result = await promise
    assert.equal(result.ok, !failedHealth)
    if (failedHealth) {
      assert.equal(result.code, 'kernel_health_timeout')
      assert.deepEqual(result.rollback, { ok: true, action: 'rolled_back' })
    } else {
      assert.equal(result.action, 'reloaded')
      assert.equal(result.runtime.rust.reachable, true)
    }
  })
}

test('global engine switch loads raw VMs and skips explicit overrides', async (t) => {
  const projectRoot = seedVmRecords([
    { id: 'vm-inherited', proxy: { host: '127.0.0.1', port: 1080, password: 'secret' } },
    { id: 'vm-explicit', inference_engine: 'go' },
  ])
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }))
  const seen = []

  const result = await switchInheritedInferenceEngines({
    projectRoot,
    previousEngine: 'go',
    targetEngine: 'rust',
    switchEngine: async (vm, root, engine) => {
      seen.push({
        id: vm.id,
        root,
        engine,
        password: vm.proxy?.password,
        hasOverride: Object.prototype.hasOwnProperty.call(vm, 'inference_engine'),
      })
      return { ok: true, active_engine: engine }
    },
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.items, [{ id: 'vm-inherited', active_engine: 'rust' }])
  assert.deepEqual(seen, [
    {
      id: 'vm-inherited',
      root: projectRoot,
      engine: 'rust',
      password: 'secret',
      hasOverride: false,
    },
  ])
})

test('global engine switch rolls back earlier inherited VMs after a failure', async (t) => {
  const projectRoot = seedVmRecords([{ id: 'vm-01' }, { id: 'vm-02' }])
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }))
  const calls = []

  const result = await switchInheritedInferenceEngines({
    projectRoot,
    previousEngine: 'go',
    targetEngine: 'rust',
    switchEngine: async (vm, _root, engine) => {
      calls.push({ id: vm.id, engine })
      if (vm.id === 'vm-02' && engine === 'rust') {
        return { ok: false, code: 'kernel_health_timeout', error: 'not ready' }
      }
      return { ok: true, active_engine: engine }
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'kernel_health_timeout')
  assert.equal(result.failed_vm, 'vm-02')
  assert.deepEqual(result.rollbacks, [{ id: 'vm-01', result: { ok: true, active_engine: 'go' } }])
  assert.deepEqual(calls, [
    { id: 'vm-01', engine: 'rust' },
    { id: 'vm-02', engine: 'rust' },
    { id: 'vm-01', engine: 'go' },
  ])
})

test('global engine switch rolls back all VMs when routing persistence fails', async (t) => {
  const projectRoot = seedVmRecords([{ id: 'vm-01' }, { id: 'vm-02' }])
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }))
  const calls = []

  const result = await switchInheritedInferenceEngines({
    projectRoot,
    previousEngine: 'go',
    targetEngine: 'rust',
    switchEngine: async (vm, _root, engine) => {
      calls.push({ id: vm.id, engine })
      return { ok: true, active_engine: engine }
    },
    commit: () => {
      throw new Error('routing write failed')
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'routing_persist_failed')
  assert.equal(result.error, 'routing write failed')
  assert.deepEqual(result.rollbacks, [
    { id: 'vm-02', result: { ok: true, active_engine: 'go' } },
    { id: 'vm-01', result: { ok: true, active_engine: 'go' } },
  ])
  assert.deepEqual(calls, [
    { id: 'vm-01', engine: 'rust' },
    { id: 'vm-02', engine: 'rust' },
    { id: 'vm-02', engine: 'go' },
    { id: 'vm-01', engine: 'go' },
  ])
})
