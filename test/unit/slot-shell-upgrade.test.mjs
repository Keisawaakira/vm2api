import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSlotShell } from '../../src/lib/vm/slot-shell.mjs'

function rejectedUpgrade(shell, url) {
  const socket = {
    text: '',
    destroyed: false,
    write(value) {
      this.text += value
    },
    destroy() {
      this.destroyed = true
    },
  }
  let handled
  assert.doesNotThrow(() => {
    handled = shell.handleUpgrade({ url }, socket, Buffer.alloc(0))
  })
  return { handled, socket }
}

for (const id of ['%ZZ', '%E0%A4%A', '%']) {
  test(`malformed slot terminal path ${id} is rejected before any Docker/session work`, () => {
    const shell = createSlotShell({ projectRoot: 'unused-no-vm-read' })
    const { handled, socket } = rejectedUpgrade(shell, `/api/panel/vms/${id}/shell?ticket=unknown`)
    assert.equal(handled, true)
    assert.match(socket.text, /^HTTP\/1\.1 400 /)
    assert.equal(socket.destroyed, true)
  })
}

test('normal terminal paths without a valid one-time ticket remain unauthorized', () => {
  const shell = createSlotShell({ projectRoot: 'unused-no-vm-read' })
  for (const url of ['/api/panel/vms/vm-01/shell', '/api/panel/vms/vm-01/shell?ticket=unknown']) {
    const { handled, socket } = rejectedUpgrade(shell, url)
    assert.equal(handled, true)
    assert.match(socket.text, /^HTTP\/1\.1 401 /)
    assert.equal(socket.destroyed, true)
  }
  const { handled, socket } = rejectedUpgrade(shell, '/unrelated')
  assert.equal(handled, false)
  assert.equal(socket.destroyed, false)
})
