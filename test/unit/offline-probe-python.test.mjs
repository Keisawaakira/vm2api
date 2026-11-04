import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('offline Python protocol/mock/proxy fixtures (no native executable or provider)', (t) => {
  const binary = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
  const available = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 5000 })
  if (available.error?.code === 'ENOENT') {
    t.skip('Python 3 is not installed on this test host')
    return
  }
  assert.equal(available.status, 0, available.stderr)
  const script = fileURLToPath(new URL('../support/offline-probe-test.py', import.meta.url))
  const result = spawnSync(binary, ['-B', script], {
    encoding: 'utf8',
    timeout: 45000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' },
  })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  assert.match(result.stderr, /Ran \d+ tests/)
})
