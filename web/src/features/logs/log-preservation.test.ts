import { describe, expect, it } from 'vitest'
import {
  cacheWriteSplit,
  cacheCostSplit,
  resolveModelAuditDisplay,
} from './log-display'

describe('fork contracts in the replacement log view', () => {
  it.each(['60000', '8192', 'max', '-1'])(
    'does not relabel recognized Claude suffix %s as a redirect',
    (suffix) => {
      const audit = resolveModelAuditDisplay({
        originalModel: `claude-opus-4-6(${suffix})`,
        model: 'claude-opus-4-6',
        actualResponseModel: 'claude-opus-4-6',
      })
      expect(audit.hasRedirect).toBe(false)
      expect(audit.hasActualMismatch).toBe(false)
    }
  )
  it('keeps real model changes and unknown suffixes visible', () => {
    expect(
      resolveModelAuditDisplay({
        originalModel: 'claude-opus-4-6(60000)',
        model: 'claude-sonnet-4-6',
        actualResponseModel: 'claude-haiku-4-5',
      })
    ).toMatchObject({ hasRedirect: true, hasActualMismatch: true })
    expect(
      resolveModelAuditDisplay({
        originalModel: 'claude-opus-4-6(custom)',
        model: 'claude-opus-4-6',
        actualResponseModel: null,
      }).hasRedirect
    ).toBe(true)
  })
  it('keeps partial and unknown cache buckets instead of inventing TTL attribution', () => {
    expect(
      cacheWriteSplit({ total: 300, fiveM: 100, oneH: 0, ttl: '5m' })
    ).toEqual({ fiveM: 100, oneH: 0, unknown: 200 })
    expect(
      cacheWriteSplit({ total: 300, fiveM: 0, oneH: 0, ttl: '1h' })
    ).toEqual({ fiveM: 0, oneH: 0, unknown: 300 })
    expect(
      cacheWriteSplit({ total: 300, fiveM: 100, oneH: 200, ttl: '5m' })
    ).toEqual({ fiveM: 100, oneH: 200 })
  })
  it('does not assign the full aggregate cost to a partially known TTL bucket', () => {
    const tokens = cacheWriteSplit({
      total: 300,
      fiveM: 100,
      oneH: 0,
      ttl: '5m',
    })
    expect(cacheCostSplit(3, tokens, '5m')).toEqual({
      fiveM: 0,
      oneH: 0,
      unallocated: 3,
    })
  })
})
