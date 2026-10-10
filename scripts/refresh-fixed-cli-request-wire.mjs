#!/usr/bin/env node
/** Rebase fixed CLIs onto main's model/field-aware request wire; no private kernel. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { inspectBunElf, sha256, verifyUnchangedOutside } from './build-offline-native-candidates.mjs'
import { sourceRange, sourceFunction } from './refresh-fixed-cli-lifecycle.mjs'
import { auditNativeBindings } from './refresh-fixed-cc-session.mjs'

export const REQUEST_WIRE_REFERENCE = '643f55232ec1950275daaa40adefd46f5d695eba613c622d66e0e8c1968a402c'
export const REQUEST_WIRE_CONTRACT = 'model_field_gates_v1'
export const REQUEST_WIRE_BASES = Object.freeze({
  wrap: {
    id: 'wrap-fixed-v1134-r1',
    file: 'cli-node',
    input: 'share/wrap-cli/cli-node',
    packed: REQUEST_WIRE_REFERENCE,
    unpacked: 'eb42cff204284c4160ae27bb0fda5e5303b54e65d6872b718fb8d5d9bb78d024',
  },
  cc: {
    id: 'cc-fixed-v1134-r1',
    file: 'cc-node',
    input: 'share/cc-fixed/v1124-r1/cc-node',
    packed: '730fd4f27d03d1e1b4496c56554d3565ae4db80967fad6afc54d1618409f8337',
    unpacked: '85c54e6589c6938d937263fe1663f4f9fdc840b189e1356b2ded73962854aead',
  },
})
const need = (v, m) => {
  if (!v) throw Error(m)
}
const json = (v) => Buffer.from(JSON.stringify(v, null, 2) + '\n')
const once = (s, a, b) => {
  need(s.split(a).length === 2, 'Non-unique anchor: ' + a)
  return s.replace(a, b)
}
const nativeRange = (s) => sourceRange(s, '// src/kin/stdioProtocol.ts', '// src/kin/slotPool.ts')
export function requestParamsRange(source) {
  const q = sourceFunction(source, 'queryModel').start
  return sourceRange(source, 'const paramsFromContext', '\n  {\n    const queryParams', q)
}
function moduleAt(source, symbol) {
  const at = source.indexOf(symbol)
  need(at >= 0, 'Missing module: ' + symbol)
  const start = source.lastIndexOf('\n// ', at),
    end = source.indexOf('\n// ', at)
  need(start >= 0 && end > at, 'Invalid module boundary')
  return { start, text: source.slice(start, end) }
}
function initializerObject(source, name) {
  const match = new RegExp(name + ' = (\\{[\\s\\S]*?\\n  \\});').exec(source)
  need(match, 'Missing object initializer: ' + name)
  return match[1]
}
export function protocolGateFactorySource(reference) {
  const block = sourceRange(
    reference,
    '// ../../src/lib/protocol/claude-code-betas.mjs',
    '// src/kin/querySource.ts',
  ).text
  const init = block.indexOf('var init_claude_code_betas'),
    brace = block.indexOf('{', init),
    end = block.lastIndexOf('});')
  need(init > 0 && brace > init && end > brace, 'Gate initializer changed')
  // Pure constant initialization in a private lexical scope; no config/network reads.
  return (
    'export var __vm2apiRequestWire=(()=>{' +
    block.slice(0, init) +
    block.slice(brace + 1, end) +
    '\nreturn {apply:withRequestProtocolBetas,setup:setupTokenBetaHeader,owned:' +
    initializerObject(reference, 'NATIVE_OWNED_FIELDS') +
    '}})();'
  )
}
function arrayInitializer(source, name) {
  const match = new RegExp('\\b' + name + '\\s*=\\s*(\\[[^\\]]*\\])').exec(source)
  need(match, 'Array initializer missing: ' + name)
  return { start: match.index + match[0].indexOf('['), text: match[1] }
}

export function patchRequestWireBytes(original, kind, { reference, minify, helper, parent }) {
  const base = REQUEST_WIRE_BASES[kind]
  need(base && sha256(original) === base.unpacked, 'Unknown request-wire baseline')
  const graph = inspectBunElf(original),
    source = graph.source.toString('utf8')
  need(Buffer.from(source).equals(graph.source), 'Non-lossless source')
  const origin = graph.modules[graph.entry].sourceOffset,
    changes = []
  const add = (id, span, text) => {
    const before = Buffer.from(span.text),
      next = Buffer.from(text)
    need(next.length <= before.length, `${id} exceeds span ${next.length}/${before.length}`)
    const offset = origin + Buffer.byteLength(source.slice(0, span.start))
    need(original.subarray(offset, offset + before.length).equals(before), 'Bad source offset')
    changes.push({
      id,
      offset,
      bytes: before.length,
      replacement_bytes: next.length,
      before: span.text,
      after: text,
      before_sha256: sha256(before),
      after_sha256: sha256(Buffer.concat([next, Buffer.alloc(before.length - next.length, 32)])),
    })
  }
  const minFunction = (text) =>
    minify('export ' + text)
      .trim()
      .replace(/^export\s+/, '')
  const minStatements = (text) => {
    const built = minify('export async function* __wire(){' + text + '}').trim()
    need(
      /^export\s+async\s+function\s*\*\s*__wire\(\)\{/.test(built) && built.endsWith('}'),
      'Minifier wrapper changed',
    )
    return built.slice(built.indexOf('{') + 1, -1) + ';'
  }
  const query = sourceFunction(source, 'queryKinMessagesWithStreaming')
  if (kind === 'wrap') {
    add(
      'caller-system-snapshot',
      query,
      minFunction(once(query.text, '      agentId: "slot",', '      agentId: "slot", __vm2apiSys: system.slice(),')),
    )
    const system = sourceRange(source, 'const kinSystemLayout', 'const extraToolSchemas')
    const split = system.text.indexOf('  } else if (kinSystemLayout !== "stock")')
    need(split > 0, 'System branch changed')
    const first = once(
      system.text.slice(0, split),
      '      }),\n      leftover: leftoverFromSystemPrompt(systemPrompt)',
      '      })',
    )
    const append =
      'if(kinQuery&&!options2.requestContext&&kinSystemLayout!=="stock"&&Array.isArray(options2.__vm2apiSys)&&options2.__vm2apiSys.length){const caller=options2.__vm2apiSys.map(text=>({type:"text",text}));const tail=system[system.length-1];if(tail?.cache_control&&tail.cache_control.scope!=="global"){caller[caller.length-1].cache_control=tail.cache_control;delete tail.cache_control;}system.push(...caller);}'
    add('caller-system-blocks', system, minStatements(first + system.text.slice(split) + append))
  } else {
    need(helper && !source.includes('__vm2apiRequestWire'), 'Helper name collision')
    let bridge = once(query.text, 'signal,wireMessages,outputConfig,', 'signal,wireMessages,wireBody,outputConfig,')
    bridge = once(bridge, 'mcpTools:[],wireMessages,', 'mcpTools:[],wireMessages,wireBody,')
    bridge = once(bridge, 'thinkingDisplay:thinking.type==="adaptive"?thinking.display:void 0,', '')
    add('request-body-bridge', query, minFunction(bridge))
    const native = nativeRange(source)
    add(
      'request-body-native-dispatch',
      native,
      once(
        native.text.trimEnd(),
        'wireMessages:Array.isArray(request2.messages)',
        'wireBody:request2,wireMessages:Array.isArray(request2.messages)',
      ),
    )
    const fp = /packageVersion:\s*"0\.112\.1"/.exec(source)
    need(fp, 'SDK fingerprint changed')
    add('sdk-wire-package-version', { start: fp.index, text: fp[0] }, fp[0].replace('0.112.1', '0.128.0'))
    for (const name of ['MESSAGE', 'EXTRA']) {
      const before = arrayInitializer(source, 'KIN_OFFICIAL_' + name + '_BETAS'),
        after = arrayInitializer(reference, 'OFFICIAL_' + name + '_BETAS')
      add(
        'common-' + name.toLowerCase() + '-betas',
        before,
        minify('export const v=' + after.text)
          .replace(/^export\s+const\s+v\s*=\s*/, '')
          .replace(/;\s*$/, '')
          .trim(),
      )
    }
    const baseModule = moduleAt(source, 'var init_betas2')
    const loop = sourceRange(baseModule.text, '      for (const beta of [', '    if (process.env.ANTHROPIC_BETAS)')
    need(
      loop.text.includes('MID_CONVERSATION_SYSTEM_BETA_HEADER') && loop.text.trimEnd().endsWith('}'),
      'Base beta loop changed',
    )
    const updated =
      baseModule.text.slice(0, loop.start) +
      '      betaHeaders.push(MID_CONVERSATION_SYSTEM_BETA_HEADER);\n    }\n' +
      baseModule.text.slice(loop.start + loop.text.length)
    const debug = parent.inherited_repairs.find((p) => p.id === 'connect-existing-api-debug-bindings')
    need(
      debug && sha256(original.subarray(debug.offset, debug.offset + debug.bytes)) === debug.after_sha256,
      'Existing debug span changed',
    )
    const pad =
      original
        .subarray(debug.offset, debug.offset + debug.bytes)
        .toString()
        .match(/ +$/)?.[0].length || 0
    need(pad >= 1400, 'Expected existing global JS padding')
    const startByte = debug.offset + debug.bytes - pad - origin
    const start = graph.source.subarray(0, startByte).toString().length
    need(start < baseModule.start, 'Noncontiguous beta insertion')
    const prefixEnd = debug.offset + debug.bytes - origin
    const prefixEndChar = graph.source.subarray(0, prefixEnd).toString().length
    const gap = source.slice(prefixEndChar, baseModule.start)
    add(
      'request-protocol-gates',
      { start, text: source.slice(start, baseModule.start + baseModule.text.length) },
      helper + '\n' + gap + minify(updated),
    )

    const params = requestParamsRange(source),
      refParams = requestParamsRange(reference)
    let after = once(
      params.text,
      'if(!options2.requestContext)configureEffortParams',
      'if(!options2.requestContext&&!options2.wireBody)configureEffortParams',
    )
    const oldThinking = sourceRange(after, 'const hasThinking', 'const contextManagement')
    const newThinking = sourceRange(refParams.text, 'const hasThinking', 'const contextManagement')
    after = once(after, oldThinking.text, newThinking.text)
    const tail = sourceRange(after, 'const temperature', '\n  };')
    const refTail = sourceRange(refParams.text, 'const temperature', '\n  };')
    const oldCache = sourceRange(tail.text, 'if(isKinQuerySource', 'return{').text
    const newCache = sourceRange(refTail.text, 'if (isKinQuerySource', 'const nativeExtras').text
    let replaced = once(refTail.text, newCache, oldCache + '\n')
    replaced = replaced
      .replace(/\bsetupTokenBetaHeader\(/g, '__vm2apiRequestWire.setup(')
      .replace(/\bwithRequestProtocolBetas\(/g, '__vm2apiRequestWire.apply(')
      .replace(/\bNATIVE_OWNED_FIELDS\b/g, '__vm2apiRequestWire.owned')
    // Node's trace nonce is an internal control field, not caller API metadata.
    // The preload normally removes it; retain a wire-owner backstop if it is absent.
    replaced = once(
      replaced,
      '{ ...options2.wireBody.metadata, ...getAPIMetadata() }',
      '{...Object.fromEntries(Object.entries(options2.wireBody.metadata).filter(([key])=>key!=="__vm2api_cc_trace")),...getAPIMetadata()}',
    )
    after = once(after, tail.text, replaced)
    add('native-request-parameters', params, minify(after))
    const log = source.indexOf('const logBetas = useBetas ? queryParams.betas ?? [] : [];', params.start)
    need(log >= 0, 'API logging anchor changed')
    add(
      'request-beta-log',
      { start: log, text: 'const logBetas = useBetas ? queryParams.betas ?? [] : [];' },
      'const logBetas = queryParams.betas;',
    )
  }
  changes.sort((a, b) => a.offset - b.offset)
  const bytes = Buffer.from(original)
  let end = origin
  for (const p of changes) {
    need(p.offset >= end && p.offset + p.bytes <= origin + graph.source.length, 'Overlapping/non-JS patch')
    Buffer.concat([Buffer.from(p.after), Buffer.alloc(p.bytes - p.replacement_bytes, 32)]).copy(bytes, p.offset)
    end = p.offset + p.bytes
  }
  verifyUnchangedOutside(original, bytes, changes)
  const next = inspectBunElf(bytes)
  need(
    JSON.stringify({ ...graph, source: null }) === JSON.stringify({ ...next, source: null }),
    'ELF/Bun layout changed',
  )
  return { bytes, changes, sourceBefore: source, sourceAfter: next.source.toString('utf8') }
}

