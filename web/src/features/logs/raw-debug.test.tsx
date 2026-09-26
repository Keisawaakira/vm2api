import {
  createElement,
  isValidElement,
  type PropsWithChildren,
  type ReactNode,
} from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { RequestLogItem } from '@/types/panel-logs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { Select } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import round from '../../../../src/lib/transport/offline-candidate-round.json'
import { LogsPane } from '../settings/logs-pane'
import { LogDetailSheet } from './log-detail-sheet'
import { rawRequestLogQueryOptions, requestLogQueryOptions } from './queries'
import { OfflineCandidateNotice, RawDebugPanel } from './raw-debug-panel'

vi.mock('@/lib/session', () => ({
  apiBase: () => '',
  clearSession: vi.fn(),
  hasSession: () => true,
  sessionToken: () => '',
}))
vi.mock('@/components/ui/sheet', () => {
  const Plain = ({ children }: PropsWithChildren) =>
    createElement('div', null, children)
  return {
    Sheet: Plain,
    SheetContent: Plain,
    SheetHeader: Plain,
    SheetTitle: Plain,
    SheetDescription: Plain,
  }
})

const item = {
  request_id: 'raw-id',
  raw_debug: {
    status: 'captured',
    hops_observed: 1,
    hops_omitted: 0,
    truncated: false,
    hops: [],
    caller: { text: 'UNREDACTED_SECRET' },
  },
} as RequestLogItem
const client = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } })
function render(node: React.ReactNode, qc = client()) {
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>{node}</QueryClientProvider>
  )
}

