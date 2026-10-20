import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { fixedDataplaneSpec } from '../../src/lib/vm/wrap-fixed.mjs'
import { bootstrapContext, verifyCCSessionSource } from '../support/fixed-cc-session-controls.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const current = JSON.parse(
  fs.readFileSync(
    path.join(
      process.env.CC_SESSION_FIXTURE_DIR || path.join(root, 'share', fixedDataplaneSpec('cc-fixed').directory),
      'semantics.json',
    ),
    'utf8',
  ),
)
// The active artifact retains the pre-classifier/system comparison spans and
// current native code; regression controls need no retired package directory.
const fallbackInitializer = current.lifecycle.native.slice(
  current.lifecycle.native.indexOf('var init_nativeMessagesRunner='),
)

test('actual CC native initializer starts without fabricated job-session dependencies', () => {
  const { context } = bootstrapContext(current.session || { native_initializer: fallbackInitializer })
  assert.doesNotThrow(() => context.init_nativeMessagesRunner())
})

test('real job scopes survive interleaving and outbound metadata without changing host fallback', async () => {
  assert.ok(current.session, 'current package must carry its real bootstrap/session source')
  const result = await verifyCCSessionSource(current.session, current)
  assert.equal(result.ok, true)
  assert.equal(result.preserved_checks, 135)
  assert.ok(result.session_checks >= 20)
})

test('Bun1.3.14 compiled miniature executes real bootstrap/session and preserved native controls', {
  skip: !process.env.BUN_BIN,
}, (t) => {
  assert.ok(current.session)
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-session-compile-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 40 }))
  const input = path.join(temp, 'entry.mjs'),
    bin = path.join(temp, process.platform === 'win32' ? 'entry.exe' : 'entry')
  const controls = path.join(root, 'test/support/fixed-cc-session-controls.mjs').replaceAll('\\', '/')
  fs.writeFileSync(
    input,
    `import{verifyCCSessionSource}from ${JSON.stringify(controls)};console.log(JSON.stringify(await verifyCCSessionSource(${JSON.stringify(current.session)},${JSON.stringify(current)})));`,
  )
  execFileSync(process.env.BUN_BIN, ['build', input, '--compile', '--outfile', bin], { stdio: 'pipe', timeout: 60000 })
  const result = JSON.parse(
    execFileSync(bin, [], { encoding: 'utf8', timeout: 60000, env: { ...process.env, BUN_OPTIONS: '' } }),
  )
  assert.equal(result.ok, true)
  assert.ok(result.session_checks >= 20)
})
