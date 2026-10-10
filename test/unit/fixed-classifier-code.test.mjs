import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { fixedDataplaneSpec, readFixedRelease } from '../../src/lib/vm/wrap-fixed.mjs'
import { verifyClassifierSource } from '../support/fixed-classifier-controls.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const all = {}
for (const kind of ['wrap', 'cc']) {
  const spec = fixedDataplaneSpec(kind + '-fixed')
  const sem = JSON.parse(fs.readFileSync(path.join(root, 'share', spec.directory, 'semantics.json'), 'utf8'))
  // Before/after reference spans are retained in the hash-bound active artifact.
  const previous = sem
  all[kind] = { sem: sem.classifier, previous }
  test(`${kind} current classifier source preserves ordinary lifecycle/system/60000 budget`, async () => {
    const result = await verifyClassifierSource(sem.classifier, previous, kind)
    assert.equal(result.ok, true)
    assert.equal(result.checks, 135)
  })
  test(`${kind} refuses a package missing the classifier capability contract`, (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'classifier-contract-'))
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
    const original = JSON.parse(fs.readFileSync(path.join(root, 'share', spec.directory, 'manifest.json'), 'utf8'))
    const dir = path.join(tmp, 'share', spec.directory)
    fs.mkdirSync(dir, { recursive: true })
    for (const value of [undefined, 'legacy']) {
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ ...original, classifier_contract: value }))
      const result = readFixedRelease(tmp, kind + '-fixed')
      assert.equal(result.ok, false)
      assert.match(result.code, /unapproved$/)
    }
  })
}
test('Bun1.3.14 compiled miniature executes current classifier and ordinary controls', {
  skip: !process.env.BUN_BIN,
}, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'classifier-compile-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 40 }))
  const input = path.join(dir, 'entry.mjs'),
    bin = path.join(dir, process.platform === 'win32' ? 'entry.exe' : 'entry')
  const controls = path.join(root, 'test/support/fixed-classifier-controls.mjs').replaceAll('\\', '/')
  fs.writeFileSync(
    input,
    `import{verifyClassifierSource}from ${JSON.stringify(controls)};const all=${JSON.stringify(all)};for(const[k,v]of Object.entries(all))console.log(JSON.stringify(await verifyClassifierSource(v.sem,v.previous,k)));`,
  )
  execFileSync(process.env.BUN_BIN, ['build', input, '--compile', '--outfile', bin], { stdio: 'pipe', timeout: 60000 })
  const text = execFileSync(bin, [], { encoding: 'utf8', timeout: 60000, env: { ...process.env, BUN_OPTIONS: '' } })
  assert.deepEqual(
    text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .map((x) => [x.kind, x.ok, x.checks]),
    [
      ['wrap', true, 135],
      ['cc', true, 135],
    ],
  )
})
