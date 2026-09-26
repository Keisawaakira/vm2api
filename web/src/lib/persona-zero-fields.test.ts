import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PERSONA_TEMPLATES,
  stringifyPersonaTemplate,
  validatePersonaTemplate,
} from './persona-template'
import {
  ZERO_WIDTH_PLACEHOLDER,
  applyZeroFields,
  hiddenUsageBlocks,
  zeroFieldsFromBlocks,
} from './persona-zero-fields'

describe('zero inject field mapping', () => {
  it('round-trips the built-in zero template without rewriting JSONL', () => {
    const seed = DEFAULT_PERSONA_TEMPLATES.zero
    const fields = zeroFieldsFromBlocks(seed)
    expect(fields).toMatchObject({
      billingText: '{{billing_semi}} prompt_version=<{{identity_compact}}>',
      billingHide: true,
      identityText: ZERO_WIDTH_PLACEHOLDER,
      identityHide: true,
      agentText: ZERO_WIDTH_PLACEHOLDER,
      agentHide: true,
      agentCacheTtl: '',
      callerText: '{{caller_system}}',
      callerHide: false,
      callerDropIfEmpty: true,
    })
    expect(JSON.stringify(applyZeroFields(seed, {}))).toBe(JSON.stringify(seed))
    expect(stringifyPersonaTemplate(applyZeroFields(seed, {}))).toBe(
      stringifyPersonaTemplate(seed)
    )
  })

  it('writes hide and ttl back onto the JSONL blocks', () => {
    const next = applyZeroFields(DEFAULT_PERSONA_TEMPLATES.zero, {
      billingHide: false,
      agentCacheTtl: '1h',
      callerHide: true,
    })
    expect(next[0]?.hide).toBeUndefined()
    expect(next[2]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect(next[3]?.hide).toBe(true)
    expect(validatePersonaTemplate(next)).toEqual([])
    expect(hiddenUsageBlocks(next).map((block) => block.id)).toEqual([
      'identity_slot',
      'agent_slot',
      'caller_system',
    ])
  })

  it('fills missing slots from the built-in zero template', () => {
    const next = applyZeroFields([], {
      billingText: '{{billing_semi}} prompt_version=<custom>',
    })
    expect(next.map((block) => block.id)).toEqual([
      'billing_zero',
      'identity_slot',
      'agent_slot',
      'caller_system',
    ])
    expect(next[0]?.text).toBe('{{billing_semi}} prompt_version=<custom>')
    expect(next[1]?.text).toBe(ZERO_WIDTH_PLACEHOLDER)
  })
})
