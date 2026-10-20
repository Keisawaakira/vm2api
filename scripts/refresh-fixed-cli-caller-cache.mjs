#!/usr/bin/env node
/** Hash-pinned caller-cache maintenance. No private kernel, native execution or slot installation. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { inspectBunElf, sha256, verifyUnchangedOutside } from './build-offline-native-candidates.mjs'
import { sourceRange, sourceFunction } from './refresh-fixed-cli-lifecycle.mjs'
import { auditNativeBindings } from './refresh-fixed-cc-session.mjs'
import { requestParamsRange } from './refresh-fixed-cli-request-wire.mjs'
import { assemblySemantics } from './refresh-fixed-cli-assembly.mjs'

export const CALLER_CACHE_CONTRACT = 'caller_markers_owned_v2'
export const CALLER_CACHE_REFERENCE = Object.freeze({
  packed: '244ef884ce427feba8f0eec6ce7957045c2226e103fb0bec2d7df2949f5bc6c7',
  unpacked: '847abadc69a4a315840113a7e79efb40657584f06d466b785331865f1e6182a6',
  originalCc: 'be5eec49a78345dd935e302e88c9d7ad0afbb09a195356d81be1bdea766f3960',
  commit: '0c8078ec38fa49642bb46420f6270b7654178543',
})
export const CALLER_CACHE_BASES = Object.freeze({
  wrap: Object.freeze({
    id: 'wrap-fixed-v1191-r1',
    file: 'cli-node',
    input: 'share/wrap-cli/cli-node',
    packed: CALLER_CACHE_REFERENCE.packed,
    unpacked: CALLER_CACHE_REFERENCE.unpacked,
  }),
  cc: Object.freeze({
    id: 'cc-fixed-v1191-r1',
    file: 'cc-node',
    input: 'share/cc-fixed/v1152-r1/cc-node',
    packed: 'c75fbb92e0e3b03ff853feb775b9c88e3b504263b16434b847df922ed5f96819',
    unpacked: '4e81f17f1d86d4c7b86e8175f197345a60621ac2d3403e3389ed3cb4949a83c0',
  }),
})
const requireThat = (ok, message) => {
  if (!ok) throw Error(message)
}
const json = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n')
const once = (source, before, after) => {
  requireThat(source.split(before).length === 2, 'Expected one anchor: ' + before)
  return source.replace(before, after)
}
const nativeCallerHelpers = `function __vm191CallerSystem(r, f) {
  const a = r === undefined ? f : typeof r === "string" ? [r] : r;
  if (!Array.isArray(a)) return null;
  const out = [];
  for (const b of a) {
    if (typeof b === "string") out.push({type:"text",text:b});
    else if (b && typeof b === "object" && typeof b.text === "string") out.push({...b});
    else return null;
  }
  return out;
}
function __vm191WireSystem(s) {
  if (!Array.isArray(s) || !s.length || !s.some(b => b && typeof b.text === "string" && /^\\s*x-anthropic-billing-header:/i.test(b.text))) return null;
  return __vm191CallerSystem(s);
}`

function cacheApply(reference, cc = false) {
  let code = sourceFunction(reference, 'applyKinOwnedCacheMarkers').text
  code = once(code, 'preserveSystem = false,', 'preserveSystem = false, preserveSystemTailCount = 0,')
  code = once(
    code,
    'system: preserveSystem ? undefined : params.system,',
    'system: preserveSystem ? undefined : preserveSystemTailCount && Array.isArray(params.system) ? params.system.slice(0,-preserveSystemTailCount) : params.system,',
  )
  code = once(
    code,
    'system: preserveSystem ? params.system : undefined,',
    'system: preserveSystem ? params.system : preserveSystemTailCount && Array.isArray(params.system) ? params.system.slice(-preserveSystemTailCount) : undefined,',
  )
  if (cc)
    code = code
      .replaceAll('collectMarkers(', '__vm191Cache.markers(')
      .replaceAll('fillMissingCacheTtl(', '__vm191Cache.fill(')
      .replaceAll('capCacheMarkers(', '__vm191Cache.cap(')
      .replaceAll('MAX_CACHE_MARKERS', '4')
  // Shorten local bindings only; retain every external option/property name.
  for (const [name, local] of [
    ['params', 'p'],
    ['owned', 'o'],
    ['preservedCount', 'n'],
  ])
    code = code.replace(new RegExp('\\b' + name + '\\b', 'g'), local)
  const options = [
    ['preserveSystem', 's', 'false'],
    ['preserveSystemTailCount', 't', '0'],
    ['preserveToolCount', 'c', '0'],
    ['preserveMessages', 'm', 'false'],
  ]
  for (const [name, local] of options) code = code.replace(new RegExp('\\b' + name + '\\b', 'g'), local)
  for (const [name, local, defaultValue] of options)
    code = once(code, local + ' = ' + defaultValue, name + ':' + local + '=' + defaultValue)
  return code
}

/** Changes are bounded UTF-8 JS spans. The runtime/resource/ELF graph is invariant. */
export function patchCallerCacheBytes(original, kind, { reference, minify, cacheCore, compileParams, parent }) {
  const base = CALLER_CACHE_BASES[kind]
  requireThat(base && sha256(original) === base.unpacked, 'Unknown caller-cache baseline: ' + kind)
  const graph = inspectBunElf(original),
    source = graph.source.toString('utf8')
  requireThat(Buffer.from(source).equals(graph.source), 'Lossy embedded source')
  const origin = graph.modules[graph.entry].sourceOffset,
    changes = []
  const add = (id, span, next) => {
    const before = Buffer.from(span.text),
      after = Buffer.from(next)
    requireThat(after.length <= before.length, `${id} exceeds span ${after.length}/${before.length}`)
    const offset = origin + Buffer.byteLength(source.slice(0, span.start))
    requireThat(original.subarray(offset, offset + before.length).equals(before), 'Source byte offset mismatch')
    changes.push({
      id,
      offset,
      bytes: before.length,
      replacement_bytes: after.length,
      before: span.text,
      after: next,
      before_sha256: sha256(before),
      after_sha256: sha256(Buffer.concat([after, Buffer.alloc(before.length - after.length, 32)])),
    })
  }
  const minFunction = (code) =>
    minify('export ' + code)
      .trim()
      .replace(/^export\s+/, '')
  const minStatements = (code) => {
    const out = minify('export async function* __caller(){' + code + '}').trim()
    requireThat(
      /^export\s+async\s+function\s*\*\s*__caller\(\)\{/.test(out) && out.endsWith('}'),
      'Minifier wrapper changed',
    )
    return out.slice(out.indexOf('{') + 1, -1) + ';'
  }
  const caller =
    'const _cS=kinQuery&&!options2.requestContext&&!kinWireSystem&&kinSystemLayout!=="stock"?__vm191CallerSystem(options2.wireSystem,options2.__vm2apiSys):null;'
  const append = 'if(_cS){for(const block of system)delete block.cache_control;system.push(..._cS);}'
  const systemSpan = sourceRange(
    source,
    kind === 'cc' ? 'const _v194s=' : 'const kinSystemLayout',
    kind === 'cc' ? 'const useBetas' : 'const extraToolSchemas',
  )
  if (kind === 'wrap') {
    const query = sourceFunction(source, 'queryKinMessagesWithStreaming')
    add(
      'caller-system-snapshot',
      query,
      minFunction(once(query.text, '      agentId: "slot",', '      agentId: "slot", __vm2apiSys: system.slice(),')),
    )
    add(
      'lossless-wire-system-helpers',
      sourceFunction(source, 'wireSystemBlocks'),
      minify(nativeCallerHelpers + '\nfunction wireSystemBlocks(input){return __vm191WireSystem(input)}'),
    )
    let system = once(systemSpan.text, '  if (kinWireSystem)', '  ' + caller + '\n  if (kinWireSystem)')
    const split = system.indexOf('  } else if (kinSystemLayout !== "stock")')
    requireThat(split > 0, 'Missing native/non-native system split')
    const native = once(
      system.slice(0, split),
      '      }),\n      leftover: leftoverFromSystemPrompt(systemPrompt)',
      '      })',
    )
    system = native + system.slice(split) + append
    add('caller-system-blocks', systemSpan, minStatements(system))
    add(
      'caller-owned-cache-capacity',
      sourceFunction(source, 'applyKinOwnedCacheMarkers'),
      minFunction(cacheApply(reference)),
    )
    const params = requestParamsRange(source)
    add(
      'caller-owned-cache-dispatch',
      params,
      minify(
        once(
          params.text,
          'preserveSystem: Boolean(kinWireSystem),',
          'preserveSystem: Boolean(kinWireSystem), preserveSystemTailCount: _cS?.length || 0,',
        ),
      ),
    )
  } else {
    requireThat(parent && cacheCore && compileParams, 'CC requires the audited parent and compiled pure cache core')
    // The insertions consume only existing JS whitespace, not executable repair statements.
    const padding = (id, repairId, code) => {
      const patch = parent.inherited_repairs.find((entry) => entry.id === repairId)
      requireThat(
        patch && sha256(original.subarray(patch.offset, patch.offset + patch.bytes)) === patch.after_sha256,
        'Inherited padding source changed: ' + repairId,
      )
      const text = original.subarray(patch.offset, patch.offset + patch.bytes).toString('utf8')
      const spaces = text.match(/ +$/)?.[0].length || 0
      requireThat(spaces > 0 && Buffer.byteLength(code) <= spaces, 'Insufficient existing padding: ' + repairId)
      const offset = patch.offset + patch.bytes - spaces
      const start = graph.source.subarray(0, offset - origin).toString('utf8').length
      add(id, { start, text: ' '.repeat(spaces) }, code)
    }
    // Both these inherited spans end at module scope. The error-handler span
    // also has padding, but is inside queryModel's catch and is not callable here.
    const callerHelper = sourceFunction(nativeCallerHelpers, '__vm191CallerSystem').text
    const wireHelper = sourceFunction(nativeCallerHelpers, '__vm191WireSystem').text
    padding(
      'caller-system-and-owned-cache-helpers',
      'complete-job-session-bootstrap',
      minify(callerHelper + '\n' + cacheApply(reference, true)),
    )
    padding('lossless-wire-system-helper', 'connect-existing-workload-context', minFunction(wireHelper))
    const cache = sourceRange(source, '// src/kin/cacheTtl.ts', '// src/kin/querySource.ts')
    const beta = cache.text.slice(cache.text.indexOf('function mergeOfficialExtraBetas'))
    requireThat(beta.startsWith('function mergeOfficialExtraBetas'), 'Missing original CC beta module')
    const imports = cache.text.slice(0, cache.text.indexOf('function normalizePanelCacheTtl'))
    const wrappers =
      'var explicitCacheTtl=__vm191Cache.explicit,readPanelCacheTtl=__vm191Cache.read,resolveKinCacheTtl=__vm191Cache.resolve,init_cacheTtl=__esm(__vm191Cache.init);'
    add('caller-owned-cache-core', cache, imports + cacheCore + wrappers + minify(beta))
    let system = once(
      systemSpan.text,
      'const kinQuery=isKinQuerySource(options2.querySource);',
      'const kinQuery=isKinQuerySource(options2.querySource);const kinWireSystem=kinQuery&&!options2.requestContext?__vm191WireSystem(options2.wireSystem):null;' +
        caller,
    )
    system = once(
      system,
      'if(kinQuery&&options2.requestContext)',
      'if(kinWireSystem){}else if(kinQuery&&options2.requestContext)',
    )
    system = once(
      system,
      'const system=options2.requestContext?',
      'const system=kinWireSystem?kinWireSystem:options2.requestContext?',
    )
    const oldAppend = system.indexOf(
      'if(!options2.requestContext&&kinSystemLayout!=="stock"&&Array.isArray(options2.__vm2apiSys)',
    )
    requireThat(oldAppend > 0, 'Missing accepted caller system append')
    system = system.slice(0, oldAppend) + append
    add('caller-system-blocks', systemSpan, minStatements(system))
    const params = requestParamsRange(source)
    const oldCache = sourceRange(
      params.text,
      'if(isKinQuerySource(options2.querySource)&&!options2.requestContext)',
      'const core=',
    ).text
    const nextCache = `if(isKinQuerySource(options2.querySource)&&!options2.requestContext){const requestTtl=explicitCacheTtl([system,allTools,apiMessages]);const ttl=resolveKinCacheTtl({system,tools:allTools,messages:apiMessages,panelTtl:requestTtl?undefined:readPanelCacheTtl()});applyKinOwnedCacheMarkers({system,tools:allTools,messages:apiMessages},ttl,{preserveSystem:Boolean(kinWireSystem),preserveSystemTailCount:_cS?.length||0,preserveToolCount:Array.isArray(options2.wireBody?.tools)?options2.wireBody.tools.length:0,preserveMessages:Array.isArray(options2.wireMessages)})}`
    add('caller-owned-cache-dispatch', params, compileParams(once(params.text, oldCache, nextCache)))
  }
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
    'ELF/Bun resource graph changed',
  )
  return { bytes, changes, sourceBefore: source, sourceAfter: next.source.toString('utf8') }
}

