import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { fixedDataplaneSpec, readFixedRelease } from '../../src/lib/vm/wrap-fixed.mjs'
import { inspectBunElf } from '../../scripts/build-offline-native-candidates.mjs'
import { auditNativeBindings, CC_SESSION_BASE } from '../../scripts/refresh-fixed-cc-session.mjs'
const root = fileURLToPath(new URL('../../', import.meta.url)),
  spec = fixedDataplaneSpec('cc-fixed')
let hasParser = false
try {
  createRequire(path.join(root, 'web/package.json')).resolve('eslint')
  hasParser = true
} catch {}

test('current CC package requires its real job-session contract', (t) => {
  const release = readFixedRelease(root, 'cc-fixed')
  assert.equal(release.ok, true, release.error)
  assert.equal(release.id, CC_SESSION_BASE.id)
  assert.equal(release.manifest.session_contract, 'native_job_session_v1')
  assert.equal(release.manifest.artifacts['cc-node'].validations.native_bindings_resolved, true)
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-job-contract-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const dest = path.join(temp, 'share', spec.directory)
  fs.mkdirSync(dest, { recursive: true })
  fs.writeFileSync(
    path.join(dest, 'manifest.json'),
    JSON.stringify({ ...release.manifest, session_contract: undefined }),
  )
  assert.match(readFixedRelease(temp, 'cc-fixed').code, /unapproved$/)
})

test('independent full-module scope resolution catches old missing bootstrap and validates new image', {
  skip:
    !process.env.UPX_BIN || !hasParser
      ? 'Maintainer scope audit requires UPX and existing frontend ESLint dependencies'
      : false,
}, (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-job-bindings-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const files = [path.join(root, CC_SESSION_BASE.input), path.join(root, 'share', spec.directory, 'cc-node')]
  const checks = files.map((file, i) => {
    const unpacked = path.join(temp, String(i))
    execFileSync(process.env.UPX_BIN, ['-d', '-o', unpacked, file], { stdio: 'pipe', timeout: 60000 })
    return auditNativeBindings(inspectBunElf(fs.readFileSync(unpacked)).source.toString('utf8'), root)
  })
  assert.deepEqual(checks[0].native_unresolved, ['getJobSessionId', 'init_jobSession', 'runWithJobSession'])
  assert.deepEqual(checks[1].native_unresolved, [])
  assert.ok(checks[1].session_bindings.every((row) => row.declared))
  assert.deepEqual(
    checks[1].whole_unresolved,
    checks[0].whole_unresolved.filter((name) => !checks[0].native_unresolved.includes(name)),
  )
})
