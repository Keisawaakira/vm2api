import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { getActiveVmId, getVm } from '../vm/vm-registry.mjs'
import { isValidVmId } from '../vm/vm-file.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { resolveKernelDataplane, resolveCliSystemLayout, resolveSlotPersonaPreset } from '../vm/slot-engine.mjs'
import { describeKernelPayload, cragKernelPath, wrapCliTemplateDir, WRAP_GLIBC_LIBS } from '../vm/wrap-cli-runtime.mjs'
import { streamGoWorker } from './go-worker-client.mjs'
import { isCrsMock } from './crs-mock.mjs'
import { OFFLINE_CANDIDATE_MODES, offlineCandidateId, readOfflineCandidate } from './offline-native-candidate.mjs'
import { readFixedRelease, fixedDataplaneSpec } from '../vm/wrap-fixed.mjs'

export const OFFLINE_INPUT_BYTES = 1024 * 1024
const MAX_FILE = 128 * 1024 * 1024
const MAX_OUTPUT = 32 * 1024 * 1024
const HELPER = fileURLToPath(new URL('../../../scripts/offline-kernel-probe.py', import.meta.url))
let active = false
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex')
const failure = (code, message) => Object.assign(new Error(message), { code: `offline_${code}` })

export function offlineDockerCreateArgs(name, image) {
  return [
    'create',
    '-i',
    '--rm',
    '--name',
    name,
    '--network',
    'none',
    '--pull',
    'never',
    '--read-only',
    '--no-healthcheck',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '256',
    '--memory',
    '1g',
    '--cpus',
    '1',
    '--log-driver',
    'none',
    '--user',
    '65534:65534',
    '--workdir',
    '/work',
    // Docker cp rejects a read-only rootfs. This fresh anonymous volume contains
    // only our upload; root-owned non-writable inputs are verified by the runner.
    '--mount',
    'type=volume,target=/probe,volume-nocopy',
    '--tmpfs',
    '/work:rw,nosuid,nodev,exec,size=128m,uid=65534,gid=65534,mode=700',
    '--tmpfs',
    '/home/kincli:rw,nosuid,nodev,exec,size=128m,uid=65534,gid=65534,mode=700',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,exec,size=64m,uid=65534,gid=65534,mode=700',
    '--label',
    'vm2api.offline_probe=true',
    '--entrypoint',
    '/usr/bin/python3',
    image,
    '-I',
    '-S',
    '-u',
    '/probe/offline-kernel-probe.py',
  ]
}

function dockerCommand(args, { signal, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(process.env.KIN_DOCKER_BIN || 'docker', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      reject(failure('docker_unavailable', 'Docker CLI is unavailable'))
      return
    }
    const out = [],
      err = []
    let size = 0,
      errorSize = 0,
      settled = false
    const finish = (error, result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve(result)
    }
    const stop = (code) => {
      try {
        child.kill('SIGKILL')
      } catch {}
      finish(failure(code, `Offline Docker ${args[0]} stopped (${code})`))
    }
    const abort = () => stop('cancelled')
    const timer = setTimeout(() => stop('timeout'), timeoutMs)
    timer.unref?.()
    child.stdout.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_OUTPUT) return stop('output_limit')
      out.push(chunk)
    })
    child.stderr.on('data', (chunk) => {
      errorSize += chunk.length
      if (errorSize <= 65536) err.push(chunk)
    })
    child.once('error', () => finish(failure('docker_unavailable', 'Docker command could not start')))
    child.once('close', (code) => {
      if (code === 0) return finish(null, Buffer.concat(out).toString('utf8'))
      // Keep command output out of public errors; it may contain paths or captured input.
      const error = failure('docker_failed', `Offline Docker ${args[0]} exited with status ${code}`)
      error.diagnostic = { command: args[0], stderr: Buffer.concat(err).toString('utf8') }
      finish(error)
    })
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}

