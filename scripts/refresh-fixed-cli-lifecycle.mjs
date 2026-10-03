#!/usr/bin/env node
/** Hash-bound v191 maintenance: caller preservation + upstream native lifecycle, no kernel patch. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { inspectBunElf, sha256, verifyUnchangedOutside } from './build-offline-native-candidates.mjs'

export const LIFECYCLE_BASES = Object.freeze({
  wrap: {
    id: 'wrap-fixed-v191-r1',
    file: 'cli-node',
    input: 'share/wrap-cli/cli-node',
    packed: 'a32241fb000f9696f846efcc32ab72d07714465edbc16fe914b33f62d65c83cc',
    unpacked: '201054c429f3b8baa76b2690172a4393ea37f19c7fa52516fdd2b4a63c98748b',
    previous: 'wrap-fixed/v189-r1',
  },
  cc: {
    id: 'cc-fixed-v191-r1',
    file: 'cc-node',
    input: 'share/cc-fixed/v189-r1/cc-node',
    packed: 'da51e3a0255f1e24bc8139de9e7c7530e9de337499a7ed8f6b80c6b1f8e382a5',
    unpacked: 'd1b4d0dbeab173391842c4338395954b69a56a7f6364f98c5cbb78e9f710b6ea',
    previous: 'cc-fixed/v189-r1',
  },
})
export const LIFECYCLE_ORIGINAL_CC = 'be5eec49a78345dd935e302e88c9d7ad0afbb09a195356d81be1bdea766f3960'
const ensure = (ok, message) => {
  if (!ok) throw Error(message)
}
const jsonBytes = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n')
const MINIFY =
  'const t=new Bun.Transpiler({loader:"js",target:"bun",minifyWhitespace:true,minifySyntax:false,minifyIdentifiers:false,deadCodeElimination:false,inline:false});process.stdout.write(t.transformSync(await Bun.stdin.text()));'
const SCAN =
  'const t=new Bun.Transpiler({loader:"js",target:"bun",deadCodeElimination:false,inline:false});const s=t.scan(await Bun.stdin.text());console.log(JSON.stringify({syntax:true,imports:s.imports.length,exports:s.exports.length}));'
function once(text, a, b) {
  ensure(text.split(a).length === 2, `Expected one occurrence: ${a}`)
  return text.replace(a, b)
}
export function sourceRange(source, begin, end, from = 0) {
  const start = source.indexOf(begin, from),
    stop = source.indexOf(end, start + begin.length)
  ensure(start >= 0 && stop > start, `Missing source boundary: ${begin}`)
  return { start, text: source.slice(start, stop) }
}
/** Parse, never execute, a bounded complete function; works for pretty and padded minified source. */
export function sourceFunction(source, name) {
  const re = new RegExp('\\b(async\\s+)?function\\s*\\*?\\s*' + name + '\\s*\\(', 'g')
  const hits = [...source.matchAll(re)]
  ensure(hits.length === 1, `Ambiguous function ${name}`)
  const start = hits[0].index,
    limit = Math.min(source.length, start + 250000)
  for (let end = source.indexOf('}', start); end >= 0 && end < limit; end = source.indexOf('}', end + 1)) {
    try {
      new Function('return (' + source.slice(start, end + 1) + ');')
    } catch {
      continue
    }
    end++
    while (end < source.length && /\s/.test(source[end])) end++
    return { start, text: source.slice(start, end) }
  }
  throw Error(`Cannot parse bounded function ${name}`)
}
function minFunction(text, minify) {
  return minify('export ' + text.trim())
    .trim()
    .replace(/^export\s+/, '')
}
function minStatements(text, minify) {
  const prefix = 'export async function* __vm191(){'
  const result = minify(prefix + text + '}').trim()
  ensure(
    /^export\s+async\s+function\s*\*\s*__vm191\(\)\{/.test(result) && result.endsWith('}'),
    'Unexpected statement minification',
  )
  return result.slice(result.indexOf('{') + 1, -1)
}
function queryWithSnapshot(source) {
  const selected = sourceFunction(source, 'queryKinMessagesWithStreaming')
  return {
    selected,
    text: once(selected.text, '      agentId: "kin-slot",', '      agentId: "kin-slot", __vm2apiSys: system.slice(),'),
  }
}
function nativeModule(source) {
  return sourceRange(source, '// src/kin/stdioProtocol.ts', '// src/kin/slotPool.ts')
}
function jobErrorModule(source) {
  return sourceRange(source, '// src/kin/jobError.ts', '// src/kin/nativeMessagesRunner.ts').text
}
function terminalFragment(source) {
  const code = sourceFunction(source, 'queryModel').text
  const match = /if\s*\(stopReason\s*===\s*"max_tokens"\)\s*\{/.exec(code)
  const end = code.indexOf('if (stopReason === "model_context_window_exceeded")', match?.index)
  ensure(match && end > match.index, 'Missing native max-token boundary')
  return code.slice(match.index, end)
}
function transportFragments(source) {
  const code = sourceFunction(source, 'queryModel').text
  const phrase = code.indexOf('Stream idle timeout - no chunks received')
  const starts = [...code.slice(0, phrase).matchAll(/if\s*\(streamIdleAborted\)\s*\{/g)]
  ensure(phrase > 0 && starts.length, 'Missing timeout fragment')
  const timeoutStart = starts.at(-1).index,
    timeoutEnd = code.indexOf('if (!partialMessage ||', phrase)
  const fallback = /const\s+disableFallback\s*=/.exec(code)
  ensure(fallback && timeoutEnd > timeoutStart, 'Missing fallback fragment')
  const throwAt = code.indexOf('throw streamingError', fallback.index),
    fallbackEnd = code.indexOf('}', throwAt) + 1
  const catchMatch = /catch\s*\(errorFromRetry\)\s*\{/.exec(code)
  ensure(catchMatch, 'Missing outer error fragment')
  const rest = code.slice(catchMatch.index + catchMatch[0].length)
  const legacy = /if\s*\(errorFromRetry\s+instanceof\s+FallbackTriggeredError\)/.exec(rest)
  ensure(legacy, 'Missing legacy error boundary')
  const dispatchStart = code.indexOf('const generator = withRetry('),
    dispatchEnd = code.indexOf('    let e2;', dispatchStart)
  ensure(dispatchStart >= 0 && dispatchEnd > dispatchStart, 'Missing retry dispatch context')
  return {
    timeout: code.slice(timeoutStart, timeoutEnd),
    fallback: code.slice(fallback.index, fallbackEnd),
    error_gate: rest.slice(0, legacy.index),
    dispatch: code.slice(dispatchStart, dispatchEnd),
  }
}

export function compactJobError(errors, { bun, directory }) {
  const file = path.join(directory, 'job-error-helper.mjs')
  fs.writeFileSync(
    file,
    'export function __vm2apiCreateJobError(){' + errors + 'return {classify:classifyKinJobError,init:init_jobError};}',
  )
  const built = execFileSync(bun, ['build', file, '--target=bun', '--minify-whitespace', '--minify-identifiers'], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 60000,
  })
  const match = /export\s*\{\s*([\w$]+)\s+as\s+__vm2apiCreateJobError\s*\}/.exec(built)
  ensure(match, 'Unexpected private helper export')
  return 'var __vm2apiJobError=(' + sourceFunction(built, match[1]).text.trim() + ')();'
}

export function patchLifecycleBytes(original, kind, donorSource, minify, compactPrivate) {
  const base = LIFECYCLE_BASES[kind]
  ensure(base && sha256(original) === base.unpacked, `Unrecognized ${kind} source image`)
  const graph = inspectBunElf(original),
    source = graph.source.toString('utf8')
  ensure(Buffer.from(source).equals(graph.source), 'Source UTF-8 roundtrip failed')
  const sourceOffset = graph.modules[graph.entry].sourceOffset,
    changes = []
  let jobErrorNamespace = ''
  const add = (id, selection, replacement) => {
    const before = Buffer.from(selection.text),
      after = Buffer.from(replacement)
    ensure(after.length <= before.length, `${id} exceeds span: ${after.length}/${before.length}`)
    const offset = sourceOffset + Buffer.byteLength(source.slice(0, selection.start))
    ensure(original.subarray(offset, offset + before.length).equals(before), 'Offset mismatch')
    changes.push({
      id,
      offset,
      bytes: before.length,
      replacement_bytes: after.length,
      before: selection.text,
      after: replacement,
      before_sha256: sha256(before),
      after_sha256: sha256(Buffer.concat([after, Buffer.alloc(before.length - after.length, 32)])),
    })
  }
  if (kind === 'wrap') {
    const { selected, text } = queryWithSnapshot(source)
    add('snapshot-caller-system', selected, minFunction(text, minify))
    const api = sourceRange(source, 'const kinSystemLayout = getSystemLayout();', '  const useBetas')
    const split = api.text.indexOf('  } else if (kinSystemLayout !== "stock")')
    ensure(split > 0, 'Missing kin/non-kin layout split')
    const kin = once(
      api.text.slice(0, split),
      '      }),\n      leftover: leftoverFromSystemPrompt(systemPrompt)',
      '      })',
    )
    const append = `if(kinQuery&&kinSystemLayout!=="stock"&&Array.isArray(options2.__vm2apiSys)&&options2.__vm2apiSys.length){
const caller=options2.__vm2apiSys.map(text=>({type:"text",text}));const tail=system[system.length-1];
if(tail?.cache_control&&tail.cache_control.scope!=="global"){caller[caller.length-1].cache_control=tail.cache_control;delete tail.cache_control;}system.push(...caller);}`
    add('preserve-caller-api-blocks', api, minStatements(kin + api.text.slice(split) + append, minify))
  } else {
    const query = sourceFunction(source, 'queryKinMessagesWithStreaming')
    ensure(
      query.text.includes('__vm2apiSys') && query.text.match(/\bonResponseHeaders\b/g)?.length === 2,
      'Unexpected preserved CC query bridge',
    )
    add(
      'native-error-callback-bridge',
      query,
      minFunction(query.text.replace(/\bonResponseHeaders\b/g, 'onResponseHeaders,onError'), minify),
    )
    const retry = sourceFunction(source, 'withRetry')
    const anchor = /return await operation\(client2, attempt, retryContext\);\s*}\s*catch \((\w+)\) \{/.exec(retry.text)
    ensure(anchor && !retry.text.includes('isKinQuerySource(options2.querySource)'), 'Unknown native retry baseline')
    const retryText =
      retry.text.slice(0, anchor.index + anchor[0].length) +
      `if(isKinQuerySource(options2.querySource))throw new CannotRetryError(${anchor[1]},retryContext);` +
      retry.text.slice(anchor.index + anchor[0].length)
    ensure(typeof compactPrivate === 'function', 'Private helper compiler required')
    jobErrorNamespace = compactPrivate(jobErrorModule(donorSource))
    const retryModule = sourceRange(
      source,
      '// src/services/api/withRetry.ts',
      '// src/tools/FileReadTool/imageProcessor.ts',
    )
    // Whitespace-only compaction of the adjacent image validator creates space for
    // the isolated NEW helper; existing global names and image behavior stay intact.
    const compactRetry = minify(once(retryModule.text, retry.text, retryText)).trim()
    add(
      'native-no-hidden-retry',
      retryModule,
      '// src/services/api/withRetry.ts\n' +
        once(
          compactRetry,
          'function isBase64ImageBlock(',
          '// src/utils/imageValidation.ts\nfunction isBase64ImageBlock(',
        ) +
        '\n' +
        jobErrorNamespace,
    )
    const queryModel = sourceFunction(source, 'queryModel')
    const timeout = sourceRange(
      source,
      '      if (streamIdleAborted) {',
      '      if (!partialMessage || newMessages.length === 0 && !stopReason)',
      queryModel.start,
    )
    add(
      'native-timeout-kind',
      timeout,
      minStatements(
        once(
          timeout.text,
          'throw new Error("Stream idle timeout - no chunks received");',
          'const message="Stream idle timeout - no chunks received";throw isKinQuerySource(options2.querySource)?new APIConnectionTimeoutError({message}):new Error(message);',
        ),
        minify,
      ),
    )
    const start = source.indexOf('      const disableFallback = ', queryModel.start)
    ensure(start >= 0, 'Missing fallback gate')
    const tail = '        throw streamingError;\n      }'
    const stop = source.indexOf(tail, start) + tail.length
    ensure(stop > start && stop - start < 6000, 'Unknown fallback block')
    const fallback = { start, text: source.slice(start, stop) }
    add(
      'native-no-nonstream-fallback',
      fallback,
      minStatements(
        once(
          fallback.text,
          'const disableFallback = ',
          'const disableFallback = isKinQuerySource(options2.querySource) || ',
        ),
        minify,
      ),
    )
    const head = '  } catch (errorFromRetry) {'
    const catchStart = source.indexOf(head, queryModel.start) + head.length,
      catchEnd = source.indexOf('\n  } finally {', catchStart)
    ensure(
      catchStart >= queryModel.start + head.length &&
        catchEnd > catchStart &&
        catchEnd < queryModel.start + queryModel.text.length,
      'Missing native outer error boundary',
    )
    const errorBody = { start: catchStart, text: source.slice(catchStart, catchEnd) }
    const callbacks = [...errorBody.text.matchAll(/yield getAssistantMessageFromError\((\w+), errorModel, \{/g)]
    ensure(callbacks.length === 2, 'Unexpected legacy assistant error paths')
    let errorText =
      'if(isKinQuerySource(options2.querySource)){const failure=errorFromRetry instanceof CannotRetryError?errorFromRetry.originalError:errorFromRetry;options2.onError?.(failure);throw failure;}' +
      errorBody.text
    errorText = errorText.replace(
      /yield getAssistantMessageFromError\((\w+), errorModel, \{/g,
      (_, name) => `options2.onError?.(${name});yield getAssistantMessageFromError(${name}, errorModel, {`,
    )
    add('native-preserve-raw-errors', errorBody, minStatements(errorText, minify))
    const selected = nativeModule(source),
      newModule = nativeModule(donorSource)
    const errors = jobErrorModule(donorSource)
    ensure(!source.includes('__vm2apiJobError'), 'Namespace already exists')
    const runner = sourceRange(newModule.text, '// src/kin/nativeMessagesRunner.ts', '\nvar init_nativeMessagesRunner')
    // All new generic helper names stay inside the closure. Preserve CC's existing bundle globals.
    const newText = newModule.text
      .replace(errors, '')
      .replace(
        'const failure = classifyKinJobError(error40, { sawEvent, message, sdkKind });',
        'const failure = __vm2apiJobError.classify(error40, { sawEvent, message, sdkKind });',
      )
      .replace('  init_jobError();', '  __vm2apiJobError.init();')
    ensure(
      runner.text.includes('case "kin_ping"') && newText.includes('__vm2apiJobError.classify'),
      'Reference lacks lifecycle behavior',
    )
    add('native-cancel-ping-errors', selected, '// src/kin/stdioProtocol.ts\n' + minify(newText).trim())
  }
  changes.sort((a, b) => a.offset - b.offset)
  const bytes = Buffer.from(original)
  let end = sourceOffset
  for (const c of changes) {
    ensure(
      c.offset >= end && c.offset + c.bytes <= sourceOffset + graph.source.length,
      'Overlapping or out-of-source patch',
    )
    Buffer.concat([Buffer.from(c.after), Buffer.alloc(c.bytes - c.replacement_bytes, 32)]).copy(bytes, c.offset)
    end = c.offset + c.bytes
  }
  verifyUnchangedOutside(original, bytes, changes)
  const finalGraph = inspectBunElf(bytes)
  ensure(
    JSON.stringify({ ...graph, source: null }) === JSON.stringify({ ...finalGraph, source: null }),
    'ELF/Bun graph changed',
  )
  const finalSource = finalGraph.source.toString('utf8')
  const api = sourceRange(finalSource, 'const kinSystemLayout', 'const useBetas')
  const cacheStart = finalSource.indexOf('function normalizePanelCacheTtl(')
  const cacheEnd = finalSource.indexOf('// src/kin/querySource.ts', cacheStart)
  ensure(cacheStart >= 0 && cacheEnd > cacheStart, 'Missing cache region')
  const semantics = {
    query: sourceFunction(finalSource, 'queryKinMessagesWithStreaming').text,
    query_before: sourceFunction(source, 'queryKinMessagesWithStreaming').text,
    system: api.text,
    system_before: sourceRange(source, 'const kinSystemLayout', 'const useBetas').text,
    retry: sourceFunction(finalSource, 'withRetry').text,
    retry_before: sourceFunction(source, 'withRetry').text,
    native: jobErrorNamespace + '\n' + nativeModule(finalSource).text,
    native_fragments: jobErrorNamespace
      ? [jobErrorNamespace, nativeModule(finalSource).text]
      : [nativeModule(finalSource).text],
    native_before: nativeModule(source).text,
    reference_native: nativeModule(donorSource).text,
    reference_retry: sourceFunction(donorSource, 'withRetry').text,
    reference_query: sourceFunction(donorSource, 'queryKinMessagesWithStreaming').text,
    job_error: jobErrorModule(donorSource),
    terminal: {
      before: terminalFragment(source),
      after: terminalFragment(finalSource),
      upstream: terminalFragment(donorSource),
      predicate: sourceFunction(finalSource, 'isKinQuerySource').text,
    },
    transport: {
      before: transportFragments(source),
      after: transportFragments(finalSource),
      reference: transportFragments(donorSource),
    },
    image_validation:
      kind === 'cc'
        ? {
            before: sourceRange(
              source,
              '// src/utils/imageValidation.ts',
              '// src/tools/FileReadTool/imageProcessor.ts',
            ).text,
            after: sourceRange(finalSource, '// src/utils/imageValidation.ts', 'var __vm2apiJobError=').text,
          }
        : null,
    cache: finalSource.slice(cacheStart, cacheEnd),
  }
  if (semantics.image_validation)
    ensure(
      minify(semantics.image_validation.before).trim() === minify(semantics.image_validation.after).trim(),
      'Adjacent image validation changed beyond equivalent compaction',
    )
  return { bytes, changes, semantics }
}

export async function buildFixedLifecycle({ root, outputRoot, evidence, upx, bun, verify }) {
  ensure(
    root && outputRoot && evidence && upx && bun && typeof verify === 'function',
    'Explicit inputs and behavior verifier required',
  )
  const run = (bin, args, opts = {}) =>
    execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 300000, ...opts })
  const minify = (text) => run(bun, ['-e', MINIFY], { input: text })
  ensure(
    sha256(fs.readFileSync(path.join(root, 'share/wrap-cli/cc-node'))) === LIFECYCLE_ORIGINAL_CC,
    'Original CC changed',
  )
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-lifecycle-'))
  fs.mkdirSync(evidence, { recursive: true })
  const results = []
  try {
    const sourceBytes = {}
    for (const [kind, base] of Object.entries(LIFECYCLE_BASES)) {
      const file = path.join(root, base.input)
      ensure(sha256(fs.readFileSync(file)) === base.packed, `Unknown ${kind} packed baseline`)
      const unpacked = path.join(temp, kind + '.original')
      run(upx, ['-d', '-o', unpacked, file])
      sourceBytes[kind] = fs.readFileSync(unpacked)
      ensure(sha256(sourceBytes[kind]) === base.unpacked, `Unknown ${kind} unpacked baseline`)
    }
    const donor = inspectBunElf(sourceBytes.wrap).source.toString('utf8')
    for (const [kind, base] of Object.entries(LIFECYCLE_BASES)) {
      const patched = patchLifecycleBytes(sourceBytes[kind], kind, donor, minify, (code) =>
        compactJobError(code, { bun, directory: temp }),
      )
      const behavior = await verify(patched.semantics, kind)
      ensure(behavior?.ok === true && behavior.checks > 0, 'Source behavior checks did not pass')
      const syntax = JSON.parse(run(bun, ['-e', SCAN], { input: inspectBunElf(patched.bytes).source }))
      const parentDir = path.join(root, 'share', base.previous),
        parent = JSON.parse(fs.readFileSync(path.join(parentDir, 'manifest.json'), 'utf8'))
      const oldSemantics = JSON.parse(fs.readFileSync(path.join(parentDir, 'semantics.json'), 'utf8'))
      ensure(
        inspectBunElf(patched.bytes).source.toString('utf8').includes(oldSemantics.cache),
        'Active cache implementation changed',
      )
      const inherited = kind === 'cc' ? [...parent.inherited_repairs, ...parent.artifacts[base.file].patches] : []
      const previous = inherited.map((p) => {
        ensure(
          sha256(sourceBytes[kind].subarray(p.offset, p.offset + p.bytes)) === p.after_sha256,
          `Unexpected previous repair ${p.id}`,
        )
        const overlap = patched.changes.find((c) => c.offset < p.offset + p.bytes && p.offset < c.offset + c.bytes)
        if (overlap) {
          ensure(
            overlap.id === 'native-error-callback-bridge',
            'Only the caller-snapshot bridge may overlap an old repair',
          )
          return {
            ...p,
            previous_after_sha256: p.after_sha256,
            after_sha256: sha256(patched.bytes.subarray(p.offset, p.offset + p.bytes)),
            preserved: false,
            reason: 'bridge now also forwards onError; caller snapshot checked semantically',
          }
        }
        ensure(
          sha256(patched.bytes.subarray(p.offset, p.offset + p.bytes)) === p.after_sha256,
          `Changed previous repair ${p.id}`,
        )
        return { ...p, preserved: true }
      })
      const dir = path.join(outputRoot, `${kind}-fixed/v191-r1`)
      ensure(!fs.existsSync(dir), 'Refusing existing output')
      fs.mkdirSync(dir, { recursive: true })
      const raw = path.join(temp, kind + '.patched'),
        packed = path.join(dir, base.file),
        roundtrip = path.join(temp, kind + '.roundtrip')
      fs.writeFileSync(raw, patched.bytes)
      run(upx, ['--best', '--lzma', '-o', packed, raw])
      run(upx, ['-t', packed])
      run(upx, ['-d', '-o', roundtrip, packed])
      ensure(fs.readFileSync(roundtrip).equals(patched.bytes), 'Roundtrip changed bytes')
      const output = fs.readFileSync(packed),
        patchFile = jsonBytes({ [base.file]: patched.changes })
      const semantics = jsonBytes({
        ...oldSemantics,
        query: patched.semantics.query,
        query_before: patched.semantics.query_before,
        system: patched.semantics.system,
        system_before: patched.semantics.system_before,
        terminal: patched.semantics.terminal,
        lifecycle: patched.semantics,
      })
      const artifact = {
        file: base.file,
        bytes: output.length,
        sha256: sha256(output),
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
          date: '2026-10-02',
          basis: 'owner-authorized locally verified fixed CLI maintenance alongside upstream',
          scope: 'source/packaging checks, not Linux ELF or provider certification',
        },
        lineage: {
          source_file: base.input,
          source_sha256: base.packed,
          upstream_cli_sha256: LIFECYCLE_BASES.wrap.packed,
          original_cc_sha256: LIFECYCLE_ORIGINAL_CC,
          previous_release: parent.id,
          lifecycle_reference_commit: '011a838',
        },
        native_lifecycle_contract: 'nonblocking_cancel_v1',
        artifacts: { [base.file]: artifact },
        inherited_repairs: previous,
        patches_sha256: sha256(patchFile),
        semantics_sha256: sha256(semantics),
        tools: { upx: run(upx, ['--version']).split(/\r?\n/)[0], bun: run(bun, ['--version']).trim() },
        local_validation: {
          completed: true,
          native_execution: false,
          behavior_tests: behavior.checks,
          scope: 'actual source fragments and upstream differential; no complete ELF/provider execution',
        },
      }
      fs.writeFileSync(path.join(dir, 'manifest.json'), jsonBytes(manifest))
      fs.writeFileSync(path.join(dir, 'patches.json'), patchFile)
      fs.writeFileSync(path.join(dir, 'semantics.json'), semantics)
      fs.writeFileSync(path.join(evidence, kind + '.unpacked'), patched.bytes)
      results.push({
        kind,
        id: base.id,
        sha256: artifact.sha256,
        bytes: output.length,
        changes: patched.changes.map((c) => ({ id: c.id, bytes: c.bytes, replacement_bytes: c.replacement_bytes })),
        behavior,
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
  const { verifyLifecycleSource } = await import('../test/support/fixed-lifecycle-controls.mjs')
  console.log(
    JSON.stringify(
      await buildFixedLifecycle({
        root: arg('--root'),
        outputRoot: arg('--output'),
        evidence: arg('--evidence'),
        upx: arg('--upx'),
        bun: arg('--bun'),
        verify: verifyLifecycleSource,
      }),
      null,
      2,
    ),
  )
}