describe('protected raw diagnostics UI', () => {
  it('separate raw query is disabled by default, uncached after unmount, and explicitly requests raw', async () => {
    const raw = rawRequestLogQueryOptions('raw id')
    const ordinary = requestLogQueryOptions('raw id')
    expect(raw.enabled).toBe(false)
    expect(raw.gcTime).toBe(0)
    expect(raw.queryKey).not.toEqual(ordinary.queryKey)
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, item }), { status: 200 })
      )
    await client().fetchQuery(rawRequestLogQueryOptions('raw id', true))
    expect(fetcher.mock.calls[0]?.[0]).toContain('/raw%20id?include_raw=1')
    fetcher.mockRestore()
  })
  it('raw panel hides cached payload by default and warns of secrets/retention/bounded download', () => {
    const qc = client()
    qc.setQueryData(rawRequestLogQueryOptions('raw-id').queryKey, { item })
    const html = render(<RawDebugPanel requestId='raw-id' />, qc)
    expect(html).not.toContain('UNREDACTED_SECRET')
    expect(html).toContain('显式加载原始正文')
    expect(html).toContain('完整 JSONL 下载')
    expect(html).toContain('下载/备份副本不随日志保留期删除')
  })
  it.each([false, true])(
    'generic detail never dumps raw; reveal control only admin=%s',
    (isAdmin) => {
      const html = render(
        <LogDetailSheet
          open
          requestId='raw-id'
          item={item}
          attempts={[]}
          loading={false}
          error={null}
          onOpenChange={() => {}}
          isAdmin={isAdmin}
        />
      )
      expect(html).not.toContain('UNREDACTED_SECRET')
      expect(html.includes('显式加载原始正文')).toBe(isAdmin)
    }
  )
  it('downloads a successful raw body even when a proxy hides count headers', async () => {
    const { readRawExportResponse } = await import('./raw-debug-panel')
    const text = '{"request_id":"raw-id","raw_debug":{"status":"captured"}}\n'
    const result = await readRawExportResponse(
      new Response(text, { status: 200 })
    )
    expect(result).not.toBeNull()
    expect(await result!.blob.text()).toBe(text)
    expect(result!.metadataKnown).toBe(false)
  })
  it('distinguishes explicit zero-record metadata and an empty fallback body', async () => {
    const { readRawExportResponse } = await import('./raw-debug-panel')
    expect(
      await readRawExportResponse(
        new Response('', {
          headers: { 'x-kin-export-count': '0' },
        })
      )
    ).toBeNull()
    expect(await readRawExportResponse(new Response(''))).toBeNull()
    const result = await readRawExportResponse(
      new Response('{}\n', {
        headers: { 'x-kin-export-count': '1' },
      })
    )
    expect(result!.metadataKnown).toBe(true)
  })
  it('does not turn HTTP failures into a raw download', async () => {
    const { readRawExportResponse } = await import('./raw-debug-panel')
    await expect(
      readRawExportResponse(new Response('denied', { status: 403 }))
    ).rejects.toThrow()
  })
  it('offline settings are visibly diagnostic and require raw Debug before enabling', () => {
    const html = render(<LogsPane value={{}} onChange={() => {}} />)
    expect(html).toContain('停止新推理')
    expect(html).toContain('HTTP 422')
    expect(html).toContain('不回退真实上游')
    expect(html).not.toContain('离线验证搭配')
    const enabled = render(
      <LogsPane
        value={{
          mode: 'debug',
          raw_nonstream_debug: true,
          offline_kernel_probe: true,
        }}
        onChange={() => {}}
      />
    )
    expect(enabled).toContain('离线验证搭配')
    expect(enabled).toContain('不改变真实槽位配置')
    expect(enabled).toContain('候选 CLI 是独立重打包的实验文件')
    expect(enabled).toContain('不退回正式版')
  })
  it('a completed round requires an explicit offline disable without changing other logging fields', () => {
    function propsFor<T>(node: ReactNode, type: unknown): T[] {
      if (Array.isArray(node))
        return node.flatMap((child) => propsFor<T>(child, type))
      if (!isValidElement<{ children?: ReactNode }>(node)) return []
      return [
        ...(node.type === type ? [node.props as T] : []),
        ...propsFor<T>(node.props.children, type),
      ]
    }
    const onChange = vi.fn()
    const value = { mode: 'debug', raw_nonstream_debug: true }
    const tree = LogsPane({ value, onChange })
    const switches = propsFor<{
      disabled?: boolean
      onCheckedChange: (v: boolean) => void
    }>(tree, Switch)
    expect(round.choices).toEqual([])
    expect(switches[1].disabled).toBe(true)
    switches[1].onCheckedChange(true)
    expect(onChange).not.toHaveBeenCalled()
    const activeTree = LogsPane({
      value: { ...value, offline_kernel_probe: true },
      onChange,
    })
    expect(propsFor(activeTree, Select)).toHaveLength(1)
    const activeSwitches = propsFor<{ onCheckedChange: (v: boolean) => void }>(
      activeTree,
      Switch
    )
    activeSwitches[1].onCheckedChange(false)
    expect(onChange).toHaveBeenLastCalledWith({
      ...value,
      offline_kernel_probe: false,
    })
  })
  it('candidate notice never labels local validation as production or runtime approval', () => {
    const passed = render(
      <OfflineCandidateNotice
        candidate={{ id: 'native-v155-r1', local_checks_completed: true }}
      />
    )
    expect(passed).toContain('等待本次截获人工验收')
    expect(passed).toContain('未批准用于真实推理')
    expect(passed).toContain('采集完成不等于 system 保留正确')
    const failed = render(
      <OfflineCandidateNotice
        candidate={{ id: 'native-v155-r1', local_checks_completed: false }}
      />
    )
    expect(failed).toContain('候选校验未完成或失败')
    expect(render(<OfflineCandidateNotice />)).toBe('')
  })
  it('settings switch is off by default with explicit warning and bounds', () => {
    const html = render(<LogsPane value={{}} onChange={() => {}} />)
    expect(html).toContain('临时原始非流式诊断')
    expect(html).toContain('data-state="unchecked"')
    expect(html).toContain('16 MiB')
    expect(html).toContain('可能不完整')
  })
})
