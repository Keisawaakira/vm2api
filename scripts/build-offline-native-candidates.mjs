#!/usr/bin/env node
/** Offline-only repacks of two exact distributed CLI builds. Never installs into a slot. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const CANDIDATE_ID = 'native-v155-r1'
export const BASELINES = Object.freeze({
  'cli-node': {
    packed: '3202378ad990d0ba098d813e7a2a4b488ba9d0930fa96b5ddbbd16cc144d709a',
    unpacked: '283e0555228f6ffcbc95eea66438bbc85c631e74676650e5e7c23cbdd36487b8',
    options: 'options',
  },
  'cc-node': {
    packed: 'be5eec49a78345dd935e302e88c9d7ad0afbb09a195356d81be1bdea766f3960',
    unpacked: '393230977c79d4cb89f0251ddcf5fd1151c30a73536f7feac984900605e5e832',
    options: 'options2',
  },
})
const KERNELS = {
  wrap: 'c44eae87aec7c537196513cc78d6e7e7c0c14b20bdc6c15eb7c0a5a68e1658a0',
  cc: 'c44eae87aec7c537196513cc78d6e7e7c0c14b20bdc6c15eb7c0a5a68e1658a0',
  crag: '5764a186e3778278a8733ecaf924211070968def7c6648c6f6ecf3b76120a537',
}
export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex')
const requireThat = (condition, message) => {
  if (!condition) throw new Error(message)
}
const TRAILER = Buffer.from('\n---- Bun! ----\n')

/** Bun 1.3.14 (0d9b296a) standalone graph: ELF .bun = u64 length + payload. */
export function inspectBunElf(bytes) {
  requireThat(
    bytes.length >= 64 && bytes.subarray(0, 6).equals(Buffer.from([127, 69, 76, 70, 2, 1])),
    'Expected ELF64 little endian',
  )
  requireThat(bytes.readUInt16LE(18) === 62, 'Expected x86-64 ELF')
  const number64 = (offset) => {
    requireThat(offset >= 0 && offset + 8 <= bytes.length, 'ELF offset outside file')
    const value = Number(bytes.readBigUInt64LE(offset))
    requireThat(Number.isSafeInteger(value), 'ELF offset is not a safe integer')
    return value
  }
  const range = (offset, length) => {
    requireThat(
      Number.isSafeInteger(offset) &&
        Number.isSafeInteger(length) &&
        offset >= 0 &&
        length >= 0 &&
        offset + length <= bytes.length,
      'ELF span outside file',
    )
    return bytes.subarray(offset, offset + length)
  }
  const shoff = number64(40),
    shsize = bytes.readUInt16LE(58),
    count = bytes.readUInt16LE(60),
    namesIndex = bytes.readUInt16LE(62)
  requireThat(shsize === 64 && count > 0 && count < 4096 && namesIndex < count, 'Unsupported section table')
  range(shoff, count * shsize)
  const sections = Array.from({ length: count }, (_, i) => {
    const at = shoff + i * shsize
    return { nameOffset: bytes.readUInt32LE(at), offset: number64(at + 24), length: number64(at + 32) }
  })
  const names = range(sections[namesIndex].offset, sections[namesIndex].length)
  const cstring = (data, offset) => {
    requireThat(offset >= 0 && offset < data.length, 'String offset outside table')
    const end = data.indexOf(0, offset)
    requireThat(end >= offset, 'Unterminated string')
    return data.subarray(offset, end).toString('utf8')
  }
  const bunSections = sections.filter((s) => cstring(names, s.nameOffset) === '.bun')
  requireThat(bunSections.length === 1, 'Expected one .bun section')
  const section = bunSections[0]
  range(section.offset, section.length)
  const payloadLength = number64(section.offset),
    base = section.offset + 8
  requireThat(
    payloadLength === section.length - 8 && payloadLength >= TRAILER.length + 32,
    'Invalid Bun payload length',
  )
  requireThat(range(base + payloadLength - TRAILER.length, TRAILER.length).equals(TRAILER), 'Invalid Bun trailer')
  const footer = base + payloadLength - TRAILER.length - 32
  const byteCount = number64(footer),
    moduleOffset = bytes.readUInt32LE(footer + 8),
    moduleLength = bytes.readUInt32LE(footer + 12)
  const entry = bytes.readUInt32LE(footer + 16),
    flags = bytes.readUInt32LE(footer + 28)
  requireThat(
    byteCount === payloadLength - TRAILER.length - 32 &&
      moduleLength > 0 &&
      moduleLength % 52 === 0 &&
      moduleOffset + moduleLength <= byteCount,
    'Invalid Bun module table',
  )
  requireThat(entry < moduleLength / 52, 'Invalid Bun entry index')
  const modules = Array.from({ length: moduleLength / 52 }, (_, i) => {
    const at = base + moduleOffset + i * 52
    const pointers = Array.from({ length: 6 }, (_, n) => ({
      offset: bytes.readUInt32LE(at + n * 8),
      length: bytes.readUInt32LE(at + n * 8 + 4),
    }))
    for (const p of pointers) requireThat(p.offset + p.length <= byteCount, 'Bun module pointer outside payload')
    const [name, source, sourcemap, bytecode, info, origin] = pointers
    requireThat(
      bytes[base + name.offset + name.length] === 0 && bytes[base + source.offset + source.length] === 0,
      'Bun text is not terminated',
    )
    return {
      name: range(base + name.offset, name.length).toString('utf8'),
      sourceOffset: base + source.offset,
      sourceBytes: source.length,
      sourcemapBytes: sourcemap.length,
      bytecodeBytes: bytecode.length,
      moduleInfoBytes: info.length,
      originBytes: origin.length,
      encoding: bytes[at + 48],
      loader: bytes[at + 49],
      format: bytes[at + 50],
      side: bytes[at + 51],
    }
  })
  requireThat(modules.length === 1 && modules[entry].name === '/$bunfs/root/cli.js', 'Unsupported standalone graph')
  const main = modules[entry]
  requireThat(
    main.bytecodeBytes === 0 && main.sourcemapBytes === 0 && main.moduleInfoBytes === 0 && main.originBytes === 0,
    'Refusing cached/bytecode build',
  )
  requireThat(
    main.encoding === 1 && main.loader === 1 && main.format === 1 && main.side === 0 && flags === 7,
    'Unsupported Bun module flags',
  )
  return { section, payloadLength, flags, entry, modules, source: range(main.sourceOffset, main.sourceBytes) }
}

