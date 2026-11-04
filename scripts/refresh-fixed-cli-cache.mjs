#!/usr/bin/env node
/** Hash-pinned fixed-CLI refresh. Never installs/runs an ELF or copies a kernel. */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inspectBunElf, sha256, verifyUnchangedOutside } from './build-offline-native-candidates.mjs'

export const FIXED_CACHE_BASES = Object.freeze({
  wrap: {
    id: 'wrap-fixed-v186-r1',
    file: 'cli-node',
    input: 'share/wrap-cli/cli-node',
    packed: '10140f71c2f2b59a274b4418d8deeb77189c31c58d3a9e02d87b7afc382f7d80',
    unpacked: '33fa35bc5aa328e8b92650305556660a09807e98b86ccc4dedb5cb6a25288ee3',
  },
  cc: {
    id: 'cc-fixed-v186-r1',
    file: 'cc-node',
    input: 'share/cc-fixed/v155-r3/cc-node',
    upstreamInput: 'share/wrap-cli/cc-node',
    upstreamPacked: 'be5eec49a78345dd935e302e88c9d7ad0afbb09a195356d81be1bdea766f3960',
    packed: '0e9744c49ce5971eafe4e5864cdbcdff77838343ceaba2727f55812a5265e7fd',
    unpacked: '92a701f08ed5c9c633ebc3b9f4873adb93d257a8ae95527651b81eaad03039f9',
  },
})
const requireThat = (ok, text) => {
  if (!ok) throw new Error(text)
}
const MINIFY =
  'const t=new Bun.Transpiler({loader:"js",target:"bun",minifyWhitespace:true,minifySyntax:false,minifyIdentifiers:false,deadCodeElimination:false,inline:false});process.stdout.write(t.transformSync(await Bun.stdin.text()));'
const SCAN =
  'const t=new Bun.Transpiler({loader:"js",target:"bun",deadCodeElimination:false,inline:false});const s=t.scan(await Bun.stdin.text());console.log(JSON.stringify({syntax:true,imports:s.imports.length,exports:s.exports.length}));'

