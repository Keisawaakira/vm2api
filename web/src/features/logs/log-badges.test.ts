import { describe, expect, it } from 'vitest'
import {
  errorClassBadge,
  rateBadge,
  rowCost,
  requestedThinkingSetting,
  showModelRedirect,
  statusBadge,
} from './log-badges'

describe('statusBadge', () => {
  it('maps http status onto console tones', () => {
    expect(statusBadge(200)).toEqual({ text: '200', tone: 'ok' })
    expect(statusBadge(429).tone).toBe('caution')
    expect(statusBadge(500).tone).toBe('bad')
    expect(statusBadge('error').tone).toBe('bad')
  })
})

describe('errorClassBadge', () => {
  it('uses the error label when present', () => {
    expect(
      errorClassBadge({ error_class: 'quota', error_label: '限流' })
    ).toEqual({ text: '限流', tone: 'warn' })
  })

  it('stays hidden without an error class', () => {
    expect(errorClassBadge({})).toBeNull()
  })
})

describe('rateBadge', () => {
  it('hides a multiplier of 1 and non-numbers', () => {
    expect(rateBadge(1)).toBeNull()
    expect(rateBadge('nope')).toBeNull()
    expect(rateBadge(null)).toBeNull()
  })

  it('marks a surcharge as caution and a discount as ok', () => {
    expect(rateBadge(1.5)).toEqual({ text: 'x1.50', tone: 'caution' })
    expect(rateBadge(0.8)).toEqual({ text: 'x0.80', tone: 'ok' })
  })
})

describe('showModelRedirect', () => {
  it('does not turn recognized Claude suffix normalization into a redirect, even in old rows', () => {
    for (const suffix of ['60000', '10000', 'max', 'auto', 'none', '-1']) {
      expect(
        showModelRedirect({
          requested_model: `claude-opus-4-6(${suffix})`,
          upstream_model: 'claude-opus-4-6',
          model_mismatch: 1,
        })
      ).toBe(false)
    }
    expect(
      showModelRedirect({
        requested_model: 'claude-opus-4-6(60000)',
        upstream_model: 'claude-sonnet-4-6',
        model_mismatch: 1,
      })
    ).toBe(true)
    expect(
      showModelRedirect({
        requested_model: 'claude-opus-4-6(unsupported)',
        upstream_model: 'claude-opus-4-6',
      })
    ).toBe(true)
    expect(
      showModelRedirect({
        requested_model: 'unrelated(60000)',
        upstream_model: 'unrelated',
      })
    ).toBe(true)
    expect(
      showModelRedirect({
        requested_model: 'claude-opus-4-6(60000)',
        model_mismatch: 1,
      })
    ).toBe(true)
  })
  it('shows when the flag is set or the models differ', () => {
    expect(showModelRedirect({ model_mismatch: 1 })).toBe(true)
    expect(
      showModelRedirect({
        requested_model: 'a',
        upstream_model: 'b',
      })
    ).toBe(true)
    expect(
      showModelRedirect({
        requested_model: 'a',
        upstream_model: 'a',
        model_mismatch: 0,
      })
    ).toBe(false)
  })
})

describe('requestedThinkingSetting', () => {
  it('labels requested budgets rather than asserting cloud execution or consumption', () => {
    expect(requestedThinkingSetting('claude-opus-4-6(60000)')).toEqual({
      model: 'claude-opus-4-6',
      suffix: '60000',
      label: '请求手动思考预算 60000 token',
    })
    expect(requestedThinkingSetting('claude-opus-4-6(0)')?.label).toBe(
      '请求关闭思考'
    )
    expect(requestedThinkingSetting('claude-opus-4-6(-1)')?.label).toBe(
      '请求自动思考'
    )
    expect(requestedThinkingSetting('claude-opus-4-6(max)')?.label).toBe(
      '请求思考等级 max'
    )
    expect(requestedThinkingSetting('claude-opus-4-6(unsupported)')).toBeNull()
    expect(requestedThinkingSetting('unrelated(60000)')).toBeNull()
  })
})

describe('rowCost', () => {
  it('prefers actual cost and falls back to total', () => {
    expect(rowCost({ actual_cost: 0.2, total_cost: 1 })).toBe(0.2)
    expect(rowCost({ total_cost: 1 })).toBe(1)
    expect(rowCost({})).toBeNull()
  })
})
