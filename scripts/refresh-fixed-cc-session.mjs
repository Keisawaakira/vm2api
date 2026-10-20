#!/usr/bin/env node
/** Carry the real upstream job-session dependency into CC; kernel/cache remain untouched. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { inspectBunElf, sha256, verifyUnchangedOutside } from './build-offline-native-candidates.mjs'
import { sourceRange, sourceFunction } from './refresh-fixed-cli-lifecycle.mjs'

export const CC_SESSION_BASE = Object.freeze({
  id: 'cc-fixed-v196-r1',
  file: 'cc-node',
  input: 'share/cc-fixed/v194-r1/cc-node',
  packed: 'ac6d4848435708eb00555308daa37bf437d40596ef99427ec417e93bc8daec8b',
  unpacked: '158ad607b58cc819ee5cd3527100396aa0ed3e7e1b1920b89b951ab4c5768433',
  reference: 'share/wrap-cli/cli-node',
  reference_packed: 'c711a9660d59fd1833e207a34782331f3b65d5d7a0f644880bb26e77e15d7ff1',
})
const ensure = (condition, message) => {
  if (!condition) throw new Error(message)
}
const json = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n')
const once = (source, from, to) => {
  ensure(source.split(from).length === 2, 'Expected one anchor: ' + from)
  return source.replace(from, to)
}
const intrinsics = new Set([
  'process',
  'Array',
  'String',
  'Number',
  'JSON',
  'Error',
  'Date',
  'Object',
  'Set',
  'Map',
  'Boolean',
  'Promise',
  'AbortController',
  'Headers',
  'Buffer',
  'Uint8Array',
  'console',
  'setTimeout',
  'clearTimeout',
  'performance',
  'globalThis',
  'Bun',
  'Infinity',
  'undefined',
  'NaN',
  'Symbol',
  'RegExp',
  'Math',
  'WeakMap',
  'WeakSet',
  'TextEncoder',
  'TextDecoder',
  'URL',
  'URLSearchParams',
  'require',
  'fetch',
  'structuredClone',
  'AbortSignal',
  'queueMicrotask',
])

/** Maintainer-only full-module scope audit, using the already installed frontend ESLint parser. */
export function auditNativeBindings(source, root) {
  const fromWeb = createRequire(path.join(root, 'web/package.json'))
  const fromEslint = createRequire(fromWeb.resolve('eslint'))
  const ast = fromEslint('espree').parse(source, { ecmaVersion: 'latest', sourceType: 'module', range: true })
  const manager = fromEslint('eslint-scope').analyze(ast, {
    ecmaVersion: 2024,
    sourceType: 'module',
    optimistic: true,
    ignoreEval: true,
  })
  const start = source.indexOf('// src/kin/stdioProtocol.ts'),
    end = source.indexOf('// src/kin/slotPool.ts', start)
  ensure(start >= 0 && end > start, 'Missing native region')
  const refs = manager.globalScope.through.filter((ref) => !intrinsics.has(ref.identifier.name))
  const native = [
    ...new Set(
      refs
        .filter((ref) => ref.identifier.range[0] >= start && ref.identifier.range[0] < end)
        .map((ref) => ref.identifier.name),
    ),
  ].sort()
  const module = manager.scopes.find((scope) => scope.type === 'module')
  return {
    native_unresolved: native,
    whole_unresolved: [...new Set(refs.map((ref) => ref.identifier.name))].sort(),
    session_bindings: ['init_jobSession', 'getJobSessionId', 'runWithJobSession', 'AsyncLocalStorage'].map((name) => ({
      name,
      declared: module.variables.some((v) => v.name === name),
    })),
  }
}

