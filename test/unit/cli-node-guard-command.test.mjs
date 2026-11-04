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
  const source = `kill() { printf 'KILL:%s\\n' "$*"; };\n` + script
  const ran = spawnSync(bash, ['-c', source, 'guard', 'live'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, KIN_GUARD_PROC: './proc' },
  })
  assert.equal(ran.status, 0, ran.stderr || ran.error?.message)
  return [...ran.stdout.matchAll(/KILL:-KILL (\d+)/g)].map((m) => Number(m[1])).sort((a, b) => a - b)
}

test('guard ignores its own/shell argv and preserves a fixed native worker', { skip }, async (t) => {
  const args = await command()
  const kills = observedKills(t, args[2], [
    { pid: 20, argv: ['/home/kincli/.kin/cli-node-fixed'], env: ['CLAUDE_CODE_KIN_NATIVE_SLOTS=2'] },
    { pid: 31, argv: ['/home/kincli/.kin/cli-node', '--print'], env: ['HOME=/home/kincli'] },
    { pid: 40, argv: ['/bin/sh', '-c', 'echo cli-node -p not-a-process'] },
    { pid: 41, argv: ['/bin/sh', '-c', args[2], 'guard', 'live'] },
    { pid: 50, argv: ['/home/kincli/.kin/cli-node'], env: ['KIN_PANEL_SHELL=live'] },
    { pid: 51, argv: ['/home/kincli/.kin/cli-node'], env: ['KIN_PANEL_SHELL=closed'] },
  ])
  assert.deepEqual(kills, [31, 51])
})

test('guard prefers a modern fixed worker while preserving legitimate marked processes', { skip }, async (t) => {
  const args = await command()
  assert.deepEqual(
    observedKills(t, args[2], [
      { pid: 10, argv: ['/home/kincli/.kin/cli-node'], env: ['CLAUDE_CODE_KIN_NATIVE_SLOTS=2'] },
      {
        pid: 20,
        argv: ['/usr/bin/qemu-x86_64', '/home/kincli/.kin/cli-node-fixed'],
        env: ['CLAUDE_CODE_NATIVE_SLOTS=2'],
      },
      { pid: 21, argv: ['/home/kincli/.kin/cli-node', '-p', 'hello'], env: ['KIN_OFFICIAL_CC=1'] },
      { pid: 22, argv: ['/bin/sh', '-c', 'cli-node CLAUDE_CODE_NATIVE_SLOTS=2'] },
      { pid: 23, argv: ['/home/kincli/.kin/cli-node'], env: ['KIN_PANEL_SHELL=live'] },
    ]),
    [10],
  )
})

test('print text does not confer native ownership; only explicit native env does', { skip }, async (t) => {
  const args = await command()
  assert.deepEqual(
    observedKills(t, args[2], [
      { pid: 10, argv: ['/home/kincli/.kin/cli-node', 'explain -p flag'], env: ['HOME=/home/kincli'] },
      { pid: 11, argv: ['/home/kincli/.kin/cli-node', 'explain\n-p\n--print\nflags'], env: ['HOME=/home/kincli'] },
      { pid: 20, argv: ['/home/kincli/.kin/cli-node-fixed', '-p'], env: ['CLAUDE_CODE_KIN_NATIVE_SLOTS=20'] },
    ]),
    [10, 11],
  )
})

test('guard preserves marked bootstrap/setup/panel and recognizes the actual QEMU target', { skip }, async (t) => {
  const args = await command()
  assert.deepEqual(
    observedKills(t, args[2], [
      {
        pid: 10,
        argv: ['/usr/bin/qemu-x86_64', '/home/kincli/.kin/cli-node-fixed', '-p'],
        env: ['CLAUDE_CODE_KIN_NATIVE_SLOTS=20'],
      },
      { pid: 11, argv: ['/home/kincli/.kin/cli-node', '-p'], env: ['CLAUDE_CODE_KIN_NATIVE_SLOTS=20'] },
      { pid: 12, argv: ['/home/kincli/.kin/cli-node', '-p', 'hello'], env: ['KIN_OFFICIAL_CC=1'] },
      { pid: 13, argv: ['/home/kincli/.kin/cli-node', 'setup-token'], env: ['KIN_SETUP_TOKEN=1'] },
      { pid: 14, argv: ['/home/kincli/.kin/cli-node', '-p', 'hello'], env: ['KIN_PANEL_SHELL=live'] },
      { pid: 15, argv: ['/home/kincli/.kin/cli-node', '-p'] },
      { pid: 16, argv: ['/usr/bin/qemu-x86_64', '/usr/bin/unrelated', 'cli-node -p'], env: ['HOME=/fixture'] },
      { pid: 18, argv: ['/home/kincli/.kin/cli-node', '-p'], env: ['HOME=/fixture'] },
    ]),
    [11, 18],
  )
})
