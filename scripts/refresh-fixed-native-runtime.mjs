#!/usr/bin/env node
/** CLI-only maintenance from the v1.4.037 payload; never writes a running slot or kernel. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { inspectBunElf, sha256, verifyUnchangedOutside } from './build-offline-native-candidates.mjs'
import { sourceRange, sourceFunction } from './refresh-fixed-cli-lifecycle.mjs'
import { auditNativeBindings } from './refresh-fixed-cc-session.mjs'
import { nativeModule, nativeTelemetryFactorySource } from './fixed-native-telemetry-runtime.mjs'
import { exactWhitespaceMinify, sourceParser } from './fixed-source-minify.mjs'
import { NATIVE_CHAT_CONTEXT } from '../src/lib/protocol/chat-messages.mjs'
import { nativeRefreshSemantics } from './fixed-native-refresh-semantics.mjs'

export const REFRESH_CONTRACT = 'native_telemetry_runtime_v1'
export const CALLER_CONTRACT = 'caller_provenance_v1'
export const REFRESH_REFERENCE = Object.freeze({
  commit: '034dad443db93f35df060a03993f602fe205914e',
  packed: '8484c4c58f4b7782a190f7cab7c8aa5d1f706ae26b2d2a5cafe81af070f0611b',
  unpacked: 'f13d8cdfa45dfc6eb7c10334d5c7f7b0ab47e7c1b7886fc3afc274942105b98b',
})
export const REFRESH_BASES = Object.freeze({
  wrap: Object.freeze({ id: 'wrap-fixed-v1437-r1', file: 'cli-node', input: 'share/wrap-cli/cli-node', packed: REFRESH_REFERENCE.packed, unpacked: REFRESH_REFERENCE.unpacked }),
  cc: Object.freeze({ id: 'cc-fixed-v1437-r1', file: 'cc-node', input: 'share/cc-fixed/v1201-r1/cc-node', packed: 'd542668ae3f14d17e66c6c71f3da1061d50700e4bb74dae05ef615ce3b8e0397', unpacked: '7e9f44110f98103b96b657d42b1350ae175df54010048468c42d48ed2cccb9b4' }),
})
const need = (ok, message) => { if (!ok) throw Error(message) }
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n')
const once = (text, before, after) => {
  need(text.split(before).length === 2, 'Ambiguous refresh anchor: ' + before.slice(0, 100))
  return text.replace(before, after)
}
const cloneContext = JSON.stringify(NATIVE_CHAT_CONTEXT)

const callerHelpers = `function __vm1437CallerContext(body){const c=body&&body.request_context;return c&&c.protocol==="openai.chat"&&c.preserve_caller_system===true}
function __vm1437CallerSystem(raw){const blocks=raw==null?[]:typeof raw==="string"?[raw]:raw;if(!Array.isArray(blocks))throw new Error("native_caller_system_invalid");return blocks.map(block=>{if(typeof block==="string")return{type:"text",text:block};if(block&&typeof block==="object"&&typeof block.text==="string")return{...block};throw new Error("native_caller_system_invalid")})}
function __vm1437StampWire(text,enabled){let body;try{body=JSON.parse(text)}catch{return text}const context=body.request_context;const owned=__vm1437CallerContext(body);if(!Object.hasOwn(body,"request_context"))return stampCchBody(text,enabled);delete body.request_context;if(!owned)return stampCchBody(JSON.stringify(body),enabled);const count=context.caller_system_tail_count;if(!Array.isArray(body.system)||typeof count!=="number"||!Number.isInteger(count)||count<0||count>body.system.length)throw new Error("native_caller_system_count_invalid");let found=false;const prefix=body.system.length-count;const edit=value=>typeof value==="string"?value.replace(/(^\\s*x-anthropic-billing-header:[^\\r\\n]*?\\bcch=)[0-9a-f]{5}(?=;)/gim,(_match,before)=>{found=true;return before+"00000"}):value;for(let i=0;i<prefix;i++){const b=body.system[i];body.system[i]=typeof b==="string"?edit(b):b&&typeof b.text==="string"?{...b,text:edit(b.text)}:b}if(!found||!enabled)return JSON.stringify(body);const cch=computeCch(JSON.stringify(body));for(let i=0;i<prefix;i++){const b=body.system[i];const stamp=value=>typeof value==="string"?value.replace(/(^\\s*x-anthropic-billing-header:[^\\r\\n]*?\\bcch=)00000(?=;)/gim,(_match,before)=>before+cch):value;body.system[i]=typeof b==="string"?stamp(b):b&&typeof b.text==="string"?{...b,text:stamp(b.text)}:b}return JSON.stringify(body)}
`

function builtinImports(source, root) {
  const ast = sourceParser(root).parse(source, { ecmaVersion: 'latest', sourceType: 'module', range: true })
  const imports = []
  for (const node of ast.body) if (node.type === 'ImportDeclaration') for (const item of node.specifiers) {
    imports.push({ module: String(node.source.value).replace(/^node:/, ''), imported: item.imported?.name || item.imported?.value || (item.type === 'ImportNamespaceSpecifier' ? '*' : 'default'), local: item.local.name })
  }
  return imports
}
function importedName(imports, module, imported) {
  const match = imports.find(item => item.module === module && item.imported === imported)
  if (match) return match.local
  const namespace = imports.find(item => item.module === module && ['*', 'default'].includes(item.imported))
  need(namespace && imported !== '*', 'Existing builtin binding not found: ' + module + '.' + imported)
  return imported === 'default' ? namespace.local : `${namespace.local}.${imported}`
}
function telemetryBootstrap(factory, imports) {
  const pairs = factory.imports.map(item => `${item.local}:${importedName(imports, item.module, item.imported)}`)
  return `var __vm1437Runtime;
function __vm1437GetRuntime(){return __vm1437Runtime||(__vm1437Runtime=__vm1437TelemetryFactory({esm:__esm,builtins:{${pairs.join(',')}},get zod(){return exports_external},get claudeEvent(){return ClaudeCodeInternalEvent},get growthEvent(){return GrowthbookExperimentEvent},initZod(...a){return init_zod(...a)},initState(...a){return init_state(...a)},initConfig(...a){return init_config(...a)},initExporter(...a){return init_firstPartyEventLoggingExporter(...a)},userId(...a){return getOrCreateUserID(...a)},sessionId(...a){return getSessionId(...a)},userAgent(...a){return getClaudeCodeUserAgent(...a)},stringify(...a){return jsonStringify(...a)},formatEvent(...a){return to1PEventFormat(...a)},stripProto(...a){return stripProtoFields(...a)},debug(...a){return logForDebugging2(...a)}}))}
function startVmTelemetry(publish){if(!process.env.KERNEL_CONFIG)return;return __vm1437GetRuntime().start(publish)}
function captureVmJob(){return __vm1437Runtime?.capture()??null}
function sendSlotStart(session,model){__vm1437Runtime?.slotStart(session,model)}
function withOutboundHeaders(report,task){return __vm1437GetRuntime().withHeaders(report,task)}
function reportOutboundHeaders(headers){return __vm1437GetRuntime().reportHeaders(headers)}
var __vm1437WindowStorage=new ${importedName(imports, 'async_hooks', 'AsyncLocalStorage')};
function getJobAutoCompactWindow(){return __vm1437WindowStorage.getStore()}
function runWithJobAutoCompactWindow(value,task){return __vm1437WindowStorage.run(value,task)}
function kernelEnv(suffix){return process.env["CLAUDE_CODE_"+suffix]||undefined}
`
}
function profileHelpers(imports) {
  const read = importedName(imports, 'fs', 'readFileSync')
  return `function __vm1437Kernel(){try{const c=JSON.parse(${read}(process.env.KERNEL_CONFIG||"/run/kin/kernel.json","utf8"));return c&&typeof c==="object"&&!Array.isArray(c)?c:null}catch{return null}}
function __vm1437ProfileVersion(){const v=__vm1437Kernel()?.cli_version;return typeof v==="string"?v.match(/\\d+\\.\\d+\\.\\d+/)?.[0]:undefined}
function readPanelCcEntrypoint(){const c=__vm1437Kernel();if(!c||!("cc_entrypoint"in c))return process.env.CLAUDE_CODE_ENTRYPOINT||"sdk-cli";return c.cc_entrypoint==="cli"?"cli":"sdk-cli"}
function readPanelModelEffort(model){const c=__vm1437Kernel(),table=c?.model_effort;if(!table||typeof table!=="object"||Array.isArray(table))return;const v=table[String(model||"").trim().toLowerCase()];return["off","low","medium","high","xhigh","max"].includes(v)?v:undefined}
`
}
function patchStockSystem(api) {
  api = once(api, '  const kinQuery = isKinQuerySource(options2.querySource);', '  const kinQuery = isKinQuerySource(options2.querySource);\n  const _vCaller = kinQuery && !options2.requestContext && __vm1437CallerContext(options2.wireBody);\n  const _cS = _vCaller ? __vm1437CallerSystem(options2.wireSystem) : null;')
  api = once(api, '  const preservedOfficial = preserveOfficialSystem(systemPrompt);', '  const preservedOfficial = _vCaller ? null : preserveOfficialSystem(systemPrompt);')
  api = once(api, '  if (preservedOfficial) {', `  if (_vCaller) {\n    systemPrompt = asSystemPrompt(layoutSystemBlocks({attribution:getAttributionHeader(fingerprint,{...gates,...billingIndexes,isSubagent:false,prevReqId:previousRequestId,promptId,turnOrigin:resolveTurnOrigin(options2.querySource)})}));\n  } else if (preservedOfficial) {`)
  api = once(api, '  const extraToolSchemas = [...options2.extraToolSchemas ?? []];', '  if (_vCaller) { for (const block of system) delete block.cache_control; system.push(..._cS); }\n  const extraToolSchemas = [...options2.extraToolSchemas ?? []];')
  api = once(api, '    lastRequestBetas = params.betas;', `    if (_vCaller) params.request_context = {...${cloneContext},caller_system_tail_count:_cS.length};\n    lastRequestBetas = params.betas;`)
  return api
}
function patchCCSystem(api) {
  const old = 'const kinQuery=isKinQuerySource(options2.querySource);const kinWireSystem=kinQuery&&!options2.requestContext?__vm191WireSystem(options2.wireSystem):null;const _cS=kinQuery&&!options2.requestContext&&!kinWireSystem&&kinSystemLayout!=="stock"?__vm191CallerSystem(options2.wireSystem,options2.__vm2apiSys):null;if(kinWireSystem);'
  const next = 'const kinQuery=isKinQuerySource(options2.querySource);const _vCaller=kinQuery&&!options2.requestContext&&__vm1437CallerContext(options2.wireBody);const kinWireSystem=!_vCaller&&kinQuery&&!options2.requestContext?__vm191WireSystem(options2.wireSystem):null;const _cS=_vCaller?__vm1437CallerSystem(options2.wireSystem):kinQuery&&!options2.requestContext&&!kinWireSystem&&kinSystemLayout!=="stock"?__vm191CallerSystem(options2.wireSystem,options2.__vm2apiSys):null;if(_vCaller)systemPrompt=asSystemPrompt(layoutSystemBlocks({attribution:_v194a(true)}));else if(kinWireSystem);'
  api = once(api, old, next)
  api = once(api, 'if(!options2.requestContext&&!options2.wireBody)configureEffortParams(effort,outputConfig,extraBodyParams,betasParams,options2.model);', 'if(!options2.requestContext){const wire=options2.wireBody,hasConfig=wire&&Object.hasOwn(wire,"output_config"),config=wire?.output_config,callerEffort=config&&typeof config==="object"&&Object.hasOwn(config,"effort");if(!wire||(!callerEffort&&(!hasConfig||config&&typeof config==="object"))){const panel=readPanelModelEffort(options2.model);if(panel==="off")delete outputConfig.effort;else configureEffortParams(panel??effort,outputConfig,extraBodyParams,betasParams,options2.model)}}')
  api = once(api, 'const gatedBetas=__vm2apiRequestWire.apply(rB,params);', `if(_vCaller)params.request_context={...${cloneContext},caller_system_tail_count:_cS.length};const gatedBetas=__vm2apiRequestWire.apply(rB,params);`)
  return api
}
function fixBusyPhase(fn) {
  need(!fn.includes('slot.phase = "running"'), 'Donor busy-phase baseline changed')
  return once(fn, '  slot.jobId = jobId;', '  slot.phase = "running";\n  slot.jobId = jobId;')
}
function closedCode(code, root) {
  const ast = sourceParser(root).parse(code, { ecmaVersion: 'latest', sourceType: 'module', range: true })
  return ast.body.map(node => {
    need(node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'FunctionDeclaration', 'Closed native compiler introduced an extra statement')
    return code.slice(...node.declaration.range)
  }).join('\n')
}

export function patchNativeRefreshBytes(original, kind, { reference, root, minify, compileClosed }) {
  const base = REFRESH_BASES[kind]
  need(base && sha256(original) === base.unpacked, 'Unknown native refresh base: ' + kind)
  const graph = inspectBunElf(original), source = graph.source.toString('utf8')
  need(Buffer.from(source).equals(graph.source), 'Lossy embedded-source decode')
  const origin = graph.modules[graph.entry].sourceOffset
  const changes = [], imports = builtinImports(source, root)
  const add = (id, span, text) => {
    const before = Buffer.from(span.text), after = Buffer.from(text)
    need(after.length <= before.length, `${id} exceeds its fixed span (${after.length}/${before.length})`)
    const offset = origin + Buffer.byteLength(source.slice(0, span.start))
    need(original.subarray(offset, offset + before.length).equals(before), 'Wrong embedded byte offset: ' + id)
    changes.push({ id, offset, bytes: before.length, replacement_bytes: after.length, before: span.text, after: text,
      before_sha256: sha256(before), after_sha256: sha256(Buffer.concat([after, Buffer.alloc(before.length - after.length, 32)])) })
  }
  const helperGlobals = callerHelpers
  let api = nativeModule(source, 'src/services/api/claude.ts')
  let apiText = kind === 'wrap' ? patchStockSystem(api.text) : patchCCSystem(api.text)
  const telemetry = kind === 'cc' ? nativeTelemetryFactorySource(reference, root) : null
  let runtimeBootstrap = ''
  if (kind === 'cc') {
    runtimeBootstrap = telemetryBootstrap(telemetry, imports)
    const allocation = nativeModule(source, 'node_modules/zod/v3/types.js')
    const compact = exactWhitespaceMinify(allocation.text, root)
    const factory = closedCode(compileClosed('export ' + telemetry.code), root)
    add('native-telemetry-capsule', allocation, '// node_modules/zod/v3/types.js\n' + compact + factory)
    apiText += '\n' + runtimeBootstrap + profileHelpers(imports)
    const nativePolicy = nativeModule(reference, 'src/kin/nativePolicy.ts').text
    apiText += '\nvar __vm1437NativePolicy=(()=>{' + nativePolicy + '\nreturn applyNativeModelPolicy})();'
    apiText = once(apiText, 'const gatedBetas=__vm2apiRequestWire.apply(rB,params);', 'delete params.kin_outbound_shape;if(!options2.requestContext)__vm1437NativePolicy(params);const gatedBetas=__vm2apiRequestWire.apply(rB,params);')
    const oldNative = sourceRange(source, '// src/kin/stdioProtocol.ts', '// src/kin/slotPool.ts')
    const donorNative = nativeModule(reference, 'src/kin/nativeMessagesRunner.ts').text
    const names = ['nativeSlotCount','runNativeMessagesLoop','startJob','cancelJob','sessionIdFromRequest','autoCompactWindowFromRequest','runJob','extractErrorText','systemFromRequest','pickRateLimitHeaders','thinkingFromRequest']
    let functions = names.map(name => {
      let fn = sourceFunction(donorNative, name).text
      if (name === 'startJob') fn = fixBusyPhase(fn)
      if (name === 'runNativeMessagesLoop') fn = once(fn, '  const telemetry = startVmTelemetry(', '  if(process.env.KERNEL_CONFIG) await __vm1437GetRuntime().load();\n  const telemetry = startVmTelemetry(')
      return 'export ' + fn
    }).join('\n').replace(/\bPROTOCOL_VERSION\b/g, 'KIN_PROTOCOL_VERSION')
      .replace(/\bCAPABILITIES\b/g, 'KIN_CAPABILITIES')
      .replace(/\bcreateInterface2\b/g, importedName(imports, 'readline', 'createInterface'))
      .replace(/\bvalidClassifierContext\b/g, '__vm2apiClassifier194.valid')
      .replace(/\bclassifyKinJobError\b/g, '__vm2apiJobError.classify')
    const compiled = closedCode(compileClosed(functions), root)
    const classifier = sourceRange(oldNative.text, 'var __vm2apiClassifier194=', 'function parseStdinLine').text
    const proto = nativeModule(reference, 'src/kin/stdioProtocol.ts').text
      .replace(/\bPROTOCOL_VERSION\b/g, 'KIN_PROTOCOL_VERSION').replace(/\bCAPABILITIES\b/g, 'KIN_CAPABILITIES')
      .replace(/\bqueuedBytes\b/g, '__vm1437QueuedBytes').replace(/\bSTDOUT_QUEUE_BYTES\b/g, '__vm1437StdoutLimit')
    const oldExports = sourceRange(oldNative.text, 'var exports_nativeMessagesRunner=', 'function nativeSlotCount').text
    const oldInit = oldNative.text.slice(oldNative.text.indexOf('var init_nativeMessagesRunner='))
    add('native-telemetry-runner', oldNative, '// src/kin/stdioProtocol.ts\n' + classifier + minify(proto) + '\n// src/kin/nativeMessagesRunner.ts\n' + oldExports + compiled + oldInit)
    const ua = sourceFunction(source, 'getUserAgent')
    add('native-profile-user-agent', ua, minify(once(ua.text, '${process.env.CLAUDE_CODE_ENTRYPOINT??"cli"}', '${readPanelCcEntrypoint()}')))
    const attr = sourceFunction(source, 'getAttributionHeader')
    add('native-profile-billing-entrypoint', attr, minify(once(attr.text, 'const entrypoint=process.env.CLAUDE_CODE_ENTRYPOINT??"unknown";', 'const entrypoint=readPanelCcEntrypoint();')))
    const effort = sourceFunction(source, 'getDefaultEffortForModel')
    const donorEffort = sourceFunction(reference, 'getDefaultEffortForModel').text
    const table = /const catalogDefault = (\[[\s\S]*?\n  \]);/.exec(donorEffort)?.[1]
    need(table, 'Missing actual native effort catalog')
    apiText += '\nfunction __vm1437CatalogEffort(model){const row=' + table + '.find(([id])=>String(model).toLowerCase().includes(id));return row?.[1]}'
    const externalStart = effort.text.indexOf('  if (model.toLowerCase().includes("opus-4-6"))')
    const externalEnd = effort.text.indexOf('  if (isUltrathinkEnabled()', externalStart)
    need(externalStart > 0 && externalEnd > externalStart, 'Unknown CC effort baseline')
    add('native-catalog-effort', effort, minify(effort.text.slice(0, externalStart) + '  const catalog=__vm1437CatalogEffort(model);if(catalog)return catalog;\n' + effort.text.slice(externalEnd)))
  } else {
    const job = sourceFunction(nativeModule(source, 'src/kin/nativeMessagesRunner.ts').text, 'startJob')
    const native = nativeModule(source, 'src/kin/nativeMessagesRunner.ts')
    add('native-busy-cancel-phase', { start: native.start + job.start, text: job.text }, minify(fixBusyPhase(job.text)))
  }
  apiText += '\n' + helperGlobals
  const fetch = sourceFunction(source, 'buildFetch')
  let fetchText = sourceFunction(reference, 'buildFetch').text
  if (kind === 'cc') fetchText = fetchText.replace(/\bgetWorkload\b/g, 'getWorkload2').replace(/\blogForDebugging\b/g, 'logForDebugging2').replace(/\brandomUUID7\b/g, importedName(imports, 'crypto', 'randomUUID'))
  fetchText = once(fetchText, 'stampCchBody(wire, readPanelCchEnabled())', '__vm1437StampWire(wire, readPanelCchEnabled())')
  if (kind === 'cc') {
    apiText += '\n' + once(fetchText, 'function buildFetch(', 'function __vm1437Fetch(')
    add('caller-aware-final-fetch-headers', fetch, 'function buildFetch(fetchOverride,source){return __vm1437Fetch(fetchOverride,source)}')
  } else add('caller-aware-final-fetch-headers', fetch, minify(fetchText))
  add('caller-provenance-system-wire', api, '// src/services/api/claude.ts\n' + minify(apiText))
  changes.sort((a, b) => a.offset - b.offset)
  let end = origin
  const bytes = Buffer.from(original)
  for (const change of changes) {
    need(change.offset >= end && change.offset + change.bytes <= origin + graph.source.length, 'Overlapping/non-source native patch')
    Buffer.concat([Buffer.from(change.after), Buffer.alloc(change.bytes - change.replacement_bytes, 32)]).copy(bytes, change.offset)
    end = change.offset + change.bytes
  }
  verifyUnchangedOutside(original, bytes, changes)
  const after = inspectBunElf(bytes)
  need(JSON.stringify({ ...graph, source: null }) === JSON.stringify({ ...after, source: null }), 'ELF/Bun resources moved')
  return { bytes, changes, sourceBefore: source, sourceAfter: after.source.toString('utf8'), telemetry, runtimeBootstrap }
}

export async function buildNativeRefresh({ root, stock, outputRoot, evidence, upx, bun, verify }) {
  need(root && stock && outputRoot && evidence && upx && bun && verify, 'Explicit native maintenance inputs required')
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-native-refresh-'))
  const run = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024, ...options })
  fs.mkdirSync(evidence, { recursive: true })
  const minify = code => exactWhitespaceMinify(code, root)
  const compileClosed = code => {
    const input = path.join(temp, 'closed-input.mjs'), out = path.join(temp, 'closed-output.mjs')
    fs.writeFileSync(input, code)
    run(bun, ['build', input, '--target=bun', '--format=esm', '--minify', '--no-bundle', '--outfile', out])
    return fs.readFileSync(out, 'utf8')
  }
  try {
    need(sha256(fs.readFileSync(stock)) === REFRESH_REFERENCE.packed, 'Stock packed SHA mismatch')
    run(upx, ['-d', '-o', path.join(temp, 'stock'), stock])
    const donor = fs.readFileSync(path.join(temp, 'stock'))
    need(sha256(donor) === REFRESH_REFERENCE.unpacked, 'Stock unpacked SHA mismatch')
    const reference = inspectBunElf(donor).source.toString('utf8'), outputs = []
    for (const [kind, base] of Object.entries(REFRESH_BASES)) {
      const parentDir = path.join(root, 'share', kind + '-fixed/v1201-r1')
      const parent = JSON.parse(fs.readFileSync(path.join(parentDir, 'manifest.json')))
      const input = kind === 'wrap' ? stock : path.join(parentDir, base.file)
      need(sha256(fs.readFileSync(input)) === base.packed, 'Native parent packed SHA mismatch: ' + kind)
      for (const [file, field] of [['patches.json','patches_sha256'],['semantics.json','semantics_sha256']]) need(sha256(fs.readFileSync(path.join(parentDir, file))) === parent[field], 'Parent metadata mismatch: ' + file)
      const previous = JSON.parse(fs.readFileSync(path.join(parentDir, 'semantics.json')))
      run(upx, ['-d', '-o', path.join(temp, kind + '-before'), input])
      const original = fs.readFileSync(path.join(temp, kind + '-before'))
      const result = patchNativeRefreshBytes(original, kind, { reference, root, minify, compileClosed })
      fs.writeFileSync(path.join(evidence, kind + '-source.mjs'), result.sourceAfter)
      const before = auditNativeBindings(result.sourceBefore, root), after = auditNativeBindings(result.sourceAfter, root)
      fs.writeFileSync(path.join(evidence, kind + '-bindings.json'), json({ before, after }))
      need(after.native_unresolved.length === 0, 'Unbound native dependency: ' + after.native_unresolved.join(','))
      need(after.whole_unresolved.every(name => before.whole_unresolved.includes(name)), 'New whole-source unresolved dependency')
      run(bun, ['-e', 'new Bun.Transpiler({loader:"js",target:"bun"}).scan(await Bun.stdin.text())'], { input: result.sourceAfter })
      const sem = nativeRefreshSemantics(previous, result, kind, reference, root)
      sem.native_refresh.reference_commit = REFRESH_REFERENCE.commit
      const behavior = await verify(sem, kind, previous, result, reference)
      need(behavior?.ok && behavior.checks > 0, 'Actual native source controls failed: ' + kind)
      const inherited = kind === 'wrap' ? [] : [...parent.inherited_repairs, ...parent.artifacts[base.file].patches].map(entry => {
        const a = original.subarray(entry.offset, entry.offset + entry.bytes), b = result.bytes.subarray(entry.offset, entry.offset + entry.bytes)
        need(sha256(a) === entry.after_sha256, 'Inherited parent span changed: ' + entry.id)
        return { ...entry, previous_after_sha256: entry.after_sha256, after_sha256: sha256(b), preserved: a.equals(b), overlap: result.changes.some(p => p.offset < entry.offset + entry.bytes && entry.offset < p.offset + p.bytes) }
      })
      const dir = path.join(outputRoot, kind + '-fixed/v1437-r1')
      need(!fs.existsSync(dir), 'Refusing to overwrite a fixed revision')
      fs.mkdirSync(dir, { recursive: true })
      const raw = path.join(temp, kind + '-after'), file = path.join(dir, base.file), roundtrip = path.join(temp, kind + '-roundtrip')
      fs.writeFileSync(raw, result.bytes)
      run(upx, ['--best', '--lzma', '-o', file, raw]); run(upx, ['-t', file]); run(upx, ['-d', '-o', roundtrip, file])
      need(fs.readFileSync(roundtrip).equals(result.bytes), 'Exact native unpack roundtrip failed')
      const packed = fs.readFileSync(file), patches = json({ [base.file]: result.changes }), semantics = json(sem)
      const artifact = { file: base.file, bytes: packed.length, sha256: sha256(packed), unpacked_bytes: result.bytes.length, unpacked_sha256: sha256(result.bytes), source_packed_sha256: base.packed, source_unpacked_sha256: base.unpacked,
        patches: result.changes.map(({ before, after, ...entry }) => entry), validations: { elf_graph: true, no_bytecode: true, unchanged_outside_js_spans: true, syntax: true, native_bindings_resolved: true, upx_integrity: true, exact_unpack_roundtrip: true } }
      const manifest = { ...parent, id: base.id, native_runtime_contract: REFRESH_CONTRACT, caller_system_contract: CALLER_CONTRACT,
        approval: { date: '2026-11-03', basis: 'owner-authorized locally verified fixed maintenance', scope: 'CLI-only native runtime and caller preservation; no Linux/cloud acceptance' },
        lineage: { ...parent.lineage, source_file: kind === 'wrap' ? 'share/wrap-cli/cli-node' : 'share/cc-fixed/v1201-r1/cc-node', source_sha256: base.packed, previous_release: parent.id, upstream_cli_sha256: REFRESH_REFERENCE.packed, runtime_reference_commit: REFRESH_REFERENCE.commit },
        artifacts: { [base.file]: artifact }, inherited_repairs: inherited, patches_sha256: sha256(patches), semantics_sha256: sha256(semantics),
        tools: { bun: run(bun, ['--version']).trim(), upx: run(upx, ['--version']).split(/\r?\n/)[0] },
        local_validation: { completed: true, native_execution: false, behavior_tests: behavior.checks, full_source_scope_audit: after, scope: 'actual-source controls with explicit SDK/IO boundaries; not shipped Linux ELF/provider execution' } }
      for (const [name, value] of [['manifest.json',json(manifest)],['patches.json',patches],['semantics.json',semantics]]) fs.writeFileSync(path.join(dir, name), value)
      fs.writeFileSync(path.join(evidence, kind + '.unpacked'), result.bytes)
      outputs.push({ kind, ...artifact, behavior })
    }
    return outputs
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
}
function helperGlobalsForSem(source) {
  return ['__vm1437CallerContext','__vm1437CallerSystem','__vm1437StampWire'].map(name => sourceFunction(source, name).text).join('\n')
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const value = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1] }
  const { verifyNativeRefreshSource } = await import('../test/support/fixed-native-refresh-controls.mjs')
  console.log(JSON.stringify(await buildNativeRefresh({ root: value('--root'), stock: value('--stock'), outputRoot: value('--output'), evidence: value('--evidence'), upx: value('--upx'), bun: value('--bun'), verify: verifyNativeRefreshSource }), null, 2))
}
