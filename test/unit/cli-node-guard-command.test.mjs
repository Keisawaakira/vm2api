import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createCliNodeGuard } from '../../src/lib/vm/cli-node-guard.mjs'

const bash = process.env.KIN_TEST_BASH || (process.platform === 'win32' ? null : 'bash')
const skip = !bash ? 'Requires an explicitly selected test bash on Windows; never launch WSL implicitly' : false

async function command() {
  let args
  const guard = createCliNodeGuard({
    listTargets: () => [{ id: 'vm-fixture', platform: 'claude' }],
    liveTokens: () => ['live'],
    exec: async (_connect, _container, cmd) => {
      args = cmd
    },
  })
  await guard.tick()
  assert.ok(args)
  return args
}

function observedKills(t, script, processes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-guard-proc-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  for (const p of processes) {
    const root = path.join(dir, 'proc', String(p.pid))
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, 'cmdline'), p.argv.join('\0') + '\0')
    fs.writeFileSync(path.join(root, 'environ'), (p.env || []).join('\0') + '\0')
  }
  // Only redirect proc reads into a fixture tree and replace the kill builtin.
  // The scanner/policy is the actual script obtained from createCliNodeGuard.
  const source = `kill() { printf 'KILL:%s\\n' "$*"; };\n` + script.replaceAll('/proc/', './proc/')
  const ran = spawnSync(bash, ['-c', source, 'guard', 'live'], { cwd: dir, encoding: 'utf8' })
  assert.equal(ran.status, 0, ran.stderr)
  return [...ran.stdout.matchAll(/KILL:-KILL (\d+)/g)].map((m) => Number(m[1])).sort((a, b) => a - b)
}

test('guard ignores its own/shell argv and preserves a fixed native worker', { skip }, async (t) => {
  const args = await command()
  const kills = observedKills(t, args[2], [
    { pid: 20, argv: ['/home/kincli/.kin/cli-node-fixed'], env: ['CLAUDE_CODE_KIN_NATIVE_SLOTS=2'] },
    { pid: 31, argv: ['/home/kincli/.kin/cli-node', '--print'] },
    { pid: 40, argv: ['/bin/sh', '-c', 'echo cli-node -p not-a-process'] },
    { pid: 41, argv: ['/bin/sh', '-c', args[2], 'guard', 'live'] },
    { pid: 50, argv: ['/home/kincli/.kin/cli-node'], env: ['KIN_PANEL_SHELL=live'] },
    { pid: 51, argv: ['/home/kincli/.kin/cli-node'], env: ['KIN_PANEL_SHELL=closed'] },
  ])
  assert.deepEqual(kills, [31, 51])
})

test('print flag is an argv token, not a phrase inside prompt text', { skip }, async (t) => {
  const args = await command()
  assert.deepEqual(
    observedKills(t, args[2], [
      { pid: 10, argv: ['/home/kincli/.kin/cli-node', 'explain -p flag'] },
      { pid: 11, argv: ['/home/kincli/.kin/cli-node', 'explain\n-p\n--print\nflags'] },
      { pid: 20, argv: ['/home/kincli/.kin/cli-node-fixed', '-p'] },
    ]),
    [10, 11],
  )
})
