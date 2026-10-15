import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeKernelConfig } from '../../src/lib/transport/rust-kernel-supervisor.mjs'

// This validates written Node configuration, not installed binaries or native behavior.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-dataplane-cache-'))
  const previous = process.env.KIN_CLAUDE_BIN
  delete process.env.KIN_CLAUDE_BIN
  t.after(() => {
    if (previous === undefined) delete process.env.KIN_CLAUDE_BIN
    else process.env.KIN_CLAUDE_BIN = previous
    fs.rmSync(root, { recursive: true, force: true })
  })
  return (vm, routing) => {
    const result = writeKernelConfig(root, vm, { token: 'test-token', routing })
    return JSON.parse(fs.readFileSync(result.configPath, 'utf8'))
  }
}

for (const dataplane of ['wrap', 'cc', 'crag']) {
  const binary = dataplane === 'wrap' ? '/home/kincli/.kin/cli-node' : '/home/kincli/.kin/cc-node'
  test(`${dataplane} config preserves selected executable and credential-aware TTL`, (t) => {
    const write = fixture(t)
    let id = 0
    for (const [mode, auto] of [
      ['oauth', '1h'],
      ['setup-token', '1h'],
      ['apikey', '5m'],
    ]) {
      for (const policy of ['auto', '5m', '1h']) {
        const doc = write(
          { id: `vm-${++id}`, dataplane, claude: { mode } },
          {
            inference: { dataplane: dataplane === 'wrap' ? 'crag' : 'wrap' },
            compatibility: { cache_ttl: policy },
          },
        )
        assert.equal(doc.provider, 'local_cli')
        assert.equal(doc.dataplane, dataplane)
        assert.equal(doc.claude_bin, binary)
        assert.equal(doc.default_cache_ttl, policy === 'auto' ? auto : policy, `${mode}/${policy}`)
      }
    }
  })

  test(`${dataplane} config preserves previous TTL without routing, otherwise uses credential default`, (t) => {
    const write = fixture(t)
    const vm = { id: 'vm-1', dataplane, claude: { mode: 'apikey' } }
    assert.equal(write(vm).default_cache_ttl, '5m')
    assert.equal(write(vm, { compatibility: { cache_ttl: '1h' } }).default_cache_ttl, '1h')
    const preserved = write(vm)
    assert.equal(preserved.default_cache_ttl, '1h')
    assert.equal(preserved.claude_bin, binary)
  })
}

test('global dataplane applies when the slot inherits; omitted configuration remains wrap', (t) => {
  const write = fixture(t)
  const wrap = write({ id: 'vm-1' }, {})
  assert.equal(wrap.dataplane, 'wrap')
  assert.equal(wrap.claude_bin, '/home/kincli/.kin/cli-node')
  for (const dataplane of ['cc', 'crag']) {
    const doc = write({ id: `vm-${dataplane}` }, { inference: { dataplane } })
    assert.equal(doc.dataplane, dataplane)
    assert.equal(doc.claude_bin, '/home/kincli/.kin/cc-node')
  }
})
