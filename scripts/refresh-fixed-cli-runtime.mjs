#!/usr/bin/env node
/** CLI-only v201 runtime maintenance. Shared kernel and production slots are not written. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { inspectBunElf, sha256, verifyUnchangedOutside } from './build-offline-native-candidates.mjs'
import { sourceFunction, sourceRange } from './refresh-fixed-cli-lifecycle.mjs'
import { requestParamsRange } from './refresh-fixed-cli-request-wire.mjs'
import { callerCacheSemantics } from './refresh-fixed-cli-caller-cache.mjs'
import { assemblyFactorySource } from './refresh-fixed-cli-assembly.mjs'
import { auditNativeBindings } from './refresh-fixed-cc-session.mjs'

export const RUNTIME_CONTRACT = 'system_cch_runtime_v1'
export const RUNTIME_REFERENCE = Object.freeze({
  packed: '049200f56fb1cf8f56b4704ab6b793d749fd45c13b87e6ed664cef62a3ddc8e3',
  unpacked: 'c2fa9ba0f60aa1cb57608d6bb7e6e5fa5f2dfcf7da9d202307b791a6c6f8a3e2',
  originalCc: 'be5eec49a78345dd935e302e88c9d7ad0afbb09a195356d81be1bdea766f3960',
  commit: '60f6335167d2969418fb27cb2160294f9c6e4bf3',
})
export const RUNTIME_BASES = Object.freeze({
  wrap: Object.freeze({
    id: 'wrap-fixed-v1201-r1',
    file: 'cli-node',
    input: 'share/wrap-cli/cli-node',
    packed: RUNTIME_REFERENCE.packed,
    unpacked: RUNTIME_REFERENCE.unpacked,
  }),
  cc: Object.freeze({
    id: 'cc-fixed-v1201-r1',
    file: 'cc-node',
    input: 'share/cc-fixed/v1191-r1/cc-node',
    packed: '7f03168ee918ab4a1701434f9c881b39acc64d4850404a93ad6c9ed1dc657ec6',
    unpacked: '4d578417286d8f91dc4e74461644d1462e9ef2011f52c74930c7e1a4b0943c03',
  }),
})
const need = (ok, message) => {
  if (!ok) throw Error(message)
}
const json = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n')
const once = (source, before, after) => {
  need(source.split(before).length === 2, 'Non-unique anchor: ' + before)
  return source.replace(before, after)
}
function moduleSpan(source, symbol) {
  const at = source.indexOf('var ' + symbol)
  need(at >= 0, 'Missing initializer: ' + symbol)
  const start = source.lastIndexOf('\n// ', at) + 1,
    end = source.indexOf('\n// ', at)
  need(start > 0 && end > at, 'Incomplete module: ' + symbol)
  return { start, text: source.slice(start, end) }
}
const callerHelpers = `function __vm191CallerSystem(r,f){const a=r===undefined?f:typeof r==="string"?[r]:r;if(!Array.isArray(a))return null;const out=[];for(const b of a){if(typeof b==="string")out.push({type:"text",text:b});else if(b&&typeof b==="object"&&typeof b.text==="string")out.push({...b});else return null}return out}
function __vm191WireSystem(s){if(!Array.isArray(s)||!s.length||!s.some(b=>b&&typeof b.text==="string"&&/^\\s*x-anthropic-billing-header:/i.test(b.text)))return null;return __vm191CallerSystem(s)}`
const cacheOwnership = `function applyKinOwnedCacheMarkers(params,ttl,{preserveSystem=false,preserveSystemTailCount=0,preserveMessages=false,preserveTools=false,preserveToolCount=0}={}){
 const owned={system:preserveSystem?undefined:preserveSystemTailCount&&Array.isArray(params.system)?params.system.slice(0,-preserveSystemTailCount):params.system,tools:preserveTools?undefined:Array.isArray(params.tools)?params.tools.slice(preserveToolCount):params.tools,messages:preserveMessages?undefined:params.messages};
 const count=collectMarkers({system:preserveSystem?params.system:preserveSystemTailCount&&Array.isArray(params.system)?params.system.slice(-preserveSystemTailCount):undefined,tools:preserveTools?params.tools:Array.isArray(params.tools)?params.tools.slice(0,preserveToolCount):undefined,messages:preserveMessages?params.messages:undefined}).length;
 fillMissingCacheTtl(owned,ttl);capCacheMarkers(owned,Math.max(0,MAX_CACHE_MARKERS-count));}`
// Restrict stamping to system billing fields, matching main's Node seal. A user
// literal preceding system in serialized property order is still caller text.
const systemCch = `function __vm201SystemCch(body,value){let seen=false;const edit=text=>{if(typeof text!=="string")return text;return text.replace(/(^\\s*x-anthropic-billing-header:[^\\r\\n]*?\\bcch=)[0-9a-f]{5}(?=;)/gim,(_match,prefix)=>{seen=true;return prefix+value})};if(typeof body.system==="string")body.system=edit(body.system);else if(Array.isArray(body.system))body.system=body.system.map(block=>typeof block==="string"?edit(block):block&&typeof block.text==="string"?{...block,text:edit(block.text)}:block);return seen}
function projectForCch(body){let material=body;try{const parsed=JSON.parse(body);__vm201SystemCch(parsed,"00000");material=JSON.stringify(parsed)}catch{}return skipMaxTokens(skipCredit(skipFallbacks(blankStringModels(material))))}
function stampCchBody(body,enabled=true){if(!enabled)return body;let parsed;try{parsed=JSON.parse(body)}catch{return body}if(!__vm201SystemCch(parsed,"00000"))return body;const placeholder=JSON.stringify(parsed);__vm201SystemCch(parsed,computeCch(placeholder));return JSON.stringify(parsed)}`
const ccConfig = `var __vm201CchEnabled=true,__vm201CachedEnabled=false;
function __vm201ConfigFlag(k,p,d,f=process.env.KERNEL_CONFIG||"/run/kin/kernel.json"){try{const c=JSON.parse(readFileSync12(f,"utf8"));if(c&&typeof c==="object"&&!Array.isArray(c)){if(!(k in c))return d;if(typeof c[k]==="boolean")return c[k]}}catch{}return p}
function readPanelCchEnabled(f){return __vm201CchEnabled=__vm201ConfigFlag("cch_enabled",__vm201CchEnabled,true,f)}
function readPanelCachedMicrocompactEnabled(f){return __vm201CachedEnabled=__vm201ConfigFlag("cached_microcompact_enabled",__vm201CachedEnabled,false,f)}
function __vm201CheckCachedMode(){if(readPanelCachedMicrocompactEnabled())throw new Error(__vm201CachedUnavailable)}
function __vm201BillingIndexes(messages){if(!Array.isArray(messages))return null;for(const m of messages){if(!m||typeof m!=="object")continue;const role=m.role??m.message?.role??m.type;const content=m.content??m.message?.content;if(role==="user"&&!(Array.isArray(content)&&content.length&&content.every(b=>b?.type==="tool_result")))return{promptIndex:0,turnIndex:1}}return null}
`
// The pinned CLI payload precedes main's thread/output-config gate. Preserve
// that final-wire gate in both native implementations, not just the Node hop.
const threadOutputModels = [
  'claude-haiku-5-5',
  'claude-sonnet-5-5',
  'claude-opus-5',
  'claude-opus-5-5',
  'claude-fable-5-1',
  'claude-mythos-5-1',
]
function threadGateReference(reference) {
  const gate = sourceFunction(reference, 'withRequestProtocolBetas').text
  // Reuse the donor's exact table minus its two non-thread models to fit the
  // original CC helper span. Reject future table drift, never widen the gate.
  const table = /MID_TOOL_CHANGE_MODELS = (\{[\s\S]*?\n  \});/.exec(reference)
  need(table, 'Missing donor model table')
  const excluded = ['claude-opus-4-8', 'claude-fable-5']
  const models = [...table[1].matchAll(/"(claude-[\w-]+)": true/g)].map((match) => match[1])
  need(
    JSON.stringify(models.filter((model) => !excluded.includes(model)).sort()) ===
      JSON.stringify([...threadOutputModels].sort()),
    'Donor thread/output-config model relationship changed',
  )
  return once(
    reference,
    gate,
    once(
      gate,
      '  if (body.output_config?.effort != null)',
      `  if(body.thread!=null&&Object.hasOwn(MID_TOOL_CHANGE_MODELS,model)&&!${JSON.stringify(excluded)}.includes(model))add(BETA_MID_CONVERSATION_OUTPUT_CONFIG);\n  if (body.output_config?.effort != null)`,
    ),
  )
}
const compactUnavailable =
  'cached_microcompact_unavailable: enabled in kernel.json, but this CLI build has no cache-editing implementation'
const compactErrors = `var __vm201CachedUnavailable=${JSON.stringify(compactUnavailable)};
function __vm201CachedError(m){return m.startsWith("cached_microcompact_unavailable:")?{error:m,code:"cached_microcompact_unavailable",status:400,error_type:"invalid_request_error"}:null}`

export function patchRuntimeBytes(
  original,
  kind,
  { reference, minify, compileFunction, compileFactory, previous, helperPatch },
) {
  const base = RUNTIME_BASES[kind]
  need(base && sha256(original) === base.unpacked, 'Unknown runtime baseline: ' + kind)
  const graph = inspectBunElf(original),
    source = graph.source.toString('utf8')
  need(Buffer.from(source).equals(graph.source), 'Embedded source is not lossless UTF-8')
  const origin = graph.modules[graph.entry].sourceOffset,
    changes = []
  let assemblyHelper = null
  const add = (id, span, code) => {
    const before = Buffer.from(span.text),
      after = Buffer.from(code)
    need(after.length <= before.length, `${id} exceeds fixed span ${after.length}/${before.length}`)
    const offset = origin + Buffer.byteLength(source.slice(0, span.start))
    need(original.subarray(offset, offset + before.length).equals(before), 'Wrong source offset: ' + id)
    changes.push({
      id,
      offset,
      bytes: before.length,
      replacement_bytes: after.length,
      before: span.text,
      after: code,
      before_sha256: sha256(before),
      after_sha256: sha256(Buffer.concat([after, Buffer.alloc(before.length - after.length, 32)])),
    })
  }
  const minFunction = (code) =>
    compileFunction
      ? compileFunction(code)
      : minify('export ' + code)
          .trim()
          .replace(/^export\s+/, '')
  const minStatements = (code) => {
    const result = minify('export async function* __runtime(){' + code + '}')
      .trim()
      .replace(/^export\s+/, '')
    need(
      result.startsWith('async function*__runtime(){') || result.startsWith('async function* __runtime(){'),
      'Unexpected minifier',
    )
    return result.slice(result.indexOf('{') + 1, -1) + ';'
  }
  let cch = moduleSpan(source, 'init_cch').text
  cch = once(cch, sourceFunction(cch, 'projectForCch').text, sourceFunction(systemCch, 'projectForCch').text)
  cch = once(cch, sourceFunction(cch, 'stampCchBody').text, sourceFunction(systemCch, 'stampCchBody').text)
  cch = sourceFunction(systemCch, '__vm201SystemCch').text + '\n' + cch
  if (kind === 'cc') cch += '\n' + compactErrors
  else cch += '\n' + callerHelpers + '\nfunction wireSystemBlocks(s){return __vm191WireSystem(s)}'
  add('system-only-canonical-cch', moduleSpan(source, 'init_cch'), '// src/utils/cch.ts\n' + minify(cch))
  const caller =
    'const _cS=kinQuery&&!options2.requestContext&&!kinWireSystem&&kinSystemLayout!=="stock"?__vm191CallerSystem(options2.wireSystem,options2.__vm2apiSys):null;'
  const append = 'if(_cS){for(const block of system)delete block.cache_control;system.push(..._cS)}'
  if (kind === 'wrap') {
    add(
      'thread-output-config-gate',
      sourceFunction(source, 'withRequestProtocolBetas'),
      minFunction(sourceFunction(threadGateReference(reference), 'withRequestProtocolBetas').text),
    )
    const query = sourceFunction(source, 'queryKinMessagesWithStreaming')
    add(
      'caller-system-snapshot',
      query,
      minFunction(once(query.text, '      agentId: "slot",', '      agentId: "slot", __vm2apiSys: system.slice(),')),
    )
    const layout = sourceRange(source, 'const kinSystemLayout', 'const extraToolSchemas')
    let code = once(
      layout.text,
      '  if (kinQuery && options2.requestContext)',
      '  const kinWireSystem=kinQuery&&!options2.requestContext?wireSystemBlocks(options2.wireSystem):null;' +
        caller +
        '\n  if(kinWireSystem);else if (kinQuery && options2.requestContext)',
    )
    const split = code.indexOf('  } else if (kinSystemLayout !== "stock")')
    need(split > 0, 'Missing native system branch')
    code =
      once(code.slice(0, split), '      }),\n      leftover: leftoverFromSystemPrompt(systemPrompt)', '      })') +
      code.slice(split)
    code = once(
      code,
      'const system = options2.requestContext ?',
      'const system = kinWireSystem?kinWireSystem:options2.requestContext ?',
    )
    add('caller-system-blocks', layout, minStatements(code + append))
    add('caller-owned-cache-capacity', sourceFunction(source, 'applyKinOwnedCacheMarkers'), minFunction(cacheOwnership))
    const params = requestParamsRange(source)
    add(
      'caller-owned-cache-dispatch',
      params,
      minify(
        once(
          params.text,
          'applyKinOwnedCacheMarkers({ system, tools: allTools, messages: apiMessages }, ttl);',
          'applyKinOwnedCacheMarkers({system,tools:allTools,messages:apiMessages},ttl,{preserveSystem:Boolean(kinWireSystem),preserveSystemTailCount:_cS?.length||0,preserveToolCount:Array.isArray(options2.wireBody?.tools)?options2.wireBody.tools.length:0,preserveMessages:Array.isArray(options2.wireMessages)});',
        ),
      ),
    )
  } else {
    need(previous && compileFactory, 'CC requires its own sealed helper and factory compiler')
    const oldHelper = previous.request_wire.helpers
    const helperAt = source.indexOf(oldHelper)
    need(helperAt >= 0 && source.indexOf(oldHelper, helperAt + 1) < 0, 'CC helper must match its recorded parent')
    need(
      helperPatch && helperPatch.bytes > oldHelper.length && helperPatch.bytes < 65536,
      'CC requires its exact inherited helper span',
    )
    const gateBytes = original.subarray(helperPatch.offset, helperPatch.offset + helperPatch.bytes)
    need(sha256(gateBytes) === helperPatch.after_sha256, 'CC inherited helper span hash changed')
    const gate = {
      start: graph.source.subarray(0, helperPatch.offset - origin).toString('utf8').length,
      text: gateBytes.toString('utf8'),
    }
    need(gate.start === helperAt && gate.text.startsWith(oldHelper), 'CC helper gate boundary changed')
    const helper = compileFactory(assemblyFactorySource(threadGateReference(reference)))
    assemblyHelper = helper
    add('thread-output-config-assembly-helper', gate, helper + '\n' + minify(gate.text.slice(oldHelper.length)))
    const fetch = sourceFunction(source, 'buildFetch')
    let next = fetch.text
    next = next
      .replaceAll('stampCchBody(body)', 'stampCchBody(body,readPanelCchEnabled())')
      .replaceAll('stampCchBody(text)', 'stampCchBody(text,readPanelCchEnabled())')
    next = once(
      next,
      'if(stamped!==body)body=stamped',
      'if(stamped!==body){body=stamped;headers.delete("content-length")}',
    )
    next = once(
      next,
      'if(stamped!==text)body=new TextEncoder().encode(stamped)',
      'if(stamped!==text){body=new TextEncoder().encode(stamped);headers.delete("content-length")}',
    )
    add('cch-hot-config-fetch', fetch, minFunction(next))
    const attribution = sourceFunction(source, 'getAttributionHeader')
    const attrModule = moduleSpan(source, 'init_system')
    let attrCode = once(
      attrModule.text,
      attribution.text,
      sourceFunction(reference, 'getAttributionHeader')
        .text.replaceAll('getWorkload()', 'getWorkload2()')
        .replaceAll('logForDebugging(', 'logForDebugging2('),
    )
    attrCode =
      sourceFunction(reference, 'boundedBillingIndex').text +
      '\n' +
      once(attrCode, 'var DEFAULT_PREFIX', 'var BILLING_INDEX_MAX=1e7;var DEFAULT_PREFIX')
    add('billing-attribution-indexes', attrModule, '// src/constants/system.ts\n' + minify(attrCode))
    add(
      'billing-placeholder',
      sourceFunction(source, 'withCchPlaceholder'),
      minFunction(sourceFunction(reference, 'withCchPlaceholder').text),
    )
    const layout = sourceRange(source, 'const _v194s=', 'const useBetas')
    add(
      'billing-index-dispatch',
      layout,
      minify(
        once(
          layout.text,
          'turnOrigin:resolveTurnOrigin(options2.querySource)',
          'turnOrigin:resolveTurnOrigin(options2.querySource),...__vm201BillingIndexes(messagesForAPI)',
        ),
      ),
    )
    // The stock payload itself has no cached-MC implementation. Do not add
    // stubs or silently ignore a requested mode; surface its existing error.
    const micro = moduleSpan(source, 'init_microCompact')
    let mc = micro.text
    mc = once(mc, '  if (false) {}\n  return { messages };', '  __vm201CheckCachedMode();\n  return { messages };')
    mc = once(mc, '  init_timeBasedMCConfig();', '  init_timeBasedMCConfig();\n  init_cch();')
    add(
      'explicit-cached-microcompact-unavailable',
      micro,
      '// src/services/compact/microCompact.ts\n' + minify(ccConfig + '\n' + mc),
    )
    const queryStart = sourceFunction(source, 'queryModel').start
    const compactGate = sourceRange(source, 'let cachedMCEnabled', 'if (useGlobalCacheFeature', queryStart)
    add(
      'cached-microcompact-query-gate',
      compactGate,
      minify(once(compactGate.text, 'if (false) {}', '__vm201CheckCachedMode();')),
    )
    const error = sourceRange(source, 'var __vm2apiJobError=', '// src/tools/FileReadTool/imageProcessor.ts')
    const classifier = /return\{classify:([\w$]+),init:/.exec(error.text)?.[1]
    need(classifier, 'Missing real error classifier')
    const fn = sourceFunction(error.text, classifier).text
    const changed = once(
      fn,
      'if(r instanceof APIError',
      'let z=__vm201CachedError(s);if(z)return z;if(r instanceof APIError',
    )
    add('cached-microcompact-error-detail', error, minify(once(error.text, fn, changed)))
  }
  changes.sort((a, b) => a.offset - b.offset)
  const bytes = Buffer.from(original)
  let end = origin
  for (const patch of changes) {
    need(
      patch.offset >= end && patch.offset + patch.bytes <= origin + graph.source.length,
      'Overlapping/non-JS patch: ' + patch.id,
    )
    Buffer.concat([Buffer.from(patch.after), Buffer.alloc(patch.bytes - patch.replacement_bytes, 32)]).copy(
      bytes,
      patch.offset,
    )
    end = patch.offset + patch.bytes
  }
  verifyUnchangedOutside(original, bytes, changes)
  const next = inspectBunElf(bytes)
  need(
    JSON.stringify({ ...graph, source: null }) === JSON.stringify({ ...next, source: null }),
    'ELF/resource graph changed',
  )
  return { bytes, changes, assemblyHelper, sourceBefore: source, sourceAfter: next.source.toString('utf8') }
}

export function runtimeSemantics(result, kind, previous, reference) {
  const sem = callerCacheSemantics(result, kind, previous, reference)
  // Before snippets stay sealed historical controls, not assertions that their
  // bytes were loaded from a deleted ancestor in this maintenance round.
  sem.system_before = previous.system_before
  sem.caller_cache.previous_system = previous.caller_cache.previous_system
  const source = result.sourceAfter
  // Module order changed upstream: cache -> querySource now crosses SDKs and
  // async_hooks. Bind controls to the actual cache module, not that old interval.
  const cacheModule =
    kind === 'cc'
      ? sourceRange(source, '// src/kin/cacheTtl.ts', 'function mergeOfficialExtraBetas').text
      : moduleSpan(source, 'init_cacheTtl').text
  const cache = cacheModule + (kind === 'cc' ? '\n' + sourceFunction(source, 'applyKinOwnedCacheMarkers').text : '')
  const referenceCache = moduleSpan(reference, 'init_cacheTtl').text
  sem.cache = cache
  sem.request_wire.cache = cache
  sem.caller_cache.cache_source = cache
  sem.upstream_cache = referenceCache
  // The new upstream API replaces preserveToolCount with all-or-nothing
  // preserveTools. Fixed still owns only its generated tool suffix. Keep the
  // real prefix-aware donor for that contract, plus the new donor separately.
  sem.caller_cache.reference_cache = previous.caller_cache.reference_cache
  sem.caller_cache.current_reference_cache = referenceCache
  sem.caller_cache.reference_note =
    'Prefix-count ownership is compared to the sealed v1191 donor; current upstream whole-section ownership is an additional control.'
  sem.runtime_wire = {
    contract: RUNTIME_CONTRACT,
    cch: moduleSpan(source, 'init_cch').text,
    fetch: sourceFunction(source, 'buildFetch').text,
    attribution: sourceFunction(source, 'getAttributionHeader').text,
    placeholder: sourceFunction(source, 'withCchPlaceholder').text,
    compact: sourceFunction(source, 'microcompactMessages').text,
    compact_gate: sourceRange(
      source,
      'let cachedMCEnabled',
      'const useGlobalCacheFeature',
      sourceFunction(source, 'queryModel').start,
    ).text,
    compact_error:
      kind === 'cc'
        ? sourceFunction(source, '__vm201CachedError').text +
          '\n' +
          sourceRange(source, 'var __vm2apiJobError=', '// src/tools/FileReadTool/imageProcessor.ts').text
        : sourceFunction(source, 'classifyKinJobError').text,
    reference_fetch: sourceFunction(reference, 'buildFetch').text,
    reference_attribution: sourceFunction(reference, 'getAttributionHeader').text,
    reference_compact: sourceFunction(reference, 'microcompactMessages').text,
    compact_implementation: 'unavailable_in_pinned_stock_payload',
    config:
      kind === 'wrap'
        ? cacheModule
        : sourceRange(source, 'var __vm201CchEnabled', 'function consumePendingCacheEdits').text,
    cache_config: cacheModule,
    attribution_helpers: sourceFunction(source, 'boundedBillingIndex').text + '\nvar BILLING_INDEX_MAX=1e7;',
    reference_compact_runtime: sourceRange(
      reference,
      '  cachedMicrocompactRuntime = {',
      '\n});',
      reference.indexOf('var init_microCompact'),
    ).text,
    reference_compact_gate: sourceRange(
      reference,
      'let cachedMCEnabled',
      'const useGlobalCacheFeature',
      sourceFunction(reference, 'queryModel').start,
    ).text,
    previous_cch: moduleSpan(result.sourceBefore, 'init_cch').text,
    previous_fetch: sourceFunction(result.sourceBefore, 'buildFetch').text,
  }
  if (kind === 'cc') {
    need(
      result.assemblyHelper && source.includes(result.assemblyHelper),
      'Recorded CC assembly must belong to the patched source',
    )
    sem.request_wire.helpers = result.assemblyHelper
    sem.classifier.api_helpers = result.assemblyHelper
    sem.kernel_wire.api_helpers = result.assemblyHelper
    sem.system = sourceFunction(source, '__vm201BillingIndexes').text + '\n' + sem.system
    sem.classifier.system = sem.system
    sem.kernel_wire.system = sem.system
    const errorModule = sourceRange(source, 'var __vm2apiJobError=', '// src/tools/FileReadTool/imageProcessor.ts').text
    for (const layer of ['lifecycle', 'classifier', 'kernel_wire', 'request_wire']) {
      sem[layer].native = once(sem[layer].native, errorModule, sem.runtime_wire.compact_error)
    }
    sem.lifecycle.native_fragments = [sem.lifecycle.native]
  }
  return sem
}

/** Restore only the compiled function binding, never matching regex/string text
 * or a shadowed local identifier. The compiler may not introduce extra helpers. */
