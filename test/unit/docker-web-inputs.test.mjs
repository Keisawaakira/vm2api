import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = fileURLToPath(new URL('../../', import.meta.url))
const images = ['Dockerfile', 'deploy/Dockerfile.arm64-control']
const shared = 'src/lib/transport/offline-candidate-round.json'

function webStage(name) {
  const content = fs.readFileSync(path.join(root, name), 'utf8')
  const stage = content.match(/^FROM .* AS web\r?\n([\s\S]*?)(?=^FROM |$(?![\s\S]))/m)?.[1]
  assert.ok(stage, `${name}: source-built web stage`)
  const workdir = stage.match(/^WORKDIR\s+(\S+)/m)?.[1]
  assert.ok(workdir)
  const copies = []
  for (const line of stage.split(/\r?\n/)) {
    if (!line.startsWith('COPY ')) continue
    const args = line.trim().split(/\s+/).slice(1)
    const dest = args.pop()
    for (const source of args) {
      const target = dest.endsWith('/') || args.length > 1 ? path.posix.join(dest, path.posix.basename(source)) : dest
      copies.push({ source, target: path.posix.resolve(workdir, target) })
    }
  }
  return { content, stage, workdir, copies }
}

for (const name of images) {
  test(`${name} builds merged web/Go source, fetches original payload, keeps fixed packages separate`, () => {
    const { content, stage } = webStage(name)
    assert.match(stage, /^COPY web\/ \.\/$/m)
    assert.match(stage, /^RUN pnpm build$/m)
    assert.match(content, /^COPY --from=web \/src\/web\/dist \.\/web\/dist$/m)
    assert.doesNotMatch(content, /^COPY web\/dist /m)
    assert.match(content, /\/out\/kin-worker/)
    assert.match(content, /\/out\/kin-egress/)
    assert.match(content, /^COPY docker\/kin-kvm \.\/docker\/kin-kvm$/m)
    assert.match(content, /^COPY deploy\/payload.json deploy\/payload.json$/m)
    assert.match(content, /^RUN node scripts\/fetch-payload.mjs --dest \/payload$/m)
    assert.match(content, /^COPY --from=payload \/payload\/share\/crag\/ \/opt\/vm2api\/image-crag\/$/m)
    for (const asset of ['share/wrap-fixed', 'share/cc-fixed']) {
      assert.ok(content.includes(`COPY ${asset} `), `${asset} remains a distinct image input`)
      assert.ok(fs.existsSync(path.join(root, asset)))
    }
  })
  for (const consumer of [
    'web/src/features/settings/logs-pane.tsx',
    'web/src/features/logs/current-candidates.test.tsx',
    'web/src/features/logs/raw-debug.test.tsx',
  ]) {
    test(`${name} copies the single shared JSON at the path resolved by ${consumer}`, () => {
      const { stage, workdir, copies } = webStage(name)
      const source = fs.readFileSync(path.join(root, consumer), 'utf8')
      const imports = [...source.matchAll(/\bfrom\s+['"]([^'"]+\.json)['"]/g)]
      assert.ok(imports.length > 0)
      for (const [, specifier] of imports) {
        assert.equal(path.resolve(root, path.dirname(consumer), specifier), path.join(root, shared))
        const imageFile = path.posix.join(workdir, consumer.slice('web/'.length))
        const resolved = path.posix.resolve(path.posix.dirname(imageFile), specifier)
        assert.ok(
          copies.some((copy) => copy.source === shared && copy.target === resolved),
          `${name}: ${resolved} is missing before pnpm build`,
        )
        assert.ok(stage.indexOf(`COPY ${shared} `) < stage.indexOf('RUN pnpm build'))
      }
    })
  }
}

test('closed diagnostic rounds are not required and every literal COPY source exists', () => {
  const round = JSON.parse(fs.readFileSync(path.join(root, shared)))
  assert.deepEqual(round.choices, [], 'a new active round requires explicit image integration')
  for (const name of images) {
    const content = fs.readFileSync(path.join(root, name), 'utf8')
    assert.doesNotMatch(content, /^COPY\s+share\/offline-candidates(?:\/|\s)/m)
    for (const line of content.split(/\r?\n/)) {
      if (!line.startsWith('COPY ') || line.includes('--from=')) continue
      for (const source of line.trim().split(/\s+/).slice(1, -1))
        assert.ok(fs.existsSync(path.join(root, source)), `${name}: missing ${source}`)
    }
  }
})

