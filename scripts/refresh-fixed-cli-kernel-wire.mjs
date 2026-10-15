#!/usr/bin/env node
/** Fixed CLI maintenance for the unprefixed kernel v2 protocol; no private kernel copy. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { inspectBunElf, sha256, verifyUnchangedOutside } from './build-offline-native-candidates.mjs'
import { sourceRange, sourceFunction } from './refresh-fixed-cli-lifecycle.mjs'
import { auditNativeBindings } from './refresh-fixed-cc-session.mjs'

export const KERNEL_WIRE_REFERENCE = 'db4f0d6b927c0479e313a15ac7028c65ed8dd8c135636c73ae0281a342358310'
export const KERNEL_WIRE_CONTRACT = 'unprefixed_native_v2'
export const KERNEL_WIRE_BASES = Object.freeze({
  wrap: {
    id: 'wrap-fixed-v1124-r1',
    file: 'cli-node',
    input: 'share/wrap-cli/cli-node',
    packed: KERNEL_WIRE_REFERENCE,
    unpacked: 'ad12b1b66ff5748e43a086acebd01daffbacf257245127a62182ccc3854adbc0',
  },
  cc: {
    id: 'cc-fixed-v1124-r1',
    file: 'cc-node',
    input: 'share/cc-fixed/v1108-r1/cc-node',
    packed: '3da4d875e96f0412be8d44a0eb9add3bd8d0ac780e3afa8b1c4fb44bd6f15236',
    unpacked: 'aa017f5d3402b9d85473a20cb6098202e763081c1436d9b564083fd8139e37b9',
  },
})
const need = (value, reason) => {
  if (!value) throw Error(reason)
}
const json = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n')
const once = (source, from, to) => {
  need(source.split(from).length === 2, 'Expected exactly one anchor: ' + from)
  return source.replace(from, to)
}
const nativeRange = (source) => sourceRange(source, '// src/kin/stdioProtocol.ts', '// src/kin/slotPool.ts')
const helpers = (source) =>
  ['validClassifierContext', 'classifierSystemBlocks'].map((name) => sourceFunction(source, name).text).join('\n')
const minFunction = (text, minify) =>
  minify('export ' + text)
    .trim()
    .replace(/^export\s+/, '')
const minStatements = (text, minify) => {
  const result = minify('export async function* __wire(){' + text + '}').trim()
  need(
    /^export\s+async\s+function\s*\*\s*__wire\(\)\{/.test(result) && result.endsWith('}'),
    'Unexpected minifier wrapper',
  )
  return result.slice(result.indexOf('{') + 1, -1) + ';'
}
const nativeKinds = [
  'job_start',
  'cancel',
  'ping',
  'host_ready',
  'slot_ready',
  'stream_event',
  'job_error',
  'job_done',
  'cancel_ack',
  'pong',
  'response_headers',
]
function apiReturn(source, from) {
  const hit = /\breturn\s*\{/.exec(source.slice(from))
  need(hit, 'Missing API return')
  const start = from + hit.index,
    brace = source.indexOf('{', start)
  for (let end = source.indexOf('}', brace); end >= 0 && end < brace + 20000; end = source.indexOf('}', end + 1)) {
    try {
      new Function('return (' + source.slice(brace, end + 1) + ');')
    } catch {
      continue
    }
    end++
    if (source[end] === ';') end++
    return { start, text: source.slice(start, end) }
  }
  throw Error('Cannot parse bounded API return')
}

export function patchKernelWireBytes(original, kind, { minify }) {
  const base = KERNEL_WIRE_BASES[kind]
  need(base && sha256(original) === base.unpacked, 'Unknown kernel-wire baseline: ' + kind)
  const graph = inspectBunElf(original),
    source = graph.source.toString('utf8')
  need(Buffer.from(source).equals(graph.source), 'Source must be lossless UTF-8')
  const origin = graph.modules[graph.entry].sourceOffset,
    changes = []
  const add = (id, selected, text) => {
    const before = Buffer.from(selected.text),
      after = Buffer.from(text)
    need(after.length <= before.length, `${id} exceeds fixed span ${after.length}/${before.length}`)
    const offset = origin + Buffer.byteLength(source.slice(0, selected.start))
    need(original.subarray(offset, offset + before.length).equals(before), 'Source offset mismatch')
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
  const covered = (index) => changes.some((p) => index >= p.offset - origin && index < p.offset - origin + p.bytes)
  const query = sourceFunction(source, 'queryKinMessagesWithStreaming')
  if (kind === 'wrap') {
    const bridge = once(query.text, '      agentId: "slot",', '      agentId: "slot", __vm2apiSys: system.slice(),')
    add('caller-system-snapshot', query, minFunction(bridge, minify))
    const system = sourceRange(source, 'const kinSystemLayout', 'const useBetas')
    const split = system.text.indexOf('  } else if (kinSystemLayout !== "stock")')
    need(split > 0, 'Missing non-kin system branch')
    const kin = once(
      system.text.slice(0, split),
      '      }),\n      leftover: leftoverFromSystemPrompt(systemPrompt)',
      '      })',
    )
    const append =
      'if(kinQuery&&!options2.requestContext&&kinSystemLayout!=="stock"&&Array.isArray(options2.__vm2apiSys)&&options2.__vm2apiSys.length){const caller=options2.__vm2apiSys.map(text=>({type:"text",text}));const tail=system[system.length-1];if(tail?.cache_control&&tail.cache_control.scope!=="global"){caller[caller.length-1].cache_control=tail.cache_control;delete tail.cache_control;}system.push(...caller);}'
    add('caller-system-blocks', system, minStatements(kin + system.text.slice(split) + append, minify))
  } else {
    // Reuse the CC implementation and all its repaired dependencies, not the wrap runtime.
    let bridge = query.text
    bridge = bridge.replace(/\bcontextManagement\s*,/, 'safeguards,contextManagement,')
    need(bridge !== query.text, 'Missing CC bridge parameter')
    bridge = once(bridge, 'contextManagementOverride:', 'safeguards,contextManagementOverride:')
    add('native-safeguards-bridge', query, minFunction(bridge, minify))
    const native = nativeRange(source)
    let code = native.text
    for (const name of nativeKinds) code = code.replaceAll('"kin_' + name + '"', '"' + name + '"')
    const gate = /!([A-Za-z_$][\w$]*)\.type\.startsWith\("kin_"\)/g
    need([...code.matchAll(gate)].length === 1, 'Native input gate changed')
    code = code.replace(
      gate,
      '![' + ['job_start', 'cancel', 'ping'].map((value) => JSON.stringify(value)).join(',') + '].includes($1.type)',
    )
    code = code.replaceAll('process.env.CLAUDE_CODE_KIN_', 'process.env.CLAUDE_CODE_')
    code = once(
      code,
      'contextManagement:request2.context_management,',
      'contextManagement:request2.context_management,safeguards:request2.safeguards,',
    )
    add('native-unprefixed-wire', native, '// src/kin/stdioProtocol.ts\n' + minify(code).trim())

    const qm = sourceFunction(source, 'queryModel').start
    const temp = sourceRange(source, 'const temperature', 'const apiMessages', qm)
    need(temp.text.includes('const presentBetas'), 'Missing native beta construction')
    const betaLine = /const presentBetas\s*=\s*betasParams\.filter\(Boolean\);/
    need(betaLine.test(temp.text), 'Beta expression changed')
    const messages = source.indexOf('const apiMessages', qm)
    const result = apiReturn(source, messages)
    const construction = { start: temp.start, text: source.slice(temp.start, result.start + result.text.length) }
    const beta = construction.text.replace(
      betaLine,
      'const presentBetas=betasParams.filter(Boolean);if(options2.safeguards!=null&&!presentBetas.includes("afk-mode-2026-01-31"))presentBetas.push("afk-mode-2026-01-31");',
    )
    const resultBody = once(
      beta,
      '...extraBodyParams,',
      '...extraBodyParams,...(options2.safeguards!=null?{safeguards:options2.safeguards}:{}),',
    )
    add('native-safeguards-api', construction, minStatements(resultBody, minify))

    const cacheInit = /KERNEL_CONFIG\s*=\s*process\.env\.KIN_KERNEL_CONFIG\s*\|\|\s*"\/run\/kin\/kernel\.json"/.exec(
      source,
    )
    need(cacheInit, 'Missing CC kernel config assignment')
    add(
      'native-cache-config-path',
      { start: cacheInit.index, text: cacheInit[0] },
      'KERNEL_CONFIG=process.env.KERNEL_CONFIG||"/run/guest/kernel.json"',
    )
    const sourceKind = sourceFunction(source, 'isKinQuerySource')
    add('native-query-source-name', sourceKind, sourceKind.text.replace('"kin_native_messages"', '"native_messages"'))
    // Member-expression replacements stay lexically complete; padding is outside tokens.
    for (const [old, next] of [
      ['process.env.CLAUDE_CODE_KIN_NATIVE_SLOTS', 'process.env.CLAUDE_CODE_NATIVE_SLOTS'],
      ['process.env.CLAUDE_CODE_KIN_HOST_REFRESH', 'process.env.CLAUDE_CODE_HOST_REFRESH'],
      ['process.env.KIN_SYSTEM_MODE', 'process.env.SYSTEM_MODE'],
      ['process.env.KIN_SLOT_TZ', 'process.env.SLOT_TZ'],
    ]) {
      let count = 0,
        at = -1
      while ((at = source.indexOf(old, at + 1)) >= 0) {
        const byteIndex = Buffer.byteLength(source.slice(0, at))
        if (covered(byteIndex)) continue
        add('native-env-' + old.split('.').at(-1).toLowerCase() + '-' + ++count, { start: at, text: old }, next)
      }
      need(count > 0, 'Missing CC environment member: ' + old)
    }
  }
  changes.sort((a, b) => a.offset - b.offset)
  const bytes = Buffer.from(original)
  let end = origin
  for (const patch of changes) {
    need(patch.offset >= end && patch.offset + patch.bytes <= origin + graph.source.length, 'Overlapping/non-JS span')
    Buffer.concat([Buffer.from(patch.after), Buffer.alloc(patch.bytes - patch.replacement_bytes, 32)]).copy(
      bytes,
      patch.offset,
    )
    end = patch.offset + patch.bytes
  }
  verifyUnchangedOutside(original, bytes, changes)
  const after = inspectBunElf(bytes)
  need(
    JSON.stringify({ ...graph, source: null }) === JSON.stringify({ ...after, source: null }),
    'ELF/Bun layout changed',
  )
  return { bytes, changes, sourceBefore: source, sourceAfter: after.source.toString('utf8') }
}

/** Active native snippets alongside retained, explicitly named before/reference spans. */
export function wireSemantics(source, kind, previous, sourceBefore) {
  const sem = structuredClone(previous)
  const nativeHelper =
    kind === 'wrap'
      ? sourceFunction(source, 'kernelEnv').text + '\n' + helpers(source)
      : sourceRange(source, 'var __vm2apiJobError=', '// src/tools/FileReadTool/imageProcessor.ts').text +
        '\n' +
        sem.session.helper
  const native = nativeHelper + '\n' + nativeRange(source).text
  const query = sourceFunction(source, 'queryKinMessagesWithStreaming').text
  const system = sourceRange(source, kind === 'cc' ? 'const _v194s=' : 'const kinSystemLayout', 'const useBetas').text
  const qm = sourceFunction(source, 'queryModel').start
  const range = (from, to) => sourceRange(source, from, to, qm).text
  const apiHelpers =
    kind === 'wrap'
      ? sourceFunction(source, 'withServerSafeguardBeta').text +
        '\nvar ' +
        source.match(/AFK_MODE_SERVER_BETA\s*=\s*"[^"]+"/)[0] +
        ';'
      : ''
  sem.query = query
  sem.lifecycle = {
    ...sem.lifecycle,
    native,
    native_fragments: [native],
    query,
    query_before: sourceBefore
      ? sourceFunction(sourceBefore, 'queryKinMessagesWithStreaming').text
      : previous.lifecycle.query_before,
    retry: sourceFunction(source, 'withRetry').text,
  }
  sem.classifier = {
    ...sem.classifier,
    native,
    query,
    system,
    query_before: sem.lifecycle.query_before,
    api_helpers: apiHelpers,
    classifierHelpers: kind === 'wrap' ? helpers(source) : sem.classifier.classifierHelpers,
    api_after: {
      ...sem.classifier.api_after,
      thinking: range('const hasThinking', 'const contextManagement'),
      management: range('const contextManagement', 'const enablePromptCaching2'),
      effort: range('const outputConfig', 'if (options2.outputFormat'),
      temperature: range('const temperature', 'const apiMessages'),
    },
  }
  const refresh = sourceFunction(source, 'checkAndRefreshOAuthTokenIfNeededImpl').text.trim()
  sem.host_refresh.after = refresh
  sem.host_refresh.reference = refresh
  sem.verdict.refresh_impl = refresh
  sem.kernel_wire = {
    contract: KERNEL_WIRE_CONTRACT,
    query,
    native,
    system,
    parse_stdin: sourceFunction(source, 'parseStdinLine').text,
    entry: sourceFunction(source, 'main2').text,
    slot_count: sourceFunction(source, 'nativeSlotCount').text,
    environment: kind === 'wrap' ? sourceFunction(source, 'kernelEnv').text : null,
    api_body: apiReturn(source, source.indexOf('const apiMessages', qm)).text,
    host_refresh: refresh,
    api_helpers: apiHelpers,
    reference_note:
      'Top-level system/query_before/cache_before fields retain earlier comparison spans; active classifier/lifecycle/kernel_wire fields above are extracted from this image.',
  }
  return sem
}

