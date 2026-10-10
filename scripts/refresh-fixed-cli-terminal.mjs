#!/usr/bin/env node
/** Port the exact upstream native max_tokens guard; never executes an ELF or packages a kernel. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { inspectBunElf, sha256, verifyUnchangedOutside } from './build-offline-native-candidates.mjs'

export const TERMINAL_REFERENCE = Object.freeze({
  file: 'share/wrap-cli/cli-node',
  packed: '75a1a7b939553a5deeea98075359a87a2d4132535f71e29ef88df291e79ea55d',
  unpacked: '6c75e5cb08dc58434a3a9c7814043d869bb5d51e0236b5255368b86e023eceae',
  commit: '259dbbdc79aa85158a29f3fbf5df372d66fd2577',
  originalCc: 'be5eec49a78345dd935e302e88c9d7ad0afbb09a195356d81be1bdea766f3960',
})
export const FIXED_TERMINAL_BASES = Object.freeze({
  wrap: {
    id: 'wrap-fixed-v189-r1',
    file: 'cli-node',
    directory: 'wrap-fixed/v186-r1',
    packed: 'e7134c6ea73d280c8288e1146428b69ba823e08f5396e90892e0a007614dc52a',
    unpacked: 'f938078e96d8e176383978dd8423e5923eeaa5818c8e4d5919b2fe05fae34bee',
  },
  cc: {
    id: 'cc-fixed-v189-r1',
    file: 'cc-node',
    directory: 'cc-fixed/v186-r1',
    packed: 'f6e2ff2d0a7095e2d1c6ebb96250725ccc0d5fd46d8c8ce492deedeba9c36196',
    unpacked: '93428c65b87239e11f6dbaa5a9295cc5c4a46d6f6323cf415d8c3493ea2d4f36',
  },
})
const MINIFY =
  'const t=new Bun.Transpiler({loader:"js",target:"bun",minifyWhitespace:true,minifySyntax:false,minifyIdentifiers:false,deadCodeElimination:false,inline:false});process.stdout.write(t.transformSync(await Bun.stdin.text()));'
const SCAN =
  'const t=new Bun.Transpiler({loader:"js",target:"bun",deadCodeElimination:false,inline:false});const s=t.scan(await Bun.stdin.text());console.log(JSON.stringify({syntax:true,imports:s.imports.length,exports:s.exports.length}));'
const ensure = (ok, message) => {
  if (!ok) throw Error(message)
}
const graphShape = (graph) => JSON.stringify({ ...graph, source: null })
const jsonBytes = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n')

export function terminalSpan(source) {
  const begin = 'if (stopReason === "max_tokens") {'
  const start = source.indexOf(begin)
  ensure(start >= 0 && source.indexOf(begin, start + begin.length) < 0, 'Ambiguous max_tokens boundary')
  const end = source.indexOf('if (stopReason === "model_context_window_exceeded") {', start)
  ensure(end > start && end - start < 4096, 'Missing next terminal boundary')
  const text = source.slice(start, end)
  ensure(
    text.includes('createAssistantAPIErrorMessage') && text.includes('tengu_max_tokens_reached'),
    'Unexpected terminal code',
  )
  return { start, text }
}
function kinPredicate(source) {
  const start = source.indexOf('function isKinQuerySource(source) {')
  ensure(start >= 0, 'Missing native query-source predicate')
  const end = source.indexOf('\n}', start) + 2
  const code = source.slice(start, end)
  ensure(code.length < 512 && code.includes('kin_native_messages'), 'Unexpected native query-source predicate')
  return code
}

export function patchFixedTerminal(original, reference, minify) {
  const graph = inspectBunElf(original),
    refGraph = inspectBunElf(reference)
  const source = graph.source.toString('utf8'),
    donor = refGraph.source.toString('utf8')
  ensure(Buffer.from(source).equals(graph.source), 'Source is not round-trippable UTF-8')
  const before = terminalSpan(source),
    upstream = terminalSpan(donor)
  ensure(!before.text.includes('isKinQuerySource'), 'Baseline already has a native terminal guard')
  ensure(upstream.text.includes('if (!isKinQuerySource(options2.querySource)) {'), 'Reference lacks the upstream guard')
  const predicate = kinPredicate(source)
  ensure(predicate === kinPredicate(donor), 'Native query-source semantics differ')
  const compact = minify(`export async function* __fixed_terminal(){${upstream.text}}`).trim()
  ensure(compact.includes('__fixed_terminal') && compact.endsWith('}'), 'Unexpected generator minification')
  const after = compact.slice(compact.indexOf('{') + 1, -1)
  const old = Buffer.from(before.text),
    data = Buffer.from(after)
  ensure(data.length <= old.length, 'Terminal guard exceeds original fixed span')
  const offset = graph.modules[graph.entry].sourceOffset + Buffer.byteLength(source.slice(0, before.start))
  ensure(original.subarray(offset, offset + old.length).equals(old), 'Terminal byte/character offset mismatch')
  const padded = Buffer.concat([data, Buffer.alloc(old.length - data.length, 32)])
  const change = {
    id: 'native-max-tokens-terminal',
    offset,
    bytes: old.length,
    replacement_bytes: data.length,
    before_sha256: sha256(old),
    after_sha256: sha256(padded),
    before: before.text,
    after,
  }
  const bytes = Buffer.from(original)
  padded.copy(bytes, offset)
  verifyUnchangedOutside(original, bytes, [change])
  const resultGraph = inspectBunElf(bytes)
  ensure(graphShape(graph) === graphShape(resultGraph), 'ELF/Bun/resource layout changed')
  return { bytes, change, semantics: { before: before.text, after, upstream: upstream.text, predicate } }
}

/** Isolated exact source fragment, not the full SDK/ELF or a provider call. */
export async function evaluateTerminal(semantics, which, querySource, stopReason, maxOutputTokens = 128000) {
  const events = []
  const make = new Function(
    'events',
    `${semantics.predicate};return async function* (stopReason,options2,maxOutputTokens){
    const API_ERROR_MESSAGE_PREFIX='API Error';
    const logEvent=(name,fields)=>events.push({name,fields});
    const createAssistantAPIErrorMessage=(value)=>({type:'assistant',isApiErrorMessage:true,...value});
    ${semantics[which]}
  }`,
  )(events)
  const yielded = []
  for await (const value of make(stopReason, { querySource }, maxOutputTokens)) yielded.push(value)
  return { events, yielded }
}
async function behaviorChecks(semantics) {
  let count = 0
  for (const source of [
    'agent:kin',
    'kin_native_messages',
    'sdk',
    'repl_main_thread',
    'agent:other',
    'agent:kin:other',
  ]) {
    for (const reason of ['max_tokens', 'end_turn'])
      for (const max of [128, 128000]) {
        assert.deepEqual(
          await evaluateTerminal(semantics, 'after', source, reason, max),
          await evaluateTerminal(semantics, 'upstream', source, reason, max),
        )
        count++
      }
  }
  return count
}

