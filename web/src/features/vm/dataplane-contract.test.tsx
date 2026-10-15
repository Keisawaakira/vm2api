import { isValidElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { WrapSamplePage } from '@/features/wrap'
import { setKernelDataplane } from '@/features/wrap/queries'
import { dataplaneLabel, type KernelDataplane } from './dataplane-contract'

const boundary = vi.hoisted(() => ({
  cursor: 0,
  states: [] as unknown[],
  pending: [] as Promise<unknown>[],
  sample: {
    ok: true,
    dataplane: 'wrap' as KernelDataplane,
    wrap_fixed: { ok: true },
    cc_fixed: { ok: true },
    cc_node: { size: 1 },
    crag: { ok: true },
  },
}))

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useMemo: (read: () => unknown) => read(),
  useRef: (initial: unknown) => ({ current: initial }),
  useState: (initial: unknown) => {
    const index = boundary.cursor++
    if (!(index in boundary.states))
      boundary.states[index] =
        typeof initial === 'function' ? initial() : initial
    return [
      boundary.states[index],
      (next: unknown) => {
        boundary.states[index] =
          typeof next === 'function' ? next(boundary.states[index]) : next
      },
    ]
  },
}))

vi.mock('@tanstack/react-query', async (original) => ({
  ...(await original<typeof import('@tanstack/react-query')>()),
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => ({
    data: queryKey[1] === 'wrap-cli' ? boundary.sample : { vms: [] },
    isLoading: false,
    error: null,
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: (options: { mutationFn: (value: unknown) => unknown }) => ({
    isPending: false,
    mutate: (value: unknown) => {
      boundary.pending.push(Promise.resolve(options.mutationFn(value)))
    },
  }),
}))

vi.mock('@/lib/api', () => ({ api: vi.fn().mockResolvedValue({ ok: true }) }))

function propsFor<T>(node: ReactNode, type: unknown): T[] {
  if (Array.isArray(node))
    return node.flatMap((child) => propsFor<T>(child, type))
  if (!isValidElement<{ children?: ReactNode }>(node)) return []
  // Expand the hook-free card to inspect its rendered public radio choice.
  if (typeof node.type === 'function' && node.type.name === 'DataplaneOption') {
    const cardProps = node.props
    const card = node.type as (props: typeof cardProps) => ReactNode
    return propsFor<T>(card(cardProps), type)
  }
  return [
    ...(node.type === type ? [node.props as T] : []),
    ...propsFor<T>(node.props.children, type),
  ]
}

function page() {
  boundary.cursor = 0
  return WrapSamplePage()
}

type Choice = { value: string; onValueChange: (value: string) => void }
type Confirmation = { open: boolean; handleConfirm: () => void }

beforeEach(() => {
  vi.mocked(api).mockClear()
  boundary.cursor = 0
  boundary.states = []
  boundary.pending = []
  boundary.sample.dataplane = 'wrap'
})

describe('promoted dataplane selection on the kernel page', () => {
  it('keeps the default label and clearly names the separate fixed variant', () => {
    expect(dataplaneLabel(undefined)).toBe('cli-node + kernel')
    expect(dataplaneLabel('wrap-fixed')).toBe('cli-node 修复版 + kernel')
    expect(dataplaneLabel('cc-fixed')).toBe('cc-node 修复版 + kernel')
  })
  it('exposes five production choices without issuing a request on render', () => {
    const tree = page()
    const group = propsFor<Choice>(tree, RadioGroup)[0]
    expect(group.value).toBe('wrap')
    const options = propsFor<{ value: string }>(tree, RadioGroupItem).map(
      (option) => option.value
    )
    expect(options).toEqual(['wrap', 'wrap-fixed', 'cc', 'cc-fixed', 'crag'])
    expect(options.some((value) => value.startsWith('candidate'))).toBe(false)
    expect(api).not.toHaveBeenCalled()
  })
  for (const dataplane of ['wrap-fixed', 'cc-fixed'] as const) {
    it(`requires explicit confirmation before selecting ${dataplane}`, async () => {
      propsFor<Choice>(page(), RadioGroup)[0].onValueChange(dataplane)
      expect(api).not.toHaveBeenCalled()
      const confirmation = propsFor<Confirmation>(page(), ConfirmDialog).find(
        (dialog) => dialog.open
      )
      expect(confirmation).toBeDefined()
      confirmation!.handleConfirm()
      await Promise.all(boundary.pending)
      expect(api).toHaveBeenCalledTimes(1)
      expect(api).toHaveBeenLastCalledWith('/api/panel/dataplane', {
        method: 'POST',
        body: JSON.stringify({ dataplane, all: true, restart: true }),
      })
    })
    it(`does not reapply an already selected ${dataplane}`, () => {
      boundary.sample.dataplane = dataplane
      propsFor<Choice>(page(), RadioGroup)[0].onValueChange(dataplane)
      expect(
        propsFor<Confirmation>(page(), ConfirmDialog).some(
          (dialog) => dialog.open
        )
      ).toBe(false)
      expect(api).not.toHaveBeenCalled()
    })
  }
  it('uses the explicit endpoint with the fixed selection and chosen targets', async () => {
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