function exactlyOne(text, needle) {
  const at = text.indexOf(needle)
  requireThat(at >= 0 && text.indexOf(needle, at + needle.length) < 0, `Expected one anchor: ${needle}`)
  return at
}
function span(text, begin, end, from = 0) {
  const start = text.indexOf(begin, from)
  requireThat(start >= 0, `Missing start: ${begin}`)
  const stop = text.indexOf(end, start + begin.length)
  requireThat(stop > start, `Missing end: ${end}`)
  return { start, stop, text: text.slice(start, stop) }
}

/** Only exact whitelisted input bytes are accepted; all non-JS and out-of-span bytes stay unchanged. */
export function patchNativeElf(bytes, kind, minify) {
  const baseline = BASELINES[kind]
  requireThat(baseline && sha256(bytes) === baseline.unpacked, 'Native baseline hash mismatch')
  const graph = inspectBunElf(bytes),
    main = graph.modules[graph.entry]
  const text = graph.source.toString('utf8')
  requireThat(Buffer.from(text).equals(graph.source), 'Native source is not valid UTF-8')
  requireThat(!text.includes('__vm2apiSys'), 'Candidate marker already exists')
  const changes = []
  const add = (id, selected, replacement) => {
    const original = Buffer.from(selected.text)
    const data = Buffer.from(replacement)
    requireThat(
      data.length <= original.length,
      `${id} exceeds its fixed source span (${data.length}/${original.length})`,
    )
    const absolute = main.sourceOffset + Buffer.byteLength(text.slice(0, selected.start))
    requireThat(
      bytes.subarray(absolute, absolute + original.length).equals(original),
      'Source byte/character offset mismatch',
    )
    const padded = Buffer.concat([data, Buffer.alloc(original.length - data.length, 32)])
    changes.push({
      id,
      offset: absolute,
      bytes: original.length,
      replacement_bytes: data.length,
      before_sha256: sha256(original),
      after_sha256: sha256(padded),
      before: selected.text,
      after: replacement,
      padded,
    })
  }
  const query = span(text, 'async function* queryKinMessagesWithStreaming({', '\nfunction ')
  const marker = '      agentId: "kin-slot",'
  exactlyOne(query.text, marker)
  const modifiedQuery = query.text.replace(marker, '      agentId: "kin-slot", __vm2apiSys: system.slice(),')
  const minifiedQuery = minify(`export ${modifiedQuery}`)
    .trim()
    .replace(/^export\s+/, '')
  requireThat(
    minifiedQuery.startsWith('async function* queryKinMessagesWithStreaming(') ||
      minifiedQuery.startsWith('async function*queryKinMessagesWithStreaming('),
    'Unexpected query minifier output',
  )
  add('snapshot-caller-system', query, minifiedQuery)

  const api = span(text, 'const kinSystemLayout = getSystemLayout();', '  const useBetas')
  const opts = baseline.options
  const extension = `\nif(kinSystemLayout!=="stock"&&Array.isArray(${opts}.__vm2apiSys)&&${opts}.__vm2apiSys.length){
    const _c=${opts}.__vm2apiSys.map(text=>({type:"text",text}));
    const _t=system[system.length-1];
    if(_t?.cache_control&&_t.cache_control.scope!=="global"){
      _c[_c.length-1].cache_control=_t.cache_control;delete _t.cache_control;
    }
    system.push(..._c);
  }\n`
  const wrapped = minify(`export async function __vm2api_patch(){${api.text}${extension}}`).trim()
  const prefix = 'export async function __vm2api_patch(){'
  requireThat(wrapped.startsWith(prefix) && wrapped.endsWith('}'), 'Unexpected block minifier output')
  const replacement = wrapped.slice(prefix.length, -1)
  requireThat(/\b(?:const|let|var) system\s*=/.test(replacement), 'Minifier removed system binding')
  requireThat(/\b(?:const|let|var) enablePromptCaching\s*=/.test(replacement), 'Minifier removed cache binding')
  add('preserve-caller-api-blocks', api, replacement)

  const entryMarker = text.lastIndexOf('// src/entrypoints/cli.tsx')
  requireThat(entryMarker >= 0, 'Missing standalone CLI entrypoint')
  const entrySpan = span(
    text,
    'async function main2()',
    kind === 'cli-node' ? '\nawait main2();' : '\nmain2();',
    entryMarker,
  )
  const guard = `if(process.env.VM2API_OFFLINE_CANDIDATE!==${JSON.stringify(CANDIDATE_ID)}||!/^http:\\/\\/127\\.0\\.0\\.1:\\d+\\/?$/.test(process.env.ANTHROPIC_BASE_URL||""))throw new Error("vm2api candidate is offline-only");\n`
  let modifiedEntry = entrySpan.text.replace('async function main2() {', `async function main2() {${guard}`)
  requireThat(modifiedEntry !== entrySpan.text, 'Entrypoint guard anchor mismatch')
  if (kind === 'cc-node') {
    const early = '  if (process.env.CLAUDE_CODE_KIN_NATIVE_SLOTS)'
    exactlyOne(modifiedEntry, early)
    requireThat(
      modifiedEntry.includes('runNativeMessagesLoop2') && modifiedEntry.includes('runSingleProcessSlots2'),
      'Missing CC early dispatch branches',
    )
    requireThat(
      text.includes('var init_init2 = __esm(') && text.includes('function setIsInteractive(value)'),
      'Missing original CC initialization symbols',
    )
    const prelude =
      'if(process.env.CLAUDE_CODE_KIN_NATIVE_SLOTS||args.includes("--single-process-subagents")){init_init2();setIsInteractive(false);process.env.USER_TYPE=process.env.USER_TYPE||"external";await init();}\n'
    modifiedEntry = modifiedEntry.replace(early, prelude + early)
  }
  const entryResult = minify(`export ${modifiedEntry}`)
    .trim()
    .replace(/^export\s+/, '')
  requireThat(entryResult.startsWith('async function main2('), 'Unexpected entry minifier output')
  add(kind === 'cc-node' ? 'offline-guard-and-cc-initialization' : 'offline-entry-guard', entrySpan, entryResult)
  changes.sort((a, b) => a.offset - b.offset)
  const output = Buffer.from(bytes)
  let end = 0
  for (const patch of changes) {
    requireThat(patch.offset >= end, 'Overlapping native patches')
    requireThat(
      patch.offset >= main.sourceOffset && patch.offset + patch.bytes <= main.sourceOffset + main.sourceBytes,
      'Patch outside JS source',
    )
    patch.padded.copy(output, patch.offset)
    end = patch.offset + patch.bytes
  }
  verifyUnchangedOutside(bytes, output, changes)
  const after = inspectBunElf(output)
  requireThat(
    JSON.stringify({ ...graph, source: null }) === JSON.stringify({ ...after, source: null }),
    'Bun/ELF layout changed',
  )
  return {
    bytes: output,
    graph: { ...after, source: undefined },
    changes: changes.map(({ padded, ...patch }) => patch),
  }
}

