#!/usr/bin/env node
/** Keep fixed CLIs on the new request assembly contract without replacing the CC runtime. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { inspectBunElf, sha256, verifyUnchangedOutside } from './build-offline-native-candidates.mjs'
import { sourceRange, sourceFunction } from './refresh-fixed-cli-lifecycle.mjs'
import { auditNativeBindings } from './refresh-fixed-cc-session.mjs'
import { requestParamsRange, patchRequestWireBytes, requestWireSemantics } from './refresh-fixed-cli-request-wire.mjs'

export const ASSEMBLY_CONTRACT = 'caller_optional_fields_v1'
export const ASSEMBLY_REFERENCE = Object.freeze({
  packed: 'c1316b7dd68490f56dde84ed1c7591591899cded321174a45f7cf954ea48465b',
  unpacked: '6fe648bf1b4969a4f5ada1760d502a77af8bc6f9922d14c368d68739cf60d164',
  originalCc: 'be5eec49a78345dd935e302e88c9d7ad0afbb09a195356d81be1bdea766f3960',
  commit: '5278867caab0eda00988fbe15f7df3dce239fa61',
})
export const ASSEMBLY_BASES = Object.freeze({
  wrap: {
    id: 'wrap-fixed-v1152-r1',
    file: 'cli-node',
    input: 'share/wrap-cli/cli-node',
    packed: ASSEMBLY_REFERENCE.packed,
    unpacked: ASSEMBLY_REFERENCE.unpacked,
  },
  cc: {
    id: 'cc-fixed-v1152-r1',
    file: 'cc-node',
    input: 'share/cc-fixed/v1134-r1/cc-node',
    packed: 'd7a40fbaf0d478be6b676c8f7988897b01634be124e4cd1a2932239e3faaabb2',
    unpacked: 'f9cbc9738522b737a6dbe3ef4140176eb315523ff59359a6265d23617e4d9c48',
  },
})
const requireThat = (ok, message) => {
  if (!ok) throw Error(message)
}
const jsonBytes = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n')
const once = (source, before, after) => {
  requireThat(source.split(before).length === 2, 'Expected one anchor: ' + before)
  return source.replace(before, after)
}
function pureInitializer(block, symbol) {
  const start = block.indexOf('var ' + symbol + ' ='),
    brace = block.indexOf('{', start),
    end = block.lastIndexOf('});')
  requireThat(start > 0 && brace > start && end > brace, 'Unexpected pure initializer: ' + symbol)
  return block.slice(0, start) + block.slice(brace + 1, end)
}
export function assemblyReferenceSource(reference) {
  return sourceRange(reference, '// src/services/api/requestBody.ts', '// ../../src/lib/protocol/claude-code-betas.mjs')
    .text
}
export function assemblyFactorySource(reference) {
  const assembly = pureInitializer(assemblyReferenceSource(reference), 'init_requestBody')
  const gates = pureInitializer(
    sourceRange(reference, '// ../../src/lib/protocol/claude-code-betas.mjs', '// src/kin/querySource.ts').text,
    'init_claude_code_betas',
  )
  return (
    'export var __vm2apiRequestWire=(()=>{' +
    assembly +
    gates +
    '\nreturn {apply:withRequestProtocolBetas,setup:setupTokenBetaHeader,owned:NATIVE_OWNED_FIELDS,assemble:assembleMessageRequest}})();'
  )
}
export function ccAssemblyParams(before) {
  // Restrict behavior changes to caller-owned native requests. Ordinary CC
  // requests retain their previous token/management/optional field construction.
  let next = once(
    before,
    'const maxOutputTokens2=retryContext?.maxTokensOverride||options2.maxOutputTokensOverride||getMaxOutputTokensForModel(options2.model);',
    'const maxOutputTokens2=options2.wireBody?(retryContext?.maxTokensOverride??options2.maxOutputTokensOverride??getMaxOutputTokensForModel(options2.model)):(retryContext?.maxTokensOverride||options2.maxOutputTokensOverride||getMaxOutputTokensForModel(options2.model));',
  )
  next = once(
    next,
    'const contextManagement=options2.contextManagementOverride??(options2.requestContext?void 0:getAPIContextManagement(',
    'const contextManagement=options2.wireBody?options2.contextManagementOverride:options2.contextManagementOverride??(options2.requestContext?void 0:getAPIContextManagement(',
  )
  const oldTail = sourceRange(next, 'const nativeExtras=', 'const gatedBetas=').text
  let legacy = oldTail.slice(oldTail.indexOf('const params='))
  legacy = once(legacy, '...nativeExtras,', '')
  const split = legacy.indexOf('...temperature')
  requireThat(split > 0 && legacy.slice(0, split).endsWith('thinking,'), 'Unexpected common request core')
  const core = once(legacy.slice(0, split - 1) + '};', 'const params=', 'const core=')
  const selected =
    'const params=options2.wireBody?__vm2apiRequestWire.assemble({...core,temperature,top_p:options2.topP,top_k:options2.topK,stop_sequences:options2.stopSequences,context_management:contextManagement,extraBodyParams,wireBody:options2.wireBody,safeguards:options2.safeguards,outputConfig,speed}):{...core,'
  return once(next, oldTail, core + selected + legacy.slice(split))
}

export function patchAssemblyBytes(original, kind, { reference, minify, helper, previousPatches, previousSemantics }) {
  const base = ASSEMBLY_BASES[kind]
  requireThat(base && sha256(original) === base.unpacked, 'Unknown assembly baseline: ' + kind)
  const graph = inspectBunElf(original),
    source = graph.source.toString('utf8')
  requireThat(Buffer.from(source).equals(graph.source), 'Source must be lossless UTF-8')
  if (kind === 'wrap') {
    // The two existing caller-system repairs apply verbatim to the new stock
    // layout. The historical builder retains its locked default input hash.
    const result = patchRequestWireBytes(original, kind, { reference, minify, baseline: base })
    return result
  }
  requireThat(helper && previousPatches && previousSemantics, 'CC requires its own audited parent')
  const origin = graph.modules[graph.entry].sourceOffset,
    changes = []
  const add = (id, span, text) => {
    const before = Buffer.from(span.text),
      after = Buffer.from(text)
    requireThat(after.length <= before.length, `${id} exceeds fixed span ${after.length}/${before.length}`)
    const offset = origin + Buffer.byteLength(source.slice(0, span.start))
    requireThat(original.subarray(offset, offset + before.length).equals(before), 'Source byte offset mismatch')
    changes.push({
      id,
      offset,
      bytes: before.length,
      replacement_bytes: after.length,
      before: span.text,
      after: text,
      before_sha256: sha256(before),
      after_sha256: sha256(Buffer.concat([after, Buffer.alloc(before.length - after.length, 32)])),
    })
  }
  const gate = previousPatches.find((p) => p.id === 'request-protocol-gates')
  requireThat(
    gate && sha256(original.subarray(gate.offset, gate.offset + gate.bytes)) === gate.after_sha256,
    'Parent gate span changed',
  )
  const gateBytes = original.subarray(gate.offset, gate.offset + gate.bytes)
  const gateText = gateBytes.toString('utf8'),
    oldHelper = previousSemantics.request_wire.helpers
  requireThat(gateText.startsWith(oldHelper), 'Private helper no longer starts its parent span')
  const start = graph.source.subarray(0, gate.offset - origin).toString('utf8').length
  add(
    'native-request-assembly-helper',
    { start, text: gateText },
    helper + '\n' + minify(gateText.slice(oldHelper.length)),
  )
  const params = requestParamsRange(source)
  add('native-request-assembly-parameters', params, minify(ccAssemblyParams(params.text)))
  changes.sort((a, b) => a.offset - b.offset)
  const bytes = Buffer.from(original)
  let end = origin
  for (const change of changes) {
    requireThat(
      change.offset >= end && change.offset + change.bytes <= origin + graph.source.length,
      'Overlapping/non-JS patch',
    )
    Buffer.concat([Buffer.from(change.after), Buffer.alloc(change.bytes - change.replacement_bytes, 32)]).copy(
      bytes,
      change.offset,
    )
    end = change.offset + change.bytes
  }
  verifyUnchangedOutside(original, bytes, changes)
  const next = inspectBunElf(bytes)
  requireThat(
    JSON.stringify({ ...graph, source: null }) === JSON.stringify({ ...next, source: null }),
    'ELF/Bun resource layout changed',
  )
  return { bytes, changes, sourceBefore: source, sourceAfter: next.source.toString('utf8') }
}
function modelHelpers(reference) {
  const temperatures = /TEMPERATURE_ACCEPTED_CANONICALS = (\{[\s\S]*?\n  \});/.exec(reference)
  requireThat(temperatures, 'Actual temperature capability table missing')
  return (
    ['modelRejectsDisabledThinking', 'modelAcceptsTemperature', 'modelCapsEffortWhenDisabled', 'effortLevelAboveHigh']
      .map((name) => sourceFunction(reference, name).text)
      .join('\n') +
    '\nvar TEMPERATURE_ACCEPTED_CANONICALS=' +
    temperatures[1] +
    ';'
  )
}
export function assemblySemantics(result, kind, previous, reference, helper) {
  const sem = requestWireSemantics(result.sourceAfter, kind, previous, {
    reference,
    helper,
    sourceBefore: result.sourceBefore,
  })
  const assembly = assemblyReferenceSource(reference)
  if (kind === 'wrap') {
    sem.request_wire.helpers += '\n' + pureInitializer(assembly, 'init_requestBody')
    // These declarations are actual stock model guards. Their environment and
    // capability sources remain explicit external test boundaries.
    sem.request_wire.model_helpers = modelHelpers(reference)
    sem.classifier.api_helpers += '\n' + sem.request_wire.model_helpers
    for (const [name, from, to] of [
      ['thinking', 'const hasThinking', 'const contextManagement'],
      ['management', 'const contextManagement', 'const enablePromptCaching2'],
      ['effort', 'const outputConfig', 'if (options2.outputFormat'],
      ['temperature', 'const temperature', 'const apiMessages'],
    ])
      sem.classifier.api_before[name] = sourceRange(requestParamsRange(reference).text, from, to).text
  }
  if (kind === 'cc') {
    sem.request_wire.previous_params = previous.request_wire.params
    sem.request_wire.previous_helpers = previous.request_wire.helpers
  }
  sem.request_wire.assembly_contract = ASSEMBLY_CONTRACT
  sem.request_wire.reference_assembly = assembly
  sem.request_wire.reference_params = requestParamsRange(reference).text
  sem.request_wire.reference_gates_sha256 = sha256(Buffer.from(sem.request_wire.reference_gates))
  sem.request_wire.note =
    'Current native API construction preserves caller optional-field presence; CC non-native construction remains its own prior path. Older before spans are historical controls.'
  return sem
}

export async function buildFixedAssembly({ root, outputRoot, evidence, upx, bun, verify }) {
  requireThat(root && outputRoot && evidence && upx && bun && verify, 'Explicit build inputs required')
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-assembly-'))
  const run = (exe, args, opts = {}) =>
    execFileSync(exe, args, { encoding: 'utf8', timeout: 300000, maxBuffer: 50 * 1024 * 1024, ...opts })
  const minify = (code) =>
    run(
      bun,
      [
        '-e',
        'const t=new Bun.Transpiler({loader:"js",target:"bun",minifyWhitespace:true,minifySyntax:false,minifyIdentifiers:false,deadCodeElimination:false,inline:false});process.stdout.write(t.transformSync(await Bun.stdin.text()))',
      ],
      { input: code },
    )
  fs.mkdirSync(evidence, { recursive: true })
  try {
    const stock = path.join(root, 'share/wrap-cli/cli-node'),
      donorFile = path.join(temp, 'reference')
    requireThat(sha256(fs.readFileSync(stock)) === ASSEMBLY_REFERENCE.packed, 'New stock CLI hash mismatch')
    requireThat(
      sha256(fs.readFileSync(path.join(root, 'share/wrap-cli/cc-node'))) === ASSEMBLY_REFERENCE.originalCc,
      'Stock CC changed; do not build on stale CC',
    )
    run(upx, ['-d', '-o', donorFile, stock])
    const donorBytes = fs.readFileSync(donorFile)
    requireThat(sha256(donorBytes) === ASSEMBLY_REFERENCE.unpacked, 'Stock unpacked hash mismatch')
    const reference = inspectBunElf(donorBytes).source.toString('utf8')
    const helperInput = path.join(temp, 'helper-input.mjs'),
      helperOutput = path.join(temp, 'helper-output.mjs')
    fs.writeFileSync(helperInput, assemblyFactorySource(reference))
    run(bun, ['build', helperInput, '--target=bun', '--format=esm', '--minify', '--outfile', helperOutput])
    const builtHelper = fs.readFileSync(helperOutput, 'utf8'),
      exported = /export\{([\w$]+) as __vm2apiRequestWire\};?\s*$/.exec(builtHelper)
    requireThat(exported, 'Private helper export changed')
    const helper =
      'var __vm2apiRequestWire=(()=>{' + builtHelper.slice(0, exported.index) + 'return ' + exported[1] + '})();'
    const results = []
    for (const [kind, base] of Object.entries(ASSEMBLY_BASES)) {
      const parentDir = path.join(root, 'share', kind + '-fixed/v1134-r1')
      const parent = JSON.parse(fs.readFileSync(path.join(parentDir, 'manifest.json')))
      requireThat(
        sha256(fs.readFileSync(path.join(parentDir, 'patches.json'))) === parent.patches_sha256,
        'Parent patch metadata changed',
      )
      requireThat(
        sha256(fs.readFileSync(path.join(parentDir, 'semantics.json'))) === parent.semantics_sha256,
        'Parent semantics changed',
      )
      const previous = JSON.parse(fs.readFileSync(path.join(parentDir, 'semantics.json')))
      const previousPatches = JSON.parse(fs.readFileSync(path.join(parentDir, 'patches.json')))[base.file]
      const input = path.join(root, base.input),
        beforeFile = path.join(temp, kind + '-before')
      requireThat(sha256(fs.readFileSync(input)) === base.packed, 'Packed baseline mismatch: ' + kind)
      run(upx, ['-d', '-o', beforeFile, input])
      const original = fs.readFileSync(beforeFile)
      const result = patchAssemblyBytes(original, kind, {
        reference,
        minify,
        helper,
        previousPatches,
        previousSemantics: previous,
      })
      const sem = assemblySemantics(result, kind, previous, reference, helper)
      const beforeAudit = auditNativeBindings(result.sourceBefore, root),
        afterAudit = auditNativeBindings(result.sourceAfter, root)
      requireThat(afterAudit.native_unresolved.length === 0, 'Native dependency unresolved')
      requireThat(
        JSON.stringify(beforeAudit.whole_unresolved) === JSON.stringify(afterAudit.whole_unresolved),
        'Whole-module unresolved bindings changed',
      )
      run(bun, ['-e', 'new Bun.Transpiler({loader:"js",target:"bun"}).scan(await Bun.stdin.text())'], {
        input: result.sourceAfter,
      })
      const behavior = await verify(sem, kind, previous)
      requireThat(behavior?.ok && behavior.checks > 0, 'Actual source controls failed')
      const inherited =
        kind === 'wrap'
          ? []
          : [...parent.inherited_repairs, ...parent.artifacts[base.file].patches].map((patch) => {
              const before = original.subarray(patch.offset, patch.offset + patch.bytes),
                after = result.bytes.subarray(patch.offset, patch.offset + patch.bytes)
              requireThat(sha256(before) === patch.after_sha256, 'Inherited input span changed: ' + patch.id)
              return {
                ...patch,
                previous_after_sha256: patch.after_sha256,
                after_sha256: sha256(after),
                preserved: before.equals(after),
                overlap: result.changes.some(
                  (change) => change.offset < patch.offset + patch.bytes && patch.offset < change.offset + change.bytes,
                ),
              }
            })
      const dest = path.join(outputRoot, kind + '-fixed/v1152-r1')
      requireThat(!fs.existsSync(dest), 'Refusing output overwrite')
      fs.mkdirSync(dest, { recursive: true })
      const raw = path.join(temp, kind + '-after'),
        file = path.join(dest, base.file),
        back = path.join(temp, kind + '-back')
      fs.writeFileSync(raw, result.bytes)
      run(upx, ['--best', '--lzma', '-o', file, raw])
      run(upx, ['-t', file])
      run(upx, ['-d', '-o', back, file])
      requireThat(fs.readFileSync(back).equals(result.bytes), 'Exact unpack roundtrip failed')
      const packed = fs.readFileSync(file),
        patches = jsonBytes({ [base.file]: result.changes }),
        semantics = jsonBytes(sem)
      const artifact = {
        file: base.file,
        bytes: packed.length,
        sha256: sha256(packed),
        unpacked_bytes: result.bytes.length,
        unpacked_sha256: sha256(result.bytes),
        source_packed_sha256: base.packed,
        source_unpacked_sha256: base.unpacked,
        patches: result.changes.map(({ before, after, ...value }) => value),
        validations: {
          elf_graph: true,
          no_bytecode: true,
          unchanged_outside_js_spans: true,
          syntax: true,
          native_bindings_resolved: true,
          upx_integrity: true,
          exact_unpack_roundtrip: true,
        },
      }
      const manifest = {
        ...parent,
        id: base.id,
        request_assembly_contract: ASSEMBLY_CONTRACT,
        approval: {
          date: '2026-10-12',
          basis: 'owner-authorized locally verified fixed maintenance',
          scope:
            'stock request assembly/beta compatibility with caller-system repairs and CC behavior retention; no cloud/Linux acceptance',
        },
        lineage: {
          ...parent.lineage,
          source_file: base.input,
          source_sha256: base.packed,
          previous_release: parent.id,
          upstream_cli_sha256: ASSEMBLY_REFERENCE.packed,
          assembly_reference_commit: ASSEMBLY_REFERENCE.commit,
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
          full_source_scope_audit: afterAudit,
          scope: 'actual native/bridge/API/helpers with mocked external boundaries; not Linux ELF/provider execution',
        },
      }
      for (const [name, bytes] of [
        ['manifest.json', jsonBytes(manifest)],
        ['patches.json', patches],
        ['semantics.json', semantics],
      ])
        fs.writeFileSync(path.join(dest, name), bytes)
      fs.writeFileSync(path.join(evidence, kind + '.unpacked'), result.bytes)
      fs.writeFileSync(
        path.join(evidence, kind + '-bindings.json'),
        jsonBytes({ before: beforeAudit, after: afterAudit }),
      )
      results.push({ kind, ...artifact, behavior })
    }
    return results
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const arg = (name) => {
    const at = process.argv.indexOf(name)
    return at < 0 ? undefined : process.argv[at + 1]
  }
  const { verifyAssemblySource } = await import('../test/support/fixed-assembly-controls.mjs')
  console.log(
    JSON.stringify(
      await buildFixedAssembly({
        root: arg('--root'),
        outputRoot: arg('--output'),
        evidence: arg('--evidence'),
        upx: arg('--upx'),
        bun: arg('--bun'),
        verify: verifyAssemblySource,
      }),
      null,
      2,
    ),
  )
}
