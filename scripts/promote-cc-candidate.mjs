#!/usr/bin/env node
/** Promote an accepted CC capture without undoing the candidate's initialization repairs. */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inspectBunElf, sha256, verifyUnchangedOutside } from './build-offline-native-candidates.mjs'

export const CC_FIXED_ID = 'cc-fixed-v155-r3'
const requireThat = (value, message) => {
  if (!value) throw new Error(message)
}
export function promoteCcBytes(candidate, manifest, priorPatches) {
  requireThat(manifest.id === 'native-v155-r3', 'Only the accepted R3 lineage can be promoted here')
  requireThat(sha256(candidate) === manifest.artifacts['cc-node'].unpacked_sha256, 'Candidate unpacked hash mismatch')
  const sourceEntry = priorPatches.find((p) => p.id === 'offline-guard-and-cc-initialization')
  requireThat(
    sourceEntry &&
      sha256(candidate.subarray(sourceEntry.offset, sourceEntry.offset + sourceEntry.bytes)) ===
        sourceEntry.after_sha256,
    'Candidate entry span differs',
  )
  const prefix = 'async function main2(){'
  const args = 'const args=process.argv.slice(2);'
  requireThat(sourceEntry.after.startsWith(prefix), 'Unexpected candidate entry shape')
  const end = sourceEntry.after.indexOf(args)
  const guard = sourceEntry.after.slice(prefix.length, end)
  requireThat(end > prefix.length, 'Unexpected guard position')
  requireThat(
    guard.startsWith('if(process.env.VM2API_OFFLINE_CANDIDATE!=="native-v155-r3"||') &&
      guard.endsWith('throw Error("vm2api candidate is offline-only");'),
    'Unexpected offline guard',
  )
  requireThat(
    !guard.includes(';const ') && sourceEntry.after.includes('init_init2();setIsInteractive(!1);'),
    'Do not remove initialization',
  )
  const bytes = Buffer.from(candidate)
  const guardOffset = sourceEntry.offset + Buffer.byteLength(prefix)
  const guardBytes = Buffer.byteLength(guard)
  bytes.fill(32, guardOffset, guardOffset + guardBytes)
  verifyUnchangedOutside(candidate, bytes, [{ offset: guardOffset, bytes: guardBytes }])
  requireThat(!bytes.includes(Buffer.from('VM2API_OFFLINE_CANDIDATE')), 'Offline guard remains in promoted ELF')
  const patches = priorPatches.map((p) => ({ ...p }))
  const entry = patches.find((p) => p.id === sourceEntry.id)
  entry.id = 'cc-loop-initialization'
  entry.after = prefix + ' '.repeat(guardBytes) + sourceEntry.after.slice(end)
  entry.after_sha256 = sha256(bytes.subarray(entry.offset, entry.offset + entry.bytes))
  entry.replacement_bytes = Buffer.byteLength(entry.after)
  const before = inspectBunElf(candidate),
    after = inspectBunElf(bytes)
  requireThat(
    JSON.stringify({ ...before, source: null }) === JSON.stringify({ ...after, source: null }),
    'Bun/ELF layout changed',
  )
  return {
    bytes,
    patches,
    entry: {
      offset: entry.offset,
      bytes: entry.bytes,
      guard_offset: guardOffset,
      guard_bytes: guardBytes,
      candidate: sourceEntry.after,
      promoted: entry.after,
      only_guard_bytes_changed: true,
    },
    graph: { ...after, source: undefined },
  }
}
const SCAN =
  'const t=new Bun.Transpiler({loader:"js",target:"bun",deadCodeElimination:false,inline:false});const s=t.scan(await Bun.stdin.text());console.log(JSON.stringify({syntax:true,imports:s.imports.length,exports:s.exports.length}));'
