/** Portable test-only helper boundary for a spawned in-process mock gateway. */
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { fileURLToPath } from 'node:url'

if (process.env.KIN_CRS_MOCK !== '1') throw new Error('kin-computer test preload requires the mock gateway')
const fixture = fileURLToPath(new URL('./kin-computer-stub.mjs', import.meta.url))
const exec = childProcess.execFileSync
process.env.KIN_COMPUTER_BIN = fixture
childProcess.execFileSync = function (file, args = [], options) {
  return file === fixture
    ? exec.call(this, process.execPath, [fixture, ...args], options)
    : exec.call(this, file, args, options)
}
syncBuiltinESMExports()
