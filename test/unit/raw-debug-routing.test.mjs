import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { RequestLogStore } from '../../src/lib/admin/request-log.mjs'
import { createRoutingRuntime } from '../../src/lib/admin/routing-runtime.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'

function fixture(t, { loggingPresent, rawBefore, failWrite, offlineBefore = false, patch }) {
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => db.close())
  const requestLog = new RequestLogStore({
    db,
    mode: 'debug',
    retainDays: 12,
    debugRetainDays: 4,
    maxMb: 99,
    rawNonstreamDebug: rawBefore,
    offlineKernelProbe: offlineBefore,
    offlineKernelDataplane: 'cc',
  })
  t.mock.method(fs, 'mkdirSync', () => {})
  t.mock.method(fs, 'writeFileSync', () => {
    if (failWrite) throw Object.assign(new Error('simulated EACCES'), { code: 'EACCES' })
  })
  const ctx = {
    cfg: { paths: { project: 'C:/__raw_routing_tests__' }, limits: { max_body_bytes: 1024 } },
    routingConfigPath: 'C:/__raw_routing_tests__/routing.json',
    // The stored config is intentionally not the complete effective/environment-derived log state.
    routingConfig: loggingPresent ? { logging: { mode: 'normal', raw_nonstream_debug: rawBefore } } : {},
    requestLog,
    stickyRouter: { reloadConfig() {} },
    accountQuota: { reloadConfig() {}, applyTierConcurrency() {}, applyTierRpm() {} },
    requireAuth(req) {
      req.panelRole = 'admin'
      req.panelUser = 'admin'
      return true
    },
    readBody: async () => patch || { logging: { raw_nonstream_debug: !rawBefore } },
    json(res, status, body) {
      Object.assign(res, { status, body })
    },
  }
  ctx.persistRoutingPatch = createRoutingRuntime(ctx).persistRoutingPatch
  const handle = createPanelHandler(ctx)
  return {
    ctx,
    requestLog,
    run: async (method, path) => {
      const res = {}
      await handle({ method, url: path, headers: {} }, res, new URL(path, 'http://test'))
      return res
    },
  }
}

for (const [method, path] of [
  ['PUT', '/api/panel/routing'],
  ['PUT', '/admin/routing'],
  ['POST', '/admin/routing'],
]) {
  for (const loggingPresent of [false, true]) {
    for (const rawBefore of [false, true]) {
      test(`failed ${method} ${path} restores exact live logging (section=${loggingPresent}, raw=${rawBefore})`, async (t) => {
        const fx = fixture(t, { loggingPresent, rawBefore, failWrite: true })
        const before = fx.requestLog.snapshot()
        const beforeConfig = structuredClone(fx.ctx.routingConfig)
        if (path.startsWith('/admin')) {
          await assert.rejects(fx.run(method, path), { code: 'EACCES' })
        } else {
          const res = await fx.run(method, path)
          assert.equal(res.status, 503)
          assert.equal(res.body.error.code, 'routing_persist_failed')
        }
        assert.deepEqual(fx.requestLog.snapshot(), before)
        assert.deepEqual(fx.ctx.routingConfig, beforeConfig)
      })
    }
  }
}

for (const offlineBefore of [false, true]) {
  test(`failed offline toggle restores live flag and pairing (before=${offlineBefore})`, async (t) => {
    const fx = fixture(t, {
      loggingPresent: false,
      rawBefore: true,
      offlineBefore,
      failWrite: true,
      patch: {
        logging: {
          mode: 'debug',
          raw_nonstream_debug: true,
          offline_kernel_probe: !offlineBefore,
          offline_kernel_dataplane: 'crag',
        },
      },
    })
    const before = fx.requestLog.snapshot()
    const res = await fx.run('PUT', '/api/panel/routing')
    assert.equal(res.status, 503)
    assert.deepEqual(fx.requestLog.snapshot(), before)
  })
}

for (const rawBefore of [false, true]) {
  test(`successful logging opt-in/out still applies (before=${rawBefore})`, async (t) => {
    const fx = fixture(t, { loggingPresent: true, rawBefore, failWrite: false })
    const res = await fx.run('PUT', '/api/panel/routing')
    assert.equal(res.status, 200)
    assert.equal(fx.requestLog.rawNonstreamDebug, !rawBefore)
    assert.equal(fx.ctx.routingConfig.logging.raw_nonstream_debug, !rawBefore)
  })
}