function segment(source, begin, end) {
  const start = source.indexOf(begin)
  requireThat(start >= 0 && source.indexOf(begin, start + begin.length) < 0, `Ambiguous start: ${begin}`)
  const stop = source.indexOf(end, start + begin.length)
  requireThat(stop > start, `Missing end: ${end}`)
  return { start, text: source.slice(start, stop) }
}
function replaceOnce(text, before, after) {
  requireThat(text.split(before).length === 2, `Expected one replacement: ${before}`)
  return text.replace(before, after)
}
function sourceSegments(source) {
  const queryMatch = /async function\s*\*\s*queryKinMessagesWithStreaming\(/.exec(source)
  requireThat(queryMatch, 'Missing native query bridge')
  const queryEnd = source.indexOf('\nfunction ', queryMatch.index)
  requireThat(queryEnd > queryMatch.index, 'Missing query boundary')
  const apiMatch = /const kinSystemLayout\s*=\s*getSystemLayout\(\)/.exec(source)
  requireThat(apiMatch, 'Missing API system construction')
  const apiEnd = source.indexOf('const useBetas =', apiMatch.index)
  requireThat(apiEnd > apiMatch.index, 'Missing API boundary')
  return { query: source.slice(queryMatch.index, queryEnd), system: source.slice(apiMatch.index, apiEnd) }
}

// Same native marker semantics as the new upstream cacheTtl module. Local names
// are short to fit the original ELF span; the tests compare 200 edge cases to the
// actual upstream functions. The adjacent beta module is minified, not changed.
const CC_CACHE_FILL = `function fillMissingCacheTtl(p, ttl) {
  const system = Array.isArray(p.system) ? p.system : p.system != null ? [p.system] : [];
  const tools = Array.isArray(p.tools) ? p.tools : [];
  const messages = Array.isArray(p.messages) ? p.messages : [];
  for (const b of system) stampBlock(b, ttl, true);
  let last;
  for (const tool of tools) {
    stampBlock(tool, ttl, true);
    if (!tool || typeof tool !== "object" || tool.defer_loading === true || tool.custom?.defer_loading === true) continue;
    const type = String(tool.type || "");
    if (type === "" || type === "function" || type === "custom") last = tool;
  }
  if (last) {
    if (!last.cache_control) last.cache_control = { type: "ephemeral", ttl };
    else stampBlock(last, ttl, true);
  }
  const messageBlocks = [];
  for (const m of messages) {
    if (!m || typeof m !== "object" || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "thinking" || b.type === "redacted_thinking") delete b.cache_control;
      else stampBlock(b, ttl);
      messageBlocks.push(b);
    }
  }
  const marked = (b) => b && typeof b === "object" && b.cache_control;
  const s = system.filter(marked), t = tools.filter(marked), m = messageBlocks.filter(marked);
  const excess = s.length + t.length + m.length - 4;
  if (excess > 0) for (const b of [...t.reverse(), ...s.reverse(), ...m].slice(0, excess)) delete b.cache_control;
}
`

export function refreshFixedBytes(original, kind, donorSource, minify) {
  const base = FIXED_CACHE_BASES[kind]
  requireThat(base && sha256(original) === base.unpacked, `Wrong ${kind} unpacked baseline`)
  const graph = inspectBunElf(original)
  const source = graph.source.toString('utf8')
  requireThat(Buffer.from(source).equals(graph.source), 'Native source is not UTF-8')
  const sourceOffset = graph.modules[graph.entry].sourceOffset
  const changes = []
  const add = (id, selected, replacement) => {
    const before = Buffer.from(selected.text),
      data = Buffer.from(replacement)
    requireThat(data.length <= before.length, `${id} exceeds fixed span: ${data.length}/${before.length}`)
    const offset = sourceOffset + Buffer.byteLength(source.slice(0, selected.start))
    requireThat(original.subarray(offset, offset + before.length).equals(before), 'Character/byte offset mismatch')
    const padded = Buffer.concat([data, Buffer.alloc(before.length - data.length, 32)])
    changes.push({
      id,
      offset,
      bytes: before.length,
      replacement_bytes: data.length,
      before_sha256: sha256(before),
      after_sha256: sha256(padded),
      before: selected.text,
      after: replacement,
      padded,
    })
  }
  const minifyBody = (text) => {
    const wrapped = minify(`export async function __vm2api_patch(){${text}}`).trim()
    const prefix = 'export async function __vm2api_patch(){'
    requireThat(wrapped.startsWith(prefix) && wrapped.endsWith('}'), 'Unexpected minified wrapper')
    return wrapped.slice(prefix.length, -1)
  }
  if (kind === 'wrap') {
    requireThat(!source.includes('__vm2apiSys'), 'Upstream already has the fork snapshot')
    const query = segment(source, 'async function* queryKinMessagesWithStreaming({', '\nfunction ')
    const updated = replaceOnce(
      query.text,
      '      agentId: "kin-slot",',
      '      agentId: "kin-slot", __vm2apiSys: system.slice(),',
    )
    add(
      'snapshot-caller-system',
      query,
      minify(`export ${updated}`)
        .trim()
        .replace(/^export\s+/, ''),
    )
    const api = segment(source, 'const kinSystemLayout = getSystemLayout();', '  const useBetas')
    const split = api.text.indexOf('  } else if (kinSystemLayout !== "stock")')
    requireThat(split > 0, 'Missing native/non-native split')
    // Only the kin branch bypasses the lossy leftover merger. Non-kin stays exact.
    const kin = replaceOnce(
      api.text.slice(0, split),
      '      }),\n      leftover: leftoverFromSystemPrompt(systemPrompt)',
      '      })',
    )
    const extension = `
if(kinQuery&&kinSystemLayout!=="stock"&&Array.isArray(options2.__vm2apiSys)&&options2.__vm2apiSys.length){
 const caller=options2.__vm2apiSys.map(text=>({type:"text",text}));
 const tail=system[system.length-1];
 if(tail?.cache_control&&tail.cache_control.scope!=="global"){
  caller[caller.length-1].cache_control=tail.cache_control;delete tail.cache_control;
 }
 system.push(...caller);
}
`
    add('preserve-caller-api-blocks', api, minifyBody(kin + api.text.slice(split) + extension))
  } else {
    requireThat(source.includes('__vm2apiSys') && source.includes('getWorkload2()'), 'Missing accepted CC repairs')
    const cache = segment(source, 'function normalizePanelCacheTtl(', '// src/kin/querySource.ts')
    let updated = replaceOnce(
      cache.text,
      'explicitCacheTtl([opts.tools, opts.messages])',
      'explicitCacheTtl([opts.system, opts.tools, opts.messages])',
    )
    updated = replaceOnce(
      updated,
      'function stampBlock(block2, ttl) {',
      'function stampBlock(block2, ttl, force = false) {',
    )
    updated = replaceOnce(
      updated,
      'if ("ttl" in control && normalizePanelCacheTtl(control.ttl))',
      'if (!force && "ttl" in control && normalizePanelCacheTtl(control.ttl))',
    )
    const begin = updated.indexOf('function fillMissingCacheTtl('),
      end = updated.indexOf('var KERNEL_CONFIG;', begin)
    requireThat(begin >= 0 && end > begin, 'Missing old CC cache filler')
    updated = updated.slice(0, begin) + CC_CACHE_FILL + updated.slice(end)
    add('native-cache-continuity', cache, minify(updated).trim())
    const selection = segment(
      source,
      '    if (isKinQuerySource(options2.querySource)) {\n      const ttl = resolveKinCacheTtl(',
      '\n    return {',
    )
    add(
      'include-system-cache-ttl',
      selection,
      minifyBody(
        replaceOnce(
          selection.text,
          '      const ttl = resolveKinCacheTtl({',
          '      const ttl = resolveKinCacheTtl({ system,',
        ),
      ),
    )
  }
  changes.sort((a, b) => a.offset - b.offset)
  const bytes = Buffer.from(original)
  let end = 0
  for (const patch of changes) {
    requireThat(
      patch.offset >= end &&
        patch.offset >= sourceOffset &&
        patch.offset + patch.bytes <= sourceOffset + graph.source.length,
      'Overlapping/outside-source patch',
    )
    patch.padded.copy(bytes, patch.offset)
    end = patch.offset + patch.bytes
  }
  verifyUnchangedOutside(original, bytes, changes)
  const after = inspectBunElf(bytes)
  requireThat(
    JSON.stringify({ ...graph, source: null }) === JSON.stringify({ ...after, source: null }),
    'ELF/Bun/resource graph changed',
  )
  const finalSource = after.source.toString('utf8')
  const segments = sourceSegments(finalSource)
  const cacheSource =
    kind === 'wrap'
      ? segment(finalSource, 'function normalizePanelCacheTtl(', '// src/kin/officialBetas.ts').text
      : changes.find((p) => p.id === 'native-cache-continuity').after
  const upstreamCache = segment(donorSource, 'function normalizePanelCacheTtl(', '// src/kin/officialBetas.ts').text
  const semantics = {
    ...segments,
    query_before: sourceSegments(source).query,
    system_before: sourceSegments(source).system,
    cache: cacheSource,
    cache_before: segment(source, 'function normalizePanelCacheTtl(', '// src/kin/querySource.ts').text,
    upstream_cache: upstreamCache,
    cache_method: kind === 'wrap' ? 'applyKinOwnedCacheMarkers' : 'fillMissingCacheTtl',
  }
  return { bytes, changes: changes.map(({ padded, ...p }) => p), semantics, graph: { ...after, source: undefined } }
}

export function buildFixedCacheRefresh({ root, outputRoot, evidence, upx, bun }) {
  requireThat(root && outputRoot && evidence && upx && bun, 'Explicit root/outputRoot/evidence/upx/bun are required')
  const run = (exe, args, opts = {}) =>
    execFileSync(exe, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 300000, ...opts })
  const minify = (text) => run(bun, ['-e', MINIFY], { input: text })
  const tools = { upx: run(upx, ['--version']).split(/\r?\n/)[0], bun: run(bun, ['--version']).trim() }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-fixed-cache-'))
  const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n')
  fs.mkdirSync(evidence, { recursive: true })
  try {
    const originals = {}
    for (const [kind, base] of Object.entries(FIXED_CACHE_BASES)) {
      const input = path.join(root, base.input)
      if (base.upstreamInput)
        requireThat(
          sha256(fs.readFileSync(path.join(root, base.upstreamInput))) === base.upstreamPacked,
          'Upstream CC changed; re-review its repair lineage instead of rebuilding the old base',
        )
      requireThat(
        sha256(fs.readFileSync(input)) === base.packed,
        `Wrong ${kind} packed source; do not apply stale offsets`,
      )
      const dest = path.join(outputRoot, `${kind}-fixed/v186-r1`, base.file)
      requireThat(!fs.existsSync(dest), `Refusing to replace an existing binary: ${dest}`)
      const unpacked = path.join(tmp, kind + '.source')
      run(upx, ['-d', '-o', unpacked, input])
      originals[kind] = fs.readFileSync(unpacked)
      requireThat(sha256(originals[kind]) === base.unpacked, `Wrong ${kind} decompression`)
    }
    const donor = inspectBunElf(originals.wrap).source.toString('utf8')
    const manifests = {}
    for (const [kind, base] of Object.entries(FIXED_CACHE_BASES)) {
      const result = refreshFixedBytes(originals[kind], kind, donor, minify)
      const dir = path.join(outputRoot, `${kind}-fixed/v186-r1`)
      fs.mkdirSync(dir, { recursive: true })
      const uncompressed = path.join(tmp, kind + '.refreshed')
      fs.writeFileSync(uncompressed, result.bytes, { mode: 0o555 })
      const syntax = JSON.parse(run(bun, ['-e', SCAN], { input: inspectBunElf(result.bytes).source, timeout: 120000 }))
      requireThat(syntax.syntax, 'Full source syntax failed')
      const dest = path.join(dir, base.file)
      run(upx, ['--best', '--lzma', '-o', dest, uncompressed])
      const integrity = run(upx, ['-t', dest])
      const roundtrip = path.join(tmp, kind + '.roundtrip')
      run(upx, ['-d', '-o', roundtrip, dest])
      requireThat(fs.readFileSync(roundtrip).equals(result.bytes), 'UPX roundtrip differs')
      writeJson(path.join(dir, 'patches.json'), { [base.file]: result.changes })
      writeJson(path.join(dir, 'semantics.json'), result.semantics)
      const artifact = {
        file: base.file,
        bytes: fs.statSync(dest).size,
        sha256: sha256(fs.readFileSync(dest)),
        unpacked_bytes: result.bytes.length,
        unpacked_sha256: sha256(result.bytes),
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
        patches: result.changes.map(({ before, after, ...p }) => p),
      }
      const manifest = {
        version: 1,
        id: base.id,
        status: 'owner_approved',
        production_approved: true,
        dataplane: `${kind}-fixed`,
        kernel_policy: 'shared_upstream',
        approval_scope: 'cli_only',
        approval: {
          date: '2026-09-30',
          basis:
            'owner requested refreshed native cache behavior while retaining fixed system preservation; prior authorization permits local verification before normal use',
          scope: 'local extracted-source and packaging checks; no new Linux/provider runtime capture',
        },
        lineage: {
          source_file: base.input,
          source_sha256: base.packed,
          upstream_cli_sha256: FIXED_CACHE_BASES.wrap.packed,
          cc_preserves_accepted_repairs: kind === 'cc',
          ...(kind === 'cc' ? { original_cc_sha256: base.upstreamPacked } : {}),
        },
        cache_contract: 'node_dual_anchor_v1',
        supported_layouts: ['zero', 'identity'],
        artifacts: { [base.file]: artifact },
        tools,
        patches_sha256: sha256(fs.readFileSync(path.join(dir, 'patches.json'))),
        semantics_sha256: sha256(fs.readFileSync(path.join(dir, 'semantics.json'))),
        local_validation: { completed: false, native_execution: false },
        limitations: [
          'No Linux ELF/kernel/provider execution',
          'No guarantee of quota savings, thinking or format compliance',
          'Stock/non-kin behavior unchanged; only zero/identity native path has caller snapshot guarantee',
        ],
      }
      writeJson(path.join(dir, 'manifest.json'), manifest)
      fs.copyFileSync(uncompressed, path.join(evidence, kind + '.refreshed.unpacked'))
      fs.writeFileSync(path.join(evidence, kind + '.upx.log'), integrity)
      manifests[kind] = { manifest, dir }
    }
    const testFile = path.join(root, 'test/unit/fixed-cache-refresh-code.test.mjs')
    const log = run(process.execPath, ['--test', '--test-reporter=tap', testFile], {
      cwd: root,
      env: { ...process.env, FIXED_CACHE_SEMANTICS: path.resolve(outputRoot) },
    })
    fs.writeFileSync(path.join(evidence, 'semantics-green.tap'), log)
    const tests = Number(log.match(/^# tests (\d+)$/m)?.[1])
    requireThat(tests >= 56 && /^# fail 0$/m.test(log) && /^# skipped 0$/m.test(log), 'Source behavior tests failed')
    for (const { manifest, dir } of Object.values(manifests)) {
      manifest.local_validation = {
        completed: true,
        native_execution: false,
        behavior_tests: tests,
        test_sha256: sha256(fs.readFileSync(testFile)),
        scope: 'actual extracted source spans and native cache oracle; not ELF/provider execution',
      }
      writeJson(path.join(dir, 'manifest.json'), manifest)
    }
    return Object.fromEntries(Object.entries(manifests).map(([kind, { manifest }]) => [kind, manifest]))
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const arg = (k) => {
    const i = args.indexOf(k)
    return i < 0 ? undefined : args[i + 1]
  }
  console.log(
    JSON.stringify(
      buildFixedCacheRefresh({
        root: path.resolve(arg('--root') || path.join(path.dirname(fileURLToPath(import.meta.url)), '..')),
        outputRoot: arg('--output-root'),
        evidence: arg('--evidence'),
        upx: arg('--upx'),
        bun: arg('--bun'),
      }),
      null,
      2,
    ),
  )
}