export function requestWireSemantics(source, kind, previous, { reference, helper, sourceBefore }) {
  const sem = structuredClone(previous)
  const query = sourceFunction(source, 'queryKinMessagesWithStreaming').text
  const system = sourceRange(
    source,
    kind === 'wrap' ? 'const kinSystemLayout' : 'const _v194s=',
    kind === 'wrap' ? 'const extraToolSchemas' : 'const useBetas',
  ).text
  const nativePrefix =
    kind === 'wrap'
      ? sourceFunction(source, 'kernelEnv').text +
        '\n' +
        ['validClassifierContext', 'classifierSystemBlocks'].map((n) => sourceFunction(source, n).text).join('\n')
      : sourceRange(source, 'var __vm2apiJobError=', '// src/tools/FileReadTool/imageProcessor.ts').text +
        '\n' +
        sem.session.helper
  const native = nativePrefix + '\n' + nativeRange(source).text
  const helpers =
    kind === 'wrap'
      ? sourceRange(source, '// ../../src/lib/protocol/claude-code-betas.mjs', '// src/kin/querySource.ts').text +
        '\ninit_claude_code_betas();\nvar NATIVE_OWNED_FIELDS=' +
        initializerObject(source, 'NATIVE_OWNED_FIELDS') +
        ';'
      : helper
  const official =
    kind === 'wrap'
      ? sourceRange(source, '// src/kin/officialBetas.ts', '// ../../src/lib/protocol/claude-code-betas.mjs').text
      : sourceRange(source, 'function mergeOfficialExtraBetas', '// src/kin/querySource.ts').text
  const params = requestParamsRange(source).text
  sem.query = query
  sem.lifecycle = {
    ...sem.lifecycle,
    native,
    native_fragments: [native],
    query,
    query_before: sourceFunction(sourceBefore, 'queryKinMessagesWithStreaming').text,
  }
  sem.classifier = {
    ...sem.classifier,
    native,
    query,
    system,
    query_before: sem.lifecycle.query_before,
    direct_wire_thinking: true,
    api_helpers: helpers,
    api_after: {
      ...sem.classifier.api_after,
      thinking: sourceRange(params, 'const hasThinking', 'const contextManagement').text,
      management: sourceRange(params, 'const contextManagement', 'const enablePromptCaching2').text,
      effort: sourceRange(
        params,
        'const outputConfig',
        params.includes('if (options2.outputFormat') ? 'if (options2.outputFormat' : 'if(options2.outputFormat',
      ).text,
      temperature: sourceRange(params, 'const temperature', 'const apiMessages').text,
    },
  }
  if (kind === 'wrap')
    sem.classifier.classifierHelpers = ['validClassifierContext', 'classifierSystemBlocks']
      .map((n) => sourceFunction(source, n).text)
      .join('\n')
  sem.kernel_wire = {
    ...sem.kernel_wire,
    native,
    query,
    system,
    api_body: null,
    api_helpers: helpers,
    entry: sourceFunction(source, 'main2').text,
  }
  sem.request_wire = {
    contract: REQUEST_WIRE_CONTRACT,
    params,
    helpers,
    official_betas: official + '\ninit_officialBetas();',
    query,
    native,
    get_betas_module: moduleAt(source, 'var init_betas2').text,
    cache: sourceRange(source, '// src/kin/cacheTtl.ts', '// src/kin/querySource.ts').text,
    reference_gates: sourceRange(
      reference,
      '// ../../src/lib/protocol/claude-code-betas.mjs',
      '// src/kin/querySource.ts',
    ).text,
    note: 'Current API construction is params, not the old return-object snippet. Older before/reference spans remain historical comparison only.',
  }
  return sem
}