function jsonFile(file) {
  try {
    if (fs.statSync(file).size > 65536) throw failure('config_size', 'Slot configuration is too large')
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    if (e?.code === 'ENOENT') return {}
    throw failure('config_invalid', 'Slot configuration could not be read safely')
  }
}
function elfBytes(file) {
  const stat = fs.statSync(file)
  if (!stat.isFile() || stat.size < 64 || stat.size > MAX_FILE)
    throw failure('binary_size', 'Invalid offline binary size')
  const bytes = fs.readFileSync(file)
  if (
    bytes.subarray(0, 4).toString('hex') !== '7f454c46' ||
    bytes[4] !== 2 ||
    bytes[5] !== 1 ||
    bytes.readUInt16LE(18) !== 62
  )
    throw failure('binary_format', 'Offline probe requires Linux x64 ELF binaries')
  return bytes
}

/** Only approved binary files are copied, never a slot HOME, credential file or Docker socket. */
export async function runOfflineKernelProbe({
  projectRoot,
  vmId,
  routing = {},
  plane = 'current',
  envelope,
  signal,
  command = dockerCommand,
} = {}) {
  if (active) throw failure('busy', 'An offline probe is already running')
  if (signal?.aborted) throw failure('cancelled', 'Offline probe cancelled')
  const candidatePairing = Object.hasOwn(OFFLINE_CANDIDATE_MODES, plane) ? OFFLINE_CANDIDATE_MODES[plane] : null
  const candidateId = candidatePairing ? offlineCandidateId(plane) : null
  if (!candidatePairing && !['current', 'wrap', 'wrap-fixed', 'cc', 'cc-fixed', 'crag'].includes(plane))
    throw failure('dataplane', 'Unsupported offline pairing')
  const bodyText = JSON.stringify(envelope)
  if (Buffer.byteLength(bodyText) > OFFLINE_INPUT_BYTES) throw failure('input_limit', 'Offline envelope exceeds 1 MiB')
  const id = String(vmId || getActiveVmId(projectRoot) || '')
  if (!isValidVmId(id)) throw failure('vm_required', 'Choose an active Claude VM or supply x-kin-vm')
  const vm = getVm(projectRoot, id)
  if (!vm || isCodexVm(vm) || (vm.runtime?.type && vm.runtime.type !== 'docker'))
    throw failure('vm_unsupported', 'Offline probe requires a Docker Claude VM')
  const container = String(vm.runtime?.container || `kin-${id.replace(/^vm-/, '')}`)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(container)) throw failure('container', 'Invalid slot container name')
  const home = path.join(projectRoot, 'vms', id, 'cli-home', '.kin')
  const saved = jsonFile(path.join(projectRoot, 'vms', id, 'run', 'kernel.json'))
  const configured =
    saved.claude_bin === '/home/kincli/.kin/cli-node-fixed'
      ? 'wrap-fixed'
      : saved.claude_bin === '/home/kincli/.kin/cc-node-fixed'
        ? 'cc-fixed'
        : saved.dataplane || resolveKernelDataplane(vm, routing) || 'wrap'
  const selected = candidatePairing || (plane === 'current' ? configured : plane)
  if (!['wrap', 'wrap-fixed', 'cc', 'cc-fixed', 'crag'].includes(selected))
    throw failure('dataplane', 'Unsupported resolved pairing')
  const fixed = fixedDataplaneSpec(selected) ? readFixedRelease(projectRoot, selected) : null
  if (fixed && !fixed.ok) throw failure('fixed_release', fixed.error)
  const kernelSource =
    plane === 'current'
      ? path.join(home, 'kin-kernel.bin')
      : fixed
        ? fixed.kernel.file
        : selected === 'crag'
          ? cragKernelPath(projectRoot) || path.join(projectRoot, 'image-crag', 'kin-kernel')
          : describeKernelPayload(projectRoot).path
  const cliName = fixed ? fixed.slotCli : selected === 'wrap' ? 'cli-node' : 'cc-node'
  if (plane === 'current' && saved.claude_bin && saved.claude_bin !== `/home/kincli/.kin/${cliName}`)
    throw failure('custom_cli', 'Current slot uses a custom CLI path; choose an explicit diagnostic pairing instead')
  const cliSource =
    fixed && plane !== 'current'
      ? fixed.cli.file
      : path.join(plane === 'current' ? home : wrapCliTemplateDir(projectRoot), cliName)
  const layout = saved.system_layout || resolveCliSystemLayout(vm, routing)
  const persona = saved.persona_preset || resolveSlotPersonaPreset(vm, routing)
  if (!['zero', 'identity', 'stock'].includes(layout)) throw failure('layout', 'Unsupported system layout')
  active = true
  const nonce = crypto.randomUUID()
  const name = `kin-offline-${nonce}`
  let root,
    meta,
    report,
    caughtError,
    created = false
  try {
    meta = {
      requested_pairing: plane,
      selected_pairing: selected,
      ...(candidatePairing ? { candidate: { id: candidateId, status: 'not_loaded', production_approved: false } } : {}),
    }
    const kernel = fixed && plane !== 'current' ? fixed.kernel.bytes : elfBytes(kernelSource)
    let cli = null,
      candidate = null
    if (candidatePairing) {
      const base = elfBytes(cliSource)
      const checked = readOfflineCandidate(projectRoot, {
        pairing: selected,
        cliName,
        kernelHash: hash(kernel),
        baseCliHash: hash(base),
        layout,
        candidateId,
      })
      cli = checked.bytes
      candidate = checked.meta
    } else {
      try {
        cli = fixed && plane !== 'current' ? fixed.cli.bytes : elfBytes(cliSource)
      } catch (e) {
        if (e?.code !== 'ENOENT') throw e
      }
    }
    if (fixed && (hash(kernel) !== fixed.kernel.sha256 || !cli || hash(cli) !== fixed.cli.sha256))
      throw failure('fixed_installed_hash', 'Installed fixed binaries do not match the approved bundle')
    // Do not collect the production container's environment/credentials in inspect output.
    const image = String(
      await command(['inspect', '--type', 'container', '--format', '{{.Image}}', container], { signal }),
    ).trim()
    if (!/^sha256:[a-f0-9]{64}$/.test(image || '')) throw failure('image', 'Slot image identity could not be verified')
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-offline-'))
    fs.chmodSync(root, 0o700)
    const payload = path.join(root, 'payload')
    fs.mkdirSync(payload, { mode: 0o755 })
    fs.writeFileSync(path.join(payload, 'kin-kernel.bin'), kernel, { mode: 0o555 })
    if (cli) fs.writeFileSync(path.join(payload, 'real-cli'), cli, { mode: 0o555 })
    const helper = fs.readFileSync(HELPER)
    fs.writeFileSync(path.join(payload, 'offline-kernel-probe.py'), helper, { mode: 0o444 })
    const shimDir =
      plane === 'current' ? path.join(home, 'glibc239') : path.join(wrapCliTemplateDir(projectRoot), 'glibc239')
    const libraries = []
    for (const lib of WRAP_GLIBC_LIBS) {
      const src = path.join(shimDir, lib)
      if (!fs.existsSync(src)) continue
      const bytes = elfBytes(src)
      fs.mkdirSync(path.join(payload, 'glibc239'), { recursive: true, mode: 0o755 })
      fs.writeFileSync(path.join(payload, 'glibc239', lib), bytes, { mode: 0o555 })
      libraries.push({ name: lib, sha256: hash(bytes) })
    }
    meta = {
      simulation: true,
      vm_id: id,
      requested_pairing: plane,
      configured_pairing: configured,
      selected_pairing: selected,
      source: candidatePairing
        ? 'offline_candidate_files'
        : plane === 'current'
          ? 'slot_files'
          : fixed
            ? 'approved_fixed_files'
            : 'distribution_files',
      ...(candidate ? { candidate } : {}),
      ...(fixed
        ? {
            fixed_release: {
              id: fixed.id,
              production_approved: true,
              source_candidate_sha256:
                fixed.manifest.artifacts[fixedDataplaneSpec(selected).artifact].source_candidate_sha256,
            },
          }
        : {}),
      running_process_verified: false,
      image,
      kernel_sha256: hash(kernel),
      helper_sha256: hash(helper),
      kernel_file: path.relative(projectRoot, kernelSource),
      cli_sha256: cli ? hash(cli) : null,
      cli_name: cliName,
      libraries,
      system_layout: layout,
      persona_preset: persona,
      slots: 1,
      configured_slots: Math.min(20, Math.max(1, Number(saved.slots_per_worker) || 20)),
      fresh_session: true,
      identity_mode: 'synthetic_oauth',
      cache_ttl: ['5m', '1h'].includes(saved.default_cache_ttl) ? saved.default_cache_ttl : '1h',
      cli_version: String(saved.cli_version || '').slice(0, 32),
      timezone: String(saved.timezone || vm.timezone || 'UTC').slice(0, 64),
      installed_kernel_sha256: null,
      installed_cli_sha256: null,
    }
    for (const [key, file] of [
      ['installed_kernel_sha256', 'kin-kernel.bin'],
      ['installed_cli_sha256', cliName],
    ]) {
      try {
        meta[key] = hash(elfBytes(path.join(home, file)))
      } catch {}
    }
    const probeEnvelope = { ...envelope, cache_ttl: envelope.cache_ttl ?? meta.cache_ttl }
    fs.writeFileSync(path.join(payload, 'input.json'), JSON.stringify({ nonce, meta, envelope: probeEnvelope }), {
      mode: 0o444,
    })
    created = true // Cleanup by our unpredictable name even if create loses its acknowledgement.
    await command(offlineDockerCreateArgs(name, image), { signal })
    await command(['cp', `${payload}${path.sep}.`, `${name}:/probe`], { signal, timeoutMs: 30000 })
    const text = await command(['start', '-a', name], { signal, timeoutMs: 85000 })
    let result
    try {
      result = JSON.parse(text)
    } catch {
      throw failure('report', 'Offline runner did not return valid diagnostic JSON')
    }
    if (
      result?.version !== 1 ||
      result?.nonce !== nonce ||
      result?.simulation !== true ||
      !Array.isArray(result.stages)
    )
      throw failure('report', 'Offline report identity is invalid')
    if (result.network_isolated !== true || result.inputs_readonly !== true)
      throw failure('isolation', 'Offline network/input isolation was not confirmed')
    if (
      (candidatePairing || fixed) &&
      (result.binary_inputs_verified !== true ||
        result.observed_binary_hashes?.kernel_sha256 !== meta.kernel_sha256 ||
        result.observed_binary_hashes?.cli_sha256 !== meta.cli_sha256)
    ) {
      const error = failure(
        candidatePairing ? 'candidate_uploaded_hash' : 'fixed_uploaded_hash',
        'Selected binary hashes were not confirmed inside the sandbox',
      )
      error.diagnostic = { observed_binary_hashes: result.observed_binary_hashes || null }
      throw error
    }
    report = { ...result, meta, container_name: name }
    return report
  } catch (error) {
    caughtError = error
    error.diagnostic = { ...error.diagnostic, meta, container_name: created ? name : null }
    throw error
  } finally {
    let cleanupError = false
    if (created) {
      try {
        await command(['rm', '-f', '-v', name], { timeoutMs: 10000 })
      } catch {
        cleanupError = true
      }
    }
    if (report) report.cleanup = { attempted: created, auto_remove: true, removal_unconfirmed: cleanupError }
    if (caughtError?.diagnostic) caughtError.diagnostic.cleanup_attempted = created
    active = false
    if (root) fs.rmSync(root, { recursive: true, force: true })
  }
}

