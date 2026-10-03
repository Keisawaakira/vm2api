import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query'
import type {
  RequestLogAttemptsPayload,
  RequestLogDetailPayload,
  RequestLogsResponse,
} from '@/types/panel-logs'
import type { RequestLogStats } from '@/types/panel-overview'
import { api } from '@/lib/api'

export const LOGS_QUERY_KEY = ['panel', 'request-logs'] as const
export const LOG_STREAM_BATCH_SIZE = 50

export function logsStreamQueryKey(filterKey: string) {
  return [...LOGS_QUERY_KEY, `stream&${filterKey}`] as const
}

export function logsQueryOptions(queryString: string, enabled = true) {
  return queryOptions({
    queryKey: [...LOGS_QUERY_KEY, queryString] as const,
    queryFn: () =>
      api<RequestLogsResponse>(`/api/panel/request-logs?${queryString}`),
    enabled,
  })
}

export function requestLogQueryOptions(id: string, enabled = true) {
  return queryOptions({
    queryKey: ['panel', 'request-log', id] as const,
    queryFn: async () => {
      const item = await api<RequestLogDetailPayload>(
        `/api/panel/request-logs/${encodeURIComponent(id)}`
      )
      const attempts = await api<RequestLogAttemptsPayload>(
        `/api/panel/request-logs/${encodeURIComponent(id)}/attempts`
      ).catch(() => ({ attempts: [] }))
      return { item: item.item || item, attempts: attempts.attempts || [] }
    },
    enabled,
  })
}

export function rawRequestLogQueryOptions(id: string, enabled = false) {
  return queryOptions({
    queryKey: ['panel', 'request-log-raw', id] as const,
    queryFn: () =>
      api<RequestLogDetailPayload>(
        `/api/panel/request-logs/${encodeURIComponent(id)}?include_raw=1`
      ),
    enabled,
    gcTime: 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  })
}

function nextOffset(
  lastPage: RequestLogsResponse,
  allPages: RequestLogsResponse[],
  errorClass: string
): number | undefined {
  const loaded = allPages.reduce((n, page) => n + (page.items?.length ?? 0), 0)
  if ((lastPage.items?.length ?? 0) < LOG_STREAM_BATCH_SIZE) return undefined
  if (
    !errorClass &&
    typeof lastPage.total === 'number' &&
    loaded >= lastPage.total
  ) {
    return undefined
  }
  return loaded
}

export function logsStreamQueryOptions({
  filterKey,
  errorClass,
  pollMs,
  shouldPoll,
}: {
  filterKey: string
  errorClass: string
  pollMs: number
  shouldPoll: () => boolean
}) {
  return infiniteQueryOptions({
    queryKey: logsStreamQueryKey(filterKey),
    queryFn: async ({ pageParam }) => {
      const qs = new URLSearchParams(filterKey)
      qs.set('offset', String(pageParam))
      return api<RequestLogsResponse>(
        `/api/panel/request-logs?${qs.toString()}`
      )
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) =>
      nextOffset(lastPage, allPages, errorClass),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchInterval: (query) => {
      if (!shouldPoll()) return false
      if (query.state.fetchStatus !== 'idle') return false
      return pollMs
    },
  })
}

export function logStatsQueryOptions(
  since: string,
  refetchInterval?: number,
  bucket: 'hour' | 'day' = 'hour'
) {
  return queryOptions({
    queryKey: ['panel', 'request-logs-stats', bucket, since] as const,
    queryFn: () =>
      api<RequestLogStats>(
        `/api/panel/request-logs/stats?bucket=${bucket}&since=${encodeURIComponent(since)}`
      ),
    ...(refetchInterval
      ? { refetchInterval, refetchOnWindowFocus: false }
      : {}),
  })
}
