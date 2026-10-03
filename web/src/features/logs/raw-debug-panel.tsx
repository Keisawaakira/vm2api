import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { panelFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { rawRequestLogQueryOptions } from './queries'

export const RAW_WARNING =
  '精确正文可能包含密钥/隐私，仅管理员可查看。request/response 是 Node 边界；开启 CC 原生跟踪后，native_trace 才包含 CC 的实际 HTTP/输出观察，需检查完整性与捕获方式。离线模式的 API 仍是假服务。下载/备份副本不随日志保留期删除。'
export const RAW_PREVIEW_CHARS = 24000

export async function readRawExportResponse(response: Response) {
  if (!response.ok) throw new Error('download failed')
  const rawCount = response.headers.get('x-kin-export-count')
  const count = rawCount?.trim() ? Number(rawCount) : null
  const metadataKnown = count !== null && Number.isFinite(count) && count >= 0
  if (metadataKnown && count === 0) return null
  // A cross-origin proxy may hide custom headers; absence is not a zero-record result.
  const blob = await response.blob()
  return blob.size ? { blob, metadataKnown } : null
}

export function OfflineCandidateNotice({
  candidate,
}: {
  candidate?: {
    id?: string
    local_checks_completed: boolean
  }
}) {
  if (!candidate) return null
  return (
    <p className='font-medium'>
      实验候选 {candidate.id}：
      {candidate.local_checks_completed
        ? '本地检查通过，等待本次截获人工验收'
        : '候选校验未完成或失败'}
      。 未批准用于真实推理；采集完成不等于 system 保留正确或生产可用。
    </p>
  )
}

export function RawDebugPanel({ requestId }: { requestId: string }) {
  const [revealed, setRevealed] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const query = useQuery(rawRequestLogQueryOptions(requestId, revealed))
  const raw = query.data?.item?.raw_debug
  const preview = raw ? JSON.stringify(raw, null, 2) : ''

  async function download() {
    setDownloading(true)
    try {
      const qs = new URLSearchParams({
        include_raw: '1',
        format: 'jsonl',
        request_id: requestId,
        include_muted: '1',
        limit: '1',
      })
      const res = await panelFetch(`/api/panel/request-logs/export?${qs}`)
      const downloaded = await readRawExportResponse(res)
      if (!downloaded) {
        toast.error('原始记录不可用、已过期或超过 32 MiB 完整记录导出上限')
        return
      }
      const { blob, metadataKnown } = downloaded
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'vm2api-raw-debug.jsonl'
      a.click()
      URL.revokeObjectURL(url)
      toast.success(
        metadataKnown
          ? '已下载完整存储记录（采集本身仍可能截断/缺失）'
          : '已下载；代理未提供导出统计头，请检查文件内的采集状态'
      )
    } catch {
      toast.error('原始诊断下载失败')
    } finally {
      setDownloading(false)
    }
  }

  return (
    <section className='mt-5 space-y-3 rounded-md border p-3'>
      <h3 className='text-sm font-medium'>原始非流式诊断（管理员）</h3>
      <p className='text-xs text-muted-foreground'>{RAW_WARNING}</p>
      <div className='flex gap-2'>
        <Button
          variant='outline'
          size='sm'
          onClick={() => setRevealed(!revealed)}
        >
          {revealed ? '隐藏原始正文' : '显式加载原始正文'}
        </Button>
        <Button
          variant='outline'
          size='sm'
          loading={downloading}
          onClick={() => void download()}
        >
          完整 JSONL 下载
        </Button>
      </div>
      {revealed ? (
        <>
          {query.isPending ? (
            <p>正在加载…</p>
          ) : query.isError ? (
            <p>原始诊断加载失败。</p>
          ) : !raw ? (
            <p>没有原始记录（未采集或已过期），不会从摘要重建。</p>
          ) : (
            <>
              {raw.offline_probe ? (
                <div className='space-y-1 rounded border border-amber-500/50 p-2 text-xs'>
                  <p>
                    离线模拟验证：未调用真实模型。槽位 {raw.offline_probe.vm_id}{' '}
                    · 搭配 {raw.offline_probe.pairing}
                  </p>
                  <OfflineCandidateNotice
                    candidate={raw.offline_probe.candidate}
                  />
                  {raw.offline_probe.phases?.map((phase) => (
                    <p key={phase.name}>
                      {phase.name}: {phase.status} · 长正文校验{' '}
                      {phase.checks?.text_equal === true
                        ? '一致'
                        : phase.checks
                          ? '存在差异'
                          : '未完成'}
                    </p>
                  ))}
                  <p>
                    完整链路位于
                    offline_probe.details.text（JSON）；阶段缺失或截断不代表已通过。真实槽位未被重装。
                  </p>
                </div>
              ) : null}
              <p className='text-xs'>
                状态: {raw.status} ·{' '}
                {raw.offline_probe
                  ? `真实推理未执行 · 诊断: ${raw.diagnostic_outcome || '未知'}`
                  : `推理结果: ${raw.inference_outcome}`}{' '}
                · hops: {raw.hops_observed} · 省略: {raw.hops_omitted} ·
                采集截断: {raw.truncated ? '是' : '否'}
              </p>
              {raw.hops?.map((hop) => (
                <p className='text-xs' key={hop.hop_no}>
                  Hop {hop.hop_no} / attempt {hop.attempt_no} / local connect{' '}
                  {hop.local_connect_attempt}: {hop.source} ·{' '}
                  {hop.response?.format || '无响应'} · {hop.outcome || '未知'} ·
                  读取{hop.response?.read_complete ? '完整' : '不完整/无响应'} ·
                  正文{hop.response?.truncated ? '截断' : '未截断'}
                  {hop.native_trace ? (
                    <span className='block'>
                      CC 原生链路: {hop.native_trace.status}
                      {hop.native_trace.reason
                        ? ` · ${hop.native_trace.reason}`
                        : ''}{' '}
                      · 已记录 API 尝试 {hop.native_trace.api_attempts} · CC
                      输出帧 {hop.native_trace.stdout_frames} （详细数据见
                      native_trace.details.text）
                      {hop.native_trace.status !== 'captured' ? (
                        <span className='block text-muted-foreground'>
                          这不是旧导出，也不代表 user key 无效：CC
                          取证尚未完整。 请先到此请求对应的 VM 概览检查「CC
                          原生跟踪」，确认加载后再看自然发生的请求日志。
                          缺失原因和进程状态在 native_trace.details.text。
                        </span>
                      ) : null}
                    </span>
                  ) : null}
                </p>
              ))}
              <p className='text-xs text-muted-foreground'>
                caller / request / response.text 为原始 UTF-8 JSON 或
                SSE；derived 为派生视图，初始/尾部 metadata 分开保存。以下仅 UI
                预览，最多 {RAW_PREVIEW_CHARS} 字符
                {preview.length > RAW_PREVIEW_CHARS ? '（预览已截短）' : ''}
                。完整下载最多 32 MiB，不会切碎存储记录。
              </p>
              <pre className='max-h-96 overflow-auto rounded bg-muted p-2 text-xs break-all whitespace-pre-wrap'>
                {preview.slice(0, RAW_PREVIEW_CHARS)}
              </pre>
            </>
          )}
        </>
      ) : null}
    </section>
  )
}
