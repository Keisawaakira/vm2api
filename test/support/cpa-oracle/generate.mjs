// Usage: node test/support/cpa-oracle/generate.mjs <frozen-cpa> <go.exe> <temporary-cache-root>
// Imports execute translators/embedded registry only, never a server/updater/provider.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const [reference, go, cache] = process.argv.slice(2).map((value) => path.resolve(value))
if (!reference || !go || !cache)
  throw new Error('Provide frozen CPA directory, Go executable and temporary cache directory')
const sha = 'c404af96ebacedf8168b3c2bdbf4449a21cd1c1e'
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: reference, encoding: 'utf8' }).trim() !== sha)
  throw new Error('CPA reference differs from the pinned oracle')
const root = fileURLToPath(new URL('../../../', import.meta.url))
const harness = path.join(reference, 'cmd', `vm2api-oracle-${process.pid}`)
const env = {
  ...process.env,
  GOTOOLCHAIN: 'local',
  GOCACHE: path.join(cache, 'go-cache'),
  GOMODCACHE: path.join(cache, 'go-mod-cache'),
  GOPATH: path.join(cache, 'go-path'),
}
fs.mkdirSync(harness, { recursive: true })
try {
  fs.copyFileSync(new URL('./main.go', import.meta.url), path.join(harness, 'main.go'))
  const output = execFileSync(
    go,
    ['run', '-mod=readonly', `./cmd/${path.basename(harness)}`, path.join(root, 'test/fixtures/cpa/inputs.json')],
    { cwd: reference, env, maxBuffer: 16 * 1024 * 1024 },
  )
  const golden = JSON.parse(output)
  fs.writeFileSync(path.join(root, 'test/fixtures/cpa/goldens.json'), output)
  fs.writeFileSync(
    path.join(root, 'src/lib/protocol/chat-cpa-capabilities.json'),
    JSON.stringify(
      {
        reference: sha,
        models: Object.fromEntries(
          golden.capabilities.map((c) => [
            c.id,
            { thinking: c.thinking || null, max_completion_tokens: c.max_completion_tokens },
          ]),
        ),
      },
      null,
      2,
    ) + '\n',
  )
  execFileSync(
    process.execPath,
    [
      path.join(root, 'node_modules/@biomejs/biome/bin/biome'),
      'format',
      '--write',
      'src/lib/protocol/chat-cpa-capabilities.json',
    ],
    { cwd: root },
  )
  console.log(`${golden.cases.length} cases; ${golden.capabilities.length} pinned capability records`)
} finally {
  fs.rmSync(harness, { recursive: true, force: true })
}
