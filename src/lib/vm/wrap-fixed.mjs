import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const WRAP_FIXED_ID = 'wrap-fixed-v155-r1'
export const WRAP_FIXED_SLOT_CLI = 'cli-node-fixed'
export const CC_FIXED_ID = 'cc-fixed-v155-r3'
const FIXED = Object.freeze({
  'wrap-fixed': Object.freeze({
    id: WRAP_FIXED_ID,
    directory: 'wrap-fixed/v155-r1',
    artifact: 'cli-node',
    slotCli: WRAP_FIXED_SLOT_CLI,
  }),
  'cc-fixed': Object.freeze({
    id: CC_FIXED_ID,
    directory: 'cc-fixed/v155-r3',
    artifact: 'cc-node',
    slotCli: 'cc-node-fixed',
  }),
})
export const fixedDataplaneSpec = (dataplane) => (Object.hasOwn(FIXED, dataplane) ? FIXED[dataplane] : null)
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')

/** Both approved pairs use one hash-checked loader, never a candidate or original fallback. */
export function readFixedRelease(projectRoot, dataplane = 'wrap-fixed') {
  const spec = fixedDataplaneSpec(dataplane)
  const denied = (code, error) => ({ ok: false, code: `${String(dataplane).replaceAll('-', '_')}_${code}`, error })
  if (!spec) return denied('unknown', 'Unsupported fixed dataplane')
  if (!projectRoot) return denied('missing', 'projectRoot is required for the approved fixed bundle')
  const roots = [path.join(projectRoot, 'share', spec.directory), path.join(projectRoot, 'image-' + spec.directory)]
  const dir = roots.find((p) => fs.existsSync(path.join(p, 'manifest.json')))
  if (!dir) return denied('missing', `Approved ${dataplane} bundle is missing; no original binary was substituted`)
  let manifest
  try {
    const file = path.join(dir, 'manifest.json')
    if (fs.statSync(file).size > 65536) throw Error('manifest too large')
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return denied('manifest', `Approved ${dataplane} manifest is invalid`)
  }
  if (
    manifest.version !== 1 ||
    manifest.id !== spec.id ||
    manifest.dataplane !== dataplane ||
    manifest.status !== 'owner_approved' ||
    manifest.production_approved !== true ||
    manifest.local_validation?.completed !== true
  )
    return denied('unapproved', `${dataplane} bundle is not approved and locally verified`)
  const cli = manifest.artifacts?.[spec.artifact],
    kernel = manifest.kernel
  if (
    cli?.file !== spec.artifact ||
    kernel?.file !== 'kin-kernel.bin' ||
    cli?.validations?.exact_unpack_roundtrip !== true
  )
    return denied('manifest', `${dataplane} artifact metadata is incomplete`)
  const verified = (entry) => {
    if (!/^[a-f0-9]{64}$/.test(entry.sha256 || '')) throw Error('invalid digest')
    const file = path.join(dir, entry.file),
      stat = fs.statSync(file)
    if (!stat.isFile() || stat.size !== entry.bytes || stat.size < 64 || stat.size > 128 * 1024 * 1024)
      throw Error('size mismatch')
    const bytes = fs.readFileSync(file)
    if (sha(bytes) !== entry.sha256) throw Error('hash mismatch')
    if (bytes.subarray(0, 6).toString('hex') !== '7f454c460201' || bytes.readUInt16LE(18) !== 62)
      throw Error('not linux x64 ELF')
    return { file, bytes, sha256: entry.sha256 }
  }
  try {
    return { ok: true, dir, id: spec.id, slotCli: spec.slotCli, manifest, cli: verified(cli), kernel: verified(kernel) }
  } catch {
    return denied('hash', `${dataplane} files are missing or differ from their approved hashes; no fallback used`)
  }
}

export const readWrapFixedRelease = (projectRoot) => readFixedRelease(projectRoot, 'wrap-fixed')
export function describeFixedRelease(projectRoot, dataplane) {
  const result = readFixedRelease(projectRoot, dataplane)
  if (!result.ok) return result
  return {
    ok: true,
    id: result.id,
    dir: result.dir,
    production_approved: true,
    cli: { path: result.cli.file, size: result.cli.bytes.length, sha256: result.cli.sha256 },
    kernel: { path: result.kernel.file, size: result.kernel.bytes.length, sha256: result.kernel.sha256 },
    approval: result.manifest.approval,
    local_validation: result.manifest.local_validation,
  }
}
export const describeWrapFixed = (projectRoot) => describeFixedRelease(projectRoot, 'wrap-fixed')
