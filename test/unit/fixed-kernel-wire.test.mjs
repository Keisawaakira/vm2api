import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { fixedDataplaneSpec, readFixedRelease } from '../../src/lib/vm/wrap-fixed.mjs'
import { KERNEL_WIRE_BASES, patchKernelWireBytes } from '../../scripts/refresh-fixed-cli-kernel-wire.mjs'
import { sourceFunction } from '../../scripts/refresh-fixed-cli-lifecycle.mjs'
import { REQUEST_WIRE_BASES } from '../../scripts/refresh-fixed-cli-request-wire.mjs'
import { verifyKernelWireSource } from '../support/fixed-kernel-wire-controls.mjs'
const root = fileURLToPath(new URL('../../', import.meta.url))
for (const kind of ['wrap', 'cc']) {
  const spec = fixedDataplaneSpec(kind + '-fixed')
  const dir = path.join(root, 'share', spec.directory)
  const sem = JSON.parse(fs.readFileSync(path.join(dir, 'semantics.json')))
  test(`${kind} active native wire and safeguards preserve ordinary source controls`, async () => {
    const result = await verifyKernelWireSource(sem, kind)
    assert.equal(result.ok, true)
    assert.equal(result.wire_checks, 46)
    assert.ok(result.preserved_checks >= 169)
  })
  test(`${kind} actual entry selects native mode from the new kernel environment`, async () => {
    const calls = []
    const context = vm.createContext({
      process: { argv: ['cli', 'entry'], env: { CLAUDE_CODE_NATIVE_SLOTS: '2' } },
      console: { log: (value) => calls.push(['version', value]) },
      init_init2: () => calls.push(['init-module']),
      setIsInteractive: (value) => calls.push(['interactive', value]),
      init: async () => calls.push(['init']),
      init_config2: () => calls.push(['config-module']),
      exports_config: { enableConfigs: () => calls.push(['enable-config']) },
      init_nativeMessagesRunner: () => calls.push(['native-module']),
      exports_nativeMessagesRunner: { runNativeMessagesLoop: async (options) => calls.push(['native', options]) },
    })
    if (sem.kernel_wire.environment) {
      vm.runInContext(sem.kernel_wire.environment, context)
      context.exports_kernelEnv = { kernelEnv: context.kernelEnv }
    }
    vm.runInContext(sem.kernel_wire.entry, context)
    await context.main2()
    assert.equal(calls.at(-1)[0], 'native')
    const init = calls.findIndex((call) => call[0] === (kind === 'cc' ? 'init' : 'enable-config'))
    assert.ok(init >= 0 && init < calls.findIndex((call) => call[0] === 'native-module'))
    assert.equal(calls.filter((call) => call[0] === 'native').length, 1)
  })
  test(`${kind} requires the current kernel wire contract before loading a fixed CLI`, (t) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-contract-'))
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
    const dest = path.join(temp, 'share', spec.directory)
    fs.mkdirSync(dest, { recursive: true })
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json')))
    assert.equal(manifest.id, REQUEST_WIRE_BASES[kind].id)
    for (const wire of [undefined, 'legacy']) {
      fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify({ ...manifest, native_wire_contract: wire }))
      assert.match(readFixedRelease(temp, kind + '-fixed').code, /unapproved$/)
    }
    assert.throws(() => patchKernelWireBytes(Buffer.alloc(128), kind, {}), /Unknown kernel-wire baseline/)
  })
  test(`${kind} real new wire controls execute in a Bun1.3.14 compiled miniature`, {
    skip: !process.env.BUN_BIN ? 'Bun maintainer tool unavailable' : false,
  }, (t) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-compiled-'))
    t.after(() => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }))
    const input = path.join(temp, 'entry.mjs'),
      output = path.join(temp, process.platform === 'win32' ? 'entry.exe' : 'entry')
    const helper = path.join(root, 'test/support/fixed-kernel-wire-controls.mjs').replaceAll('\\', '/')
    fs.writeFileSync(
      input,
      `import {verifyKernelWireSource} from ${JSON.stringify(helper)};console.log(JSON.stringify(await verifyKernelWireSource(${JSON.stringify(sem)},${JSON.stringify(kind)})))`,
    )
    execFileSync(process.env.BUN_BIN, ['build', input, '--compile', '--outfile', output], {
      stdio: 'pipe',
      timeout: 60000,
    })
    const result = JSON.parse(
      execFileSync(output, [], { encoding: 'utf8', timeout: 60000, env: { ...process.env, BUN_OPTIONS: '' } }),
    )
    assert.equal(result.ok, true)
    assert.equal(result.wire_checks, 46)
  })
}

test('retained CC before span demonstrates why the old CLI could not parse the new kernel input', () => {
  const spec = fixedDataplaneSpec('cc-fixed')
  const patches = JSON.parse(fs.readFileSync(path.join(root, 'share', spec.directory, 'patches.json')))['cc-node']
  // The current maintenance is already on native v2. The retained legacy span
  // is historical input evidence, not the active implementation.
  const sem = JSON.parse(fs.readFileSync(path.join(root, 'share', spec.directory, 'semantics.json')))
  const before = sem.lifecycle.native_before
  const context = vm.createContext({ process: { env: { CLAUDE_CODE_NATIVE_SLOTS: '2' } } })
  vm.runInContext(
    sourceFunction(before, 'nativeSlotCount').text + '\n' + sourceFunction(before, 'parseStdinLine').text,
    context,
  )
  assert.equal(context.nativeSlotCount(), 0)
  assert.equal(context.parseStdinLine('{"type":"job_start"}'), null)
  assert.equal(context.parseStdinLine('{"type":"kin_job_start"}').type, 'kin_job_start')
})
