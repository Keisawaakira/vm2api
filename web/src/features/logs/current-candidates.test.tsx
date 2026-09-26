import { isValidElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Select, SelectItem } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import round from '../../../../src/lib/transport/offline-candidate-round.json'
import { LogsPane } from '../settings/logs-pane'

const fixture = vi.hoisted(() => ({
  id: 'fixture-round',
  notice: '本轮暂无待测候选',
  choices: [] as { value: string; label: string }[],
}))
vi.mock('../../../../src/lib/transport/offline-candidate-round.json', () => ({
  default: fixture,
}))
beforeEach(() => {
  fixture.choices = [
    { value: 'fixture-cc', label: 'CC' },
    { value: 'fixture-crag', label: 'Crag' },
  ]
})
function propsFor<T>(node: ReactNode, type: unknown): T[] {
  if (Array.isArray(node))
    return node.flatMap((child) => propsFor<T>(child, type))
  if (!isValidElement<{ children?: ReactNode }>(node)) return []
  return [
    ...(node.type === type ? [node.props as T] : []),
    ...propsFor<T>(node.props.children, type),
  ]
}
const enabled = {
  mode: 'debug',
  raw_nonstream_debug: true,
  offline_kernel_probe: true,
}
function picker(value: Record<string, unknown>, onChange = vi.fn()) {
  const tree = LogsPane({ value, onChange })
  const selects = propsFor<{
    value: string
    children: ReactNode
    onValueChange: (v: string) => void
  }>(tree, Select)
  return { tree, select: selects[selects.length - 1], onChange }
}
describe('current-round diagnostic picker', () => {
  it('shows only the configured round, not historical/base/promoted entries', () => {
    const p = picker({
      ...enabled,
      offline_kernel_dataplane: fixture.choices[0].value,
    })
    expect(
      propsFor<{ value: string }>(p.select.children, SelectItem).map(
        (x) => x.value
      )
    ).toEqual(fixture.choices.map((x) => x.value))
    expect(round.id).toBe(fixture.id)
  })
  it('never silently replaces a stale saved choice', () => {
    const p = picker({
      ...enabled,
      offline_kernel_dataplane: 'candidate-cc-r2',
    })
    expect(p.select.value).toBe('')
    expect(p.onChange).not.toHaveBeenCalled()
  })
  it('accepts current picks and ignores unsupported callbacks', () => {
    const p = picker({ ...enabled, offline_kernel_dataplane: 'current' })
    p.select.onValueChange('candidate-wrap')
    expect(p.onChange).not.toHaveBeenCalled()
    p.select.onValueChange(fixture.choices[1].value)
    expect(p.onChange).toHaveBeenLastCalledWith({
      ...enabled,
      offline_kernel_dataplane: fixture.choices[1].value,
    })
  })
  it('explicitly enabling a populated round selects its first candidate', () => {
    const onChange = vi.fn(),
      value = {
        mode: 'debug',
        raw_nonstream_debug: true,
        offline_kernel_dataplane: 'current',
      }
    const controls = propsFor<{ onCheckedChange: (v: boolean) => void }>(
      LogsPane({ value, onChange }),
      Switch
    )
    controls[1].onCheckedChange(true)
    expect(onChange).toHaveBeenLastCalledWith({
      ...value,
      offline_kernel_probe: true,
      offline_kernel_dataplane: fixture.choices[0].value,
    })
  })
  it('a closed round cannot be enabled and has no stale selector entries', () => {
    fixture.choices = []
    const onChange = vi.fn(),
      tree = LogsPane({
        value: { mode: 'debug', raw_nonstream_debug: true },
        onChange,
      })
    const switches = propsFor<{
      disabled?: boolean
      onCheckedChange: (v: boolean) => void
    }>(tree, Switch)
    expect(switches[1].disabled).toBe(true)
    expect(() => switches[1].onCheckedChange(true)).not.toThrow()
    expect(onChange).not.toHaveBeenCalled()
  })
  it('a closed round does not silently disable offline mode or restore real inference', () => {
    fixture.choices = []
    const onChange = vi.fn(),
      value = { ...enabled, offline_kernel_dataplane: 'candidate-crag-r3' },
      tree = LogsPane({ value, onChange })
    expect(renderToStaticMarkup(tree)).toContain('本轮暂无待测候选')
    expect(propsFor(tree, Select)).toHaveLength(1)
    expect(onChange).not.toHaveBeenCalled()
    const switches = propsFor<{
      disabled?: boolean
      onCheckedChange: (v: boolean) => void
    }>(tree, Switch)
    expect(switches[1].disabled).toBe(false)
    switches[1].onCheckedChange(false)
    expect(onChange).toHaveBeenCalledWith({
      ...value,
      offline_kernel_probe: false,
    })
  })
})
