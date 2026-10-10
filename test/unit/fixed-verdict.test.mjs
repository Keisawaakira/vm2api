import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { fixedDataplaneSpec, readFixedRelease } from '../../src/lib/vm/wrap-fixed.mjs'
import { VERDICT_BASES } from '../../scripts/refresh-fixed-cli-verdict.mjs'
import { nativeValidator, verifyVerdictSource } from '../support/fixed-verdict-controls.mjs'
const root = fileURLToPath(new URL('../../', import.meta.url))
for (const kind of ['wrap', 'cc']) {
  const dir = path.join(
    process.env.FIXED_VERDICT_ROOT || path.join(root, 'share'),
    process.env.FIXED_VERDICT_ROOT ? kind + '-fixed/v1102-r1' : fixedDataplaneSpec(kind + '-fixed').directory,
  )
  const sem = JSON.parse(fs.readFileSync(path.join(dir, 'semantics.json'), 'utf8'))
  test(`${kind} actual classifier validator accepts severity verdict without block tag`, () => {
    const validate = nativeValidator(sem.classifier.classifierHelpers, kind)
    assert.equal(
      validate(
        { purpose: 'auto_mode_classifier', format: 'xml', stage: 'xml_s1' },
        {
          system: [{ type: 'text', text: '<severity>50</severity>' }],
          messages: [{ role: 'user', content: '<transcript>Read {}</transcript>' }],
        },
      ),
      true,
    )
  })
  test(`${kind} real native dispatch, rotated credential reads and existing fixes stay coherent`, async () => {
    const result = await verifyVerdictSource(sem, kind)
    assert.equal(result.ok, true)
    assert.ok(result.verdict_checks >= 24)
    assert.equal(result.preserved_checks, kind === 'cc' ? 157 : 135)
  })
  test(`${kind} current package retains the format-independent classifier and session repairs`, () => {
    const rel = process.env.FIXED_VERDICT_ROOT
      ? { ok: true, manifest: JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'))) }
      : readFixedRelease(root, kind + '-fixed')
    assert.equal(rel.ok, true, rel.error)
    const m = rel.manifest
    assert.equal(m.id, process.env.FIXED_VERDICT_ROOT ? VERDICT_BASES[kind].id : fixedDataplaneSpec(kind + '-fixed').id)
    const classifierPatch = [...m.artifacts[VERDICT_BASES[kind].file].patches, ...m.inherited_repairs].find(
      (p) => p.id === 'classifier-format-independent',
    )
    if (m.native_wire_contract) {
      assert.equal(m.classifier_contract, 'native_request_context_v1')
      assert.equal(m.artifacts[VERDICT_BASES[kind].file].patches.length, kind === 'wrap' ? 2 : 8)
      // New wrap includes the validator upstream; CC's containing native span was renamed.
      if (kind === 'wrap') assert.equal(classifierPatch, undefined)
      else assert.equal(classifierPatch.overlap, true)
      for (const patch of m.inherited_repairs.filter((p) => !p.preserved)) assert.equal(patch.overlap, true)
    } else {
      assert.ok(classifierPatch)
      if (!process.env.FIXED_VERDICT_ROOT) assert.equal(classifierPatch.preserved, true)
      assert.equal(m.artifacts[VERDICT_BASES[kind].file].patches.length, 1)
      const changed = m.inherited_repairs.filter((p) => !p.preserved).map((p) => p.id)
      assert.deepEqual(
        changed.sort(),
        process.env.FIXED_VERDICT_ROOT && kind === 'cc'
          ? ['classifier-native-context-dispatch', 'native-cancel-ping-errors']
          : [],
      )
    }
    for (const name of [
      'complete-job-session-bootstrap',
      'read-active-job-session',
      'initialize-job-session-with-state',
    ])
      if (kind === 'cc') assert.ok(m.inherited_repairs.some((p) => p.id === name && p.preserved))
  })
  test(`${kind} Bun compiled miniature preserves native/session behavior`, { skip: !process.env.BUN_BIN }, (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-compiled-'))
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }))
    const input = path.join(tmp, 'entry.mjs'),
      output = path.join(tmp, process.platform === 'win32' ? 'entry.exe' : 'entry')
    fs.writeFileSync(
      input,
      `import{verifyVerdictSource}from ${JSON.stringify(path.join(root, 'test/support/fixed-verdict-controls.mjs').replaceAll('\\', '/'))};console.log(JSON.stringify(await verifyVerdictSource(${JSON.stringify(sem)},${JSON.stringify(kind)})));`,
    )
    execFileSync(process.env.BUN_BIN, ['build', input, '--compile', '--outfile', output], {
      stdio: 'pipe',
      timeout: 60000,
    })
    const result = JSON.parse(
      execFileSync(output, [], { encoding: 'utf8', timeout: 60000, env: { ...process.env, BUN_OPTIONS: '' } }),
    )
    assert.equal(result.ok, true)
  })
}
