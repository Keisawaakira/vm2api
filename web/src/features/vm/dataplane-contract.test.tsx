import { isValidElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { Select, SelectItem } from '@/components/ui/select'
import { KernelRoutingPane } from '@/features/settings/kernel-routing-pane'
import { setKernelDataplane } from '@/features/wrap/queries'
import { dataplaneLabel } from './dataplane-contract'

vi.mock('@/lib/api', () => ({ api: vi.fn().mockResolvedValue({ ok: true }) }))
function propsFor<T>(node: ReactNode, type: unknown): T[] {
  if (Array.isArray(node))
    return node.flatMap((child) => propsFor<T>(child, type))
  if (!isValidElement<{ children?: ReactNode }>(node)) return []
  return [
    ...(node.type === type ? [node.props as T] : []),
    ...propsFor<T>(node.props.children, type),
  ]
}
describe('promoted dataplane selection', () => {
  it('keeps the default label and clearly names the separate fixed variant', () => {
    expect(dataplaneLabel(undefined)).toBe('cli-node + kernel')
    expect(dataplaneLabel('wrap-fixed')).toBe('cli-node 修复版 + kernel')
    expect(dataplaneLabel('cc-fixed')).toBe('cc-node 修复版 + kernel')
  })
  it('requires an explicit selection and never exposes offline candidates as production modes', () => {
    const onChange = vi.fn()
    const value = { session_slots: 4 }
    const tree = KernelRoutingPane({ value, onChange })
    const selects = propsFor<{
      value: string
      onValueChange: (v: string) => void
    }>(tree, Select)
    expect(selects[0].value).toBe('wrap')
    expect(onChange).not.toHaveBeenCalled()
    const options = propsFor<{ value: string }>(tree, SelectItem).map(
      (p) => p.value
    )
    expect(options.slice(0, 5)).toEqual([
      'wrap',
      'wrap-fixed',
      'cc',
      'cc-fixed',
      'crag',
    ])
    expect(options.some((v) => v.startsWith('candidate'))).toBe(false)
    for (const dataplane of ['wrap-fixed', 'cc-fixed']) {
      selects[0].onValueChange(dataplane)
      expect(onChange).toHaveBeenCalledWith({ ...value, dataplane })
    }
  })
  it('uses the existing explicit dataplane endpoint with the fixed selection and chosen targets', async () => {
    const body = {
      dataplane: 'wrap-fixed' as const,
      ids: ['vm-1'],
      restart: true,
    }
    await setKernelDataplane(body)
    expect(api).toHaveBeenLastCalledWith('/api/panel/dataplane', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  })
})