export async function buildFixedTerminalRefresh({ root, outputRoot, evidence, upx, bun }) {
  ensure(root && outputRoot && evidence && upx && bun, 'Explicit root/outputRoot/evidence/upx/bun required')
  const run = (bin, args, options = {}) =>
    execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 300000, ...options })
  const minify = (code) => run(bun, ['-e', MINIFY], { input: code })
  const tools = { upx: run(upx, ['--version']).split(/\r?\n/)[0], bun: run(bun, ['--version']).trim() }
  const referenceFile = path.join(root, TERMINAL_REFERENCE.file)
  ensure(sha256(fs.readFileSync(referenceFile)) === TERMINAL_REFERENCE.packed, 'Upstream CLI reference changed')
  ensure(
    sha256(fs.readFileSync(path.join(root, 'share/wrap-cli/cc-node'))) === TERMINAL_REFERENCE.originalCc,
    'Original CC changed; re-derive the patch',
  )
  fs.mkdirSync(evidence, { recursive: true })
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-terminal-'))
  const built = []
  try {
    const referencePath = path.join(tmp, 'reference')
    run(upx, ['-d', '-o', referencePath, referenceFile])
    const reference = fs.readFileSync(referencePath)
    ensure(sha256(reference) === TERMINAL_REFERENCE.unpacked, 'Reference decompression mismatch')
    for (const [kind, base] of Object.entries(FIXED_TERMINAL_BASES)) {
      const inputDir = path.join(root, 'share', base.directory),
        input = path.join(inputDir, base.file)
      ensure(sha256(fs.readFileSync(input)) === base.packed, `Unknown ${kind} fixed baseline`)
      const parent = JSON.parse(fs.readFileSync(path.join(inputDir, 'manifest.json'), 'utf8'))
      ensure(
        sha256(fs.readFileSync(path.join(inputDir, 'patches.json'))) === parent.patches_sha256,
        'Previous patch metadata changed',
      )
      ensure(
        sha256(fs.readFileSync(path.join(inputDir, 'semantics.json'))) === parent.semantics_sha256,
        'Previous semantics metadata changed',
      )
      const unpacked = path.join(tmp, kind + '.source')
      run(upx, ['-d', '-o', unpacked, input])
      const original = fs.readFileSync(unpacked)
      ensure(
        sha256(original) === base.unpacked && base.unpacked === parent.artifacts[base.file].unpacked_sha256,
        'Baseline unpack mismatch',
      )
      const result = patchFixedTerminal(original, reference, minify)
      const protectedPatches = [...parent.artifacts[base.file].patches]
      if (kind === 'cc') {
        const inherited = JSON.parse(fs.readFileSync(path.join(root, 'share/cc-fixed/v155-r3/patches.json'), 'utf8'))
        protectedPatches.push(...inherited['cc-node'])
      }
      for (const patch of protectedPatches) {
        ensure(
          sha256(original.subarray(patch.offset, patch.offset + patch.bytes)) === patch.after_sha256,
          `Unexpected inherited repair ${patch.id}`,
        )
        ensure(
          original
            .subarray(patch.offset, patch.offset + patch.bytes)
            .equals(result.bytes.subarray(patch.offset, patch.offset + patch.bytes)),
          `Changed inherited repair ${patch.id}`,
        )
      }
      const checks = await behaviorChecks(result.semantics)
      const syntax = JSON.parse(run(bun, ['-e', SCAN], { input: inspectBunElf(result.bytes).source }))
      const outDir = path.join(outputRoot, `${kind}-fixed/v189-r1`)
      ensure(!fs.existsSync(outDir), 'Refusing to overwrite existing fixed output')
      fs.mkdirSync(outDir, { recursive: true })
      const raw = path.join(tmp, kind + '.patched'),
        packed = path.join(outDir, base.file)
      fs.writeFileSync(raw, result.bytes)
      run(upx, ['--best', '--lzma', '-o', packed, raw])
      const integrity = run(upx, ['-t', packed])
      const roundtrip = path.join(tmp, kind + '.roundtrip')
      run(upx, ['-d', '-o', roundtrip, packed])
      ensure(fs.readFileSync(roundtrip).equals(result.bytes), 'UPX roundtrip differs')
      const bytes = fs.readFileSync(packed)
      const patches = jsonBytes({ [base.file]: [result.change] })
      const semantics = jsonBytes({
        ...JSON.parse(fs.readFileSync(path.join(inputDir, 'semantics.json'), 'utf8')),
        terminal: result.semantics,
      })
      const { before, after, ...patchSummary } = result.change
      const artifact = {
        ...parent.artifacts[base.file],
        bytes: bytes.length,
        sha256: sha256(bytes),
        unpacked_bytes: result.bytes.length,
        unpacked_sha256: sha256(result.bytes),
        source_packed_sha256: base.packed,
        source_unpacked_sha256: sha256(original),
        patches: [patchSummary],
        validations: {
          elf_graph: true,
          no_bytecode: true,
          unchanged_outside_js_spans: true,
          syntax,
          upx_integrity: true,
          exact_unpack_roundtrip: true,
        },
      }
      const manifest = {
        ...parent,
        id: base.id,
        approval: {
          date: '2026-10-01',
          basis:
            'owner-authorized fixed CLI maintenance, preserving accepted repairs while integrating the exact upstream native terminal fix',
          scope: 'local source/packaging verification; not Linux ELF/provider execution',
        },
        lineage: {
          ...parent.lineage,
          source_file: `share/${base.directory}/${base.file}`,
          source_sha256: base.packed,
          previous_release: parent.id,
          upstream_cli_sha256: TERMINAL_REFERENCE.packed,
          terminal_reference_commit: TERMINAL_REFERENCE.commit,
        },
        artifacts: { [base.file]: artifact },
        tools,
        patches_sha256: sha256(patches),
        semantics_sha256: sha256(semantics),
        inherited_repairs: protectedPatches.map(({ id, offset, bytes, after_sha256 }) => ({
          id,
          offset,
          bytes,
          after_sha256,
        })),
        local_validation: {
          completed: true,
          native_execution: false,
          behavior_tests: checks,
          scope:
            'exact native terminal fragment versus upstream; inherited repair bytes and complete ELF/package checks',
        },
      }
      fs.writeFileSync(path.join(outDir, 'patches.json'), patches)
      fs.writeFileSync(path.join(outDir, 'semantics.json'), semantics)
      fs.writeFileSync(path.join(outDir, 'manifest.json'), jsonBytes(manifest))
      fs.writeFileSync(path.join(evidence, kind + '.upx.log'), integrity)
      fs.writeFileSync(path.join(evidence, kind + '.unpacked'), result.bytes)
      built.push({
        id: base.id,
        sha256: artifact.sha256,
        unpacked_sha256: artifact.unpacked_sha256,
        bytes: bytes.length,
        checks,
        protected_patches: protectedPatches.length,
      })
    }
    return built
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const arg = (key) => {
    const at = process.argv.indexOf(key)
    return at < 0 ? undefined : process.argv[at + 1]
  }
  const result = await buildFixedTerminalRefresh({
    root: arg('--root'),
    outputRoot: arg('--output'),
    evidence: arg('--evidence'),
    upx: arg('--upx'),
    bun: arg('--bun'),
  })
  console.log(JSON.stringify(result, null, 2))
}
