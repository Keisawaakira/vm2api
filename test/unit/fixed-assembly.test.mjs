import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { fixedDataplaneSpec, readFixedRelease } from '../../src/lib/vm/wrap-fixed.mjs'
import { inspectBunElf } from '../../scripts/build-offline-native-candidates.mjs'
import { sourceFunction, sourceRange } from '../../scripts/refresh-fixed-cli-lifecycle.mjs'
import { ASSEMBLY_BASES, ASSEMBLY_CONTRACT, patchAssemblyBytes } from '../../scripts/refresh-fixed-cli-assembly.mjs'
import { verifyAssemblySource } from '../support/fixed-assembly-controls.mjs'
import { fixedParentImage } from '../support/fixed-parent-image.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex')
for (const [kind, base] of Object.entries(ASSEMBLY_BASES)) {
  const spec = fixedDataplaneSpec(kind + '-fixed'),
    dir = path.join(root, 'share', spec.directory)
  const sem = JSON.parse(fs.readFileSync(path.join(dir, 'semantics.json')))
  test(`${kind} native optional-field presence matches actual upstream assembly`, async () => {
    const result = await verifyAssemblySource(sem, kind)
    assert.equal(result.ok, true)
    assert.equal(result.assembly_checks, kind === 'cc' ? 279 : 275)
    assert.equal(result.preserved_checks, kind === 'cc' ? 607 : 583)
  })
  test(`${kind} loader requires assembly compatibility and refuses unrecognized bytes`, (t) => {
    assert.equal(readFixedRelease(root, kind + '-fixed').ok, true)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-assembly-contract-'))
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
    const dest = path.join(tmp, 'share', spec.directory)
    fs.mkdirSync(dest, { recursive: true })
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json')))
    assert.equal(manifest.request_assembly_contract, ASSEMBLY_CONTRACT)
    for (const contract of [undefined, 'old-request-assembly']) {
      fs.writeFileSync(
        path.join(dest, 'manifest.json'),
        JSON.stringify({ ...manifest, request_assembly_contract: contract }),
      )
      assert.match(readFixedRelease(tmp, kind + '-fixed').code, /unapproved$/)
    }
    assert.throws(() => patchAssemblyBytes(Buffer.alloc(128), kind, {}), /Unknown assembly baseline/)
  })
  test(`${kind} assembly and preserved lifecycle execute in compiled Bun1.3.14`, {
    skip: !process.env.BUN_BIN ? 'Existing Bun maintainer tool unavailable' : false,
  }, (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-assembly-compiled-'))
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }))
    const input = path.join(tmp, 'entry.mjs'),
      bin = path.join(tmp, process.platform === 'win32' ? 'entry.exe' : 'entry')
    const controls = path.join(root, 'test/support/fixed-assembly-controls.mjs').replaceAll('\\', '/')
    fs.writeFileSync(
      input,
      `import{verifyAssemblySource}from ${JSON.stringify(controls)};console.log(JSON.stringify(await verifyAssemblySource(${JSON.stringify(sem)},${JSON.stringify(kind)})));`,
    )
    execFileSync(process.env.BUN_BIN, ['build', input, '--compile', '--outfile', bin], {
      stdio: 'pipe',
      timeout: 60000,
    })
    const value = JSON.parse(
      execFileSync(bin, [], { encoding: 'utf8', timeout: 60000, env: { ...process.env, BUN_OPTIONS: '' } }),
    )
    assert.equal(value.ok, true)
    assert.equal(value.checks, kind === 'cc' ? 886 : 858)
  })
  test(`${kind} fresh unpack binds recorded assembly helpers and preserves all out-of-patch bytes`, {
    skip: !process.env.UPX_BIN ? 'Existing UPX maintainer tool unavailable' : false,
  }, (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-assembly-source-'))
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }))
    const file = path.join(tmp, 'current')
    execFileSync(process.env.UPX_BIN, ['-d', '-o', file, path.join(dir, base.file)], { stdio: 'pipe', timeout: 60000 })
    const current = fs.readFileSync(file),
      patches = JSON.parse(fs.readFileSync(path.join(dir, 'patches.json')))[base.file]
    const parent = fixedParentImage(current, patches, base.unpacked)
    const now = inspectBunElf(current),
      prior = inspectBunElf(parent),
      text = now.source.toString('utf8')
    assert.deepEqual({ ...now, source: null }, { ...prior, source: null })
    let cursor = 0
    for (const patch of patches) {
      assert.ok(parent.subarray(cursor, patch.offset).equals(current.subarray(cursor, patch.offset)))
      assert.equal(hash(current.subarray(patch.offset, patch.offset + patch.bytes)), patch.after_sha256)
      cursor = patch.offset + patch.bytes
    }
    assert.ok(parent.subarray(cursor).equals(current.subarray(cursor)))
    if (kind === 'wrap') {
      const actual = sourceRange(
        text,
        '// src/services/api/requestBody.ts',
        '// ../../src/lib/protocol/claude-code-betas.mjs',
      ).text
      assert.equal(actual, sem.request_wire.reference_assembly)
      for (const name of [
        'modelRejectsDisabledThinking',
        'modelAcceptsTemperature',
        'modelCapsEffortWhenDisabled',
        'effortLevelAboveHigh',
      ])
        assert.equal(
          sourceFunction(text, name).text.trim(),
          sourceFunction(sem.request_wire.model_helpers, name).text.trim(),
          name,
        )
    } else {
      assert.ok(text.includes(sem.request_wire.helpers), 'Private helper must be actual executable source')
      assert.ok(text.includes(sem.request_wire.params), 'Native constructor must be actual executable source')
      const old = prior.source.toString('utf8')
      assert.equal(
        sem.request_wire.previous_params.trim(),
        sourceRange(
          old,
          'const paramsFromContext',
          '\n  {\n    const queryParams',
          sourceFunction(old, 'queryModel').start,
        ).text.trim(),
      )
      for (const name of [
        'queryKinMessagesWithStreaming',
        'runNativeMessagesLoop',
        'getSessionId',
        'getJobSessionId',
        'runWithJobSession',
        'getAnthropicClient',
        'officialH2Fetch',
        'stampCchBody',
      ])
        assert.equal(sourceFunction(text, name).text.trim(), sourceFunction(old, name).text.trim(), name)
    }
  })
}