export function restoreCompiledFunction(text, name, root) {
  const match = new RegExp('export\\{([\\w$]+) as ' + name + '\\};?\\s*$').exec(text)
  need(match, 'Function export changed: ' + name)
  const fromWeb = createRequire(path.join(root, 'web/package.json'))
  const fromEslint = createRequire(fromWeb.resolve('eslint'))
  const program = text.slice(0, match.index)
  const ast = fromEslint('espree').parse(program, { ecmaVersion: 'latest', sourceType: 'module', range: true })
  need(
    ast.body.length === 1 && ast.body[0].type === 'FunctionDeclaration',
    'Compiled function introduced extra statements: ' + name,
  )
  const fn = ast.body[0]
  need(fn.id?.name === match[1], 'Compiled function export does not match its declaration')
  const scopes = fromEslint('eslint-scope').analyze(ast, {
    ecmaVersion: 2024,
    sourceType: 'module',
    optimistic: true,
    ignoreEval: true,
  })
  const binding = scopes.scopes
    .find((scope) => scope.type === 'module')
    ?.variables.find((variable) => variable.name === match[1])
  need(binding, 'Compiled function binding is missing')
  need(
    !scopes.scopes.some((scope) => scope.variables.some((variable) => variable !== binding && variable.name === name)),
    'Restored function name would capture a local binding: ' + name,
  )
  const locations = new Map(
    [...binding.identifiers, ...binding.references.map((ref) => ref.identifier)].map((identifier) => [
      identifier.range[0],
      identifier.range,
    ]),
  )
  let result = program.slice(...fn.range)
  for (const [start, end] of [...locations.values()].sort((a, b) => b[0] - a[0])) {
    need(start >= fn.range[0] && end <= fn.range[1], 'Function binding reference escaped its declaration')
    result = result.slice(0, start - fn.range[0]) + name + result.slice(end - fn.range[0])
  }
  return result
}