export async function buildFixedRequestWire({ root, outputRoot, evidence, upx, bun, verify }) {
  need(root && outputRoot && evidence && upx && bun && verify, 'Explicit build inputs required')
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-request-wire-'))
  const run = (exe, args, opts = {}) =>
    execFileSync(exe, args, { encoding: 'utf8', timeout: 300000, maxBuffer: 50 * 1024 * 1024, ...opts })
  const minify = (text) =>
    run(
      bun,
      [
        '-e',
        'const t=new Bun.Transpiler({loader:"js",target:"bun",minifyWhitespace:true,minifySyntax:false,minifyIdentifiers:false,deadCodeElimination:false,inline:false});process.stdout.write(t.transformSync(await Bun.stdin.text()))',
      ],
      { input: text },
    )
  fs.mkdirSync(evidence, { recursive: true })
  try {
    const stock = path.join(root, 'share/wrap-cli/cli-node'),
      referenceFile = path.join(temp, 'reference')
    need(sha256(fs.readFileSync(stock)) === REQUEST_WIRE_REFERENCE, 'New original CLI hash mismatch')
    need(
      sha256(fs.readFileSync(path.join(root, 'share/wrap-cli/cc-node'))) ===
        'be5eec49a78345dd935e302e88c9d7ad0afbb09a195356d81be1bdea766f3960',
      'Original CC changed',
    )
    run(upx, ['-d', '-o', referenceFile, stock])
    const reference = inspectBunElf(fs.readFileSync(referenceFile)).source.toString('utf8')
    const helperInput = path.join(temp, 'helper.mjs'),
      helperOut = path.join(temp, 'helper-out.mjs')
    fs.writeFileSync(helperInput, protocolGateFactorySource(reference))
    run(bun, ['build', helperInput, '--target=bun', '--format=esm', '--minify', '--outfile', helperOut])
    const compiled = fs.readFileSync(helperOut, 'utf8'),
      exported = /export\{([\w$]+) as __vm2apiRequestWire\};?\s*$/.exec(compiled)
    need(exported, 'Private helper export changed')
    const helper =
      'var __vm2apiRequestWire=(()=>{' + compiled.slice(0, exported.index) + 'return ' + exported[1] + '})();'
    const results = []
    for (const [kind, base] of Object.entries(REQUEST_WIRE_BASES)) {
      const input = path.join(root, base.input)
      need(sha256(fs.readFileSync(input)) === base.packed, 'Input hash mismatch: ' + kind)
      const beforeFile = path.join(temp, kind + '-before')
      run(upx, ['-d', '-o', beforeFile, input])
      const original = fs.readFileSync(beforeFile)
      const parentDir = path.join(root, 'share', kind + '-fixed/v1124-r1'),
        parent = JSON.parse(fs.readFileSync(path.join(parentDir, 'manifest.json'))),
        previous = JSON.parse(fs.readFileSync(path.join(parentDir, 'semantics.json')))
      const result = patchRequestWireBytes(original, kind, { reference, minify, helper, parent })
      const sem = requestWireSemantics(result.sourceAfter, kind, previous, {
        reference,
        helper,
        sourceBefore: result.sourceBefore,
      })
      const beforeAudit = auditNativeBindings(result.sourceBefore, root),
        afterAudit = auditNativeBindings(result.sourceAfter, root)
      need(afterAudit.native_unresolved.length === 0, 'New native unbound identifiers')
      need(
        JSON.stringify(beforeAudit.whole_unresolved) === JSON.stringify(afterAudit.whole_unresolved),
        'Whole-module unresolved set changed',
      )
      run(bun, ['-e', 'new Bun.Transpiler({loader:"js",target:"bun"}).scan(await Bun.stdin.text())'], {
        input: result.sourceAfter,
      })
      const behavior = await verify(sem, kind)
      need(behavior?.ok && behavior.checks > 0, 'Source controls failed')
      const inherited =
        kind === 'wrap'
          ? []
          : [...parent.inherited_repairs, ...parent.artifacts[base.file].patches].map((p) => {
              const before = original.subarray(p.offset, p.offset + p.bytes),
                after = result.bytes.subarray(p.offset, p.offset + p.bytes)
              need(sha256(before) === p.after_sha256, 'Inherited span changed: ' + p.id)
              return {
                ...p,
                previous_after_sha256: p.after_sha256,
                after_sha256: sha256(after),
                preserved: before.equals(after),
                overlap: result.changes.some((n) => n.offset < p.offset + p.bytes && p.offset < n.offset + n.bytes),
              }
            })
      const dest = path.join(outputRoot, kind + '-fixed/v1134-r1')
      need(!fs.existsSync(dest), 'Refusing overwrite')
      fs.mkdirSync(dest, { recursive: true })
      const changed = path.join(temp, kind + '-after'),
        file = path.join(dest, base.file),
        back = path.join(temp, kind + '-back')
      fs.writeFileSync(changed, result.bytes)
      run(upx, ['--best', '--lzma', '-o', file, changed])
      run(upx, ['-t', file])
      run(upx, ['-d', '-o', back, file])
      need(fs.readFileSync(back).equals(result.bytes), 'Unpack roundtrip mismatch')
      const packed = fs.readFileSync(file),
        patches = json({ [base.file]: result.changes }),
        semBytes = json(sem)
      const artifact = {
        file: base.file,
        bytes: packed.length,
        sha256: sha256(packed),
        unpacked_bytes: result.bytes.length,
        unpacked_sha256: sha256(result.bytes),
        source_packed_sha256: base.packed,
        source_unpacked_sha256: base.unpacked,
        patches: result.changes.map(({ before, after, ...p }) => p),
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
        request_wire_contract: REQUEST_WIRE_CONTRACT,
        approval: {
          date: '2026-10-09',
          basis: 'owner-authorized locally verified fixed maintenance',
          scope:
            'model/field request gates and lossless native passthrough; not provider-refusal bypass or Linux/cloud acceptance',
        },
        lineage: {
          ...parent.lineage,
          source_file: base.input,
          source_sha256: base.packed,
          previous_release: parent.id,
          upstream_cli_sha256: REQUEST_WIRE_REFERENCE,
          request_wire_reference_commit: 'af30a588',
        },
        artifacts: { [base.file]: artifact },
        inherited_repairs: inherited,
        patches_sha256: sha256(patches),
        semantics_sha256: sha256(semBytes),
        tools: { upx: run(upx, ['--version']).split(/\r?\n/)[0], bun: run(bun, ['--version']).trim() },
        local_validation: {
          completed: true,
          native_execution: false,
          behavior_tests: behavior.checks,
          full_source_scope_audit: afterAudit,
          scope: 'actual native/bridge/API/gate fragments, fake SDK, no real provider or Linux execution',
        },
      }
      for (const [name, bytes] of [
        ['manifest.json', json(manifest)],
        ['patches.json', patches],
        ['semantics.json', semBytes],
      ])
        fs.writeFileSync(path.join(dest, name), bytes)
      fs.writeFileSync(path.join(evidence, kind + '.unpacked'), result.bytes)
      fs.writeFileSync(path.join(evidence, kind + '-bindings.json'), json({ before: beforeAudit, after: afterAudit }))
      results.push({ kind, ...artifact, behavior })
    }
    return results
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const arg = (n) => {
    const i = process.argv.indexOf(n)
    return i < 0 ? undefined : process.argv[i + 1]
  }
  const { verifyRequestWireSource } = await import('../test/support/fixed-request-wire-controls.mjs')
  console.log(
    JSON.stringify(
      await buildFixedRequestWire({
        root: arg('--root'),
        outputRoot: arg('--output'),
        evidence: arg('--evidence'),
        upx: arg('--upx'),
        bun: arg('--bun'),
        verify: verifyRequestWireSource,
      }),
      null,
      2,
    ),
  )
}
