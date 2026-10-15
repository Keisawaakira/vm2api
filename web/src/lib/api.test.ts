import { describe, expect, it } from 'vitest'
import { ApiError, normalizePanelError } from './api'

describe('panel error envelope', () => {
  it('preserves structured error metadata', () => {
    const normalized = normalizePanelError(
      {
        error: {
          type: 'permission_error',
          code: 'forbidden',
          message: '没有权限',
          details: { capability: 'users' },
        },
        data: { refresh_class: 'fatal' },
      },
      403,
      'Forbidden'
    )

    expect(normalized).toEqual({
      message: '没有权限',
      status: 403,
      type: 'permission_error',
      code: 'forbidden',
      details: { capability: 'users' },
      data: { refresh_class: 'fatal' },
    })
  })

  it('keeps a committed routing change distinct from a failed per-VM sync', () => {
    const runtime = {
      ok: false,
      failed_count: 1,
      items: [
        {
          id: 'vm-01',
          ok: false,
          code: 'kernel_restart_failed',
          error: 'native startup failed',
          kernel: { ok: false, reason: 'health_timeout' },
        },
        { id: 'vm-02', ok: true },
      ],
    }
    const normalized = normalizePanelError(
      {
        routing_committed: true,
        dataplane_runtime: runtime,
        error: {
          code: 'dataplane_sync_failed',
          message:
            'Routing was saved, but dataplane synchronization failed; inspect the report and retry.',
        },
      },
      503
    )
    expect(normalized.message).toContain('vm-01')
    expect(normalized.message).toContain('kernel_restart_failed')
    expect(normalized.message).toContain('native startup failed')
    expect(normalized.message).toContain('配置已保存')
    expect(normalized.message).not.toContain('vm-02')
    expect(normalized.details).toEqual({
      routing_committed: true,
      dataplane_runtime: runtime,
    })
  })

  it('bounds sync error text and never renders arbitrary nested metadata', () => {
    const normalized = normalizePanelError(
      {
        routing_committed: true,
        dataplane_runtime: {
          items: Array.from({ length: 20 }, (_, i) => ({
            id: `vm-${i}`,
            ok: false,
            code: 'kernel_restart_failed',
            error: 'x'.repeat(2000),
            headers: { authorization: 'PRIVATE_TOKEN' },
          })),
        },
        error: { code: 'dataplane_sync_failed', message: 'failed' },
      },
      503
    )
    expect(normalized.message.length).toBeLessThan(1600)
    expect(normalized.message).not.toContain('vm-19')
    expect(normalized.message).not.toContain('PRIVATE_TOKEN')
    expect(normalized.message).toContain('数据面')
  })

  it('malformed sync reports retain the original failure rather than throwing', () => {
    expect(
      normalizePanelError(
        {
          dataplane_runtime: [],
          error: { code: 'dataplane_sync_failed', message: 'failed' },
        },
        503
      ).message
    ).toBe('failed')
  })

  it('keeps string error codes compatible with existing callers', () => {
    const error = new ApiError('冲突', 409, 'conflict')
    expect(error).toMatchObject({ status: 409, code: 'conflict' })
  })
})