export function patchCCSessionBytes(original, reference, minify) {
  ensure(sha256(original) === CC_SESSION_BASE.unpacked, 'Unknown CC session baseline')
  const graph = inspectBunElf(original),
    source = graph.source.toString('utf8')
  const origin = graph.modules[graph.entry].sourceOffset
  ensure(Buffer.from(source).equals(graph.source), 'Lossy source decoding')
  ensure(
    source.includes('import { AsyncLocalStorage } from "async_hooks";'),
    'Missing existing real AsyncLocalStorage import',
  )
  const jobModule = sourceRange(reference, '// src/bootstrap/jobSession.ts', '// src/bootstrap/state.ts').text
  const helper = once(jobModule, 'import { AsyncLocalStorage } from "async_hooks";', '').replace(
    /\bstorage\b/g,
    '__vm2apiJobSessionStorage',
  )
  ensure(!source.includes('__vm2apiJobSessionStorage'), 'Job storage name already exists')
  for (const name of ['init_jobSession', 'getJobSessionId', 'runWithJobSession'])
    ensure(source.split(name).length === 2, 'Unexpected existing dependency: ' + name)
  const changes = []
  const add = (id, selected, after) => {
    const before = Buffer.from(selected.text),
      next = Buffer.from(after)
    ensure(next.length <= before.length, `${id} exceeds fixed span ${next.length}/${before.length}`)
    const offset = origin + Buffer.byteLength(source.slice(0, selected.start))
    ensure(original.subarray(offset, offset + before.length).equals(before), 'Wrong source interval')
    changes.push({
      id,
      offset,
      bytes: before.length,
      replacement_bytes: next.length,
      before: selected.text,
      after,
      before_sha256: sha256(before),
      after_sha256: sha256(Buffer.concat([next, Buffer.alloc(before.length - next.length, 32)])),
    })
  }
  // The export map is pure binding setup. Its whitespace pays for the missing module,
  // placed BEFORE any state initializer can invoke it; do not add late initialization.
  const exports = sourceRange(source, '// src/bootstrap/state.ts', '\nfunction getInitialState()')
  const minExports = minify(exports.text).trim() + ';'
  add('complete-job-session-bootstrap', exports, minify(helper).trim() + ';\n// src/bootstrap/state.ts\n' + minExports)
  const getters = sourceRange(source, 'function getSessionId()', 'function getParentSessionId()')
  const getter = sourceFunction(source, 'getSessionId').text
  const updated = once(
    getters.text,
    getter,
    once(getter, 'return STATE.sessionId;', 'return getJobSessionId() || STATE.sessionId;'),
  )
  add('read-active-job-session', getters, minify(updated).trim() + '\n')
  const initializer = sourceRange(source, 'var init_state = __esm(() => {', '// src/constants/keys.ts')
  add(
    'initialize-job-session-with-state',
    initializer,
    minify(once(initializer.text, '  init_sumBy();', '  init_jobSession();\n  init_sumBy();')).trim() + ';\n',
  )
  changes.sort((a, b) => a.offset - b.offset)
  const bytes = Buffer.from(original)
  let end = origin
  for (const p of changes) {
    ensure(p.offset >= end && p.offset + p.bytes <= origin + graph.source.length, 'Overlapping/non-source patch')
    Buffer.concat([Buffer.from(p.after), Buffer.alloc(p.bytes - p.replacement_bytes, 32)]).copy(bytes, p.offset)
    end = p.offset + p.bytes
  }
  verifyUnchangedOutside(original, bytes, changes)
  const after = inspectBunElf(bytes),
    final = after.source.toString('utf8')
  ensure(
    JSON.stringify({ ...graph, source: null }) === JSON.stringify({ ...after, source: null }),
    'Bun/ELF graph changed',
  )
  const getterAfter = sourceFunction(final, 'regenerateSessionId').text
  ensure(
    minify(sourceFunction(source, 'regenerateSessionId').text).trim() === minify(getterAfter).trim(),
    'Adjacent regenerateSessionId changed',
  )
  const finalExports = sourceRange(final, '// src/bootstrap/state.ts', 'function getInitialState()').text
  ensure(
    minify(exports.text).trim().replace(/;+$/, '') === minify(finalExports).trim().replace(/;+$/, ''),
    'State export mapping changed',
  )
  const semantics = {
    helper: sourceRange(final, 'function getJobSessionId()', '// src/bootstrap/state.ts').text,
    getter: sourceFunction(final, 'getSessionId').text,
    regenerate: getterAfter,
    regenerate_before: sourceFunction(source, 'regenerateSessionId').text,
    state_initializer: sourceRange(final, 'var init_state=', '// src/constants/keys.ts').text,
    native_initializer: sourceRange(final, 'var init_nativeMessagesRunner=', '// src/kin/slotPool.ts').text,
    api_metadata: sourceFunction(final, 'getAPIMetadata').text,
  }
  return { bytes, changes, semantics, source_before: source, source_after: final }
}

