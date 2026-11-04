#!/usr/bin/env node
/** Explicit, hash-pinned promotion of wrap r1 and a separate, unapproved CC r2. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { BASELINES, inspectBunElf, sha256, verifyUnchangedOutside } from './build-offline-native-candidates.mjs'

export const FIXED_ID = 'wrap-fixed-v155-r1'
export const CC_R2_ID = 'native-v155-r2'
const R1_HASHES = {
  'cli-node': '47c6687f47cbf808bb25743b4b309175d98845e3cfd76add08fa8671d9ba38d5',
  'cc-node': 'c18cd72c26da381d925d0480113664c06f8e4c30b6559238f077fce99389be45',
}
const R1_UNPACKED = {
  'cli-node': '52dfe8b4e06abf9aa1abbe9297168e7bd36c88a14f4711e887d3610ee844a3ad',
  'cc-node': 'd704c0d405aaa54e81ffceca51328afb1940827fe581824b226103fe5279d45b',
}
const WRAP_KERNEL = 'c44eae87aec7c537196513cc78d6e7e7c0c14b20bdc6c15eb7c0a5a68e1658a0'
const CRAG_KERNEL = '5764a186e3778278a8733ecaf924211070968def7c6648c6f6ecf3b76120a537'
const requireThat = (value, text) => {
  if (!value) throw new Error(text)
}
const padded = (text, length) => {
  const bytes = Buffer.from(text)
  requireThat(bytes.length <= length, `Replacement exceeds fixed span (${bytes.length}/${length})`)
  return Buffer.concat([bytes, Buffer.alloc(length - bytes.length, 32)])
}
function checkR1(original, candidate, kind, patches) {
  requireThat(sha256(original) === BASELINES[kind].unpacked, `Wrong original ${kind}`)
  requireThat(sha256(candidate) === R1_UNPACKED[kind], `Wrong r1 ${kind}`)
  verifyUnchangedOutside(original, candidate, patches)
  for (const patch of patches) {
    requireThat(
      sha256(original.subarray(patch.offset, patch.offset + patch.bytes)) === patch.before_sha256,
      'Original span hash mismatch',
    )
    requireThat(
      sha256(candidate.subarray(patch.offset, patch.offset + patch.bytes)) === patch.after_sha256,
      'R1 span hash mismatch',
    )
  }
}
function checkGraph(original, bytes) {
  const before = inspectBunElf(original),
    after = inspectBunElf(bytes)
  requireThat(
    JSON.stringify({ ...before, source: null }) === JSON.stringify({ ...after, source: null }),
    'Bun/ELF layout changed',
  )
  return { ...after, source: undefined }
}
export function promoteCli(original, candidate, r1Patches) {
  checkR1(original, candidate, 'cli-node', r1Patches)
  const entry = r1Patches.find((p) => p.id === 'offline-entry-guard')
  requireThat(entry, 'Missing r1 entry patch')
  const bytes = Buffer.from(candidate)
  // Exact original entry bytes, not a rewritten/minified approximation.
  original.copy(bytes, entry.offset, entry.offset, entry.offset + entry.bytes)
  const patches = r1Patches.filter((p) => p !== entry)
  verifyUnchangedOutside(original, bytes, patches)
  requireThat(
    !bytes.includes(Buffer.from('VM2API_OFFLINE_CANDIDATE')),
    'Promotion still contains offline-only entry guard',
  )
  requireThat(!bytes.includes(Buffer.from('native-v155-r1')), 'Promotion still contains r1 guard ID')
  return {
    bytes,
    patches,
    graph: checkGraph(original, bytes),
    entry: {
      offset: entry.offset,
      bytes: entry.bytes,
      candidate: entry.after,
      promoted: entry.before,
      restored_sha256: sha256(bytes.subarray(entry.offset, entry.offset + entry.bytes)),
    },
  }
}
export function repairCc(original, candidate, r1Patches, minify) {
  checkR1(original, candidate, 'cc-node', r1Patches)
  const bytes = Buffer.from(candidate)
  const graph = inspectBunElf(candidate)
  const base = graph.modules[graph.entry].sourceOffset
  const source = graph.source.toString('utf8')
  requireThat(
    !source.includes('function getWorkload(') &&
      source.includes('function getWorkload2()') &&
      source.includes('function runWithWorkload(') &&
      source.includes('var init_workloadContext = __esm('),
    'Unexpected workload dependency layout',
  )
  const patches = r1Patches.map((p) => ({ ...p }))
  const entry = patches.find((p) => p.id === 'offline-guard-and-cc-initialization')
  requireThat(entry && entry.after.includes('native-v155-r1'), 'Missing r1 CC entry guard')
  entry.after = entry.after.replace('native-v155-r1', CC_R2_ID)
  const entryBytes = padded(entry.after, entry.bytes)
  entry.after_sha256 = sha256(entryBytes)
  entry.replacement_bytes = Buffer.byteLength(entry.after)
  entryBytes.copy(bytes, entry.offset)
  const span = (begin, end) => {
    const start = source.indexOf(begin)
    requireThat(start >= 0 && source.indexOf(begin, start + begin.length) < 0, `Ambiguous span ${begin}`)
    const stop = source.indexOf(end, start + begin.length)
    requireThat(stop > start, `Missing end ${end}`)
    return { text: source.slice(start, stop), offset: base + Buffer.byteLength(source.slice(0, start)) }
  }
  const apply = (id, before, after) => {
    const count = Buffer.byteLength(before.text),
      replacement = padded(after, count)
    requireThat(
      original.subarray(before.offset, before.offset + count).equals(Buffer.from(before.text)),
      'New fix overlaps an existing r1 source patch',
    )
    replacement.copy(bytes, before.offset)
    patches.push({
      id,
      offset: before.offset,
      bytes: count,
      replacement_bytes: Buffer.byteLength(after),
      before: before.text,
      after,
      before_sha256: sha256(Buffer.from(before.text)),
      after_sha256: sha256(replacement),
    })
  }
  const http = span('// src/utils/http.ts\nfunction getUserAgent()', '\n// ')
  const wrongCall = 'const workload = getWorkload();'
  requireThat(http.text.split(wrongCall).length === 2, 'Unexpected User-Agent workload reference')
  const httpAfter = minify(
    http.text.replace(wrongCall, 'init_workloadContext(); const workload = getWorkload2();'),
  ).trim()
  for (const name of ['getUserAgent', 'getMCPUserAgent', 'getWebFetchUserAgent', 'getAuthHeaders', 'withOAuth401Retry'])
    requireThat(httpAfter.includes(`function ${name}(`), `Minifier removed ${name}`)
  requireThat(httpAfter.includes('init_http2'), 'Minifier removed HTTP module initializer')
  apply('connect-existing-workload-context', http, httpAfter)
  const workloadSource = span('// src/utils/workloadContext.ts\n', '\n// ').text
  const slot = span('async function runSlot(slot, prompt, continuous)', '\nvar writeChain3;')
  const oldError = 'throw new Error("api_error");'
  requireThat(slot.text.split(oldError).length === 2, 'Unexpected Crag error branch')
  const newError = `const content = ev.message?.content;
    const detail = typeof content === "string" ? content : Array.isArray(content) ? content.filter(p => p?.type === "text" && typeof p.text === "string").map(p => p.text).join("\\n") : "";
    throw new Error(detail || (typeof ev.error?.message === "string" ? ev.error.message : "api_error"));`
  const slotAfter = minify('export ' + slot.text.replace(oldError, newError))
    .trim()
    .replace(/^export\s+/, '')
  requireThat(slotAfter.startsWith('async function runSlot('), 'Unexpected Crag minifier output')
  apply('preserve-crag-api-error-detail', slot, slotAfter)
  patches.sort((a, b) => a.offset - b.offset)
  verifyUnchangedOutside(original, bytes, patches)
  return { bytes, patches, graph: checkGraph(original, bytes), workloadSource }
}
const MINIFY =
  'const t=new Bun.Transpiler({loader:"js",target:"bun",minifyWhitespace:true,minifySyntax:false,minifyIdentifiers:false,deadCodeElimination:false,inline:false});process.stdout.write(t.transformSync(await Bun.stdin.text()));'
const SCAN =
  'const t=new Bun.Transpiler({loader:"js",target:"bun",deadCodeElimination:false,inline:false});const s=t.scan(await Bun.stdin.text());console.log(JSON.stringify({syntax:true,imports:s.imports.length,exports:s.exports.length}));'
export function buildNativeRevisions({ root, outputRoot = path.join(root, 'share'), evidence, upx, bun }) {
  requireThat(upx && bun, 'Explicit UPX and Bun paths are required')
  const run = (exe, args, opts = {}) =>
    execFileSync(exe, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 240000, ...opts })
  const minify = (text) => run(bun, ['-e', MINIFY], { input: text })
  const r1Dir = path.join(root, 'share/offline-candidates/native-v155-r1')
  const r1Manifest = JSON.parse(fs.readFileSync(path.join(r1Dir, 'manifest.json'), 'utf8'))
  const r1PatchBytes = fs.readFileSync(path.join(r1Dir, 'patches.json'))
  requireThat(sha256(r1PatchBytes) === r1Manifest.patches_sha256, 'R1 patch record was changed')
  const r1Patches = JSON.parse(r1PatchBytes)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-native-revisions-'))
  if (evidence) fs.mkdirSync(evidence, { recursive: true })
  const tools = { upx: run(upx, ['--version']).split(/\r?\n/)[0], syntax_minifier: run(bun, ['--version']).trim() }
  const writeJson = (file, obj) => fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n')
  const manifests = {}
  try {
    for (const kind of ['cli-node', 'cc-node']) {
      const src = path.join(root, 'share/wrap-cli', kind),
        r1 = path.join(r1Dir, kind)
      requireThat(sha256(fs.readFileSync(src)) === BASELINES[kind].packed, `Release ${kind} changed`)
      requireThat(sha256(fs.readFileSync(r1)) === R1_HASHES[kind], `R1 ${kind} changed`)
      const origPath = path.join(tmp, kind + '.original'),
        r1Path = path.join(tmp, kind + '.r1')
      run(upx, ['-d', '-o', origPath, src])
      run(upx, ['-d', '-o', r1Path, r1])
      const original = fs.readFileSync(origPath),
        candidate = fs.readFileSync(r1Path)
      const result =
        kind === 'cli-node'
          ? promoteCli(original, candidate, r1Patches[kind])
          : repairCc(original, candidate, r1Patches[kind], minify)
      const dir =
        kind === 'cli-node'
          ? path.join(outputRoot, 'wrap-fixed', 'v155-r1')
          : path.join(outputRoot, 'offline-candidates', CC_R2_ID)
      fs.mkdirSync(dir, { recursive: true })
      const dest = path.join(dir, kind)
      requireThat(!fs.existsSync(dest), `Refusing to replace existing revision: ${dest}`)
      const uncompressed = path.join(tmp, kind + '.new')
      fs.writeFileSync(uncompressed, result.bytes, { mode: 0o555 })
      const syntax = JSON.parse(run(bun, ['-e', SCAN], { input: inspectBunElf(result.bytes).source, timeout: 120000 }))
      requireThat(syntax.syntax === true, 'Full module syntax validation failed')
      run(upx, ['--best', '--lzma', '-o', dest, uncompressed])
      const integrity = run(upx, ['-t', dest])
      const roundtrip = path.join(tmp, kind + '.roundtrip')
      run(upx, ['-d', '-o', roundtrip, dest])
      requireThat(fs.readFileSync(roundtrip).equals(result.bytes), 'Compressed roundtrip differs')
      const data = fs.readFileSync(dest)
      const artifact = {
        file: kind,
        bytes: data.length,
        sha256: sha256(data),
        unpacked_bytes: result.bytes.length,
        unpacked_sha256: sha256(result.bytes),
        source_packed_sha256: BASELINES[kind].packed,
        source_unpacked_sha256: BASELINES[kind].unpacked,
        source_candidate_sha256: R1_HASHES[kind],
        source_candidate_unpacked_sha256: R1_UNPACKED[kind],
        validations: {
          elf_graph: true,
          no_bytecode: true,
          unchanged_outside_js_spans: true,
          syntax,
          upx_integrity: true,
          exact_unpack_roundtrip: true,
        },
        patches: result.patches.map(({ before, after, ...p }) => p),
      }
      let manifest
      if (kind === 'cli-node') {
        const kernel = fs.readFileSync(path.join(root, 'bin/kin-kernel'))
        requireThat(sha256(kernel) === WRAP_KERNEL, 'Promotion kernel differs from the observed pair')
        fs.writeFileSync(path.join(dir, 'kin-kernel.bin'), kernel, { mode: 0o555 })
        manifest = {
          version: 1,
          id: FIXED_ID,
          status: 'owner_approved',
          production_approved: true,
          approval: {
            date: '2026-09-26',
            basis: 'owner explicitly permits selectable production CLI after supplied offline capture review',
            candidate_capture_sha256: '3be91df45083e521d6831df5ca96d2b3ba210525c51e661340101b1cb33fd2f0',
            scope: 'one zero/Opus4.6/text-only sample; real provider behavior not locally tested',
          },
          dataplane: 'wrap-fixed',
          kernel: { file: 'kin-kernel.bin', sha256: WRAP_KERNEL, bytes: kernel.length },
          artifacts: { 'cli-node': artifact },
          entry: result.entry,
          supported_layouts: ['zero', 'identity'],
          tools,
          local_validation: { completed: false, native_execution: false },
          limitations: [
            'Only the original entrypoint was restored relative to the observed CLI candidate',
            'No local Linux native or real-provider execution',
            'Real quota/model/concurrency behavior remains unverified',
          ],
        }
      } else {
        manifest = {
          version: 1,
          id: CC_R2_ID,
          status: 'offline_only_pending_runtime',
          production_approved: false,
          supported_layouts: ['zero', 'identity'],
          kernel_sha256: { cc: WRAP_KERNEL, crag: CRAG_KERNEL },
          tools,
          execution_guard: {
            env: 'VM2API_OFFLINE_CANDIDATE',
            value: CC_R2_ID,
            base_url: 'literal http://127.0.0.1:port only',
          },
          artifacts: { 'cc-node': artifact },
          workload_context: {
            source: result.workloadSource,
            sha256: sha256(Buffer.from(result.workloadSource)),
            unchanged_from_r1: true,
          },
          local_validation: { completed: false, native_execution: false, user_capture_accepted: false },
          limitations: [
            'CC/Crag Linux API stages await new user captures',
            'Crag kernel request shaping is unchanged',
            'No production installation or inference approval',
          ],
        }
      }
      writeJson(path.join(dir, 'patches.json'), { [kind]: result.patches })
      manifest.patches_sha256 = sha256(fs.readFileSync(path.join(dir, 'patches.json')))
      writeJson(path.join(dir, 'manifest.json'), manifest)
      if (evidence) {
        fs.copyFileSync(uncompressed, path.join(evidence, kind + '.revision.unpacked'))
        fs.writeFileSync(path.join(evidence, kind + '.upx-test.log'), integrity)
      }
      manifests[kind] = { dir, manifest }
    }
    const file = path.join(root, 'test/unit/native-revisions-code.test.mjs')
    const log = run(process.execPath, ['--test', '--test-reporter=tap', file], {
      cwd: root,
      env: { ...process.env, NATIVE_REVISIONS_ROOT: path.resolve(outputRoot), NATIVE_REVISIONS_ORIGINAL: '0' },
    })
    requireThat(/^# fail 0$/m.test(log) && /^# skipped 0$/m.test(log), 'Revision code verification failed')
    const count = Number(log.match(/^# tests (\d+)$/m)?.[1])
    requireThat(count >= 8, 'Too few revision code checks')
    for (const { dir, manifest } of Object.values(manifests)) {
      Object.assign(manifest.local_validation, {
        completed: true,
        behavior_tests: count,
        test_sha256: sha256(fs.readFileSync(file)),
        scope: 'extracted code and actual AsyncLocalStorage; other dependencies controlled, not Linux ELF execution',
      })
      writeJson(path.join(dir, 'manifest.json'), manifest)
    }
    if (evidence) fs.writeFileSync(path.join(evidence, 'revision-code-tests.tap'), log)
    return Object.fromEntries(Object.entries(manifests).map(([kind, value]) => [kind, value.manifest]))
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2),
    opt = (key, fallback) => {
      const i = args.indexOf(key)
      return i < 0 ? fallback : args[i + 1]
    }
  const root = path.resolve(opt('--root', path.join(path.dirname(fileURLToPath(import.meta.url)), '..')))
  console.log(
    JSON.stringify(
      buildNativeRevisions({
        root,
        outputRoot: opt('--output-root'),
        evidence: opt('--evidence'),
        upx: opt('--upx'),
        bun: opt('--bun'),
      }),
      null,
      2,
    ),
  )
}
