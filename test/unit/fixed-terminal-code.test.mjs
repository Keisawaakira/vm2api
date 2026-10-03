import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { evaluateTerminal } from '../../scripts/refresh-fixed-cli-terminal.mjs'
import { fixedDataplaneSpec } from '../../src/lib/vm/wrap-fixed.mjs'

const root = process.env.FIXED_TERMINAL_ASSET_ROOT || fileURLToPath(new URL('../../share/', import.meta.url))
const which = process.env.FIXED_TERMINAL_BASELINE === '1' ? 'before' : 'after'
const all = {}
for (const kind of ['wrap', 'cc']) {
  const semantics = JSON.parse(
    fs.readFileSync(path.join(root, fixedDataplaneSpec(`${kind}-fixed`).directory, 'semantics.json'), 'utf8'),
  ).terminal
  all[kind] = semantics
  for (const querySource of [
    'agent:kin',
    'kin_native_messages',
    'sdk',
    'repl_main_thread',
    'agent:other',
    'agent:kin:other',
  ])
    for (const stop of ['max_tokens', 'end_turn'])
      for (const max of [128, 128000])
        test(`${kind} native terminal source=${querySource}, stop=${stop}, max=${max}`, async () => {
          const actual = await evaluateTerminal(semantics, which, querySource, stop, max)
          const expected = await evaluateTerminal(semantics, 'upstream', querySource, stop, max)
          assert.deepEqual(actual, expected)
          const native = querySource === 'agent:kin' || querySource === 'kin_native_messages'
          assert.equal(actual.yielded.length, stop === 'max_tokens' && !native ? 1 : 0)
          if (stop === 'max_tokens')
            assert.deepEqual(actual.events, [{ name: 'tengu_max_tokens_reached', fields: { max_tokens: max } }])
        })
}

test('Bun1.3.14 compiled miniature executes exact fixed/upstream terminal fragments', {
  skip: !process.env.BUN_BIN,
}, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-terminal-code-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const input = path.join(dir, 'terminal.mjs'),
    output = path.join(dir, process.platform === 'win32' ? 'terminal.exe' : 'terminal')
  const source = `const all=${JSON.stringify(all)};const which=${JSON.stringify(which)};${evaluateTerminal.toString()}
let checks=0;
for(const semantics of Object.values(all))for(const querySource of ['agent:kin','kin_native_messages','sdk','repl_main_thread'])for(const stop of ['max_tokens','end_turn']){
 const actual=await evaluateTerminal(semantics,which,querySource,stop,128000);
 const expected=await evaluateTerminal(semantics,'upstream',querySource,stop,128000);
 if(JSON.stringify(actual)!==JSON.stringify(expected))throw Error('terminal mismatch '+querySource+' '+stop);
 checks++;
}
console.log(JSON.stringify({checks,runtime:Bun.version,provider_requests:0}));`
  fs.writeFileSync(input, source)
  execFileSync(process.env.BUN_BIN, ['build', input, '--compile', '--outfile', output], {
    stdio: 'pipe',
    timeout: 60000,
  })
  const result = JSON.parse(
    execFileSync(output, [], { encoding: 'utf8', env: { ...process.env, BUN_OPTIONS: '' }, timeout: 15000 }),
  )
  assert.equal(result.checks, 16)
  assert.equal(result.provider_requests, 0)
})
