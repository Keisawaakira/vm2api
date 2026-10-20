#!/usr/bin/env node
/** Carry upstream's host-only refresh-token writer policy into the current fixed CLIs. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { inspectBunElf, sha256, verifyUnchangedOutside } from './build-offline-native-candidates.mjs'
import { sourceFunction } from './refresh-fixed-cli-lifecycle.mjs'
import { auditNativeBindings } from './refresh-fixed-cc-session.mjs'

export const HOST_REFRESH_BASES = Object.freeze({
  wrap: {
    id: 'wrap-fixed-v1108-r1',
    file: 'cli-node',
    input: 'share/wrap-fixed/v1102-r1/cli-node',
    packed: '40c3aa30788fc05520e023856e1ebdc897905b155d775626882dcbac0666007f',
    unpacked: 'cad45f85368ed3da7859f5ad25d446d5d4b5d545b6533190a0867ddaa3e2b15a',
  },
  cc: {
    id: 'cc-fixed-v1108-r1',
    file: 'cc-node',
    input: 'share/cc-fixed/v1102-r1/cc-node',
    packed: 'ae1eaea25391a07b5d8b7abd83a09eb91e255512f97a45577a25eaec27eefac2',
    unpacked: 'c44eb30115e35643500ca19fd662512152777d8b8d3928cc37a8605cacfbff8e',
  },
})
export const HOST_REFRESH_REFERENCE = '7b23385e502b5158f4d73cb8444b4aca0a171076d255a34a4d8379c28ef494ce'
const requireThat = (v, why) => {
  if (!v) throw Error(why)
}
const json = (v) => Buffer.from(JSON.stringify(v, null, 2) + '\n')
const name = 'checkAndRefreshOAuthTokenIfNeededImpl'

export function patchHostRefreshBytes(original, kind, reference, minify) {
  const base = HOST_REFRESH_BASES[kind]
  requireThat(base && sha256(original) === base.unpacked, 'Unknown fixed source ' + kind)
  const graph = inspectBunElf(original),
    source = graph.source.toString('utf8')
  requireThat(Buffer.from(source).equals(graph.source), 'Lossy source')
  const before = sourceFunction(source, name)
  const donor = sourceFunction(reference, name).text.trim()
  const addition = /  if \(isEnvTruthy\(process\.env\.CLAUDE_CODE_KIN_HOST_REFRESH\)\) \{\n[\s\S]*?\n  \}\n/.exec(donor)
  requireThat(
    addition && donor.replace(addition[0], '') === before.text.trim(),
    'Reference has unrelated refresh changes',
  )
  const replacement = minify(donor).trim()
  const length = Buffer.byteLength(before.text)
  requireThat(Buffer.byteLength(replacement) <= length, 'Refresh function exceeds reserved span')
  const offset = graph.modules[graph.entry].sourceOffset + Buffer.byteLength(source.slice(0, before.start))
  const after = Buffer.concat([Buffer.from(replacement), Buffer.alloc(length - Buffer.byteLength(replacement), 32)])
  const patch = {
    id: 'host-owned-oauth-refresh',
    offset,
    bytes: length,
    replacement_bytes: Buffer.byteLength(replacement),
    before: before.text,
    after: replacement,
    before_sha256: sha256(Buffer.from(before.text)),
    after_sha256: sha256(after),
  }
  const bytes = Buffer.from(original)
  after.copy(bytes, offset)
  verifyUnchangedOutside(original, bytes, [patch])
  const updated = inspectBunElf(bytes)
  requireThat(
    JSON.stringify({ ...graph, source: null }) === JSON.stringify({ ...updated, source: null }),
    'ELF/Bun layout changed',
  )
  return { bytes, patch, sourceBefore: source, sourceAfter: updated.source.toString('utf8'), reference: donor }
}

export async function buildFixedHostRefresh({ root, outputRoot, evidence, upx, bun, verify }) {
  requireThat(root && outputRoot && evidence && upx && bun && verify, 'Explicit paths and verifier required')
  const run = (exe, args, options = {}) =>
    execFileSync(exe, args, { encoding: 'utf8', timeout: 300000, maxBuffer: 32 * 1024 * 1024, ...options })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-host-refresh-'))
  fs.mkdirSync(evidence, { recursive: true })
  try {
    const referenceFile = path.join(root, 'share/wrap-cli/cli-node')
    requireThat(sha256(fs.readFileSync(referenceFile)) === HOST_REFRESH_REFERENCE, 'Unknown upstream reference')
    requireThat(
      sha256(fs.readFileSync(path.join(root, 'share/wrap-cli/cc-node'))) ===
        'be5eec49a78345dd935e302e88c9d7ad0afbb09a195356d81be1bdea766f3960',
      'Original CC changed',
    )
    const refRaw = path.join(dir, 'reference')
    run(upx, ['-d', '-o', refRaw, referenceFile])
    const reference = inspectBunElf(fs.readFileSync(refRaw)).source.toString('utf8')
    const minify = (text) =>
      run(
        bun,
        [
          '-e',
          'const t=new Bun.Transpiler({loader:"js",target:"bun",minifyWhitespace:true,minifySyntax:false,minifyIdentifiers:false,deadCodeElimination:false,inline:false});process.stdout.write(t.transformSync(await Bun.stdin.text()))',
        ],
        { input: text },
      )
    const results = []
    for (const [kind, base] of Object.entries(HOST_REFRESH_BASES)) {
      const input = path.join(root, base.input)
      requireThat(sha256(fs.readFileSync(input)) === base.packed, 'Unknown packed input ' + kind)
      const raw = path.join(dir, kind + '-before')
      run(upx, ['-d', '-o', raw, input])
      const original = fs.readFileSync(raw),
        patched = patchHostRefreshBytes(original, kind, reference, minify)
      const parentDir = path.dirname(input),
        parent = JSON.parse(fs.readFileSync(path.join(parentDir, 'manifest.json')))
      const sem = JSON.parse(fs.readFileSync(path.join(parentDir, 'semantics.json')))
      const afterFunction = sourceFunction(patched.sourceAfter, name).text.trim()
      sem.host_refresh = {
        before: sourceFunction(patched.sourceBefore, name).text.trim(),
        after: afterFunction,
        reference: patched.reference,
      }
      sem.verdict.refresh_impl = afterFunction
      const auditBefore = auditNativeBindings(patched.sourceBefore, root),
        auditAfter = auditNativeBindings(patched.sourceAfter, root)
      requireThat(
        auditAfter.native_unresolved.length === 0 && JSON.stringify(auditBefore) === JSON.stringify(auditAfter),
        'Full source binding regression',
      )
      const behavior = await verify(sem, kind)
      requireThat(behavior?.ok === true && behavior.checks > 0, 'Source controls failed')
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
      const inherited = [...(parent.inherited_repairs || []), ...parent.artifacts[base.file].patches].map((p) => {
        requireThat(
          sha256(original.subarray(p.offset, p.offset + p.bytes)) === p.after_sha256,
          'Unexpected prior patch ' + p.id,
        )
        requireThat(
          !(p.offset < patched.patch.offset + patched.patch.bytes && patched.patch.offset < p.offset + p.bytes),
          'Overlapping prior repair ' + p.id,
        )
        requireThat(
          sha256(patched.bytes.subarray(p.offset, p.offset + p.bytes)) === p.after_sha256,
          'Prior repair changed ' + p.id,
        )
        return { ...p, previous_after_sha256: p.after_sha256, preserved: true }
      })
      const dest = path.join(outputRoot, kind + '-fixed/v1108-r1')
      requireThat(!fs.existsSync(dest), 'Refusing overwrite')
      fs.mkdirSync(dest, { recursive: true })
      const changed = path.join(dir, kind + '-after'),
        file = path.join(dest, base.file),
        back = path.join(dir, kind + '-roundtrip')
      fs.writeFileSync(changed, patched.bytes)
      run(upx, ['--best', '--lzma', '-o', file, changed])
      run(upx, ['-t', file])
      run(upx, ['-d', '-o', back, file])
      requireThat(fs.readFileSync(back).equals(patched.bytes), 'Unpack roundtrip differs')
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
        patches: [span],
        validations: {
          elf_graph: true,
          no_bytecode: true,
          unchanged_outside_js_spans: true,
          syntax,
          native_bindings_resolved: true,
          upx_integrity: true,
          exact_unpack_roundtrip: true,
        },
      }
      const manifest = {
        ...parent,
        id: base.id,
        approval: {
          date: '2026-10-05',
          basis: 'owner-authorized locally verified fixed maintenance',
          scope: 'host refresh policy only; not actual Linux/cloud certification',
        },
        lineage: {
          ...parent.lineage,
          source_file: base.input,
          source_sha256: base.packed,
          previous_release: parent.id,
          upstream_cli_sha256: HOST_REFRESH_REFERENCE,
          refresh_reference_commit: 'cb585bb6',
        },
        artifacts: { [base.file]: artifact },
        inherited_repairs: inherited,
        patches_sha256: sha256(patches),
        semantics_sha256: sha256(semantics),
        tools: { upx: run(upx, ['--version']).split(/\r?\n/)[0], bun: run(bun, ['--version']).trim() },
        local_validation: {
          completed: true,
          native_execution: false,
          behavior_tests: behavior.checks,
          full_source_scope_audit: auditAfter,
          scope: 'one bounded refresh function; all system/cache/session/classifier/lifecycle repairs preserved',
        },
      }
      fs.writeFileSync(path.join(dest, 'manifest.json'), json(manifest))
      fs.writeFileSync(path.join(dest, 'patches.json'), patches)
      fs.writeFileSync(path.join(dest, 'semantics.json'), semantics)
      fs.writeFileSync(path.join(evidence, kind + '.unpacked'), patched.bytes)
      fs.writeFileSync(path.join(evidence, kind + '-scope.json'), json({ before: auditBefore, after: auditAfter }))
      results.push({ kind, ...artifact, behavior })
    }
    return results
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const arg = (key) => {
    const i = process.argv.indexOf(key)
    return i < 0 ? undefined : process.argv[i + 1]
  }
  const { verifyHostRefreshSource } = await import('../test/support/fixed-host-refresh-controls.mjs')
  console.log(
    JSON.stringify(
      await buildFixedHostRefresh({
        root: arg('--root'),
        outputRoot: arg('--output'),
        evidence: arg('--evidence'),
        upx: arg('--upx'),
        bun: arg('--bun'),
        verify: verifyHostRefreshSource,
      }),
      null,
      2,
    ),
  )
}
