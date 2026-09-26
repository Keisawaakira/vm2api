import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PERSONA_TEMPLATES,
  PERSONA_PRESET_OPTIONS,
  PERSONA_PRESETS,
  overlayDisabledByPersona,
  personaInjectFromPreset,
  protocolPersonaSaveToast,
  presetSeed,
  templateOrFollowPreset,
  validatePersonaTemplate,
} from './persona-template'

describe('persona template contract', () => {
  it('keeps the four routing presets in PUT order', () => {
    expect([...PERSONA_PRESETS]).toEqual([
      'official',
      'official_full',
      'zero',
      'custom',
    ])
    expect(PERSONA_PRESET_OPTIONS.map(([value]) => value)).toEqual([
      ...PERSONA_PRESETS,
    ])
  })

  it('keeps official / official_full / zero slot ids and hide defaults', () => {
    expect(DEFAULT_PERSONA_TEMPLATES.official.map((block) => block.id)).toEqual(
      ['billing', 'identity', 'caller_agent', 'caller_system']
    )
    expect(
      DEFAULT_PERSONA_TEMPLATES.official_full.map((block) => block.id)
    ).toEqual([
      'billing',
      'identity',
      'agent_official',
      'env_official',
      'caller_system',
    ])
    expect(DEFAULT_PERSONA_TEMPLATES.zero.map((block) => block.id)).toEqual([
      'billing_zero',
      'identity_slot',
      'agent_slot',
      'caller_system',
    ])
    expect(DEFAULT_PERSONA_TEMPLATES.official.some((block) => block.hide)).toBe(
      false
    )
    expect(
      DEFAULT_PERSONA_TEMPLATES.official_full.some((block) => block.hide)
    ).toBe(false)
    expect(
      DEFAULT_PERSONA_TEMPLATES.zero.map((block) => block.hide === true)
    ).toEqual([true, true, true, false])
    expect(DEFAULT_PERSONA_TEMPLATES.zero[2]?.cache_control).toEqual({
      type: 'ephemeral',
    })
    expect(DEFAULT_PERSONA_TEMPLATES.custom).toEqual([])
  })

  it('forces overlay off only for zero, and empty custom seeds official', () => {
    expect(overlayDisabledByPersona('zero')).toBe(true)
    expect(overlayDisabledByPersona('official')).toBe(false)
    expect(presetSeed(DEFAULT_PERSONA_TEMPLATES, 'custom')).toEqual(
      DEFAULT_PERSONA_TEMPLATES.official
    )
    expect(
      templateOrFollowPreset(
        DEFAULT_PERSONA_TEMPLATES.zero,
        DEFAULT_PERSONA_TEMPLATES,
        'zero'
      )
    ).toEqual([])
    expect(validatePersonaTemplate(DEFAULT_PERSONA_TEMPLATES.zero)).toEqual([])
  })

  it('writes the three persona switches back as their own inject values', () => {
    expect(personaInjectFromPreset('official', 'rewrite')).toBe(
      'official_prompt'
    )
    expect(personaInjectFromPreset('official_full', 'rewrite')).toBe(
      'official_full'
    )
    expect(personaInjectFromPreset('zero', 'rewrite')).toBe('zero')
    expect(personaInjectFromPreset('custom', 'append')).toBe('append')
  })

  it('save toast names the stored preset and the kernel hot update', () => {
    expect(
      protocolPersonaSaveToast({ persona_preset: 'official_full' }, 0, {
        updated: 2,
      })
    ).toBe('已保存 · 官方完整提示词 · 人设与缓存 TTL 已热更新 2 个槽')
    expect(
      protocolPersonaSaveToast({ persona_preset: 'zero' }, 1, { updated: 0 })
    ).toBe(
      '已保存 · 0注入 · 1 个槽位改为跟随全局 · 人设与缓存 TTL 的 kernel 配置已一致'
    )
  })
})
