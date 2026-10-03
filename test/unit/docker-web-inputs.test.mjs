import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8')

test('Docker ships the rebuilt console instead of compiling a second frontend', () => {
  assert.match(dockerfile, /^COPY web\/dist \.\/web\/dist$/m)
  assert.doesNotMatch(dockerfile, /^FROM .* AS web$|^RUN .*pnpm.*build/m)
  assert.match(dockerfile, /^COPY src \.\/src$/m)
  for (const asset of ['share/wrap-fixed', 'share/cc-fixed', 'share/offline-candidates']) {
    assert.ok(dockerfile.includes(`COPY ${asset} `), `${asset} remains an image input`)
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

test('the reachable prebuilt console contains fork diagnostics and fixed controls', () => {
  const dist = path.join(root, 'web/dist')
  const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8')
  const queue = [...html.matchAll(/(?:src|href)=["']([^"']+\.js)["']/g)].map(([, value]) =>
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
  for (const marker of ['raw_nonstream_debug', 'cc_native_trace', 'cc-fixed', 'wrap-fixed']) {
    assert.ok(text.includes(marker), `prebuilt console misses ${marker}; rebuild from merged fork source`)
  }
})
