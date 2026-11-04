import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const script = path.resolve(import.meta.dirname, '../../scripts/fetch-payload.mjs')
const bytes = Buffer.from('synthetic payload fixture; not a native executable')
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex')
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'payload-fetch-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dest = path.join(root, 'dest')
  fs.mkdirSync(path.join(dest, 'bin'), { recursive: true })
  const manifest = path.join(root, 'manifest.json')
  fs.writeFileSync(
    manifest,
    JSON.stringify({
      repo: 'fixture/unused',
      release: 'fixture-tag',
      files: [
        { path: 'bin/sample', asset: 'sample', size: bytes.length, sha256: hash(bytes) },
        { path: 'share/sample', asset: 'sample', size: bytes.length, sha256: hash(bytes) },
      ],
    }),
  )
  async function run(args = [], env = {}) {
    try {
      return {
        ...(await exec(process.execPath, [script, '--manifest', manifest, '--dest', dest, ...args], {
          env: { ...process.env, VM2API_PAYLOAD_BASE_URL: 'http://127.0.0.1:1', ...env },
          timeout: 10000,
        })),
        code: 0,
      }
    } catch (error) {
      return { code: error.code, stdout: error.stdout || '', stderr: error.stderr || '' }
    }
  }
  return { root, dest, run }
}

for (const corrupt of [false, true]) {
  test(`payload --check is offline and validates exact size/hash (corrupt=${corrupt})`, async (t) => {
    const f = fixture(t)
    fs.mkdirSync(path.join(f.dest, 'share'))
    fs.writeFileSync(path.join(f.dest, 'bin/sample'), corrupt ? Buffer.alloc(bytes.length, 120) : bytes)
    fs.writeFileSync(path.join(f.dest, 'share/sample'), bytes)
    const result = await f.run(['--check'])
    assert.equal(result.code, corrupt ? 1 : 0, result.stderr)
    if (corrupt) assert.match(result.stderr, /payload mismatch.*bin\/sample/)
    else assert.match(result.stdout, /payload ok/)
  })
}

for (const mode of ['ok', 'bad-hash', 'http-error']) {
  test(`payload download ${mode} preserves existing files until validation succeeds`, async (t) => {
    const f = fixture(t)
    const old = Buffer.from('stale local content')
    fs.writeFileSync(path.join(f.dest, 'bin/sample'), old)
    let calls = 0
    const server = http.createServer((req, res) => {
      calls++
      assert.equal(req.url, '/fixture-tag/sample')
      res.writeHead(mode === 'http-error' ? 503 : 200)
      res.end(mode === 'bad-hash' ? Buffer.alloc(bytes.length, 120) : bytes)
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    t.after(async () => {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    })
    const result = await f.run([], { VM2API_PAYLOAD_BASE_URL: `http://127.0.0.1:${server.address().port}` })
    assert.equal(calls, 1, 'duplicate asset paths share one verified download')
    if (mode === 'ok') {
      assert.equal(result.code, 0, result.stderr)
      assert.deepEqual(fs.readFileSync(path.join(f.dest, 'bin/sample')), bytes)
      assert.deepEqual(fs.readFileSync(path.join(f.dest, 'share/sample')), bytes)
      const cached = await f.run()
      assert.equal(cached.code, 0, cached.stderr)
      assert.equal(calls, 1)
    } else {
      assert.notEqual(result.code, 0)
      assert.deepEqual(fs.readFileSync(path.join(f.dest, 'bin/sample')), old)
      assert.equal(fs.existsSync(path.join(f.dest, 'share/sample')), false)
    }
  })
}