export async function buildFixedRuntime({ root, outputRoot, evidence, stock, upx, bun, verify }) {
  need(root && outputRoot && evidence && stock && upx && bun && verify, 'Explicit inputs and verifier required')
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-runtime-'))
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
  const compileFunction = (code) => {
    const name = /function\s*\*?\s*([\w$]+)\s*\(/.exec(code)?.[1]
    need(name, 'Expected a named function')
    const input = path.join(temp, 'function.mjs'),
      out = path.join(temp, 'function-built.mjs')
    fs.writeFileSync(input, 'export ' + code)
    run(bun, ['build', input, '--target=bun', '--format=esm', '--minify', '--outfile', out])
    return restoreCompiledFunction(fs.readFileSync(out, 'utf8'), name, root)
  }
  const compileFactory = (code) => {
    const input = path.join(temp, 'helper-input.mjs'),
      out = path.join(temp, 'helper-output.mjs')
    fs.writeFileSync(input, code)
    run(bun, ['build', input, '--target=bun', '--format=esm', '--minify', '--outfile', out])
    const text = fs.readFileSync(out, 'utf8'),
      match = /export\{([\w$]+) as __vm2apiRequestWire\};?\s*$/.exec(text)
    need(match, 'Compiled assembly export changed')
    return 'var __vm2apiRequestWire=(()=>{' + text.slice(0, match.index) + 'return ' + match[1] + '})();'
  }
  fs.mkdirSync(evidence, { recursive: true })
  try {
    need(sha256(fs.readFileSync(stock)) === RUNTIME_REFERENCE.packed, 'Stock reference hash mismatch')
    run(upx, ['-d', '-o', path.join(temp, 'stock'), stock])
    const donor = fs.readFileSync(path.join(temp, 'stock'))
    need(sha256(donor) === RUNTIME_REFERENCE.unpacked, 'Donor decompression hash mismatch')
    const reference = inspectBunElf(donor).source.toString('utf8'),
      outputs = []
    for (const [kind, base] of Object.entries(RUNTIME_BASES)) {
      const parentDir = path.join(root, 'share', kind + '-fixed/v1191-r1'),
        parent = JSON.parse(fs.readFileSync(path.join(parentDir, 'manifest.json')))
      for (const [file, key] of [
        ['patches.json', 'patches_sha256'],
        ['semantics.json', 'semantics_sha256'],
      ])
        need(sha256(fs.readFileSync(path.join(parentDir, file))) === parent[key], 'Parent ' + file + ' hash mismatch')
      const previous = JSON.parse(fs.readFileSync(path.join(parentDir, 'semantics.json'))),
        input = kind === 'wrap' ? stock : path.join(root, base.input)
      need(sha256(fs.readFileSync(input)) === base.packed, 'Input hash mismatch: ' + kind)
      const beforeFile = path.join(temp, kind + '-before')
      run(upx, ['-d', '-o', beforeFile, input])
      const original = fs.readFileSync(beforeFile),
        result = patchRuntimeBytes(original, kind, {
          reference,
          minify,
          compileFunction,
          compileFactory,
          previous,
          helperPatch: parent.inherited_repairs.find((entry) => entry.id === 'native-request-assembly-helper'),
        })
      fs.writeFileSync(path.join(evidence, kind + '-patched-source.mjs'), result.sourceAfter)
      const beforeAudit = auditNativeBindings(result.sourceBefore, root),
        afterAudit = auditNativeBindings(result.sourceAfter, root)
      fs.writeFileSync(path.join(evidence, kind + '-bindings.json'), json({ before: beforeAudit, after: afterAudit }))
      need(
        afterAudit.native_unresolved.length === 0,
        'Native unbound identifiers: ' + afterAudit.native_unresolved.join(','),
      )
      need(
        !afterAudit.whole_unresolved.some((name) => !beforeAudit.whole_unresolved.includes(name)),
        'New whole-source unbound identifier',
      )
      run(bun, ['-e', 'new Bun.Transpiler({loader:"js",target:"bun"}).scan(await Bun.stdin.text())'], {
        input: result.sourceAfter,
      })
      const sem = runtimeSemantics(result, kind, previous, reference),
        behavior = await verify(sem, kind, previous)
      need(behavior?.ok && behavior.checks > 0, 'Executable controls failed')
      const inherited =
        kind === 'wrap'
          ? []
          : [...parent.inherited_repairs, ...parent.artifacts[base.file].patches].map((entry) => {
              const a = original.subarray(entry.offset, entry.offset + entry.bytes),
                b = result.bytes.subarray(entry.offset, entry.offset + entry.bytes)
              need(sha256(a) === entry.after_sha256, 'Inherited input changed: ' + entry.id)
              return {
                ...entry,
                previous_after_sha256: entry.after_sha256,
                after_sha256: sha256(b),
                preserved: a.equals(b),
                overlap: result.changes.some(
                  (p) => p.offset < entry.offset + entry.bytes && entry.offset < p.offset + p.bytes,
                ),
              }
            })
      const dir = path.join(outputRoot, kind + '-fixed/v1201-r1')
      need(!fs.existsSync(dir), 'Refusing output overwrite')
      fs.mkdirSync(dir, { recursive: true })
      const raw = path.join(temp, kind + '-after'),
        file = path.join(dir, base.file),
        roundtrip = path.join(temp, kind + '-roundtrip')
      fs.writeFileSync(raw, result.bytes)
      run(upx, ['--best', '--lzma', '-o', file, raw])
      run(upx, ['-t', file])
      run(upx, ['-d', '-o', roundtrip, file])
      need(fs.readFileSync(roundtrip).equals(result.bytes), 'Exact UPX roundtrip failed')
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
        runtime_wire_contract: RUNTIME_CONTRACT,
        approval: {
          date: '2026-10-20',
          basis: 'owner-authorized locally verified fixed maintenance',
          scope: 'CLI-only upstream runtime interfaces and caller preservation; no Linux/cloud acceptance',
        },
        lineage: {
          ...parent.lineage,
          source_file: base.input,
          source_sha256: base.packed,
          previous_release: parent.id,
          upstream_cli_sha256: RUNTIME_REFERENCE.packed,
          runtime_reference_commit: RUNTIME_REFERENCE.commit,
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
            'actual executable-source controls with external boundaries substituted; not Linux ELF/provider execution',
        },
      }
      for (const [name, value] of [
        ['manifest.json', json(manifest)],
        ['patches.json', patches],
        ['semantics.json', semantics],
      ])
        fs.writeFileSync(path.join(dir, name), value)
      fs.writeFileSync(path.join(evidence, kind + '.unpacked'), result.bytes)
      outputs.push({ kind, ...artifact, behavior })
    }
    return outputs
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const arg = (name) => {
    const i = process.argv.indexOf(name)
    return i < 0 ? undefined : process.argv[i + 1]
  }
  const { verifyCallerCacheSource } = await import('../test/support/fixed-caller-cache-controls.mjs')
  const { verifyAssemblySource } = await import('../test/support/fixed-assembly-controls.mjs')
  const { verifyRuntimeSource } = await import('../test/support/fixed-runtime-controls.mjs')
  const verify = async (sem, kind) => {
    const caller = await verifyCallerCacheSource(sem, kind),
      assembly = await verifyAssemblySource(sem, kind),
      runtime = await verifyRuntimeSource(sem, kind)
    return {
      ok: caller.ok && assembly.ok && runtime.ok,
      checks: caller.checks + assembly.checks + runtime.checks,
      caller,
      assembly,
      runtime,
    }
  }
  console.log(
    JSON.stringify(
      await buildFixedRuntime({
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
