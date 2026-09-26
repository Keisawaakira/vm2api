import { describe, expect, it } from 'vitest'
import {
  CACHE_TTL_OPTIONS,
  cacheTtlFromCompat,
  normalizeCacheTtl,
  normalizeCacheBreakpoints,
  messagesModeExplain,
} from './cache-breakpoints'

describe('cache defaults contract', () => {
  it('defaults to credential auto without rewriting a saved explicit selection', () => {
    expect(cacheTtlFromCompat(undefined)).toBe('auto')
    expect(cacheTtlFromCompat({ cache_ttl: 'auto' })).toBe('auto')
    expect(cacheTtlFromCompat({ cache_ttl: '1h' })).toBe('1h')
    expect(cacheTtlFromCompat({ cache_ttl: '5m' })).toBe('5m')
    expect(CACHE_TTL_OPTIONS.map(([value]) => value)).toEqual([
      'auto',
      '1h',
      '5m',
    ])
  })
  it('keeps the existing TTL spelling aliases', () => {
    expect(normalizeCacheTtl('60m')).toBe('1h')
    expect(normalizeCacheTtl('300')).toBe('5m')
  })
  it('uses non-destructive message fill and describes the legacy rewrite accurately', () => {
    expect(normalizeCacheBreakpoints(undefined).messages).toBe('fill')
    expect(messagesModeExplain('rewrite')).toContain('保留已有断点')
    expect(messagesModeExplain('cli-hop')).toContain('保留调用方')
  })
})
