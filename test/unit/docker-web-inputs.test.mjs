import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = fileURLToPath(new URL('../../', import.meta.url))
const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8')

test('Docker ships the rebuilt console instead of compiling a second frontend', () => {
  assert.match(dockerfile, /^COPY web\/dist \.\/web\/dist$/m)
  assert.doesNotMatch(dockerfile, /^FROM .* AS web$|^RUN .*pnpm.*build/m)
  assert.match(dockerfile, /^COPY src \.\/src$/m)
  for (const asset of ['share/wrap-fixed', 'share/cc-fixed']) {
    assert.ok(dockerfile.includes(`COPY ${asset} `), `${asset} remains an image input`)
  }
})

test('ARM64 control image carries the same amd64 fixed/diagnostic slot payloads', () => {
  const arm = fs.readFileSync(path.join(root, 'deploy/Dockerfile.arm64-control'), 'utf8')
  for (const [source, target] of [
    ['share/wrap-fixed', 'image-wrap-fixed'],
    ['share/cc-fixed', 'image-cc-fixed'],
    ['share/crag/kin-kernel', 'image-crag/kin-kernel'],
  ]) {
    assert.ok(arm.includes(`COPY ${source} /opt/vm2api/${target}`))
    assert.ok(fs.existsSync(path.join(root, source)))
  }
  assert.match(arm, /DOCKER_DEFAULT_PLATFORM=linux\/amd64/)
})

test('a closed candidate round has no mandatory archive COPY in either image', () => {
  const round = JSON.parse(fs.readFileSync(path.join(root, 'src/lib/transport/offline-candidate-round.json')))
  assert.deepEqual(round.choices, [], 'an active round needs an explicit packaging review')
  for (const name of ['Dockerfile', 'deploy/Dockerfile.arm64-control']) {
    const content = fs.readFileSync(path.join(root, name), 'utf8')
    assert.doesNotMatch(content, /^COPY\s+share\/offline-candidates(?:\/|\s)/m, name)
    for (const line of content.split(/\r?\n/)) {
      if (!/^COPY\s/.test(line) || line.includes('--from=')) continue
      const sources = line.trim().split(/\s+/).slice(1, -1)
      for (const source of sources) assert.ok(fs.existsSync(path.join(root, source)), `${name}: missing ${source}`)
    }
  }
})

test('the shipped console is not excluded while private runtime/source directories stay excluded', () => {
  const ignore = fs.readFileSync(path.join(root, '.dockerignore'), 'utf8')
  assert.doesNotMatch(ignore, /^(?:web\/?|web\/dist\/?|\*\*\/dist\/?)$/m)
  for (const value of ['logs', 'vms', 'data', 'CLIProxyAPI', 'pi', 'skills']) {
    assert.ok(ignore.split(/\r?\n/).includes(value), `${value} is excluded`)
  }
})

for (const consumer of [
  'web/src/features/settings/logs-pane.tsx',
  'web/src/features/logs/current-candidates.test.tsx',
  'web/src/features/logs/raw-debug.test.tsx',
])
  test(`prebuild resolves the single shared JSON source for ${consumer}`, () => {
    const source = fs.readFileSync(path.join(root, consumer), 'utf8')
    const imports = [...source.matchAll(/\bfrom\s+['"]([^'"]+\.json)['"]/g)]
    assert.ok(imports.length > 0)
    for (const [, specifier] of imports) {
      const dependency = path.resolve(root, path.dirname(consumer), specifier)
      assert.equal(dependency, path.join(root, 'src/lib/transport/offline-candidate-round.json'))
      assert.ok(Array.isArray(JSON.parse(fs.readFileSync(dependency, 'utf8')).choices))
    }
  })

function consoleGraph() {
  const dist = path.join(root, 'web/dist')
  const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8')
  const queue = [...html.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css))["']/g)].map(([, value]) =>
    path.join(dist, value.replace(/^\//, '')),
  )
  assert.ok(queue.length > 0, 'built entry JS is referenced')
  const seen = new Set()
  let text = ''
  while (queue.length) {
    const file = path.resolve(queue.shift())
    if (seen.has(file)) continue
    assert.ok(file.startsWith(dist + path.sep), 'assets stay inside dist')
    assert.ok(seen.size < 512, 'bounded asset traversal')
    seen.add(file)
    const source = fs.readFileSync(file, 'utf8')
    text += source
    // Vite imports and its mapDeps table both use quoted local .js paths.
    for (const [, name] of source.matchAll(/["']([^"'\s]+\.js)["']/g)) {
      if (/^(?:https?:|data:)/.test(name)) continue
      const target =
        name.startsWith('/assets/') || name.startsWith('assets/')
          ? path.resolve(dist, name.replace(/^\//, ''))
          : path.resolve(path.dirname(file), name)
      if (target.startsWith(dist + path.sep) && fs.existsSync(target)) queue.push(target)
    }
  }
  return { files: [...seen, path.join(dist, 'index.html')], text }
}

test('the reachable prebuilt console contains fork diagnostics and fixed controls', () => {
  const { text } = consoleGraph()
  for (const marker of ['raw_nonstream_debug', 'cc_native_trace', 'cc-fixed', 'wrap-fixed']) {
    assert.ok(text.includes(marker), `prebuilt console misses ${marker}; rebuild from merged fork source`)
  }
})

test('reachable prebuilt assets must ship in Git, not only exist as local build residue', (t) => {
  let listed
  try {
    listed = execFileSync('git', ['ls-files', '-z', '--', 'web/dist'], { cwd: root, encoding: 'utf8' })
  } catch {
    t.skip('Source archive has no Git index; use the filesystem graph check')
    return
  }
  const tracked = new Set(listed.split('\0').filter(Boolean))
  for (const file of consoleGraph().files) {
    const relative = path.relative(root, file).split(path.sep).join('/')
    assert.ok(tracked.has(relative), `Missing from tracked build input: ${relative}`)
  }
})