export async function buildFixedKernelWire({ root, outputRoot, evidence, upx, bun, verify }) {
  need(root && outputRoot && evidence && upx && bun && verify, 'Explicit inputs/verifier required')
  const run = (exe, args, options = {}) =>
    execFileSync(exe, args, { encoding: 'utf8', timeout: 300000, maxBuffer: 40 * 1024 * 1024, ...options })
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-kernel-wire-'))
  fs.mkdirSync(evidence, { recursive: true })
  try {
    need(
      sha256(fs.readFileSync(path.join(root, 'share/wrap-cli/cli-node'))) === KERNEL_WIRE_REFERENCE,
      'Upstream reference changed',
    )
    need(
      sha256(fs.readFileSync(path.join(root, 'share/wrap-cli/cc-node'))) ===
        'be5eec49a78345dd935e302e88c9d7ad0afbb09a195356d81be1bdea766f3960',
      'Original CC changed',
    )
    const minify = (text) =>
      run(
        bun,
        [
          '-e',
          'const t=new Bun.Transpiler({loader:"js",target:"bun",minifyWhitespace:true,minifySyntax:false,minifyIdentifiers:false,deadCodeElimination:false,inline:false});process.stdout.write(t.transformSync(await Bun.stdin.text()))',
        ],
        { input: text },
      )
    const results = []
    for (const [kind, base] of Object.entries(KERNEL_WIRE_BASES)) {
      const input = path.join(root, base.input),
        raw = path.join(temp, kind + '-before')
      need(sha256(fs.readFileSync(input)) === base.packed, 'Packed baseline changed: ' + kind)
      run(upx, ['-d', '-o', raw, input])
      const original = fs.readFileSync(raw)
      const patched = patchKernelWireBytes(original, kind, { minify })
      const parentDir = path.join(root, 'share', kind + '-fixed/v1108-r1')
      const parent = JSON.parse(fs.readFileSync(path.join(parentDir, 'manifest.json')))
      const previous = JSON.parse(fs.readFileSync(path.join(parentDir, 'semantics.json')))
      const sem = wireSemantics(patched.sourceAfter, kind, previous, patched.sourceBefore)
      const beforeAudit = auditNativeBindings(patched.sourceBefore, root),
        afterAudit = auditNativeBindings(patched.sourceAfter, root)
      need(afterAudit.native_unresolved.length === 0, 'Native scope has unresolved bindings')
      need(
        JSON.stringify(beforeAudit.whole_unresolved) === JSON.stringify(afterAudit.whole_unresolved),
        'Whole-module unresolved bindings changed',
      )
      const behavior = await verify(sem, kind)
      need(behavior?.ok && behavior.checks > 0, 'Behavior controls failed')
      const syntax = JSON.parse(
        run(
          bun,
          [
            '-e',
            'new Bun.Transpiler({loader:"js",target:"bun"}).scan(await Bun.stdin.text());console.log(JSON.stringify({syntax:true}))',
          ],
          { input: patched.sourceAfter },
        ),
      )
      const inherited =
        kind === 'wrap'
          ? []
          : [...(parent.inherited_repairs || []), ...parent.artifacts[base.file].patches].map((p) => {
              const before = original.subarray(p.offset, p.offset + p.bytes),
                after = patched.bytes.subarray(p.offset, p.offset + p.bytes)
              need(sha256(before) === p.after_sha256, 'Inherited input span changed: ' + p.id)
              return {
                ...p,
                previous_after_sha256: p.after_sha256,
                after_sha256: sha256(after),
                preserved: before.equals(after),
                overlap: patched.changes.some((n) => n.offset < p.offset + p.bytes && p.offset < n.offset + n.bytes),
              }
            })
      const dest = path.join(outputRoot, kind + '-fixed/v1124-r1')
      need(!fs.existsSync(dest), 'Refusing artifact overwrite')
      fs.mkdirSync(dest, { recursive: true })
      const changed = path.join(temp, kind + '-after'),
        file = path.join(dest, base.file),
        back = path.join(temp, kind + '-roundtrip')
      fs.writeFileSync(changed, patched.bytes)
      run(upx, ['--best', '--lzma', '-o', file, changed])
      run(upx, ['-t', file])
      run(upx, ['-d', '-o', back, file])
      need(fs.readFileSync(back).equals(patched.bytes), 'Roundtrip changed bytes')
      const packed = fs.readFileSync(file),
        patches = json({ [base.file]: patched.changes }),
        semBytes = json(sem)
      const artifact = {
        file: base.file,
        bytes: packed.length,
        sha256: sha256(packed),
        unpacked_bytes: patched.bytes.length,
        unpacked_sha256: sha256(patched.bytes),
        source_packed_sha256: base.packed,
        source_unpacked_sha256: base.unpacked,
        patches: patched.changes.map(({ before, after, ...p }) => p),
        validations: {
          elf_graph: true,
          no_bytecode: true,
          unchanged_outside_js_spans: true,
          syntax,
          native_bindings_resolved: true,
          upx_integrity: true,
          exact_unpack_roundtrip: true,
        },
      }
      const manifest = {
        ...parent,
        id: base.id,
        native_wire_contract: KERNEL_WIRE_CONTRACT,
        approval: {
          date: '2026-10-08',
          basis: 'owner-authorized locally verified fixed maintenance',
          scope: 'kernel wire/env compatibility; not actual Linux/cloud certification',
        },
        lineage: {
          ...parent.lineage,
          source_file: base.input,
          source_sha256: base.packed,
          previous_release: parent.id,
          upstream_cli_sha256: KERNEL_WIRE_REFERENCE,
          kernel_wire_reference_commit: '18188710',
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
          scope: 'actual patched native/bridge and preserved controls; fake SDK, no provider/ELF execution',
        },
      }
      fs.writeFileSync(path.join(dest, 'manifest.json'), json(manifest))
      fs.writeFileSync(path.join(dest, 'patches.json'), patches)
      fs.writeFileSync(path.join(dest, 'semantics.json'), semBytes)
      fs.writeFileSync(path.join(evidence, kind + '.unpacked'), patched.bytes)
      fs.writeFileSync(path.join(evidence, kind + '-scope.json'), json({ before: beforeAudit, after: afterAudit }))
      results.push({ kind, ...artifact, behavior })
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
  const { verifyKernelWireSource } = await import('../test/support/fixed-kernel-wire-controls.mjs')
  console.log(
    JSON.stringify(
      await buildFixedKernelWire({
        root: arg('--root'),
        outputRoot: arg('--output'),
        evidence: arg('--evidence'),
        upx: arg('--upx'),
        bun: arg('--bun'),
        verify: verifyKernelWireSource,
      }),
      null,
      2,
    ),
  )
}
