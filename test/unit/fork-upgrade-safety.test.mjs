import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildUpdateStatus, clearReleaseCache, startHostUpgrade } from '../../src/lib/admin/release.mjs'

function fixture(t, fixed = true) {
  clearReleaseCache()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-upgrade-'))
  t.after(() => {
    clearReleaseCache()
    fs.rmSync(root, { recursive: true, force: true })
  })
  fs.writeFileSync(path.join(root, 'VERSION'), '1.3.142')
  if (fixed) {
    fs.mkdirSync(path.join(root, 'src/lib/vm'), { recursive: true })
    fs.writeFileSync(path.join(root, 'src/lib/vm/wrap-fixed.mjs'), '// fork-only registry marker, never executed')
  }
  const sock = path.join(root, 'fake-docker.sock')
  fs.writeFileSync(sock, '')
  const calls = []
  return {
    calls,
    options: {
      projectRoot: root,
      currentVersion: '1.3.142',
      version: 'v1.3.143',
      confirm: true,
      dockerBin: 'fake-docker',
      sock,
      containerized: true,
      hostname: 'control',
      arch: 'amd64',
      fetchImpl: async () => ({ ok: true, json: async () => ({ tag_name: 'v1.3.143' }) }),
      execFileImpl: async (_bin, args) => {
        calls.push(args)
        if (args[0] === 'inspect') {
          if (args.at(-1).startsWith('vm2api-upgrade-')) throw Error('not yet created')
          return {
            stdout: JSON.stringify({
              Id: 'prior-control-id',
              Name: '/control',
              State: { Running: true },
              Config: {
                Hostname: 'control',
                Labels: {
                  'com.docker.compose.project': 'fork',
                  'com.docker.compose.service': 'vm2api',
                  'com.docker.compose.project.working_dir': '/srv/vm2api',
                  'com.docker.compose.project.config_files': '/srv/vm2api/docker-compose.yml',
                },
              },
            }),
          }
        }
        return { stdout: 'fake-upgrade-task-id' }
      },
    },
  }
}

test('fork status recommends its source branch rather than an upstream release tag', async (t) => {
  const f = fixture(t)
  const result = await buildUpdateStatus(f.options)
  assert.match(result.upgrade_command, /Keisawaakira\/vm2api\/test\/deploy\/install.sh/)
  assert.match(result.upgrade_command, /upgrade --ref test/)
  assert.doesNotMatch(result.upgrade_command, /--version/)
  assert.equal(f.calls.length, 0)
})

test('fork upgrade does not launch a helper that checks out stock tags and removes fixed/CPA code', async (t) => {
  const f = fixture(t)
  const result = await startHostUpgrade(f.options)
  assert.equal(result.status, 409)
  assert.equal(result.error.code, 'host_upgrade_required')
  assert.match(result.error.message, /fork|修复版/)
  assert.match(result.error.command, /--ref test/)
  assert.equal(result.data.started, false)
  assert.equal(f.calls.length, 0, 'no inspect, build, restart or helper launch')
})

test('the ordinary upstream Compose updater remains available outside this fork', async (t) => {
  const f = fixture(t, false)
  const result = await startHostUpgrade(f.options)
  assert.equal(result.status, 202)
  assert.ok(f.calls.some((args) => args[0] === 'run'))
  assert.match(result.data.command, /--version v1\.3\.143/)
})