export function callerCacheSemantics(result, kind, previous, reference) {
  const oldHelper = previous.request_wire.helpers
  const sem = assemblySemantics(result, kind, previous, reference, oldHelper)
  const helpers = ['__vm191CallerSystem', '__vm191WireSystem']
    .map((name) => sourceFunction(result.sourceAfter, name).text)
    .join('\n')
  const prefix = sourceRange(
    result.sourceAfter,
    kind === 'cc' ? 'const _v194s=' : 'const kinSystemLayout',
    kind === 'cc' ? 'const useBetas' : 'const extraToolSchemas',
  ).text
  const cacheModule = sourceRange(result.sourceAfter, '// src/kin/cacheTtl.ts', '// src/kin/querySource.ts').text
  const cacheSource =
    cacheModule + '\n' + (kind === 'cc' ? sourceFunction(result.sourceAfter, 'applyKinOwnedCacheMarkers').text : '')
  // Active snippets are bound to the new bytes. Named before snippets remain historical controls.
  sem.query = sem.request_wire.query
  sem.system =
    helpers +
    '\n' +
    (kind === 'wrap' ? sourceFunction(result.sourceAfter, 'wireSystemBlocks').text + '\n' : '') +
    prefix
  sem.system_before = previous.system
  sem.cache = cacheSource
  sem.cache_before = previous.cache
  sem.upstream_cache = sourceRange(reference, '// src/kin/cacheTtl.ts', '// src/kin/officialBetas.ts').text
  sem.cache_method = 'applyKinOwnedCacheMarkers'
  sem.classifier.system = sem.system
  sem.kernel_wire.system = sem.system
  sem.caller_cache = {
    contract: CALLER_CACHE_CONTRACT,
    cache_source: cacheSource,
    reference_cache: sem.upstream_cache,
    system_helpers: '',
    previous_system: previous.kernel_wire.system,
    previous_params: previous.request_wire.params,
    previous_cache: previous.request_wire.cache,
    prefix,
    helpers,
    note: 'Caller system blocks and wired tools/messages retain cache marker fields; only owned framework markers are capped. Non-native CC assembly is unchanged.',
  }
  return sem
}

