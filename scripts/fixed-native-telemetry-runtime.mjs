import { createRequire } from 'node:module'
import path from 'node:path'

const modules = [
  'src/kin/vmTelemetryContext.ts',
  'src/kin/vmTelemetryRecordOnly.ts',
  'src/kin/vmTelemetryContract.ts',
  'src/kin/vmTelemetryHttp.ts',
  'src/kin/vmTelemetryEgress.ts',
  'src/kin/vmTelemetry.ts',
  'src/kin/outboundHeaders.ts',
]

function parser(root) {
  const web = createRequire(path.join(root, 'web/package.json'))
  return createRequire(web.resolve('eslint'))('espree')
}

export function nativeModule(source, name) {
  const marker = '// ' + name
  const offset = source.indexOf(marker + '\n')
  if (offset < 0 || source.indexOf(marker + '\n', offset + marker.length) >= 0) throw Error('Missing/ambiguous native module: ' + name)
  // Fixed-length predecessors may leave spaces before the next real module comment.
  const tail = source.slice(offset + marker.length)
  const next = /^ *\/\/ (?:src\/|node_modules\/|\.\.\/)[^\r\n]+/m.exec(tail)
  const end = next ? offset + marker.length + next.index : source.length
  return { start: offset, text: source.slice(offset, end) }
}

export function nativeTelemetryFactorySource(reference, root) {
  const espree = parser(root)
  const imports = []
  const parts = []
  for (const name of modules) {
    const selected = nativeModule(reference, name).text
    const ast = espree.parse(selected, { ecmaVersion: 'latest', sourceType: 'module', range: true })
    let code = selected
    for (const node of ast.body.filter(node => node.type === 'ImportDeclaration').reverse()) {
      for (const item of node.specifiers) {
        imports.push({
          module: node.source.value,
          imported: item.imported?.name || item.imported?.value || (item.type === 'ImportNamespaceSpecifier' ? '*' : 'default'),
          local: item.local.name,
        })
      }
      code = code.slice(0, node.range[0]) + code.slice(node.range[1])
    }
    parts.push(code)
  }
  const exporter = nativeModule(reference, 'src/services/analytics/firstPartyEventLoggingExporter.ts').text
  const ast = espree.parse(exporter, { ecmaVersion: 'latest', sourceType: 'module', range: true })
  const cls = ast.body.find(node => node.type === 'ClassDeclaration' && node.id?.name === 'FirstPartyEventLoggingExporter')
  if (!cls) throw Error('Missing actual telemetry exporter')
  const required = ['serializeVmRecords', 'sendVmBatch', 'hrTimeToDate', 'transformLogsToEvents']
  const methods = required.map(name => {
    const method = cls.body.body.find(node => node.type === 'MethodDefinition' && node.key?.name === name)
    if (!method) throw Error('Missing actual native exporter method: ' + name)
    return exporter.slice(...method.range)
  }).join('\n')
  // The native owner never starts the generic exporter's legacy-batch retry loop.
  // Copy its actual VM serialization/upload methods, retaining the CC SDK's real proto encoders.
  parts.unshift('class FirstPartyEventLoggingExporter{constructor(options={}){this.timeout=options.timeout||10000}\n' + methods + '\n}')
  let body = parts.join('\n')
  body = body.replace(/\bexports_external\./g, 'd.zod.')
    .replace(/\bClaudeCodeInternalEvent\./g, 'd.claudeEvent.')
    .replace(/\bGrowthbookExperimentEvent\./g, 'd.growthEvent.')
  if (/\bexports_external\b/.test(body)) throw Error('Unmapped zod reference in actual native modules')
  const sdk = {
    init_zod: 'initZod',
    init_state: 'initState',
    init_config4: 'initConfig',
    init_firstPartyEventLoggingExporter: 'initExporter',
    getOrCreateUserID: 'userId',
    getSessionId: 'sessionId',
    getClaudeCodeUserAgent: 'userAgent',
    jsonStringify: 'stringify',
    to1PEventFormat: 'formatEvent',
    stripProtoFields: 'stripProto',
    logForDebugging: 'debug',
  }
  const forwards = Object.entries(sdk).map(([name, field]) => `function ${name}(...args){return d.${field}(...args)}`).join('\n')
  const bindings = [...new Map(imports.map(item => [item.local, item])).values()]
  const declarations = bindings.map(item => `const ${item.local}=d.builtins.${item.local};`).join('\n')
  const code = `function __vm1437TelemetryFactory(d){
const __esm=d.esm;
${declarations}
${forwards}
var $Agent,$request;
async function loadTransport(){const u=d.undici||await import("undici");if(typeof u.Agent!=="function"||typeof u.request!=="function")throw new Error("native_telemetry_transport_unavailable");$Agent=u.Agent;$request=u.request}
function init_undici(){if(!$Agent||!$request)throw new Error("native_telemetry_transport_uninitialized")}
${body}
return{
 load:loadTransport,
 start(publish){init_vmTelemetry();return startVmTelemetry(publish)},
 capture:captureVmJob,
 slotStart:sendSlotStart,
 record(name,metadata){init_vmTelemetryContract();return recordManagedAnalytics(name,metadata)},
 withHeaders(report,task){init_outboundHeaders();return withOutboundHeaders(report,task)},
 reportHeaders(headers){init_outboundHeaders();return reportOutboundHeaders(headers)},
 context(){init_vmTelemetryContext();return readVmTelemetryContext()},
 Owner:VmTelemetryOwner,
 Exporter:FirstPartyEventLoggingExporter,
 event(raw){init_vmTelemetryContract();return telemetryEventSchema.safeParse(raw)},
 egress:VmTelemetryEgress
}}
`
  espree.parse(code, { ecmaVersion: 'latest', sourceType: 'module', range: true })
  return { code, imports: bindings, sdk, modules, exporterMethods: required }
}
