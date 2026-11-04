#!/usr/bin/env node
/** v1.3.102: carry only upstream's format-independent classifier gate into fixed CLIs. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { inspectBunElf, sha256, verifyUnchangedOutside } from './build-offline-native-candidates.mjs'
import { sourceFunction } from './refresh-fixed-cli-lifecycle.mjs'
import { auditNativeBindings } from './refresh-fixed-cc-session.mjs'

export const VERDICT_BASES = Object.freeze({
  wrap: {
    id: 'wrap-fixed-v1102-r1',
    file: 'cli-node',
    input: 'share/wrap-fixed/v194-r1/cli-node',
    packed: '4a9e49c02f4c06e52c2f2ebce1aa6097f43b44b6bcf54c01e9e8c82c802665a7',
    unpacked: 'cc126b04d55222ab0e2158a8eb2dd76b870b89e0977c517e758d136caed994c0',
  },
  cc: {
    id: 'cc-fixed-v1102-r1',
    file: 'cc-node',
    input: 'share/cc-fixed/v196-r1/cc-node',
    packed: '393826e6543dec018bcebbbcd52f8579ce8bb6ad66768c8a4bf7cf9ae28142a9',
    unpacked: 'd458505eee26a000878cab3bc9bcc846a7bf04f2ad9b4356a3a300c2f5c6a6a6',
  },
})
export const VERDICT_REFERENCE = '72714299db914432158d7832a3c4fb9aef2e481d444b8a3ff49b8c0f603101dd'
const gate = /\s*&&\s*\(JSON\.stringify\(([\w$]+)\.system\)\s*\|\|\s*""\)\.includes\("<block>"\)/g
const ensure = (value, message) => {
  if (!value) throw Error(message)
}
const json = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n')
const updateText = (text) => text.replace(gate, (match) => ' '.repeat(match.length))
function updateSemantics(value) {
  if (typeof value === 'string') return updateText(value)
  if (Array.isArray(value)) return value.map(updateSemantics)
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, updateSemantics(v)]))
  return value
}
export function patchVerdictBytes(original, kind) {
  const base = VERDICT_BASES[kind]
  ensure(sha256(original) === base.unpacked, 'Unknown fixed source ' + kind)
  const graph = inspectBunElf(original),
    source = graph.source.toString('utf8')
  ensure(Buffer.from(source).equals(graph.source), 'Lossy source')
  const matches = [...source.matchAll(gate)]
  ensure(matches.length === 1, 'Expected one classifier verdict gate')
  const match = matches[0],
    origin = graph.modules[graph.entry].sourceOffset
  const offset = origin + Buffer.byteLength(source.slice(0, match.index)),
    before = Buffer.from(match[0]),
    after = Buffer.alloc(before.length, 32)
  const enclosing =
    kind === 'wrap'
      ? sourceFunction(source, 'validClassifierContext').text
      : source.slice(source.indexOf('var __vm2apiClassifier194='), source.indexOf('var __vm2apiClassifier194=') + 2000)
  ensure(enclosing.includes(match[0]), 'Gate is outside classifier validation')
  const patch = {
    id: 'classifier-format-independent',
    offset,
    bytes: before.length,
    replacement_bytes: after.length,
    before: match[0],
    after: after.toString(),
    before_sha256: sha256(before),
    after_sha256: sha256(after),
  }
  const bytes = Buffer.from(original)
  after.copy(bytes, offset)
  verifyUnchangedOutside(original, bytes, [patch])
  const decoded = inspectBunElf(bytes)
  ensure(
    JSON.stringify({ ...graph, source: null }) === JSON.stringify({ ...decoded, source: null }),
    'ELF graph changed',
  )
  return { bytes, patch, sourceBefore: source, sourceAfter: decoded.source.toString('utf8') }
}

export async function buildFixedVerdict({ root, outputRoot, evidence, upx, bun, verify }) {
  ensure(root && outputRoot && evidence && upx && bun && verify, 'Explicit build inputs and verifier required')
  const run = (bin, args, opts = {}) =>
    execFileSync(bin, args, { encoding: 'utf8', timeout: 300000, maxBuffer: 32 * 1024 * 1024, ...opts })
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-verdict-'))
  fs.mkdirSync(evidence, { recursive: true })
  try {
    const ref = path.join(root, 'share/wrap-cli/cli-node')
    ensure(sha256(fs.readFileSync(ref)) === VERDICT_REFERENCE, 'Unknown upstream reference')
    ensure(
      sha256(fs.readFileSync(path.join(root, 'share/wrap-cli/cc-node'))) ===
        'be5eec49a78345dd935e302e88c9d7ad0afbb09a195356d81be1bdea766f3960',
      'Original CC changed',
    )
    run(upx, ['-d', '-o', path.join(temp, 'reference'), ref])
    const reference = inspectBunElf(fs.readFileSync(path.join(temp, 'reference'))).source.toString('utf8')
    const referenceValidator = sourceFunction(reference, 'validClassifierContext').text
    ensure(!referenceValidator.includes('.includes("<block>")'), 'Reference still gates verdict text')
    const results = []
    for (const [kind, base] of Object.entries(VERDICT_BASES)) {
      const input = path.join(root, base.input)
      ensure(sha256(fs.readFileSync(input)) === base.packed, 'Unknown packed fixed ' + kind)
      const raw = path.join(temp, kind + '-before')
      run(upx, ['-d', '-o', raw, input])
      const original = fs.readFileSync(raw)
      const patched = patchVerdictBytes(original, kind),
        parentDir = path.dirname(input)
      const parent = JSON.parse(fs.readFileSync(path.join(parentDir, 'manifest.json'), 'utf8'))
      const previous = JSON.parse(fs.readFileSync(path.join(parentDir, 'semantics.json'), 'utf8'))
      const sem = updateSemantics(previous)
      sem.verdict = {
        before_helpers: previous.classifier.classifierHelpers,
        reference_helpers: referenceValidator,
        disk_invalidation: sourceFunction(patched.sourceAfter, 'invalidateOAuthCacheIfDiskChanged').text,
        refresh_impl: sourceFunction(patched.sourceAfter, 'checkAndRefreshOAuthTokenIfNeededImpl').text,
      }
      if (kind === 'cc')
        ensure(
          patched.sourceAfter.includes(sem.classifier.classifierHelpers),
          'Semantic helper is not actual patched source',
        )
      else
        for (const name of ['validClassifierContext', 'classifierSystemBlocks'])
          ensure(
            sourceFunction(patched.sourceAfter, name).text.trim() ===
              sourceFunction(sem.classifier.classifierHelpers, name).text.trim(),
            'Semantic function differs: ' + name,
          )
      const auditBefore = auditNativeBindings(patched.sourceBefore, root),
        auditAfter = auditNativeBindings(patched.sourceAfter, root)
      ensure(auditAfter.native_unresolved.length === 0, 'Unresolved native bindings')
      ensure(JSON.stringify(auditBefore) === JSON.stringify(auditAfter), 'Scope bindings changed')
      const behavior = await verify(sem, kind)
      ensure(behavior.ok && behavior.checks > 0, 'Source controls failed')
      const syntax = JSON.parse(
        run(
          bun,
          [
            '-e',
            'new Bun.Transpiler({loader:"js",target:"bun"}).scan(await Bun.stdin.text());console.log(JSON.stringify({syntax:true}))',
          ],
          { input: inspectBunElf(patched.bytes).source },
        ),
      )
      const repairs = [...(parent.inherited_repairs || []), ...parent.artifacts[base.file].patches].map((p) => {
        ensure(
          sha256(original.subarray(p.offset, p.offset + p.bytes)) === p.after_sha256,
          'Invalid inherited patch ' + p.id,
        )
        const overlap =
          p.offset < patched.patch.offset + patched.patch.bytes && patched.patch.offset < p.offset + p.bytes
        ensure(
          !overlap ||
            (kind === 'cc' && ['classifier-native-context-dispatch', 'native-cancel-ping-errors'].includes(p.id)),
          'Unexpected patch overlap ' + p.id,
        )
        const after = sha256(patched.bytes.subarray(p.offset, p.offset + p.bytes))
        if (!overlap) ensure(after === p.after_sha256, 'Prior repair changed ' + p.id)
        return {
          ...p,
          previous_after_sha256: p.after_sha256,
          after_sha256: after,
          preserved: !overlap,
          ...(overlap ? { updated_by: [patched.patch.id] } : {}),
        }
      })
      const dir = path.join(outputRoot, kind + '-fixed/v1102-r1')
      ensure(!fs.existsSync(dir), 'Refusing overwrite')
      fs.mkdirSync(dir, { recursive: true })
      const changed = path.join(temp, kind + '-after'),
        file = path.join(dir, base.file),
        roundtrip = path.join(temp, kind + '-roundtrip')
      fs.writeFileSync(changed, patched.bytes)
      run(upx, ['--best', '--lzma', '-o', file, changed])
      run(upx, ['-t', file])
      run(upx, ['-d', '-o', roundtrip, file])
      ensure(fs.readFileSync(roundtrip).equals(patched.bytes), 'Unpack roundtrip differs')
      const packed = fs.readFileSync(file),
        patches = json({ [base.file]: [patched.patch] }),
        semantics = json(sem)
      const { before, after, ...span } = patched.patch
      const artifact = {
        file: base.file,
        bytes: packed.length,
        sha256: sha256(packed),
        unpacked_bytes: patched.bytes.length,
        unpacked_sha256: sha256(patched.bytes),
        source_packed_sha256: base.packed,
        source_unpacked_sha256: base.unpacked,
        validations: {
          elf_graph: true,
          no_bytecode: true,
          unchanged_outside_js_spans: true,
          syntax,
          native_bindings_resolved: true,
          upx_integrity: true,
          exact_unpack_roundtrip: true,
        },
        patches: [span],
      }
      const manifest = {
        ...parent,
        id: base.id,
        approval: {
          date: '2026-10-04',
          basis: 'owner-authorized locally verified fixed CLI maintenance',
          scope: 'CLI verdict gate only; not Linux/cloud certification',
        },
        lineage: {
          ...parent.lineage,
          source_file: base.input,
          source_sha256: base.packed,
          previous_release: parent.id,
          upstream_cli_sha256: VERDICT_REFERENCE,
          classifier_reference_commit: 'fe4b23a',
        },
        artifacts: { [base.file]: artifact },
        inherited_repairs: repairs,
        patches_sha256: sha256(patches),
        semantics_sha256: sha256(semantics),
        tools: { upx: run(upx, ['--version']).split(/\r?\n/)[0], bun: run(bun, ['--version']).trim() },
        local_validation: {
          completed: true,
          native_execution: false,
          behavior_tests: behavior.checks,
          full_source_scope_audit: auditAfter,
          scope: 'one-span upstream predicate port; original bootstrap/system/cache/terminal preserved',
        },
      }
      fs.writeFileSync(path.join(dir, 'manifest.json'), json(manifest))
      fs.writeFileSync(path.join(dir, 'patches.json'), patches)
      fs.writeFileSync(path.join(dir, 'semantics.json'), semantics)
      fs.writeFileSync(path.join(evidence, kind + '.unpacked'), patched.bytes)
      fs.writeFileSync(path.join(evidence, kind + '-bindings.json'), json({ before: auditBefore, after: auditAfter }))
      results.push({ kind, id: base.id, ...artifact, behavior })
    }
    return results
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const arg = (k) => {
    const i = process.argv.indexOf(k)
    return i < 0 ? undefined : process.argv[i + 1]
  }
  const { verifyVerdictSource } = await import('../test/support/fixed-verdict-controls.mjs')
  console.log(
    JSON.stringify(
      await buildFixedVerdict({
        root: arg('--root'),
        outputRoot: arg('--output'),
        evidence: arg('--evidence'),
        upx: arg('--upx'),
        bun: arg('--bun'),
        verify: verifyVerdictSource,
      }),
      null,
      2,
    ),
  )
}
