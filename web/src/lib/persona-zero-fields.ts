import {
  DEFAULT_PERSONA_TEMPLATES,
  type RawBlock,
} from '@/lib/persona-template'

export const ZERO_SLOT_ORDER = [
  'billing',
  'identity',
  'agent',
  'caller',
] as const

export type ZeroSlot = (typeof ZERO_SLOT_ORDER)[number]

export const ZERO_SLOT_IDS: Record<ZeroSlot, string> = {
  billing: 'billing_zero',
  identity: 'identity_slot',
  agent: 'agent_slot',
  caller: 'caller_system',
}

/** 上游拒空 text 时的零宽占位，与默认 zero 模板一致。 */
export const ZERO_WIDTH_PLACEHOLDER = '\u200b'

export type ZeroFields = {
  billingText: string
  billingHide: boolean
  identityText: string
  identityHide: boolean
  agentText: string
  agentHide: boolean
  agentCacheTtl: string
  callerText: string
  callerHide: boolean
  callerDropIfEmpty: boolean
}

function seedBlock(slot: ZeroSlot): RawBlock {
  return {
    ...DEFAULT_PERSONA_TEMPLATES.zero[ZERO_SLOT_ORDER.indexOf(slot)],
  }
}

function findSlot(
  blocks: RawBlock[],
  slot: ZeroSlot
): { index: number; block: RawBlock } | null {
  const id = ZERO_SLOT_IDS[slot]
  const byId = blocks.findIndex((block) => block && block.id === id)
  if (byId >= 0) return { index: byId, block: blocks[byId] }
  const fallback = ZERO_SLOT_ORDER.indexOf(slot)
  const block = blocks[fallback]
  if (block && typeof block === 'object' && !Array.isArray(block)) {
    return { index: fallback, block }
  }
  return null
}

function cacheTtl(block: RawBlock | undefined): string {
  const cc = block?.cache_control
  if (!cc || typeof cc !== 'object' || Array.isArray(cc)) return ''
  const rec = cc as Record<string, unknown>
  return typeof rec.ttl === 'string' ? rec.ttl : ''
}

export function zeroFieldsFromBlocks(blocks: RawBlock[]): ZeroFields {
  const billing = findSlot(blocks, 'billing')?.block ?? seedBlock('billing')
  const identity = findSlot(blocks, 'identity')?.block ?? seedBlock('identity')
  const agent = findSlot(blocks, 'agent')?.block ?? seedBlock('agent')
  const caller = findSlot(blocks, 'caller')?.block ?? seedBlock('caller')
  return {
    billingText: typeof billing.text === 'string' ? billing.text : '',
    billingHide: billing.hide === true,
    identityText: typeof identity.text === 'string' ? identity.text : '',
    identityHide: identity.hide === true,
    agentText: typeof agent.text === 'string' ? agent.text : '',
    agentHide: agent.hide === true,
    agentCacheTtl: cacheTtl(agent),
    callerText: typeof caller.text === 'string' ? caller.text : '',
    callerHide: caller.hide === true,
    callerDropIfEmpty: caller.drop_if_empty === true,
  }
}

function setFlag(block: RawBlock, key: 'hide' | 'drop_if_empty', on: boolean) {
  if (on) block[key] = true
  else delete block[key]
}

function ensureSlot(blocks: RawBlock[], slot: ZeroSlot): number {
  const found = findSlot(blocks, slot)
  if (found) return found.index
  blocks.push(seedBlock(slot))
  return blocks.length - 1
}

function patchAgentCache(block: RawBlock, ttl: string) {
  const prev = block.cache_control
  const next: Record<string, unknown> =
    prev && typeof prev === 'object' && !Array.isArray(prev) ? { ...prev } : {}
  const trimmed = ttl.trim()
  if (trimmed) {
    if (next.type == null) next.type = 'ephemeral'
    next.ttl = trimmed
    block.cache_control = next
    return
  }
  delete next.ttl
  if (Object.keys(next).length === 0) delete block.cache_control
  else block.cache_control = next
}

/**
 * 按字段改 zero 模板，写回 JSONL 块。缺槽时用内置 zero 块补上，其它自定义块保留。
 */
export function applyZeroFields(
  blocks: RawBlock[],
  patch: Partial<ZeroFields>
): RawBlock[] {
  const fields = { ...zeroFieldsFromBlocks(blocks), ...patch }
  const next = (blocks.length ? blocks : DEFAULT_PERSONA_TEMPLATES.zero).map(
    (block) => ({ ...block })
  )

  const billing = next[ensureSlot(next, 'billing')]
  billing.text = fields.billingText
  setFlag(billing, 'hide', fields.billingHide)

  const identity = next[ensureSlot(next, 'identity')]
  identity.text = fields.identityText
  setFlag(identity, 'hide', fields.identityHide)

  const agent = next[ensureSlot(next, 'agent')]
  agent.text = fields.agentText
  setFlag(agent, 'hide', fields.agentHide)
  patchAgentCache(agent, fields.agentCacheTtl)

  const caller = next[ensureSlot(next, 'caller')]
  caller.text = fields.callerText
  setFlag(caller, 'hide', fields.callerHide)
  setFlag(caller, 'drop_if_empty', fields.callerDropIfEmpty)

  return next
}

export function hiddenUsageBlocks(
  blocks: RawBlock[]
): { id: string; note: string }[] {
  return blocks
    .filter((block) => block && block.hide === true)
    .map((block) => ({
      id: String(block.id ?? ''),
      note: String(block.note ?? ''),
    }))
}

export function isZeroWidthPlaceholder(text: string): boolean {
  return text === ZERO_WIDTH_PLACEHOLDER
}
