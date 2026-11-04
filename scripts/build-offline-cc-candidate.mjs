#!/usr/bin/env node
/** Current CC-only repair round. Prior candidates and approved wrap-fixed are immutable inputs. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inspectBunElf, sha256, verifyUnchangedOutside } from './build-offline-native-candidates.mjs'

export const CC_CANDIDATE_ID = 'native-v155-r3'
const R2_PACKED = '0c662e6464c302bede85ca65ac2d68745520ed00946eada8f4243d6082f87e96'
const requireThat = (ok, text) => {
  if (!ok) throw new Error(text)
}
const pad = (text, size) => {
  const body = Buffer.from(text)
  requireThat(body.length <= size, `Fixed native span overflow: ${body.length}/${size}`)
  return Buffer.concat([body, Buffer.alloc(size - body.length, 32)])
}
export function repairApiBindings(original, r2, manifest, r2Patches, minify) {
  requireThat(
    manifest.id === 'native-v155-r2' && manifest.artifacts['cc-node'].sha256 === R2_PACKED,
    'Wrong candidate input revision',
  )
  requireThat(sha256(original) === manifest.artifacts['cc-node'].source_unpacked_sha256, 'Wrong original CC bytes')
  requireThat(sha256(r2) === manifest.artifacts['cc-node'].unpacked_sha256, 'Wrong R2 CC bytes')
  verifyUnchangedOutside(original, r2, r2Patches)
  const graph = inspectBunElf(r2),
    source = graph.source.toString('utf8'),
    base = graph.modules[graph.entry].sourceOffset
  for (const anchor of ['function logForDebugging2(', 'var init_debug = __esm(', 'isDebugToStdErr2 = memoize_default('])
    requireThat(source.includes(anchor), `Missing original debug dependency: ${anchor}`)
  requireThat(!source.includes('function logForDebugging('), 'Unexpected unsuffixed logger definition')
  const start = source.indexOf('// src/services/api/client.ts\n'),
    end = source.indexOf('\n// ', start + 4)
  requireThat(start >= 0 && end > start, 'Missing client module')
  const before = source.slice(start, end)
  requireThat((before.match(/\blogForDebugging\(/g) || []).length === 4, 'Unexpected logger call count')
  requireThat((before.match(/\bisDebugToStdErr\(/g) || []).length === 4, 'Unexpected stderr call count')
  requireThat(before.includes('var init_client2 = __esm(() => {'), 'Missing client initializer')
  const fixed = before
    .replace(/\blogForDebugging\(/g, 'logForDebugging2(')
    .replace(/\bisDebugToStdErr\(/g, 'isDebugToStdErr2(')
    .replace('var init_client2 = __esm(() => {', 'var init_client2 = __esm(() => {\n  init_debug();')
  const after = minify(fixed).trim()
  for (const name of [
    'createStderrLogger',
    'getAnthropicClient',
    'configureApiKeyHeaders',
    'getCustomHeaders',
    'buildFetch',
  ])
    requireThat(after.includes(`function ${name}(`), `Client binding lost: ${name}`)
  requireThat(
    !/\blogForDebugging\(/.test(after) && !/\bisDebugToStdErr\(/.test(after),
    'Old API debug references remain',
  )
  const offset = base + Buffer.byteLength(source.slice(0, start)),
    size = Buffer.byteLength(before)
  requireThat(
    original.subarray(offset, offset + size).equals(Buffer.from(before)),
    'Client module was already modified',
  )
  const output = Buffer.from(r2),
    changed = pad(after, size)
  changed.copy(output, offset)
  const patches = r2Patches.map((p) => ({ ...p }))
  patches.push({
    id: 'connect-existing-api-debug-bindings',
    offset,
    bytes: size,
    replacement_bytes: Buffer.byteLength(after),
    before,
    after,
    before_sha256: sha256(Buffer.from(before)),
    after_sha256: sha256(changed),
  })
  const entry = patches.find((p) => p.id === 'offline-guard-and-cc-initialization')
  requireThat(entry && entry.after.includes('native-v155-r2'), 'Missing R2 entry guard')
  entry.after = entry.after.replace('native-v155-r2', CC_CANDIDATE_ID)
  const guarded = pad(entry.after, entry.bytes)
  entry.after_sha256 = sha256(guarded)
  entry.replacement_bytes = Buffer.byteLength(entry.after)
  guarded.copy(output, entry.offset)
  patches.sort((a, b) => a.offset - b.offset)
  verifyUnchangedOutside(original, output, patches)
  const next = inspectBunElf(output)
  requireThat(
    JSON.stringify({ ...graph, source: null }) === JSON.stringify({ ...next, source: null }),
    'ELF/Bun graph changed',
  )
  const debugStart = source.indexOf('function logForDebugging2('),
    debugEnd = source.indexOf('\nfunction getDebugLogPath()', debugStart)
  requireThat(debugStart >= 0 && debugEnd > debugStart, 'Logger source missing')
  const logFunction = source.slice(debugStart, debugEnd)
  const stderrStart = source.indexOf('isDebugToStdErr2 = memoize_default(() => {')
  const stderrEnd = source.indexOf('});', stderrStart) + 3
  requireThat(stderrStart >= 0 && stderrEnd > stderrStart, 'Missing stderr getter initializer')
  const stderrGetter = source.slice(stderrStart, stderrEnd)
  return {
    bytes: output,
    patches,
    graph: { ...next, source: undefined },
    debug: {
      log_function: logFunction,
      sha256: sha256(Buffer.from(logFunction)),
      stderr_getter: stderrGetter,
      stderr_sha256: sha256(Buffer.from(stderrGetter)),
      unchanged_from_r2: true,
    },
  }
}
const MINIFY =
  'const t=new Bun.Transpiler({loader:"js",target:"bun",minifyWhitespace:true,minifySyntax:false,minifyIdentifiers:false,deadCodeElimination:false,inline:false});process.stdout.write(t.transformSync(await Bun.stdin.text()));'
const SCAN =
  'const t=new Bun.Transpiler({loader:"js",target:"bun",deadCodeElimination:false,inline:false});const s=t.scan(await Bun.stdin.text());console.log(JSON.stringify({syntax:true,imports:s.imports.length,exports:s.exports.length}));'
export function buildCcCandidate({ root, output, evidence, upx, bun }) {
  requireThat(upx && bun, 'Explicit trusted UPX and Bun executables are required')
  const dir = path.resolve(output || path.join(root, 'share/offline-candidates', CC_CANDIDATE_ID))
  const target = path.join(dir, 'cc-node')
  requireThat(!fs.existsSync(target), 'Refusing to overwrite an existing candidate artifact')
  const run = (exe, args, opts = {}) =>
    execFileSync(exe, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 240000, ...opts })
  const minify = (text) => run(bun, ['-e', MINIFY], { input: text })
  const r2Dir = path.join(root, 'share/offline-candidates/native-v155-r2')
  const r2Manifest = JSON.parse(fs.readFileSync(path.join(r2Dir, 'manifest.json'), 'utf8'))
  const patchBytes = fs.readFileSync(path.join(r2Dir, 'patches.json'))
  requireThat(sha256(patchBytes) === r2Manifest.patches_sha256, 'R2 patch manifest mismatch')
  const src = path.join(root, 'share/wrap-cli/cc-node'),
    r2File = path.join(r2Dir, 'cc-node')
  requireThat(
    sha256(fs.readFileSync(src)) === r2Manifest.artifacts['cc-node'].source_packed_sha256,
    'Original CLI baseline changed',
  )
  requireThat(sha256(fs.readFileSync(r2File)) === R2_PACKED, 'R2 artifact changed')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-cc-candidate-'))
  try {
    const original = path.join(tmp, 'original'),
      r2 = path.join(tmp, 'r2'),
      modified = path.join(tmp, 'candidate'),
      roundtrip = path.join(tmp, 'roundtrip')
    run(upx, ['-d', '-o', original, src])
    run(upx, ['-d', '-o', r2, r2File])
    const result = repairApiBindings(
      fs.readFileSync(original),
      fs.readFileSync(r2),
      r2Manifest,
      JSON.parse(patchBytes)['cc-node'],
      minify,
    )
    const syntax = JSON.parse(run(bun, ['-e', SCAN], { input: inspectBunElf(result.bytes).source, timeout: 120000 }))
    requireThat(syntax.syntax === true, 'Full module syntax failed')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(modified, result.bytes, { mode: 0o555 })
    run(upx, ['--best', '--lzma', '-o', target, modified])
    const integrity = run(upx, ['-t', target])
    run(upx, ['-d', '-o', roundtrip, target])
    requireThat(fs.readFileSync(roundtrip).equals(result.bytes), 'UPX exact roundtrip failed')
    const manifest = structuredClone(r2Manifest),
      packed = fs.readFileSync(target)
    manifest.id = CC_CANDIDATE_ID
    manifest.execution_guard.value = CC_CANDIDATE_ID
    manifest.tools = { upx: run(upx, ['--version']).split(/\r?\n/)[0], syntax_minifier: run(bun, ['--version']).trim() }
    manifest.debug_dependencies = result.debug
    const artifact = manifest.artifacts['cc-node']
    Object.assign(artifact, {
      bytes: packed.length,
      sha256: sha256(packed),
      unpacked_bytes: result.bytes.length,
      unpacked_sha256: sha256(result.bytes),
      source_candidate_sha256: R2_PACKED,
      source_candidate_unpacked_sha256: r2Manifest.artifacts['cc-node'].unpacked_sha256,
      patches: result.patches.map(({ before, after, ...p }) => p),
    })
    artifact.validations.syntax = syntax
    manifest.local_validation = { completed: false, native_execution: false, user_capture_accepted: false }
    manifest.limitations = [
      'No new Linux native runtime acceptance yet',
      'Only the external API-client debug bindings are repaired; no logging is disabled',
      'Crag request framing remains unchanged',
      'Original/approved/r1/r2 artifacts are unchanged',
    ]
    const write = (name, value) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2) + '\n')
    write('patches.json', { 'cc-node': result.patches })
    manifest.patches_sha256 = sha256(fs.readFileSync(path.join(dir, 'patches.json')))
    write('manifest.json', manifest)
    const testFile = path.join(root, 'test/unit/native-cc-client.test.mjs')
    const log = run(process.execPath, ['--test', '--test-reporter=tap', testFile], {
      cwd: root,
      env: { ...process.env, NATIVE_CC_CANDIDATE_DIR: dir, NATIVE_CC_CLIENT_ORIGINAL: '0' },
    })
    const count = Number(log.match(/^# tests (\d+)$/m)?.[1])
    requireThat(
      count >= 8 && /^# fail 0$/m.test(log) && /^# skipped 0$/m.test(log),
      'API client behavior checks failed',
    )
    manifest.local_validation = {
      completed: true,
      native_execution: false,
      user_capture_accepted: false,
      behavior_tests: count,
      test_sha256: sha256(fs.readFileSync(testFile)),
      scope:
        'extracted API factory/fetch and real logger with controlled SDK/network/dependencies; not Linux ELF execution',
    }
    write('manifest.json', manifest)
    if (evidence) {
      fs.mkdirSync(evidence, { recursive: true })
      fs.copyFileSync(modified, path.join(evidence, 'cc-node.r3.unpacked'))
      fs.writeFileSync(path.join(evidence, 'upx-test.log'), integrity)
      fs.writeFileSync(path.join(evidence, 'api-client-tests.tap'), log)
    }
    return manifest
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2),
    opt = (key, fallback) => {
      const i = args.indexOf(key)
      return i < 0 ? fallback : args[i + 1]
    }
  const root = path.resolve(opt('--root', path.join(path.dirname(fileURLToPath(import.meta.url)), '..')))
  console.log(
    JSON.stringify(
      buildCcCandidate({
        root,
        output: opt('--output'),
        evidence: opt('--evidence'),
        upx: opt('--upx'),
        bun: opt('--bun'),
      }),
      null,
      2,
    ),
  )
}
