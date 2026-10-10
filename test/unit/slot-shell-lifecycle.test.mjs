import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { registerHooks } from 'node:module'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { WebSocketServer } from 'ws'

// Execute the actual ticket/attach path. Only VM lookup and Docker I/O are
// replaced; no daemon, credentials, SSH, real CLI or provider is contacted.
const key = 'vm2api.slot-shell.test'
const state = { open: null, reaps: [] }
globalThis[Symbol.for(key)] = state
const file = (name) => new URL(`../../src/lib/${name}`, import.meta.url).href
const replacements = new Map([
  [
    file('cluster/docker-remote.mjs'),
    `
    const state=globalThis[Symbol.for(${JSON.stringify(key)})];
    export const openExecTty=(...args)=>state.open(...args);
    export const resizeExec=async()=>{};
    export const inspectExec=async()=>({ExitCode:0});
    export const execDetached=async(...args)=>{state.reaps.push(args)};
  `,
  ],
  [file('transport/rust-kernel-supervisor.mjs'), `export const slotContainerName=({vm})=>'kin-'+vm.id;`],
  [
    file('vm/slot-host.mjs'),
    `export const slotHost=()=>({dockerApi:()=>({fixture:true}),bins:{cli:'/fixture/cli-node'}});`,
  ],
  [file('vm/vm-registry.mjs'), `export const getVm=(_root,id)=>({id,platform:'claude'});`],
])
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (replacements.has(url)) return { format: 'module', shortCircuit: true, source: replacements.get(url) }
    return nextLoad(url, context)
  },
})
const { createSlotShell } = await import('../../src/lib/vm/slot-shell.mjs')
hooks.deregister()
const tick = () => new Promise((resolve) => setImmediate(resolve))

for (const beforeOpen of [true, false]) {
  test(`terminal WebSocket error closes/reaps its own session (before Docker ready=${beforeOpen})`, async (t) => {
    state.reaps = []
    let resolveOpen
    const stream = new PassThrough()
    const session = { execId: 'a'.repeat(64), stream }
    state.open = () =>
      new Promise((resolve) => {
        resolveOpen = resolve
      })
    const closes = []
    const ws = Object.assign(new EventEmitter(), {
      OPEN: 1,
      readyState: 1,
      send() {},
      close(code) {
        if (this.readyState === 3) return
        this.readyState = 3
        closes.push(code)
        this.emit('close')
      },
    })
    t.mock.method(WebSocketServer.prototype, 'handleUpgrade', (_req, _socket, _head, callback) => callback(ws))
    const shell = createSlotShell({ projectRoot: 'fixture-only' })
    const issued = shell.issueTicket('vm-01')
    assert.equal(issued.ok, true)
    shell.handleUpgrade({ url: `/api/panel/vms/vm-01/shell?ticket=${issued.ticket}` }, {}, Buffer.alloc(0))
    assert.equal(typeof resolveOpen, 'function')
    try {
      if (!beforeOpen) {
        resolveOpen(session)
        await tick()
      }
      assert.doesNotThrow(() => ws.emit('error', new Error('fixture invalid WebSocket frame')))
      assert.deepEqual(closes, [1011])
      if (beforeOpen) resolveOpen(session)
      await tick()
      assert.equal(stream.destroyed, true)
      assert.equal(state.reaps.length, 1)
      assert.equal(state.reaps[0][1], 'kin-vm-01')
      assert.match(state.reaps[0][2].at(-1), /^[a-f0-9]{24}$/)
    } finally {
      ws.close(1000)
      resolveOpen(session)
      await tick()
      stream.destroy()
    }
  })
}