export async function buildFixedCallerCache({ root, outputRoot, evidence, stock, upx, bun, verify }) {
  requireThat(
    root && outputRoot && evidence && stock && upx && bun && verify,
    'Explicit build inputs and verifier required',
  )
  root = path.resolve(root)
  outputRoot = path.resolve(outputRoot)
  evidence = path.resolve(evidence)
  stock = path.resolve(stock)
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-caller-cache-'))
  const run = (file, args, opts = {}) =>
    execFileSync(file, args, { encoding: 'utf8', timeout: 300000, maxBuffer: 50 * 1024 * 1024, ...opts })
  const minify = (code) =>
    run(
      bun,
      [
        '-e',
        'const t=new Bun.Transpiler({loader:"js",target:"bun",minifyWhitespace:true,minifySyntax:false,minifyIdentifiers:false,deadCodeElimination:false,inline:false});process.stdout.write(t.transformSync(await Bun.stdin.text()))',
      ],
      { input: code },
    )
  const compileExport = (source, symbol, name) => {
    const input = path.join(temp, name + '.mjs'),
      output = path.join(temp, name + '-built.mjs')
    fs.writeFileSync(input, 'export ' + source)
    run(bun, ['build', input, '--target=bun', '--format=esm', '--minify', '--outfile', output])
    const text = fs.readFileSync(output, 'utf8'),
      exported = new RegExp('export\\{([\\w$]+) as ' + symbol + '\\};?\\s*$').exec(text)
    requireThat(exported, 'Bundled symbol export changed: ' + symbol)
    return { text: text.slice(0, exported.index), local: exported[1] }
  }
  fs.mkdirSync(evidence, { recursive: true })
  try {
    requireThat(sha256(fs.readFileSync(stock)) === CALLER_CACHE_REFERENCE.packed, 'Stock reference SHA mismatch')
    requireThat(
      sha256(fs.readFileSync(path.join(root, 'share/wrap-cli/cc-node'))) === CALLER_CACHE_REFERENCE.originalCc,
      'Original CC changed',
    )
    const donorFile = path.join(temp, 'stock')
    run(upx, ['-d', '-o', donorFile, stock])
    const donorBytes = fs.readFileSync(donorFile)
    requireThat(sha256(donorBytes) === CALLER_CACHE_REFERENCE.unpacked, 'Stock decompression SHA mismatch')
    const reference = inspectBunElf(donorBytes).source.toString('utf8')
    let cache = sourceRange(reference, '// src/kin/cacheTtl.ts', '// src/kin/officialBetas.ts').text
    cache = cache.replace(/^\/\/[^\n]*\nimport[^\n]*\n/, '').replaceAll('readFileSync8', 'readFileSync12')
    cache = once(cache, sourceFunction(cache, 'applyKinOwnedCacheMarkers').text, '')
    const core = compileExport(
      'const __vm191Cache=(()=>{' +
        cache +
        'return {explicit:explicitCacheTtl,read:readPanelCacheTtl,resolve:resolveKinCacheTtl,markers:collectMarkers,fill:fillMissingCacheTtl,cap:capCacheMarkers,init:init_cacheTtl}})();',
      '__vm191Cache',
      'cache-core',
    )
    const cacheCore = 'var __vm191Cache=(()=>{' + core.text + 'return ' + core.local + '})();'
    const compileParams = (code) => {
      // Preserve semantic boundary names; shorten only private local bindings.
      // Bundling this whole constructor renames those boundaries and would leave
      // the retained fixture pointing at an alias instead of the executable body.
      for (const [name, local] of [
        ['retryContext', 'rC'],
        ['requestBetas', 'rB'],
        ['inferenceOnly', 'iO'],
        ['callerBetas', 'cB'],
        ['isFastModeForRetry', 'fR'],
      ]) {
        requireThat(!new RegExp('\\b' + local + '\\b').test(code), 'Local binding collision: ' + local)
        requireThat(!new RegExp('[.\\\"\' ]' + name + '[:\\\"\']').test(code), 'Unexpected local property: ' + name)
        code = code.replace(new RegExp('\\b' + name + '\\b', 'g'), local)
      }
      return minify('export ' + code)
        .trim()
        .replace(/^export\s+/, '')
    }
    const outputs = []
    for (const [kind, base] of Object.entries(CALLER_CACHE_BASES)) {
      const parentDir = path.join(root, 'share', kind + '-fixed/v1152-r1')
      const parent = JSON.parse(fs.readFileSync(path.join(parentDir, 'manifest.json')))
      requireThat(
        sha256(fs.readFileSync(path.join(parentDir, 'patches.json'))) === parent.patches_sha256,
        'Parent patches SHA mismatch',
      )
      requireThat(
        sha256(fs.readFileSync(path.join(parentDir, 'semantics.json'))) === parent.semantics_sha256,
        'Parent semantics SHA mismatch',
      )
      const previous = JSON.parse(fs.readFileSync(path.join(parentDir, 'semantics.json')))
      const input = kind === 'wrap' ? stock : path.join(root, base.input)
      requireThat(sha256(fs.readFileSync(input)) === base.packed, 'Input packed SHA mismatch: ' + kind)
      const unpacked = path.join(temp, kind + '-before')
      run(upx, ['-d', '-o', unpacked, input])
      const original = fs.readFileSync(unpacked)
      const result = patchCallerCacheBytes(original, kind, { reference, minify, cacheCore, compileParams, parent })
      const sem = callerCacheSemantics(result, kind, previous, reference)
      const beforeAudit = auditNativeBindings(result.sourceBefore, root),
        afterAudit = auditNativeBindings(result.sourceAfter, root)
      // Persist preflight evidence even when a binding gate rejects the build.
      fs.writeFileSync(path.join(evidence, kind + '-bindings.json'), json({ before: beforeAudit, after: afterAudit }))
      fs.writeFileSync(path.join(evidence, kind + '-patched-source.mjs'), result.sourceAfter)
      requireThat(afterAudit.native_unresolved.length === 0, 'Unbound native references')
      const newUnresolved = afterAudit.whole_unresolved.filter((name) => !beforeAudit.whole_unresolved.includes(name))
      requireThat(newUnresolved.length === 0, 'New unbound whole-source reference: ' + newUnresolved.join(', '))
      run(bun, ['-e', 'new Bun.Transpiler({loader:"js",target:"bun"}).scan(await Bun.stdin.text())'], {
        input: result.sourceAfter,
      })
      const behavior = await verify(sem, kind, previous)
      requireThat(behavior?.ok && behavior.checks > 0, 'Executable source controls failed')
      const inherited =
        kind === 'wrap'
          ? []
          : [...parent.inherited_repairs, ...parent.artifacts[base.file].patches].map((entry) => {
              const before = original.subarray(entry.offset, entry.offset + entry.bytes),
                after = result.bytes.subarray(entry.offset, entry.offset + entry.bytes)
              requireThat(sha256(before) === entry.after_sha256, 'Changed inherited input span: ' + entry.id)
              return {
                ...entry,
                previous_after_sha256: entry.after_sha256,
                after_sha256: sha256(after),
                preserved: before.equals(after),
                overlap: result.changes.some(
                  (patch) => patch.offset < entry.offset + entry.bytes && entry.offset < patch.offset + patch.bytes,
                ),
              }
            })
      const dir = path.join(outputRoot, kind + '-fixed/v1191-r1')
      requireThat(!fs.existsSync(dir), 'Refusing output overwrite: ' + dir)
      fs.mkdirSync(dir, { recursive: true })
      const raw = path.join(temp, kind + '-after'),
        file = path.join(dir, base.file),
        roundtrip = path.join(temp, kind + '-roundtrip')
      fs.writeFileSync(raw, result.bytes)
      run(upx, ['--best', '--lzma', '-o', file, raw])
      run(upx, ['-t', file])
      run(upx, ['-d', '-o', roundtrip, file])
      requireThat(fs.readFileSync(roundtrip).equals(result.bytes), 'UPX exact roundtrip failed')
      const packed = fs.readFileSync(file),
        patches = json({ [base.file]: result.changes }),
        semantics = json(sem)
      const artifact = {
        file: base.file,
        bytes: packed.length,
        sha256: sha256(packed),
        unpacked_bytes: result.bytes.length,
        unpacked_sha256: sha256(result.bytes),
        source_packed_sha256: base.packed,
        source_unpacked_sha256: base.unpacked,
        patches: result.changes.map(({ before, after, ...entry }) => entry),
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
        cache_contract: CALLER_CACHE_CONTRACT,
        approval: {
          date: '2026-10-18',
          basis: 'owner-authorized locally verified fixed maintenance',
          scope: 'caller-owned cache/system and upstream native interfaces; no Linux/cloud acceptance',
        },
        lineage: {
          ...parent.lineage,
          source_file: base.input,
          source_sha256: base.packed,
          previous_release: parent.id,
          upstream_cli_sha256: CALLER_CACHE_REFERENCE.packed,
          caller_cache_reference_commit: CALLER_CACHE_REFERENCE.commit,
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
          scope:
            'actual native/bridge/system/API/cache with external boundaries substituted; not Linux ELF/provider execution',
        },
      }
      for (const [name, value] of [
        ['manifest.json', json(manifest)],
        ['patches.json', patches],
        ['semantics.json', semantics],
      ])
        fs.writeFileSync(path.join(dir, name), value)
      fs.writeFileSync(path.join(evidence, kind + '.unpacked'), result.bytes)
      fs.writeFileSync(path.join(evidence, kind + '-bindings.json'), json({ before: beforeAudit, after: afterAudit }))
      outputs.push({ kind, ...artifact, behavior })
    }
    return outputs
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const arg = (name) => {
    const at = process.argv.indexOf(name)
    return at < 0 ? undefined : process.argv[at + 1]
  }
  const { verifyCallerCacheSource } = await import('../test/support/fixed-caller-cache-controls.mjs')
  const { verifyAssemblySource } = await import('../test/support/fixed-assembly-controls.mjs')
  const verify = async (sem, kind) => {
    const caller = await verifyCallerCacheSource(sem, kind),
      assembly = await verifyAssemblySource(sem, kind)
    return { ok: caller.ok && assembly.ok, checks: caller.checks + assembly.checks, caller, assembly }
  }
  console.log(
    JSON.stringify(
      await buildFixedCallerCache({
        root: arg('--root'),
        outputRoot: arg('--output'),
        evidence: arg('--evidence'),
        stock: arg('--stock'),
        upx: arg('--upx'),
        bun: arg('--bun'),
        verify,
      }),
      null,
      2,
    ),
  )
}
