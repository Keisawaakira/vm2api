import { sourceRange, sourceFunction } from './refresh-fixed-cli-lifecycle.mjs'
import { nativeModule } from './fixed-native-telemetry-runtime.mjs'
import { sourceParser } from './fixed-source-minify.mjs'

export function nativeVariableStatement(source, name, root) {
  const ast = sourceParser(root).parse(source, { ecmaVersion: 'latest', sourceType: 'module', range: true })
  let found
  const visit = (node, parent) => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'VariableDeclarator' && node.id?.name === name) {
      if (found) throw Error('Ambiguous native variable: ' + name)
      found = source.slice(...parent.range)
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'range') continue
      if (Array.isArray(value)) for (const child of value) visit(child, node)
      else if (value && typeof value === 'object') visit(value, node)
    }
  }
  visit(ast, null)
  if (!found) throw Error('Native variable statement missing: ' + name)
  return found
}
function moduleContaining(source, symbol) {
  const at = source.indexOf(symbol)
  if (at < 0) throw Error('Native module binding missing: ' + symbol)
  const start = source.lastIndexOf('\n// ', at) + 1
  const end = source.indexOf('\n// ', at)
  return source.slice(start, end < 0 ? source.length : end)
}
const fn = (source, names) => names.map(name => sourceFunction(source, name).text).join('\n')

/** Every current control fragment is selected from the completed ELF source, not a guessed donor. */
export function nativeRefreshSemantics(previous, result, kind, reference, root) {
  const sem = structuredClone(previous)
  const source = result.sourceAfter
  const api = nativeModule(source, 'src/services/api/claude.ts').text
  const native = nativeModule(source, 'src/kin/stdioProtocol.ts').text + '\n' + nativeModule(source, 'src/kin/nativeMessagesRunner.ts').text
  const helpers = fn(source, ['__vm1437CallerContext','__vm1437CallerSystem','__vm1437StampWire'])
  let system = sourceRange(api, 'const kinSystemLayout', 'const extraToolSchemas').text
  if (kind === 'cc') {
    system = sourceRange(api, 'const _v194s', 'const extraToolSchemas').text
    system = fn(source, ['__vm201BillingIndexes','__vm191CallerSystem','__vm191WireSystem']) + '\n' + system
  }
  system = helpers + '\n' + system
  sem.query = sourceFunction(source, 'queryKinMessagesWithStreaming').text
  sem.system = system
  const jobHelpers = kind === 'cc'
    ? moduleContaining(source, 'var __vm2apiJobError=')
    : nativeModule(source, 'src/kin/jobError.ts').text
  const runnerHelpers = kind === 'cc'
    ? fn(source, ['kernelEnv','getJobAutoCompactWindow','runWithJobAutoCompactWindow','startVmTelemetry','captureVmJob','sendSlotStart','withOutboundHeaders','reportOutboundHeaders'])
    : nativeModule(source, 'src/kin/kernelEnv.ts').text
  const completeNative = jobHelpers + '\n' + runnerHelpers + '\n' + native
  const params = nativeVariableStatement(api, 'paramsFromContext', root)
  let requestHelpers
  if (kind === 'cc') {
    requestHelpers = nativeVariableStatement(source, '__vm2apiRequestWire', root)
    requestHelpers += '\n' + nativeVariableStatement(api, '__vm1437NativePolicy', root)
    requestHelpers += '\n' + fn(source, ['__vm1437Kernel','__vm1437CatalogEffort','readPanelModelEffort'])
  } else {
    requestHelpers = nativeModule(source, 'src/services/api/requestBody.ts').text +
      '\n' + nativeModule(source, '../../src/lib/protocol/claude-code-betas.mjs').text +
      '\n' + nativeModule(source, 'src/kin/nativePolicy.ts').text +
      '\ninit_requestBody();init_claude_code_betas();'
  }
  const cache = kind === 'cc'
    ? sourceRange(source, '// src/kin/cacheTtl.ts', 'function mergeOfficialExtraBetas').text + '\n' + sourceFunction(source, 'applyKinOwnedCacheMarkers').text
    : nativeModule(source, 'src/kin/cacheTtl.ts').text
  for (const layer of ['lifecycle','classifier','kernel_wire','request_wire']) {
    sem[layer].query = sem.query
    sem[layer].system = system
    sem[layer].native = completeNative
  }
  sem.lifecycle.native_fragments = [completeNative]
  sem.request_wire.params = params
  sem.request_wire.helpers = requestHelpers
  sem.request_wire.model_helpers = kind === 'cc' ? '' : ''
  sem.request_wire.cache = cache
  sem.caller_cache.cache_source = cache
  sem.caller_cache.prefix = system
  sem.caller_cache.system_helpers = helpers
  sem.cache = cache
  sem.classifier.api_helpers = requestHelpers
  sem.kernel_wire.api_helpers = requestHelpers
  const officialBetas = kind === 'cc'
    ? previous.request_wire.official_betas
    : nativeModule(source, 'src/kin/officialBetas.ts').text
  sem.request_wire.official_betas = officialBetas
  const fetch = fn(source, kind === 'cc' ? ['buildFetch','__vm1437Fetch'] : ['buildFetch']) + '\n' + helpers
  sem.runtime_wire.fetch = fetch
  sem.runtime_wire.cch = moduleContaining(source, 'var init_cch')
  sem.runtime_wire.attribution = sourceFunction(source, 'getAttributionHeader').text
  sem.runtime_wire.attribution_helpers = fn(source, ['boundedBillingIndex']) + '\nvar BILLING_INDEX_MAX=1e7;' +
    (kind === 'cc' ? '\n' + fn(source, ['__vm1437Kernel','readPanelCcEntrypoint']) : '')
  sem.runtime_wire.config = kind === 'cc'
    ? sourceRange(source, 'var __vm201CchEnabled', 'function consumePendingCacheEdits').text
    : cache
  sem.runtime_wire.compact = sourceFunction(source, 'microcompactMessages').text
  sem.native_refresh = {
    contract: 'native_telemetry_runtime_v1', caller_contract: 'caller_provenance_v1',
    api, native: completeNative, runner: native, system, params, helpers,
    fetch: sourceFunction(source, 'buildFetch').text,
    fetch_implementation: sourceFunction(source, kind === 'cc' ? '__vm1437Fetch' : 'buildFetch').text,
    telemetry_factory: kind === 'cc' ? sourceFunction(source, '__vm1437TelemetryFactory').text : null,
    telemetry_source: result.telemetry?.code || null,
    telemetry_bindings: result.telemetry?.imports || [],
    telemetry_modules: kind === 'wrap'
      ? ['vmTelemetryContext','vmTelemetryRecordOnly','vmTelemetryContract','vmTelemetryHttp','vmTelemetryEgress','vmTelemetry','outboundHeaders'].map(name => nativeModule(source, 'src/kin/' + name + '.ts').text).join('\n')
      : null,
    runtime_bootstrap: result.runtimeBootstrap,
    session_helper: kind === 'wrap' ? nativeModule(source, 'src/bootstrap/jobSession.ts').text : previous.session?.helper || null,
    reference_native: nativeModule(reference, 'src/kin/nativeMessagesRunner.ts').text,
    note: 'Current fields are bound to the completed source. Historical before/reference fragments remain comparisons only; SDK/IO fixture substitution is not shipped Linux or cloud acceptance.',
  }
  return sem
}
