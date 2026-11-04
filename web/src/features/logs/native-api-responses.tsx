type Details = { text?: string; truncated?: boolean }
type MessageSummary = {
  model?: string
  stopReason?: string
  category?: string
  explanation?: string
  messageStopObserved: boolean
}
type ResponseSummary = {
  index: number
  transport?: string
  httpStatus?: number
  readComplete: boolean
  captureKind?: string
  format: 'sse' | 'json' | 'unavailable'
  messages: MessageSummary[]
  errors: string[]
  notes: string[]
}
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
const text = (value: unknown, limit = 1000) =>
  typeof value === 'string' ? value.slice(0, limit) : undefined
const MAX_DETAILS = 16 * 1024 * 1024
const MAX_RESPONSE = 2 * 1024 * 1024

// Display-only interpretation of existing admin-only capture. This does not
// rewrite stored bytes, inference results, or the collector's completeness flag.
function responseSummary(value: unknown, position: number): ResponseSummary {
  const api = record(value),
    response = record(api?.response),
    body = record(response?.body)
  const result: ResponseSummary = {
    index:
      Number.isSafeInteger(api?.index) && Number(api?.index) > 0
        ? Number(api?.index)
        : position + 1,
    transport: text(api?.transport, 40),
    httpStatus:
      typeof response?.status === 'number' && Number.isInteger(response.status)
        ? response.status
        : undefined,
    readComplete: response?.read_complete === true,
    captureKind: text(response?.capture_kind, 80),
    format: 'unavailable',
    messages: [],
    errors: [],
    notes: [],
  }
  if (
    response?.raw_body_unavailable === true ||
    body?.encoding !== 'utf8' ||
    typeof body.text !== 'string'
  ) {
    result.notes.push(
      '未保存可解析的 UTF-8 API 原文；不从 CC stdout 或已解析视图重建。'
    )
    return result
  }
  if (body.text.length > MAX_RESPONSE)
    result.notes.push(
      '摘要扫描已达上限；不代表原始记录被截断，请查看完整 JSONL。'
    )
  const content = body.text.slice(0, MAX_RESPONSE).replace(/^\uFEFF/, '')
  let current: MessageSummary | undefined
  const begin = (message?: Record<string, unknown>) => {
    if (result.messages.length >= 8) return undefined
    const next: MessageSummary = { messageStopObserved: false }
    if (typeof message?.model === 'string')
      next.model = text(message.model, 120)
    result.messages.push(next)
    return next
  }
  const fields = (message: MessageSummary, delta?: Record<string, unknown>) => {
    if (!delta) return
    const reason = text(delta.stop_reason, 120)
    const details = record(delta.stop_details)
    const category = text(details?.category, 120),
      explanation = text(details?.explanation)
    if (reason !== undefined) message.stopReason = reason
    if (category !== undefined) message.category = category
    if (explanation !== undefined) message.explanation = explanation
  }
  const consume = (value: unknown) => {
    const event = record(value)
    if (!event) return
    if (event.type === 'error') {
      const error = record(event.error)
      const parts = [text(error?.type, 100), text(error?.message)].filter(
        Boolean
      )
      if (parts.length && result.errors.length < 8)
        result.errors.push(parts.join(': '))
      return
    }
    if (
      !['message', 'message_start', 'message_delta', 'message_stop'].includes(
        String(event.type)
      )
    )
      return
    if (event.type === 'message_start' || event.type === 'message') {
      const message = event.type === 'message' ? event : record(event.message)
      current = begin(message)
      if (current) fields(current, message)
    } else {
      if (!current || current.messageStopObserved) current = begin()
      if (!current) return
      if (event.type === 'message_delta') fields(current, record(event.delta))
      if (event.type === 'message_stop') current.messageStopObserved = true
    }
  }
  if (content.trimStart().startsWith('{')) {
    result.format = 'json'
    try {
      consume(JSON.parse(content))
    } catch {
      result.notes.push('API JSON 未解析完整。')
    }
  } else {
    result.format = 'sse'
    const frames = content.replace(/\r\n?/g, '\n').split('\n\n')
    const tail = frames.pop()
    if (tail?.trim())
      result.notes.push('尾部 SSE 帧未闭合；摘要未将其视作已完成事件。')
    if (frames.length > 16000)
      result.notes.push('摘要事件数已达上限；请查看完整 JSONL。')
    let invalid = false
    for (const frame of frames.slice(0, 16000)) {
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n')
      if (!data || data === '[DONE]') continue
      try {
        consume(JSON.parse(data))
      } catch {
        invalid = true
      }
    }
    if (invalid)
      result.notes.push('部分 SSE data 无法解析；原文仍在完整记录中。')
  }
  if (result.messages.length >= 8)
    result.notes.push('最多展示前 8 条 Message；完整记录不变。')
  return result
}