/** Observed JSON only. A text occurrence is not proof of its role/priority or model compliance. */
export function inspectOfflineRequests(body, captures = []) {
  const original = (Array.isArray(body?.system) ? body.system : [{ text: body?.system }])
    .map((b) => b?.text)
    .filter((s) => typeof s === 'string')
  const summaries = []
  for (const record of captures) {
    if (
      record.truncated ||
      !['cli_stdin', 'cli_request_file', 'cli_envelope_environment', 'anthropic_request'].includes(record.kind)
    )
      continue
    if (record.kind === 'anthropic_request' && String(record.path).split('?')[0] !== '/v1/messages') continue
    let parsed
    try {
      parsed = JSON.parse(record.text)
    } catch {
      continue
    }
    const request = parsed?.type === 'kin_job_start' ? parsed.request : parsed?.body || parsed
    if (!request || !Array.isArray(request.messages)) continue
    const nodes = []
    const add = (content, role, prefix) => {
      if (typeof content === 'string') nodes.push({ text: content, role, path: prefix })
      else if (Array.isArray(content))
        content.forEach((b, index) => {
          if (typeof b?.text === 'string') nodes.push({ text: b.text, role, path: `${prefix}/${index}/text` })
        })
    }
    add(request.system, 'system_root', '/system')
    request.messages.forEach((m, i) => add(m?.content, m?.role, `/messages/${i}/content`))
    summaries.push({
      boundary: record.kind === 'anthropic_request' ? 'cli_to_mock_anthropic' : 'kernel_to_cli',
      model: request.model,
      max_tokens: request.max_tokens ?? null,
      thinking: request.thinking ?? null,
      output_config: request.output_config ?? null,
      message_count: request.messages.length,
      system_blocks: Array.isArray(request.system) ? request.system.length : typeof request.system === 'string' ? 1 : 0,
      node_system_blocks: original.length,
      node_system_text_locations: original.map((text, index) => ({
        index,
        sha256: hash(text),
        matches: nodes
          .filter((n) => n.text === text || (text.length > 0 && n.text.includes(text)))
          .map((n) => ({ path: n.path, role: n.role, exact: n.text === text }))
          .slice(0, 32),
      })),
    })
  }
  return summaries
}

