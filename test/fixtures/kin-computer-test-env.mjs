import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { after, mock } from 'node:test'
import { fileURLToPath } from 'node:url'

const fixturesDir = path.dirname(fileURLToPath(import.meta.url))
const stubPath = path.join(fixturesDir, 'kin-computer-stub.mjs')
const wrapperPath = path.join(os.tmpdir(), `kin-computer-stub-wrap-${process.pid}.sh`)

/** Point unit tests at the kin-computer stub unless the runner already set a bin. */
export function ensureKinComputerStubEnv() {
  if (String(process.env.KIN_COMPUTER_BIN || '').trim()) return process.env.KIN_COMPUTER_BIN
  const node = process.execPath.replace(/'/g, `'\\''`)
  const stub = stubPath.replace(/'/g, `'\\''`)
  fs.writeFileSync(wrapperPath, `#!/bin/sh\nexec '${node}' '${stub}' "$@"\n`, { encoding: 'utf8', mode: 0o755 })
  process.env.KIN_COMPUTER_BIN = wrapperPath
  if (process.platform === 'win32') {
    // Windows cannot exec a POSIX shebang. Redirect only this test wrapper to
    // the same Node fixture, never the real helper or unrelated subprocesses.
    const exec = childProcess.execFileSync
    const control = mock.method(childProcess, 'execFileSync', (file, args = [], options) =>
      file === wrapperPath ? exec(process.execPath, [stubPath, ...args], options) : exec(file, args, options),
    )
    syncBuiltinESMExports()
    after(() => {
      control.mock.restore()
      syncBuiltinESMExports()
      fs.rmSync(wrapperPath, { force: true })
    })
  }
  return wrapperPath
}

ensureKinComputerStubEnv()
