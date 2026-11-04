import type { UsageLogRow } from '@/types/panel-usage-logs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CostTooltipContent } from './cost-tooltip'

function row(cacheCreationInputTokens: number | null): UsageLogRow {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens,
    cacheReadInputTokens: 0,
    cacheCreation5mInputTokens: 0,
    cacheCreation1hInputTokens: 0,
    cacheTtlApplied: '1h',
    costUsd: 0.015,
    actualCostUsd: 0.015,
    groupCostMultiplier: null,
    context1mApplied: false,
    costBreakdown: { input: 0, output: 0, cacheCreation: 0.015, cacheRead: 0 },
  } as UsageLogRow
}

describe('cache cost with unreported write tokens', () => {
  it('retains the observed cost but cannot derive a token unit price from null', () => {
    const markup = renderToStaticMarkup(<CostTooltipContent row={row(null)} />)
    expect(markup).toContain('缓存写入合计（未分摊）')
    expect(markup).toContain('0.015000')
    expect(markup).not.toContain('/ 1M')
    expect(markup).not.toContain('TTL 未细分：')
  })

  it('can show the aggregate unit price when tokens are actually reported', () => {
    const markup = renderToStaticMarkup(<CostTooltipContent row={row(300)} />)
    expect(markup).toContain('/ 1M')
    expect(markup).toContain('50.00')
    expect(markup).toContain('TTL 未细分：')
  })
})