test('Docker excludes private trees and ignored output, not merged source or fixed packages', () => {
  const lines = fs.readFileSync(path.join(root, '.dockerignore'), 'utf8').split(/\r?\n/)
  for (const value of ['bin', 'web/dist', 'logs', 'vms', 'data', 'CLIProxyAPI', 'pi', 'skills', '.pi-subagents'])
    assert.ok(lines.includes(value), `${value} must stay out of build context`)
  for (const value of ['web', 'src', 'worker', 'share/wrap-fixed', 'share/cc-fixed'])
    assert.ok(!lines.includes(value), `${value} remains an input`)
})

test('original payload manifest is pinned and fixed packages are not overwritten by it', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'deploy/payload.json')))
  assert.equal(typeof manifest.release, 'string')
  assert.ok(manifest.files.length >= 10)
  for (const file of manifest.files) {
    assert.match(file.sha256, /^[a-f0-9]{64}$/)
    assert.ok(Number.isSafeInteger(file.size) && file.size > 0)
    assert.doesNotMatch(file.path, /(?:cc|wrap)-fixed/)
  }
  const core = manifest.files.find((file) => file.path === 'bin/kin-kernel')
  const sample = manifest.files.find((file) => file.path === 'share/wrap-cli/kin-kernel.bin')
  assert.equal(core.sha256, sample.sha256)
})

test('upstream-generated output stays out of Git while the fixed packages remain tracked', (t) => {
  let generated
  try {
    generated = execFileSync('git', ['ls-files', '-z', '--', 'web/dist', 'bin'], { cwd: root, encoding: 'utf8' })
  } catch {
    t.skip('Source archive has no Git index; COPY/build graph is checked independently')
    return
  }
  assert.equal(generated, '')
  const fixed = execFileSync('git', ['ls-files', '--', 'share/wrap-fixed', 'share/cc-fixed'], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.match(fixed, /share\/wrap-fixed\/[^/]+\/cli-node\r?\n/)
  assert.match(fixed, /share\/cc-fixed\/[^/]+\/cc-node\r?\n/)
})

function consoleGraph(dist) {
  const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8')
  const queue = [...html.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css))["']/g)].map(([, value]) =>
    path.join(dist, value.replace(/^\//, '')),
  )
  assert.ok(queue.length > 0)
  const seen = new Set()
  let text = ''
  while (queue.length) {
    const file = path.resolve(queue.shift())
    if (seen.has(file)) continue
    assert.ok(file.startsWith(dist + path.sep))
    assert.ok(seen.size < 512)
    seen.add(file)
    const source = fs.readFileSync(file, 'utf8')
    text += source
    for (const [, name] of source.matchAll(/["']([^"'\s]+\.js)["']/g)) {
      if (/^(?:https?:|data:)/.test(name)) continue
      const target =
        name.startsWith('/assets/') || name.startsWith('assets/')
          ? path.resolve(dist, name.replace(/^\//, ''))
          : path.resolve(path.dirname(file), name)
      if (target.startsWith(dist + path.sep) && fs.existsSync(target)) queue.push(target)
    }
  }
  return { text, files: [...seen] }
}
const dist = path.resolve(process.env.VM2API_WEB_DIST || path.join(root, 'web/dist'))
test('fresh built console contains fork diagnostics and fixed controls', {
  skip:
    !process.env.VM2API_WEB_DIST && !fs.existsSync(path.join(dist, 'index.html'))
      ? 'Source checkout: run build:web or provide VM2API_WEB_DIST for build verification'
      : false,
}, () => {
  const { text } = consoleGraph(dist)
  for (const marker of ['raw_nonstream_debug', 'cc_native_trace', 'cc-fixed', 'wrap-fixed'])
    assert.ok(text.includes(marker), `built console misses ${marker}`)
})