export function buildCcPromotion({ root, output, capture, evidence, upx, bun }) {
  requireThat(upx && bun && capture, 'Explicit trusted tool paths and the accepted CC capture are required')
  const dir = path.resolve(output || path.join(root, 'share/cc-fixed/v155-r3'))
  requireThat(!fs.existsSync(path.join(dir, 'cc-node')), 'Refusing to overwrite a promoted release')
  const sourceDir = path.join(root, 'share/offline-candidates/native-v155-r3')
  const manifest = JSON.parse(fs.readFileSync(path.join(sourceDir, 'manifest.json'), 'utf8'))
  const patchData = fs.readFileSync(path.join(sourceDir, 'patches.json'))
  requireThat(sha256(patchData) === manifest.patches_sha256, 'Candidate patch record mismatch')
  const capturedBytes = fs.readFileSync(capture),
    row = JSON.parse(capturedBytes.toString('utf8').replace(/^\uFEFF/, ''))
  const observed = JSON.parse(row.raw_debug.offline_probe.details.text)
  requireThat(
    observed.meta.selected_pairing === 'cc' && observed.meta.candidate.id === manifest.id,
    'Only the accepted CC combination may be promoted',
  )
  requireThat(
    observed.meta.candidate.manifest_sha256 === sha256(fs.readFileSync(path.join(sourceDir, 'manifest.json'))),
    'Candidate manifest differs from the observed release',
  )
  const source = fs.readFileSync(path.join(sourceDir, 'cc-node'))
  const kernel = fs.readFileSync(path.join(root, 'bin/kin-kernel'))
  requireThat(
    sha256(source) === manifest.artifacts['cc-node'].sha256 && sha256(source) === observed.meta.cli_sha256,
    'Capture and candidate CLI do not match',
  )
  requireThat(
    observed.binary_inputs_verified === true && observed.observed_binary_hashes.cli_sha256 === sha256(source),
    'Capture did not verify uploaded CLI',
  )
  requireThat(
    sha256(kernel) === manifest.kernel_sha256.cc && sha256(kernel) === observed.observed_binary_hashes.kernel_sha256,
    'Current kernel differs from the tested pair',
  )
  requireThat(
    observed.stages.every((s) => s.status === 'completed' && s.capture_complete && s.checks?.text_equal),
    'Capture is not complete',
  )
  const run = (exe, args, opts = {}) =>
    execFileSync(exe, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 240000, ...opts })
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-cc-promotion-'))
  try {
    const unpacked = path.join(tmp, 'candidate'),
      modified = path.join(tmp, 'promoted'),
      roundtrip = path.join(tmp, 'roundtrip')
    run(upx, ['-d', '-o', unpacked, path.join(sourceDir, 'cc-node')])
    const result = promoteCcBytes(fs.readFileSync(unpacked), manifest, JSON.parse(patchData)['cc-node'])
    const syntax = JSON.parse(run(bun, ['-e', SCAN], { input: inspectBunElf(result.bytes).source, timeout: 120000 }))
    requireThat(syntax.syntax, 'Promoted full JS syntax failed')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(modified, result.bytes, { mode: 0o555 })
    run(upx, ['--best', '--lzma', '-o', path.join(dir, 'cc-node'), modified])
    const integrity = run(upx, ['-t', path.join(dir, 'cc-node')])
    run(upx, ['-d', '-o', roundtrip, path.join(dir, 'cc-node')])
    requireThat(fs.readFileSync(roundtrip).equals(result.bytes), 'Promoted UPX roundtrip mismatch')
    fs.writeFileSync(path.join(dir, 'kin-kernel.bin'), kernel, { mode: 0o555 })
    const packed = fs.readFileSync(path.join(dir, 'cc-node'))
    const artifact = {
      ...manifest.artifacts['cc-node'],
      sha256: sha256(packed),
      bytes: packed.length,
      unpacked_sha256: sha256(result.bytes),
      source_candidate_sha256: sha256(source),
      source_candidate_unpacked_sha256: manifest.artifacts['cc-node'].unpacked_sha256,
      validations: {
        ...manifest.artifacts['cc-node'].validations,
        syntax,
        only_entry_guard_changed_from_accepted_candidate: true,
      },
      patches: result.patches.map(({ before, after, ...p }) => p),
    }
    const capturedRequests =
      observed.stages
        .find((stage) => stage.name === 'mock_api')
        ?.captures.filter((item) => item.kind === 'anthropic_request') || []
    requireThat(capturedRequests.length === 1, 'Expected exactly one observed API request')
    const capturedApi = JSON.parse(capturedRequests[0].text)
    const attribution = capturedApi.system?.[0]?.text || ''
    const ccDifferences = {
      context_management: capturedApi.context_management || null,
      attribution_fields: Object.fromEntries(
        ['cc_version', 'cc_is_subagent', 'cc_turn_origin'].map((key) => [
          key,
          attribution.match(new RegExp(key + '=([^;]+);'))?.[1] || null,
        ]),
      ),
      scope: 'Native CC behavior retained, not introduced by the repair; real quota/provider effects unverified',
    }
    const next = {
      version: 1,
      id: CC_FIXED_ID,
      status: 'owner_approved',
      production_approved: true,
      dataplane: 'cc-fixed',
      approval: {
        date: '2026-09-26',
        basis:
          'owner conditionally permits promotion after supplied CC request/response comparison; CC accepted, Crag rejected',
        candidate_capture_sha256: sha256(capturedBytes),
        preserved_cc_differences: ccDifferences,
        scope:
          'one zero/Opus4.6/text-only/nonstream case with245 messages; no real-provider/quota/concurrency validation',
      },
      kernel: { file: 'kin-kernel.bin', bytes: kernel.length, sha256: sha256(kernel) },
      artifacts: { 'cc-node': artifact },
      entry: result.entry,
      local_validation: { completed: false, native_execution: false },
      tools: { upx: run(upx, ['--version']).split(/\r?\n/)[0], syntax: run(bun, ['--version']).trim() },
    }
    const write = (file, data) => fs.writeFileSync(path.join(dir, file), JSON.stringify(data, null, 2) + '\n')
    write('patches.json', { 'cc-node': result.patches })
    next.patches_sha256 = sha256(fs.readFileSync(path.join(dir, 'patches.json')))
    write('manifest.json', next)
    const testFile = path.join(root, 'test/unit/cc-promotion-code.test.mjs')
    const tests = run(process.execPath, ['--test', '--test-reporter=tap', testFile], {
      cwd: root,
      env: { ...process.env, CC_FIXED_DIR: dir, CC_PROMOTION_ORIGINAL: '0' },
    })
    const count = Number(tests.match(/^# tests (\d+)$/m)?.[1])
    requireThat(count >= 4 && /^# fail 0$/m.test(tests) && /^# skipped 0$/m.test(tests), 'Promoted entry checks failed')
    next.local_validation = {
      completed: true,
      native_execution: false,
      behavior_tests: count,
      test_sha256: sha256(fs.readFileSync(testFile)),
      scope: 'extracted entry with controlled dependencies, full JS/ELF/UPX checks; not Linux ELF execution',
    }
    write('manifest.json', next)
    if (evidence) {
      fs.mkdirSync(evidence, { recursive: true })
      fs.copyFileSync(modified, path.join(evidence, 'cc-node.promoted.unpacked'))
      fs.writeFileSync(path.join(evidence, 'promotion-tests.tap'), tests)
      fs.writeFileSync(path.join(evidence, 'promotion-upx.log'), integrity)
    }
    return next
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2),
    opt = (name, fallback) => {
      const i = argv.indexOf(name)
      return i < 0 ? fallback : argv[i + 1]
    }
  const root = path.resolve(opt('--root', path.join(path.dirname(fileURLToPath(import.meta.url)), '..')))
  console.log(
    JSON.stringify(
      buildCcPromotion({
        root,
        output: opt('--output'),
        capture: opt('--capture'),
        evidence: opt('--evidence'),
        upx: opt('--upx'),
        bun: opt('--bun'),
      }),
      null,
      2,
    ),
  )
}