export async function buildFixedCCSession({ root, outputRoot, evidence, upx, bun, verify }) {
  ensure(root && outputRoot && evidence && upx && bun && verify, 'Explicit build inputs/verifier required')
  const run = (bin, args, options = {}) =>
    execFileSync(bin, args, { encoding: 'utf8', timeout: 300000, maxBuffer: 32 * 1024 * 1024, ...options })
  const minify = (source) =>
    run(
      bun,
      [
        '-e',
        'const t=new Bun.Transpiler({loader:"js",target:"bun",minifyWhitespace:true,minifySyntax:false,minifyIdentifiers:false,deadCodeElimination:false,inline:false});process.stdout.write(t.transformSync(await Bun.stdin.text()))',
      ],
      { input: source },
    )
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-session-build-'))
  fs.mkdirSync(evidence, { recursive: true })
  try {
    const input = path.join(root, CC_SESSION_BASE.input),
      reference = path.join(root, CC_SESSION_BASE.reference)
    ensure(sha256(fs.readFileSync(input)) === CC_SESSION_BASE.packed, 'Unknown packed CC')
    ensure(
      sha256(fs.readFileSync(reference)) === CC_SESSION_BASE.reference_packed,
      'Unknown upstream session reference',
    )
    run(upx, ['-d', '-o', path.join(temp, 'cc'), input])
    run(upx, ['-d', '-o', path.join(temp, 'wrap'), reference])
    const before = fs.readFileSync(path.join(temp, 'cc'))
    const donor = inspectBunElf(fs.readFileSync(path.join(temp, 'wrap'))).source.toString('utf8')
    const result = patchCCSessionBytes(before, donor, minify)
    const auditBefore = auditNativeBindings(result.source_before, root),
      auditAfter = auditNativeBindings(result.source_after, root)
    ensure(
      JSON.stringify(auditBefore.native_unresolved) ===
        JSON.stringify(['getJobSessionId', 'init_jobSession', 'runWithJobSession']),
      'Baseline dependency diagnosis changed',
    )
    ensure(
      auditAfter.native_unresolved.length === 0 && auditAfter.session_bindings.every((x) => x.declared),
      'Unresolved native dependency remains',
    )
    ensure(
      auditAfter.whole_unresolved.every((name) => auditBefore.whole_unresolved.includes(name)),
      'New unresolved reference introduced elsewhere',
    )
    const parentDir = path.dirname(input),
      parent = JSON.parse(fs.readFileSync(path.join(parentDir, 'manifest.json'), 'utf8'))
    const previous = JSON.parse(fs.readFileSync(path.join(parentDir, 'semantics.json'), 'utf8'))
    const behavior = await verify(result.semantics, previous)
    ensure(behavior.ok && behavior.checks > 0, 'Bootstrap/session controls failed')
    const syntax = JSON.parse(
      run(
        bun,
        [
          '-e',
          'const t=new Bun.Transpiler({loader:"js",target:"bun"});t.scan(await Bun.stdin.text());console.log(JSON.stringify({syntax:true}))',
        ],
        { input: inspectBunElf(result.bytes).source },
      ),
    )
    const inherited = [...parent.inherited_repairs, ...parent.artifacts['cc-node'].patches].map((p) => {
      ensure(
        sha256(before.subarray(p.offset, p.offset + p.bytes)) === p.after_sha256,
        'Unknown previous repair ' + p.id,
      )
      ensure(
        !result.changes.some((q) => q.offset < p.offset + p.bytes && p.offset < q.offset + q.bytes),
        'Unexpected overlap ' + p.id,
      )
      ensure(
        sha256(result.bytes.subarray(p.offset, p.offset + p.bytes)) === p.after_sha256,
        'Previous repair changed ' + p.id,
      )
      return { ...p, previous_after_sha256: p.after_sha256, preserved: true }
    })
    const dir = path.join(outputRoot, 'cc-fixed/v196-r1')
    ensure(!fs.existsSync(dir), 'Refusing existing output')
    fs.mkdirSync(dir, { recursive: true })
    const raw = path.join(temp, 'patched'),
      packed = path.join(dir, 'cc-node'),
      again = path.join(temp, 'roundtrip')
    fs.writeFileSync(raw, result.bytes)
    run(upx, ['--best', '--lzma', '-o', packed, raw])
    run(upx, ['-t', packed])
    run(upx, ['-d', '-o', again, packed])
    ensure(fs.readFileSync(again).equals(result.bytes), 'Unpack roundtrip changed bytes')
    const patchedBytes = fs.readFileSync(packed)
    const patches = json({ 'cc-node': result.changes })
    const semantics = json({
      ...previous,
      session: result.semantics,
      lifecycle: {
        ...previous.lifecycle,
        native: result.semantics.helper + '\n' + previous.lifecycle.native,
        native_fragments: [result.semantics.helper + '\n' + previous.lifecycle.native],
      },
      classifier: { ...previous.classifier, native: result.semantics.helper + '\n' + previous.classifier.native },
    })
    const artifact = {
      file: 'cc-node',
      bytes: patchedBytes.length,
      sha256: sha256(patchedBytes),
      unpacked_bytes: result.bytes.length,
      unpacked_sha256: sha256(result.bytes),
      source_packed_sha256: CC_SESSION_BASE.packed,
      source_unpacked_sha256: CC_SESSION_BASE.unpacked,
      validations: {
        elf_graph: true,
        no_bytecode: true,
        unchanged_outside_js_spans: true,
        syntax,
        native_bindings_resolved: true,
        upx_integrity: true,
        exact_unpack_roundtrip: true,
      },
      patches: result.changes.map(({ before, after, ...p }) => p),
    }
    const manifest = {
      ...parent,
      id: CC_SESSION_BASE.id,
      approval: {
        date: '2026-10-03',
        basis: 'owner-authorized locally verified fixed CLI maintenance',
        scope: 'CLI bootstrap/session repair; not complete Linux/cloud certification',
      },
      lineage: {
        ...parent.lineage,
        source_file: CC_SESSION_BASE.input,
        source_sha256: CC_SESSION_BASE.packed,
        previous_release: parent.id,
        session_reference_commit: '1b735bf',
      },
      session_contract: 'native_job_session_v1',
      artifacts: { 'cc-node': artifact },
      inherited_repairs: inherited,
      patches_sha256: sha256(patches),
      semantics_sha256: sha256(semantics),
      tools: { upx: run(upx, ['--version']).split(/\r?\n/)[0], bun: run(bun, ['--version']).trim() },
      local_validation: {
        completed: true,
        native_execution: false,
        behavior_tests: behavior.checks,
        full_source_scope_audit: auditAfter,
        scope: 'real AsyncLocalStorage/bootstrap functions + full-module bindings and packing; not Linux ELF/cloud',
      },
    }
    fs.writeFileSync(path.join(dir, 'manifest.json'), json(manifest))
    fs.writeFileSync(path.join(dir, 'patches.json'), patches)
    fs.writeFileSync(path.join(dir, 'semantics.json'), semantics)
    fs.writeFileSync(path.join(evidence, 'cc.unpacked'), result.bytes)
    fs.writeFileSync(path.join(evidence, 'binding-audit.json'), json({ before: auditBefore, after: auditAfter }))
    return { id: manifest.id, ...artifact, behavior }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const arg = (name) => {
    const i = process.argv.indexOf(name)
    return i < 0 ? undefined : process.argv[i + 1]
  }
  const { verifyCCSessionSource } = await import('../test/support/fixed-cc-session-controls.mjs')
  console.log(
    JSON.stringify(
      await buildFixedCCSession({
        root: arg('--root'),
        outputRoot: arg('--output'),
        evidence: arg('--evidence'),
        upx: arg('--upx'),
        bun: arg('--bun'),
        verify: verifyCCSessionSource,
      }),
      null,
      2,
    ),
  )
}
