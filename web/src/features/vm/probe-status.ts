import { normalizePanelError } from '@/lib/api'

export type ProbeCheck = {
  at?: string
  probed_at?: string
  ok?: boolean
  source?: string
  via?: string
  error?: unknown
  data_at?: string | null
}

export function latestProbe(...records: (ProbeCheck | null | undefined)[]) {
  return (
    records
      .filter((p): p is ProbeCheck => !!p)
      .sort(
        (a, b) =>
          (Date.parse(b.at || b.probed_at || '') || 0) -
          (Date.parse(a.at || a.probed_at || '') || 0)
      )[0] || {}
  )
}

export function probeSourceLabel(source?: string) {
  return source === 'messages-headers' ? '请求响应头（缓存）' : source || '—'
}

export function probeOutcome(probe: ProbeCheck): string {
  if (probe.ok === false) {
    if (typeof probe.error === 'string') return probe.error || '探测失败'
    // Persisted probes can carry a structured provider error, not only a string.
    // Render its message rather than passing the object to React (or exposing metadata).
    return normalizePanelError({ error: probe.error }, 0, '探测失败').message
  }
  if (probe.ok === true)
    return probe.source === 'messages-headers' ? '已读取缓存' : '探测成功'
  return '—'
}