export function summarizeNativeApiResponses(details?: Details): {
  rows: ResponseSummary[]
  note?: string
} {
  if (!details?.text || details.truncated || details.text.length > MAX_DETAILS)
    return {
      rows: [],
      note: '原生详情缺失、截断或超出摘要上限，无法安全解析。',
    }
  let data: Record<string, unknown> | undefined
  try {
    data = record(JSON.parse(details.text))
  } catch {
    return { rows: [], note: '原生详情 JSON 无法解析。' }
  }
  if (!Array.isArray(data?.http_exchanges) || data.http_exchanges.length === 0)
    return {
      rows: [],
      note: '没有已保存的 API 交换记录；不能据此断言未调用上游。',
    }
  return {
    rows: data.http_exchanges.slice(0, 16).map(responseSummary),
    ...(data.http_exchanges.length > 16
      ? { note: '摘要最多展示前 16 次交换；完整 JSONL 不变。' }
      : {}),
  }
}

export function nativeTraceHint(trace: { status: string; reason?: string }) {
  if (trace.status === 'captured') return ''
  if (trace.reason === 'api_response_not_fully_read')
    return 'SDK 未确认读到 HTTP EOF；这与是否已收到 Message 终态不同，请看下方 API 摘要。不因此判定漏掉后续正文或必须重启 CLI。'
  if (trace.status === 'unavailable')
    return '不是旧导出，也不代表 user key 无效：尚未观察到完整 CC 取证。请到该请求对应的 VM 概览检查「CC 原生跟踪」；详细状态在 native_trace.details.text。'
  return '本次取证存在缺失或关联问题。保留完整 JSONL，不能用缺失记录推断云端没有响应。'
}

export function NativeApiResponses({ details }: { details?: Details }) {
  if (!details) return null
  const summary = summarizeNativeApiResponses(details)
  return (
    <div className='space-y-2 rounded border p-2 text-xs'>
      <p className='font-medium'>已保存的 API 响应摘要（不是 CC stdout）</p>
      <p className='text-muted-foreground'>
        仅从已捕获原文派生，不改变采集完整性或推理结果。
      </p>
      {summary.note ? <p>{summary.note}</p> : null}
      {summary.rows.map((row) => (
        <div key={row.index} className='space-y-1'>
          <p>
            API {row.index} · {row.transport || '未知传输'} · HTTP{' '}
            {row.httpStatus ?? '未知'} · HTTP EOF：
            {row.readComplete ? '已确认' : '未确认'}
            {row.captureKind ? ` · ${row.captureKind}` : ''}
          </p>
          {row.messages.map((message, index) => (
            <div key={index}>
              <p>
                Message {index + 1}
                {message.model ? ` · ${message.model}` : ''} · stop_reason：
                {message.stopReason || '未观察'} ·{' '}
                {row.format === 'json'
                  ? 'JSON 响应（无 SSE message_stop）'
                  : `message_stop：${message.messageStopObserved ? '已观察' : '未观察'}`}
              </p>
              {message.category ? (
                <p>上游 stop_details.category：{message.category}</p>
              ) : null}
              {message.explanation ? (
                <p className='break-words'>上游说明：{message.explanation}</p>
              ) : null}
            </div>
          ))}
          {row.errors.map((error, index) => (
            <p key={index} className='break-words'>
              上游错误：{error}
            </p>
          ))}
          {row.notes.map((note) => (
            <p key={note} className='text-muted-foreground'>
              {note}
            </p>
          ))}
          {!row.messages.length && !row.errors.length ? (
            <p>未观察到可识别的 Message／错误详情；不从正文关键字推测。</p>
          ) : null}
        </div>
      ))}
    </div>
  )
}