/** Re-run the exact production reader/assembler against captured bytes, via a private local socket. */
export async function replayOfflineKernelReply(stage, assemble, { signal } = {}) {
  if (typeof stage?.kernel_reply?.body_b64 !== 'string') return { observed: false, reason: 'no_kernel_reply' }
  if (stage.kernel_reply.complete !== true) return { observed: false, reason: 'kernel_capture_incomplete' }
  if (isCrsMock()) throw failure('reader_mocked', 'Disable KIN_CRS_MOCK before checking the production reader')
  const bytes = Buffer.from(stage.kernel_reply.body_b64, 'base64')
  if (bytes.length > 4 * 1024 * 1024) throw failure('reply_limit', 'Offline kernel response exceeds replay limit')
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-offline-replay-'))
  fs.chmodSync(temp, 0o700)
  const socketPath =
    process.platform === 'win32' ? `\\\\.\\pipe\\kin-offline-${crypto.randomUUID()}` : path.join(temp, 's.sock')
  const token = crypto.randomUUID()
  const tokenPath = path.join(temp, 'internal.token')
  fs.writeFileSync(tokenPath, token, { mode: 0o600 })
  const headers = { 'content-type': stage.kernel_reply.content_type || 'text/event-stream' }
  const trailers = {}
  const keep =
    /^x-kin-(terminal-state|stop-reason|model|usage|input-tokens|output-tokens|cache-read-input-tokens|cache-creation-input-tokens)$/
  for (const [key, value] of Object.entries(stage.kernel_reply.headers || {}))
    if (keep.test(key.toLowerCase())) headers[key.toLowerCase()] = String(value)
  for (const [key, value] of Object.entries(stage.kernel_reply.trailers || {}))
    if (keep.test(key.toLowerCase())) trailers[key.toLowerCase()] = String(value)
  const server = http.createServer((req, res) => {
    req.resume()
    if (req.headers['x-kin-internal-token'] !== token || req.method !== 'POST') {
      res.writeHead(403)
      res.end()
      return
    }
    res.writeHead(stage.kernel_reply.status || 502, headers)
    let at = 0
    const send = () => {
      if (res.destroyed) return
      if (at >= bytes.length) {
        res.addTrailers(trailers)
        res.end()
        return
      }
      const size = [1, 2, 7, 521][at % 4]
      const next = bytes.subarray(at, at + size)
      at += next.length
      if (res.write(next)) setImmediate(send)
      else res.once('drain', send)
    }
    send()
  })
  server.maxConnections = 1
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
    const homeDir = path.join(temp, 'cli-home')
    fs.mkdirSync(homeDir, { mode: 0o700 })
    const exec = {
      vmId: 'offline-replay',
      homeDir,
      vm: { runtime: { worker_socket: socketPath, worker_token_file: tokenPath } },
    }
    const body = {
      model: 'claude-opus-4-6',
      messages: [{ role: 'user', content: 'Offline reader replay' }],
      stream: true,
    }
    const result = await assemble({
      candidate: { exec },
      body,
      signal,
      chatPreserve: true,
      cliHop: true,
      dispatchStream: ({ ensureCredential: _unused, ...options }) => streamGoWorker(options),
      timeoutMs: 10000,
      idleTimeoutMs: 10000,
    })
    return { observed: true, result }
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(temp, { recursive: true, force: true })
  }
}
