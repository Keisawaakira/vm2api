import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const posix = path.posix
const copies = []
let webStage = false
let workdir = '/'
let foundBuild = false
// Model only the plain COPY/WORKDIR forms used in this Dockerfile, up to the
// actual build. This is an input-path regression, not a Docker execution test.
for (const raw of fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8').split(/\r?\n/)) {
  const line = raw.trim()
  if (/^FROM\s/i.test(line)) {
    if (webStage) break
    webStage = /\sAS\s+web$/i.test(line)
  }
  if (!webStage) continue
  if (/^RUN\s+pnpm\s+build$/i.test(line)) {
    foundBuild = true
    break
  }
  if (/^WORKDIR\s/i.test(line)) workdir = posix.resolve(workdir, line.slice(8).trim())
  if (/^COPY\s/i.test(line)) {
    const args = line.slice(5).trim().split(/\s+/)
    assert.ok(!args.some((arg) => arg.startsWith('--') || /[\[\]"]/.test(arg)), 'Review new COPY syntax in this test')
    const destination = args.pop()
    for (const source of args) copies.push({ source: posix.normalize(source), destination, workdir })
  }
}
assert.ok(foundBuild, 'web build instruction must be covered')
function imageLocations(file) {
  return copies.flatMap(({ source, destination, workdir }) => {
    const isDirectory = fs.statSync(path.join(root, source)).isDirectory()
    if (!isDirectory) {
      if (source !== file) return []
      return [posix.resolve(workdir, destination, destination.endsWith('/') ? posix.basename(source) : '')]
    }
    const relative = posix.relative(source, file)
    if (relative === '..' || relative.startsWith('../') || posix.isAbsolute(relative)) return []
    return [posix.resolve(workdir, destination, relative)]
  })
}
for (const consumer of [
  'web/src/features/settings/logs-pane.tsx',
  'web/src/features/logs/current-candidates.test.tsx',
  'web/src/features/logs/raw-debug.test.tsx',
]) {
  test(`web stage supplies JSON imports for ${consumer}`, () => {
    const code = fs.readFileSync(path.join(root, consumer), 'utf8')
    const imports = [...code.matchAll(/\bfrom\s+['"](\.[^'"]+\.json)['"]/g)]
    assert.ok(imports.length > 0, 'shared catalog import must be exercised')
    const consumerLocations = imageLocations(consumer)
    assert.ok(consumerLocations.length > 0, 'consumer is copied before build')
    for (const [, specifier] of imports) {
      const dependency = posix.normalize(posix.join(posix.dirname(consumer), specifier))
      for (const location of consumerLocations) {
        const resolved = posix.resolve(posix.dirname(location), specifier)
        assert.ok(
          imageLocations(dependency).includes(resolved),
          `Missing build input: ${dependency} must exist at ${resolved}`,
        )
      }
    }
  })
}
