#!/usr/bin/env node
/** Hash-bound v194 CLI-only maintenance; kernel remains the shared upstream image. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { inspectBunElf, sha256, verifyUnchangedOutside } from './build-offline-native-candidates.mjs'
import { sourceRange, sourceFunction } from './refresh-fixed-cli-lifecycle.mjs'

export const CLASSIFIER_BASES = Object.freeze({
  wrap: {
    id: 'wrap-fixed-v194-r1',
    file: 'cli-node',
    input: 'share/wrap-cli/cli-node',
    packed: 'c711a9660d59fd1833e207a34782331f3b65d5d7a0f644880bb26e77e15d7ff1',
    unpacked: '3e04a46d3afd53dc2c13eab26a49fe1aa95db96af0d332c4aacb6cbe51ac2a3f',
  },
  cc: {
    id: 'cc-fixed-v194-r1',
    file: 'cc-node',
    input: 'share/cc-fixed/v191-r1/cc-node',
    packed: 'dd9d357f256e0ba87468d0a2915a4984d5d7f85f9ad135636b2de82f0e5c7fe3',
    unpacked: 'bd5e1aa06b215697aaaafb5490e3ba48569fb57deba3a84c6e1c242edb0ee5db',
  },
})
const ORIGINAL_CC = 'be5eec49a78345dd935e302e88c9d7ad0afbb09a195356d81be1bdea766f3960'
const requireThat = (ok, message) => {
  if (!ok) throw new Error(message)
}
const json = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n')
const once = (text, old, value) => {
  requireThat(text.split(old).length === 2, 'Expected one source anchor: ' + old)
  return text.replace(old, value)
}
const nativeRange = (source) => sourceRange(source, '// src/kin/stdioProtocol.ts', '// src/kin/slotPool.ts')
const errorRange = (source) => sourceRange(source, '// src/kin/jobError.ts', '// src/kin/nativeMessagesRunner.ts')
const helperSource = (source) =>
  ['validClassifierContext', 'classifierSystemBlocks'].map((name) => sourceFunction(source, name).text).join('\n')
const minFunction = (text, minify) =>
  minify('export ' + text)
    .trim()
    .replace(/^export\s+/, '')
function minStatements(text, minify) {
  const result = minify('export async function* __v194(){' + text + '}').trim()
  requireThat(
    /^export\s+async\s+function\s*\*\s*__v194\(\)\{/.test(result) && result.endsWith('}'),
    'Unexpected statement compiler output',
  )
  return result.slice(result.indexOf('{') + 1, -1) + ';'
}
function snapshotQuery(source) {
  const selected = sourceFunction(source, 'queryKinMessagesWithStreaming')
  return once(selected.text, '      agentId: "kin-slot",', '      agentId: "kin-slot", __vm2apiSys: system.slice(),')
}

export function patchClassifierBytes(original, kind, donor, { minify, compact }) {
  const spec = CLASSIFIER_BASES[kind]
  requireThat(spec && sha256(original) === spec.unpacked, 'Unknown classifier source image: ' + kind)
  const graph = inspectBunElf(original),
    source = graph.source.toString('utf8')
  requireThat(Buffer.from(source).equals(graph.source), 'Source is not lossless UTF-8')
  const origin = graph.modules[graph.entry].sourceOffset
  const changes = []
  const add = (id, selected, text) => {
    const before = Buffer.from(selected.text),
      after = Buffer.from(text)
    requireThat(after.length <= before.length, `${id} exceeds span ${after.length}/${before.length}`)
    const offset = origin + Buffer.byteLength(source.slice(0, selected.start))
    requireThat(original.subarray(offset, offset + before.length).equals(before), 'Wrong source offset')
    changes.push({
      id,
      offset,
      bytes: before.length,
      replacement_bytes: after.length,
      before: selected.text,
      after: text,
      before_sha256: sha256(before),
      after_sha256: sha256(Buffer.concat([after, Buffer.alloc(before.length - after.length, 32)])),
    })
  }
  const query = sourceFunction(source, 'queryKinMessagesWithStreaming')
  add('classifier-caller-snapshot-bridge', query, minFunction(snapshotQuery(donor), minify))
  const systemRange = sourceRange(source, 'const kinSystemLayout', 'const useBetas')
  let classifierHelpers = ''
  if (kind === 'wrap') {
    const split = systemRange.text.indexOf('  } else if (kinSystemLayout !== "stock")')
    requireThat(split > 0, 'Missing stock/non-kin split')
    const kin = once(
      systemRange.text.slice(0, split),
      '      }),\n      leftover: leftoverFromSystemPrompt(systemPrompt)',
      '      })',
    )
    const appended = `if(kinQuery&&!options2.requestContext&&kinSystemLayout!=="stock"&&Array.isArray(options2.__vm2apiSys)&&options2.__vm2apiSys.length){const caller=options2.__vm2apiSys.map(text=>({type:"text",text}));const tail=system[system.length-1];if(tail?.cache_control&&tail.cache_control.scope!=="global"){caller[caller.length-1].cache_control=tail.cache_control;delete tail.cache_control;}system.push(...caller);}`
    add(
      'classifier-safe-caller-system',
      systemRange,
      minStatements(kin + systemRange.text.slice(split) + appended, minify),
    )
    classifierHelpers = helperSource(source)
  } else {
    requireThat(!source.includes('__vm2apiClassifier194'), 'Classifier namespace already exists')
    classifierHelpers = compact(
      'Classifier',
      helperSource(donor),
      '{valid:validClassifierContext,system:classifierSystemBlocks}',
    )
    let text = systemRange.text
    const fixedSub =
      'getAttributionHeader(fingerprint,{...gates,isSubagent:!0,prevReqId:previousRequestId,promptId,turnOrigin:resolveTurnOrigin(options2.querySource)})'
    const dynamicSub =
      'getAttributionHeader(fingerprint,{...gates,isSubagent:typeof options2.querySource==="string"&&options2.querySource.startsWith("agent:"),prevReqId:previousRequestId,promptId,turnOrigin:resolveTurnOrigin(options2.querySource)})'
    requireThat(text.split(dynamicSub).length === 3, 'Unknown CC attribution branches')
    // Factor identical lazy attribution calls; keep CC's own gates, environment and stock behavior.
    text = once(text, fixedSub, '_v194a(true)').replaceAll(dynamicSub, '_v194a(_v194s)')
    text =
      'const _v194s=typeof options2.querySource==="string"&&options2.querySource.startsWith("agent:");const _v194a=(sub)=>getAttributionHeader(fingerprint,{...gates,isSubagent:sub,prevReqId:previousRequestId,promptId,turnOrigin:resolveTurnOrigin(options2.querySource)});' +
      text
    text = once(
      text,
      'if(kinQuery&&kinSystemLayout',
      'if(kinQuery&&options2.requestContext){systemPrompt=asSystemPrompt(systemPrompt)}else if(kinQuery&&kinSystemLayout',
    )
    text = once(
      text,
      'const system=buildSystemPromptBlocks(',
      'const system=options2.requestContext?__vm2apiClassifier194.system(options2.wireSystem,_v194a(true)):buildSystemPromptBlocks(',
    )
    text = once(
      text,
      'if(kinSystemLayout!=="stock"&&Array.isArray(options2.__vm2apiSys)',
      'if(!options2.requestContext&&kinSystemLayout!=="stock"&&Array.isArray(options2.__vm2apiSys)',
    )
    add('classifier-safe-caller-system', systemRange, minStatements(text, minify))
    const qm = sourceFunction(source, 'queryModel')
    const range = (begin, end) => sourceRange(source, begin, end, qm.start)
    const agentic = range('  const isAgenticQuery =', 'if (isKinQuerySource')
    const expression = /const isAgenticQuery = ([^;]+);/.exec(agentic.text)
    requireThat(expression, 'Missing agentic predicate')
    add(
      'classifier-non-agentic-query',
      agentic,
      minStatements(
        once(agentic.text, expression[0], `const isAgenticQuery = !options2.requestContext && (${expression[1]});`),
        minify,
      ),
    )
    const effort = range('const outputConfig =', '    if (options2.outputFormat')
    add(
      'classifier-explicit-effort',
      effort,
      minStatements(
        once(effort.text, '    configureEffortParams(', '    if(!options2.requestContext) configureEffortParams('),
        minify,
      ),
    )
    const thinking = range('const hasThinking =', '    const contextManagement')
    add(
      'classifier-disabled-thinking',
      thinking,
      minStatements(
        once(
          thinking.text,
          '      if (/haiku/i.test(options2.model)) {',
          '      if(options2.requestContext&&options2.wireThinking?.type==="disabled"){thinking={type:"disabled"}}else if (/haiku/i.test(options2.model)) {',
        ),
        minify,
      ),
    )
    const management = range('const contextManagement =', '    const enablePromptCaching2')
    let managementText = once(
      management.text,
      '?? getAPIContextManagement({',
      '?? (options2.requestContext ? undefined : getAPIContextManagement({',
    )
    managementText = once(managementText, '    });', '    }));')
    add('classifier-no-context-default', management, minStatements(managementText, minify))
    const temperature = range('const temperature =', '    const apiMessages')
    add(
      'classifier-no-temperature-default',
      temperature,
      minStatements(
        once(
          temperature.text,
          'options2.temperatureOverride ?? 1',
          'options2.temperatureOverride ?? (options2.requestContext ? undefined : 1)',
        ),
        minify,
      ),
    )
    const cache = range('if(isKinQuerySource(options2.querySource)){', '    return {')
    add(
      'classifier-preserve-cache-anchors',
      cache,
      minStatements(
        once(
          cache.text,
          'if(isKinQuerySource(options2.querySource))',
          'if(isKinQuerySource(options2.querySource)&&!options2.requestContext)',
        ),
        minify,
      ),
    )
    const errors = sourceRange(source, 'var __vm2apiJobError=', '// src/tools/FileReadTool/imageProcessor.ts')
    add(
      'classifier-native-error-metadata',
      errors,
      compact(
        'Errors',
        errorRange(donor).text,
        '{classify:classifyKinJobError,init:init_jobError}',
        '__vm2apiJobError',
      ),
    )
    const native = nativeRange(donor)
    let newNative = once(native.text, errorRange(donor).text, '')
    newNative = once(
      newNative,
      'classifyKinJobError(error40, { sawEvent, message, sdkKind })',
      '__vm2apiJobError.classify(error40, { sawEvent, message, sdkKind })',
    )
    newNative = once(newNative, '  init_jobError();', '  __vm2apiJobError.init();')
    newNative = once(
      newNative,
      '!validClassifierContext(requestContext, request2)',
      '!__vm2apiClassifier194.valid(requestContext, request2)',
    )
    // Shorten only local parameters; preserve the query options property name.
    requireThat(
      !/\b(cX|hO)\b|\.(requestContext|hostOptions)\b|["'](requestContext|hostOptions)["']/.test(newNative),
      'Unexpected native context binding',
    )
    newNative = newNative.replace(/\b(requestContext|hostOptions)\b/g, (name) =>
      name === 'requestContext' ? 'cX' : 'hO',
    )
    newNative = once(newNative, '      cX,\n      wireSystem:', '      requestContext: cX,\n      wireSystem:')
    add(
      'classifier-native-context-dispatch',
      nativeRange(source),
      '// src/kin/stdioProtocol.ts\n' + classifierHelpers + '\n' + minify(newNative).trim(),
    )
  }
  changes.sort((a, b) => a.offset - b.offset)
  const bytes = Buffer.from(original)
  let end = origin
  for (const c of changes) {
    requireThat(c.offset >= end && c.offset + c.bytes <= origin + graph.source.length, 'Overlapping/non-source patch')
    Buffer.concat([Buffer.from(c.after), Buffer.alloc(c.bytes - c.replacement_bytes, 32)]).copy(bytes, c.offset)
    end = c.offset + c.bytes
  }
  verifyUnchangedOutside(original, bytes, changes)
  const finalGraph = inspectBunElf(bytes)
  requireThat(
    JSON.stringify({ ...graph, source: null }) === JSON.stringify({ ...finalGraph, source: null }),
    'ELF/Bun graph changed',
  )
  const final = finalGraph.source.toString('utf8')
  const errorCode =
    kind === 'cc' ? sourceRange(final, 'var __vm2apiJobError=', '// src/tools/FileReadTool/imageProcessor.ts').text : ''
  const native =
    kind === 'cc' ? errorCode + '\n' + nativeRange(final).text : classifierHelpers + '\n' + nativeRange(final).text
  const apiParts = (s) => {
    const start = sourceFunction(s, 'queryModel').start
    const msgStart = s.indexOf('const apiMessages', start)
    const cacheMatch = /if\s*\(isKinQuerySource\(options2.querySource\)/.exec(s.slice(msgStart))
    requireThat(msgStart >= 0 && cacheMatch, 'Missing API cache gate')
    const cacheStart = msgStart + cacheMatch.index,
      cacheEnd = s.indexOf('return {', cacheStart)
    requireThat(cacheEnd > cacheStart && cacheEnd - cacheStart < 1500, 'Unknown API cache region')
    return {
      effort: sourceRange(s, 'const outputConfig', 'if (options2.outputFormat', start).text,
      cache: s.slice(cacheStart, cacheEnd),
      agentic: sourceRange(s, 'const isAgenticQuery', 'if (isKinQuerySource', start).text,
      thinking: sourceRange(s, 'const hasThinking', 'const contextManagement', start).text,
      management: sourceRange(s, 'const contextManagement', 'const enablePromptCaching2', start).text,
      temperature: sourceRange(s, 'const temperature', 'const apiMessages', start).text,
    }
  }
  const semantics = {
    kind,
    query: sourceFunction(final, 'queryKinMessagesWithStreaming').text,
    query_before: query.text,
    system: sourceRange(final, 'const kinSystemLayout', 'const useBetas').text,
    // CC attribution factoring begins just before kinSystemLayout; retain that exact prefix.
    system_before: systemRange.text,
    classifierHelpers,
    native,
    reference_native: helperSource(donor) + '\n' + nativeRange(donor).text,
    reference_query: sourceFunction(donor, 'queryKinMessagesWithStreaming').text,
    api_before: apiParts(source),
    api_after: apiParts(final),
  }
  if (kind === 'cc') semantics.system = sourceRange(final, 'const _v194s=', 'const useBetas').text
  return { bytes, changes, semantics }
}

export async function buildFixedClassifier({ root, outputRoot, evidence, upx, bun, verify }) {
  requireThat(
    root && outputRoot && evidence && upx && bun && typeof verify === 'function',
    'Explicit build inputs/verifier required',
  )
  requireThat(sha256(fs.readFileSync(path.join(root, 'share/wrap-cli/cc-node'))) === ORIGINAL_CC, 'Original CC changed')
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-classifier-'))
  fs.mkdirSync(evidence, { recursive: true })
  const run = (bin, args, opts = {}) =>
    execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 300000, ...opts })
  const minify = (text) =>
    run(
      bun,
      [
        '-e',
        'const t=new Bun.Transpiler({loader:"js",target:"bun",minifyWhitespace:true,minifySyntax:false,minifyIdentifiers:false,deadCodeElimination:false,inline:false});process.stdout.write(t.transformSync(await Bun.stdin.text()))',
      ],
      { input: text },
    )
  const compact = (label, source, result, variable = '__vm2apiClassifier194') => {
    const file = path.join(temp, `helper-${label}.mjs`),
      name = `__vm194${label}`
    fs.writeFileSync(file, `export function ${name}(){${source}\nreturn ${result};}`)
    const built = run(bun, [
      'build',
      file,
      '--target=bun',
      '--minify-whitespace',
      '--minify-identifiers',
      '--minify-syntax',
    ])
    const match = new RegExp('export\\s*\\{\\s*([\\w$]+)\\s+as\\s+' + name + '\\s*\\}').exec(built)
    requireThat(match, 'Unexpected private helper export')
    return 'var ' + variable + '=(' + sourceFunction(built, match[1]).text.trim() + ')();'
  }
  try {
    const originals = {}
    for (const [kind, base] of Object.entries(CLASSIFIER_BASES)) {
      const input = path.join(root, base.input),
        raw = path.join(temp, kind + '.source')
      requireThat(sha256(fs.readFileSync(input)) === base.packed, 'Unknown packed source ' + kind)
      run(upx, ['-d', '-o', raw, input])
      originals[kind] = fs.readFileSync(raw)
    }
    const donor = inspectBunElf(originals.wrap).source.toString('utf8'),
      results = []
    const prepared = {}
    for (const kind of Object.keys(CLASSIFIER_BASES))
      prepared[kind] = patchClassifierBytes(originals[kind], kind, donor, { minify, compact })
    for (const [kind, base] of Object.entries(CLASSIFIER_BASES)) {
      const patched = prepared[kind]
      const parentDir = path.join(root, 'share', kind + '-fixed/v191-r1')
      const parent = JSON.parse(fs.readFileSync(path.join(parentDir, 'manifest.json'), 'utf8'))
      const oldSemantics = JSON.parse(fs.readFileSync(path.join(parentDir, 'semantics.json'), 'utf8'))
      const behavior = await verify(patched.semantics, oldSemantics, kind)
      requireThat(behavior?.ok === true && behavior.checks > 0, 'Native source controls failed')
      const source = inspectBunElf(patched.bytes).source
      const syntax = JSON.parse(
        run(
          bun,
          [
            '-e',
            'const t=new Bun.Transpiler({loader:"js",target:"bun"});const s=t.scan(await Bun.stdin.text());console.log(JSON.stringify({syntax:true,imports:s.imports.length,exports:s.exports.length}))',
          ],
          { input: source },
        ),
      )
      const dir = path.join(outputRoot, kind + '-fixed/v194-r1')
      requireThat(!fs.existsSync(dir), 'Refusing existing output')
      fs.mkdirSync(dir, { recursive: true })
      const raw = path.join(temp, kind + '.patched'),
        packed = path.join(dir, base.file),
        roundtrip = path.join(temp, kind + '.roundtrip')
      fs.writeFileSync(raw, patched.bytes)
      run(upx, ['--best', '--lzma', '-o', packed, raw])
      run(upx, ['-t', packed])
      run(upx, ['-d', '-o', roundtrip, packed])
      requireThat(fs.readFileSync(roundtrip).equals(patched.bytes), 'Unpack roundtrip differs')
      const inherited =
        kind === 'cc' ? [...(parent.inherited_repairs || []), ...parent.artifacts[base.file].patches] : []
      const repairs = inherited.map((p) => {
        requireThat(
          sha256(originals[kind].subarray(p.offset, p.offset + p.bytes)) === p.after_sha256,
          'Unknown inherited repair ' + p.id,
        )
        const overlaps = patched.changes.filter((c) => c.offset < p.offset + p.bytes && p.offset < c.offset + c.bytes)
        const after = sha256(patched.bytes.subarray(p.offset, p.offset + p.bytes))
        if (!overlaps.length) requireThat(after === p.after_sha256, 'Unrelated repair changed ' + p.id)
        return {
          ...p,
          previous_after_sha256: p.after_sha256,
          after_sha256: after,
          preserved: !overlaps.length,
          ...(overlaps.length ? { updated_by: overlaps.map((c) => c.id) } : {}),
        }
      })
      const lifecycle = {
        ...oldSemantics.lifecycle,
        query: patched.semantics.query,
        query_before: patched.semantics.query_before,
        system: patched.semantics.system,
        system_before: patched.semantics.system_before,
        native: patched.semantics.native,
        native_fragments: [patched.semantics.native],
        reference_native: patched.semantics.reference_native,
        reference_query: patched.semantics.reference_query,
        job_error: errorRange(donor).text,
      }
      const patches = json({ [base.file]: patched.changes }),
        semantics = json({
          ...oldSemantics,
          query: patched.semantics.query,
          query_before: patched.semantics.query_before,
          system: patched.semantics.system,
          system_before: patched.semantics.system_before,
          lifecycle,
          classifier: patched.semantics,
        })
      const out = fs.readFileSync(packed)
      const artifact = {
        file: base.file,
        bytes: out.length,
        sha256: sha256(out),
        unpacked_bytes: patched.bytes.length,
        unpacked_sha256: sha256(patched.bytes),
        source_packed_sha256: base.packed,
        source_unpacked_sha256: base.unpacked,
        validations: {
          elf_graph: true,
          no_bytecode: true,
          unchanged_outside_js_spans: true,
          syntax,
          upx_integrity: true,
          exact_unpack_roundtrip: true,
        },
        patches: patched.changes.map(({ before, after, ...p }) => p),
      }
      const manifest = {
        ...parent,
        id: base.id,
        approval: {
          date: '2026-10-03',
          basis: 'owner-authorized locally verified fixed CLI maintenance',
          scope: 'CLI only; not full Linux ELF/provider certification',
        },
        lineage: {
          source_file: base.input,
          source_sha256: base.packed,
          upstream_cli_sha256: CLASSIFIER_BASES.wrap.packed,
          original_cc_sha256: ORIGINAL_CC,
          previous_release: parent.id,
          classifier_reference_commit: '1b735bf',
        },
        classifier_contract: 'native_request_context_v1',
        artifacts: { [base.file]: artifact },
        inherited_repairs: repairs,
        patches_sha256: sha256(patches),
        semantics_sha256: sha256(semantics),
        tools: { upx: run(upx, ['--version']).split(/\r?\n/)[0], bun: run(bun, ['--version']).trim() },
        local_validation: {
          completed: true,
          native_execution: false,
          behavior_tests: behavior.checks,
          scope: 'exact source differential and packaging; no model requests',
        },
      }
      fs.writeFileSync(path.join(dir, 'manifest.json'), json(manifest))
      fs.writeFileSync(path.join(dir, 'patches.json'), patches)
      fs.writeFileSync(path.join(dir, 'semantics.json'), semantics)
      fs.writeFileSync(path.join(evidence, kind + '.unpacked'), patched.bytes)
      results.push({
        kind,
        id: base.id,
        sha256: artifact.sha256,
        bytes: out.length,
        behavior,
        changes: patched.changes.map((c) => ({ id: c.id, bytes: c.bytes, replacement_bytes: c.replacement_bytes })),
      })
    }
    return results
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const arg = (key) => {
    const i = process.argv.indexOf(key)
    return i < 0 ? undefined : process.argv[i + 1]
  }
  const { verifyClassifierSource } = await import('../test/support/fixed-classifier-controls.mjs')
  console.log(
    JSON.stringify(
      await buildFixedClassifier({
        root: arg('--root'),
        outputRoot: arg('--output'),
        evidence: arg('--evidence'),
        upx: arg('--upx'),
        bun: arg('--bun'),
        verify: verifyClassifierSource,
      }),
      null,
      2,
    ),
  )
}
