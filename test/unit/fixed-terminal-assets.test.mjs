import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  FIXED_TERMINAL_BASES,
  buildFixedTerminalRefresh,
  evaluateTerminal,
} from '../../scripts/refresh-fixed-cli-terminal.mjs'
import { inspectBunElf } from '../../scripts/build-offline-native-candidates.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
for (const [kind, base] of Object.entries(FIXED_TERMINAL_BASES)) {
  const dir = path.join(root, 'share', `${kind}-fixed/v189-r1`)
  const parent = path.join(root, 'share', base.directory, base.file)
  test(`${kind} historical v189 ELF changes only its declared terminal span and retains prior repairs`, {
    skip: !process.env.UPX_BIN
      ? 'UPX is required for fresh byte verification'
      : !fs.existsSync(parent)
        ? 'Historical baseline is not retained locally'
        : false,
  }, async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-terminal-bytes-'))
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
    const patch = JSON.parse(fs.readFileSync(path.join(dir, 'patches.json'), 'utf8'))[base.file][0]
    const current = path.join(dir, base.file)
    assert.equal(hash(fs.readFileSync(parent)), base.packed)
    assert.equal(hash(fs.readFileSync(current)), manifest.artifacts[base.file].sha256)
    for (const [file, out] of [
      [parent, 'before'],
      [current, 'after'],
    ])
      execFileSync(process.env.UPX_BIN, ['-d', '-o', path.join(tmp, out), file], { stdio: 'pipe', timeout: 60000 })
    const before = fs.readFileSync(path.join(tmp, 'before')),
      after = fs.readFileSync(path.join(tmp, 'after'))
    assert.equal(hash(before), base.unpacked)
    assert.equal(hash(after), manifest.artifacts[base.file].unpacked_sha256)
    assert.equal(before.length, after.length)
    assert.ok(before.subarray(0, patch.offset).equals(after.subarray(0, patch.offset)))
    assert.ok(before.subarray(patch.offset + patch.bytes).equals(after.subarray(patch.offset + patch.bytes)))
    const actual = after.subarray(patch.offset, patch.offset + patch.replacement_bytes).toString('utf8')
    assert.equal(actual, patch.after)
    assert.equal(hash(before.subarray(patch.offset, patch.offset + patch.bytes)), patch.before_sha256)
    assert.equal(hash(after.subarray(patch.offset, patch.offset + patch.bytes)), patch.after_sha256)
    for (const prior of manifest.inherited_repairs) {
      assert.equal(hash(before.subarray(prior.offset, prior.offset + prior.bytes)), prior.after_sha256)
      assert.ok(
        before
          .subarray(prior.offset, prior.offset + prior.bytes)
          .equals(after.subarray(prior.offset, prior.offset + prior.bytes)),
      )
    }
    assert.equal(manifest.inherited_repairs.length, kind === 'cc' ? 8 : 2)
    const a = inspectBunElf(before),
      b = inspectBunElf(after)
    assert.deepEqual({ ...a, source: null }, { ...b, source: null })
    const semantics = JSON.parse(fs.readFileSync(path.join(dir, 'semantics.json'), 'utf8')).terminal
    assert.equal(semantics.after, actual)
    for (const source of ['agent:kin', 'kin_native_messages', 'sdk'])
      assert.deepEqual(
        await evaluateTerminal({ ...semantics, after: actual }, 'after', source, 'max_tokens'),
        await evaluateTerminal(semantics, 'upstream', source, 'max_tokens'),
      )
  })
}

test('terminal builder refuses changed reference bytes before producing output', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-terminal-refusal-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const source = path.join(dir, 'share/wrap-cli')
  fs.mkdirSync(source, { recursive: true })
  fs.writeFileSync(path.join(source, 'cli-node'), Buffer.alloc(128))
  await assert.rejects(
    buildFixedTerminalRefresh({
      root: dir,
      outputRoot: path.join(dir, 'output'),
      evidence: path.join(dir, 'evidence'),
      upx: process.execPath,
      bun: process.execPath,
    }),
    /reference changed/,
  )
  assert.equal(fs.existsSync(path.join(dir, 'output')), false)
})
