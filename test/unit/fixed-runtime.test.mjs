import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { fixedDataplaneSpec, readFixedRelease } from '../../src/lib/vm/wrap-fixed.mjs'
import { inspectBunElf, sha256 } from '../../scripts/build-offline-native-candidates.mjs'
import { RUNTIME_BASES, RUNTIME_CONTRACT } from '../../scripts/refresh-fixed-cli-runtime.mjs'
import { sourceFunction } from '../../scripts/refresh-fixed-cli-lifecycle.mjs'
import { verifyRuntimeSource } from '../support/fixed-runtime-controls.mjs'
import { fixedParentImage } from '../support/fixed-parent-image.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const temporary = (t, prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }))
  return dir
}

for (const kind of ['wrap', 'cc']) {
  const spec = fixedDataplaneSpec(kind + '-fixed')
  const dir = path.join(root, 'share', spec.directory)
  const sem = JSON.parse(fs.readFileSync(path.join(dir, 'semantics.json'), 'utf8'))

  test(`${kind} actual native CCH/config/fetch and unsupported cached-mode controls`, async () => {
    const result = await verifyRuntimeSource(sem, kind)
    assert.equal(result.ok, true)
    assert.equal(result.checks, 88)
  })

  test(`${kind} runtime contract fails closed before incompatible CLI selection`, (t) => {
    assert.equal(readFixedRelease(root, kind + '-fixed').ok, true)
    const project = temporary(t, 'fixed-runtime-contract-')
    const dest = path.join(project, 'share', spec.directory)
    fs.mkdirSync(dest, { recursive: true })
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.runtime_wire_contract, RUNTIME_CONTRACT)
    for (const value of [undefined, 'old-runtime']) {
      fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify({ ...manifest, runtime_wire_contract: value }))
      assert.match(readFixedRelease(project, kind + '-fixed').code, /unapproved$/)
    }
  })

  test(`${kind} recorded runtime functions are bound to the freshly unpacked executable`, {
    skip: !process.env.UPX_BIN ? 'Existing UPX maintainer tool unavailable' : false,
  }, (t) => {
    const tmp = temporary(t, 'fixed-runtime-bindings-')
    const unpacked = path.join(tmp, 'cli')
    execFileSync(process.env.UPX_BIN, ['-d', '-o', unpacked, path.join(dir, RUNTIME_BASES[kind].file)], {
      stdio: 'pipe',
      timeout: 60000,
    })
    const bytes = fs.readFileSync(unpacked)
    const patches = JSON.parse(fs.readFileSync(path.join(dir, 'patches.json'), 'utf8'))[RUNTIME_BASES[kind].file]
    const parent = fixedParentImage(bytes, patches, RUNTIME_BASES[kind].unpacked)
    const source = inspectBunElf(bytes).source.toString('utf8')
    const before = inspectBunElf(parent).source.toString('utf8')
    assert.ok(source.includes(sem.runtime_wire.cch))
    assert.ok(source.includes(sem.runtime_wire.cache_config))
    const controls = {
      __vm201SystemCch: sem.runtime_wire.cch,
      projectForCch: sem.runtime_wire.cch,
      stampCchBody: sem.runtime_wire.cch,
      buildFetch: sem.runtime_wire.fetch,
      getAttributionHeader: sem.runtime_wire.attribution,
      microcompactMessages: sem.runtime_wire.compact,
      readPanelCchEnabled: sem.runtime_wire.config,
      readPanelCachedMicrocompactEnabled: sem.runtime_wire.config,
    }
    for (const [name, control] of Object.entries(controls)) {
      assert.equal(sourceFunction(source, name).text.trim(), sourceFunction(control, name).text.trim(), name)
    }
    assert.equal(sourceFunction(before, 'buildFetch').text.trim(), sem.runtime_wire.previous_fetch.trim())
    for (const patch of patches)
      assert.equal(sha256(bytes.subarray(patch.offset, patch.offset + patch.bytes)), patch.after_sha256)
  })

  test(`${kind} actual runtime controls execute in compiled Bun1.3.14`, {
    skip: !process.env.BUN_BIN ? 'Existing Bun maintainer tool unavailable' : false,
  }, (t) => {
    const tmp = temporary(t, 'fixed-runtime-compiled-')
    const input = path.join(tmp, 'entry.mjs')
    const output = path.join(tmp, process.platform === 'win32' ? 'entry.exe' : 'entry')
    const control = path.join(root, 'test/support/fixed-runtime-controls.mjs').replaceAll('\\', '/')
    fs.writeFileSync(
      input,
      `import{verifyRuntimeSource}from ${JSON.stringify(control)};console.log(JSON.stringify(await verifyRuntimeSource(${JSON.stringify(sem)},${JSON.stringify(kind)})));`,
    )
    execFileSync(process.env.BUN_BIN, ['build', input, '--compile', '--outfile', output], {
      stdio: 'pipe',
      timeout: 60000,
    })
    const result = JSON.parse(
      execFileSync(output, [], {
        encoding: 'utf8',
        timeout: 60000,
        env: { ...process.env, BUN_OPTIONS: '' },
      }),
    )
    assert.equal(result.ok, true)
    assert.equal(result.checks, 88)
  })
}