export function verifyUnchangedOutside(before, after, changes) {
  requireThat(before.length === after.length, 'Native file length changed')
  let cursor = 0
  for (const change of [...changes].sort((a, b) => a.offset - b.offset)) {
    requireThat(
      before.subarray(cursor, change.offset).equals(after.subarray(cursor, change.offset)),
      'Change outside declared JS spans',
    )
    cursor = change.offset + change.bytes
  }
  requireThat(before.subarray(cursor).equals(after.subarray(cursor)), 'Trailing bytes changed')
}

const MINIFY =
  'const s=await Bun.stdin.text();const t=new Bun.Transpiler({loader:"js",target:"bun",minifyWhitespace:true,minifySyntax:false,minifyIdentifiers:false,deadCodeElimination:false,inline:false});process.stdout.write(t.transformSync(s));'
const SCAN =
  'const s=await Bun.stdin.text();const t=new Bun.Transpiler({loader:"js",target:"bun",deadCodeElimination:false,inline:false});const r=t.scan(s);console.log(JSON.stringify({syntax:true,imports:r.imports.length,exports:r.exports.length}));'

export function buildCandidates({ root, upx, bun = 'bun', output, evidence }) {
  requireThat(upx, 'Provide an explicit trusted UPX executable with --upx')
  const out = path.resolve(output || path.join(root, 'share/offline-candidates', CANDIDATE_ID))
  for (const protectedPath of ['share/wrap-cli', 'vms', 'bin', 'image-wrap-cli']) {
    const relative = path.relative(path.resolve(root, protectedPath), out)
    requireThat(
      relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative),
      'Refusing output inside production binary/slot directories',
    )
  }
  fs.mkdirSync(out, { recursive: true })
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-native-repack-'))
  const run = (exe, args, options = {}) =>
    execFileSync(exe, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 240000, ...options })
  const minify = (source) => run(bun, ['-e', MINIFY], { input: source })
  const manifest = {
    version: 1,
    id: CANDIDATE_ID,
    status: 'offline_only_pending_runtime',
    production_approved: false,
    purpose: 'isolated fake-Anthropic capture only',
    supported_layouts: ['zero', 'identity'],
    kernel_sha256: KERNELS,
    local_validation: { completed: false, native_execution: false, user_capture_accepted: false },
    bun_runtime: '1.3.14+0d9b296a',
    method: 'fixed-length embedded-JS spans; existing runtime/resources unchanged',
    tools: { upx: run(upx, ['--version']).split(/\r?\n/)[0], syntax_minifier: run(bun, ['--version']).trim() },
    execution_guard: {
      env: 'VM2API_OFFLINE_CANDIDATE',
      value: CANDIDATE_ID,
      base_url: 'literal http://127.0.0.1:port only',
    },
    limitations: [
      'Linux native execution awaits user capture acceptance',
      'Crag kernel request shaping is unchanged',
      'Generated native prompts remain separate from preserved caller blocks',
      'Only the final non-global system cache marker is extended; real cache efficiency is unverified',
    ],
    artifacts: {},
  }
  const patches = {}
  try {
    for (const [kind, baseline] of Object.entries(BASELINES)) {
      const released = path.join(root, 'share/wrap-cli', kind)
      requireThat(sha256(fs.readFileSync(released)) === baseline.packed, `Released ${kind} hash mismatch`)
      const unpacked = path.join(tmp, `${kind}.unpacked`)
      run(upx, ['-d', '-o', unpacked, released])
      const original = fs.readFileSync(unpacked)
      const result = patchNativeElf(original, kind, minify)
      const candidate = path.join(out, kind)
      const patched = path.join(tmp, `${kind}.patched`)
      fs.writeFileSync(patched, result.bytes, { mode: 0o555 })
      const graph = inspectBunElf(result.bytes)
      const syntax = JSON.parse(run(bun, ['-e', SCAN], { input: graph.source, timeout: 120000 }))
      requireThat(syntax.syntax === true, 'Native JS syntax check failed')
      // Refuse overwrite of an already generated artifact; callers must review a new revision explicitly.
      requireThat(!fs.existsSync(candidate), `Candidate already exists: ${candidate}`)
      run(upx, ['--best', '--lzma', '-o', candidate, patched])
      const integrity = run(upx, ['-t', candidate])
      const roundtrip = path.join(tmp, `${kind}.roundtrip`)
      run(upx, ['-d', '-o', roundtrip, candidate])
      requireThat(fs.readFileSync(roundtrip).equals(result.bytes), 'UPX roundtrip changed candidate bytes')
      const packed = fs.readFileSync(candidate)
      manifest.artifacts[kind] = {
        file: kind,
        source_packed_sha256: baseline.packed,
        source_unpacked_sha256: baseline.unpacked,
        sha256: sha256(packed),
        bytes: packed.length,
        unpacked_sha256: sha256(result.bytes),
        unpacked_bytes: result.bytes.length,
        validations: {
          elf_graph: true,
          no_bytecode: true,
          unchanged_outside_js_spans: true,
          syntax,
          upx_integrity: true,
          exact_unpack_roundtrip: true,
        },
        graph: result.graph,
        patches: result.changes.map(({ before, after, ...p }) => p),
      }
      patches[kind] = result.changes
      if (evidence) {
        fs.mkdirSync(evidence, { recursive: true })
        fs.copyFileSync(patched, path.join(evidence, `${kind}.candidate.unpacked`))
        fs.writeFileSync(path.join(evidence, `${kind}.upx-test.log`), integrity)
      }
    }
    fs.writeFileSync(path.join(out, 'patches.json'), JSON.stringify(patches, null, 2) + '\n')
    manifest.patches_sha256 = sha256(fs.readFileSync(path.join(out, 'patches.json')))
    fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
    const testFile = path.join(root, 'test/unit/offline-native-candidate-code.test.mjs')
    const testLog = run(process.execPath, ['--test', '--test-reporter=tap', testFile], {
      cwd: root,
      env: { ...process.env, NATIVE_CANDIDATE_PATCHES: path.join(out, 'patches.json'), NATIVE_TEST_ORIGINAL: '0' },
    })
    const tests = Number(testLog.match(/^# tests (\d+)$/m)?.[1])
    requireThat(
      tests >= 23 && /^# fail 0$/m.test(testLog) && /^# skipped 0$/m.test(testLog),
      'Candidate behavior verification did not complete',
    )
    if (evidence) fs.writeFileSync(path.join(evidence, 'native-code-tests.tap'), testLog)
    manifest.local_validation = {
      completed: true,
      scope: 'isolated extracted code with stubbed dependencies; no Linux native execution',
      behavior_tests: tests,
      test_sha256: sha256(fs.readFileSync(testFile)),
      native_execution: false,
      user_capture_accepted: false,
    }
    fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
    return manifest
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const option = (key, fallback) => {
    const i = args.indexOf(key)
    return i < 0 ? fallback : args[i + 1]
  }
  const root = path.resolve(option('--root', path.join(path.dirname(fileURLToPath(import.meta.url)), '..')))
  const result = buildCandidates({
    root,
    upx: option('--upx'),
    bun: option('--bun', 'bun'),
    output: option('--output'),
    evidence: option('--evidence'),
  })
  console.log(JSON.stringify(result, null, 2))
}
