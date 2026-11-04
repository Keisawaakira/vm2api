import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  NativeApiResponses,
  nativeTraceHint,
  summarizeNativeApiResponses,
} from './native-api-responses'

const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
const start = event({
  type: 'message_start',
  message: { type: 'message', model: 'claude-opus-5-5' },
})
const refuse = event({
  type: 'message_delta',
  delta: {
    stop_reason: 'refusal',
    stop_details: {
      type: 'refusal',
      category: 'reasoning_extraction',
      explanation: 'Provider supplied diagnostic',
    },
  },
})
const stop = event({ type: 'message_stop' })
function details(text: string, extra = {}) {
  return {
    text: JSON.stringify({
      http_exchanges: [
        {
          index: 1,
          transport: 'undici',
          response: {
            status: 200,
            read_complete: false,
            capture_kind: 'sdk_iterator_return',
            body: { encoding: 'utf8', text },
            ...extra,
          },
        },
      ],
    }),
  }
}

describe('explicit raw-only API response summary', () => {
  it('retains the observed refusal independently of HTTP EOF and never mutates the report', () => {
    const input = details(start + refuse + stop)
    const before = JSON.stringify(input)
    const result = summarizeNativeApiResponses(input)
    expect(result.rows[0]).toMatchObject({
      index: 1,
      httpStatus: 200,
      readComplete: false,
      captureKind: 'sdk_iterator_return',
    })
    expect(result.rows[0].messages).toEqual([
      {
        model: 'claude-opus-5-5',
        stopReason: 'refusal',
        category: 'reasoning_extraction',
        explanation: 'Provider supplied diagnostic',
        messageStopObserved: true,
      },
    ])
    expect(JSON.stringify(input)).toBe(before)
  })
  it('recognizes CRLF and multiline data without relying on the event label', () => {
    const text = `${start}event: anything\r\ndata: {"type":"message_delta",\r\ndata: "delta":{"stop_reason":"refusal"}}\r\n\r\n${stop}`
    expect(
      summarizeNativeApiResponses(details(text)).rows[0].messages[0]
    ).toMatchObject({ stopReason: 'refusal', messageStopObserved: true })
  })
  it('does not treat business text mentioning a terminal as that terminal', () => {
    const text =
      start +
      event({
        type: 'content_block_delta',
        delta: {
          type: 'text_delta',
          text: 'message_stop {"stop_reason":"refusal"}',
        },
      })
    expect(
      summarizeNativeApiResponses(details(text)).rows[0].messages[0]
    ).toEqual({ model: 'claude-opus-5-5', messageStopObserved: false })
  })
  it('does not dispatch an unfinished SSE frame even when its JSON prefix looks complete', () => {
    const result = summarizeNativeApiResponses(
      details(start + refuse + 'data: {"type":"message_stop"}')
    )
    expect(result.rows[0].messages[0].messageStopObserved).toBe(false)
    expect(result.rows[0].notes.length).toBeGreaterThan(0)
  })
  it('keeps multiple message terminals separate, including an unfinished final message', () => {
    const text =
      start +
      refuse +
      stop +
      start +
      event({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }) +
      stop +
      start
    const result = summarizeNativeApiResponses(
      details(text, { read_complete: true })
    )
    expect(
      result.rows[0].messages.map((message) => [
        message.stopReason,
        message.messageStopObserved,
      ])
    ).toEqual([
      ['refusal', true],
      ['end_turn', true],
      [undefined, false],
    ])
  })
  it('accepts raw JSON Message semantics without inventing an SSE message_stop', () => {
    const result = summarizeNativeApiResponses(
      details(
        JSON.stringify({
          type: 'message',
          model: 'fixture',
          stop_reason: 'refusal',
          stop_details: { category: 'policy' },
        }),
        { read_complete: true }
      )
    )
    expect(result.rows[0].format).toBe('json')
    expect(result.rows[0].messages[0]).toMatchObject({
      stopReason: 'refusal',
      category: 'policy',
      messageStopObserved: false,
    })
  })
  it('shows an actual JSON API error, not a synthetic successful message', () => {
    const result = summarizeNativeApiResponses(
      details(
        JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: 'Denied fixture' },
        }),
        { status: 401, read_complete: true }
      )
    )
    expect(result.rows[0].httpStatus).toBe(401)
    expect(result.rows[0].messages).toEqual([])
    expect(result.rows[0].errors).toEqual([
      'authentication_error: Denied fixture',
    ])
  })
  it.each([
    { text: 'not JSON' },
    { text: JSON.stringify({ http_exchanges: [] }), truncated: true },
  ])(
    'does not invent a summary from unavailable/truncated details',
    (input) => {
      expect(summarizeNativeApiResponses(input).rows).toEqual([])
      expect(summarizeNativeApiResponses(input).note).toBeTruthy()
    }
  )
  it('does not parse binary/derived-only response bodies as raw protocol evidence', () => {
    const result = summarizeNativeApiResponses(
      details('', {
        body: { encoding: 'base64', text: start + refuse + stop },
        parsed_json: { type: 'message', stop_reason: 'refusal' },
      })
    )
    expect(result.rows[0].messages).toEqual([])
    expect(result.rows[0].notes.length).toBeGreaterThan(0)
  })
  it('does not certify derived-only bytes or mistake an empty exchange list for no upstream call', () => {
    expect(
      summarizeNativeApiResponses(
        details(start + refuse + stop, { raw_body_unavailable: true })
      ).rows[0].messages
    ).toEqual([])
    expect(
      summarizeNativeApiResponses({
        text: JSON.stringify({ http_exchanges: [] }),
      }).note
    ).toContain('不能据此断言未调用上游')
  })
  it('ignores non-scalar server details rather than rendering objects', () => {
    const text =
      start +
      event({
        type: 'message_delta',
        delta: {
          stop_reason: 'refusal',
          stop_details: {
            category: { secret: 'not a label' },
            explanation: ['not text'],
          },
        },
      }) +
      stop
    expect(
      summarizeNativeApiResponses(details(text)).rows[0].messages[0]
    ).toEqual({
      model: 'claude-opus-5-5',
      stopReason: 'refusal',
      messageStopObserved: true,
    })
  })
  it('bounds visible exchanges without modifying the underlying export', () => {
    const input = {
      text: JSON.stringify({
        http_exchanges: Array.from({ length: 20 }, (_, index) => ({
          index: index + 1,
          response: { body: { encoding: 'utf8', text: start + stop } },
        })),
      }),
    }
    const result = summarizeNativeApiResponses(input)
    expect(result.rows).toHaveLength(16)
    expect(result.note).toBeTruthy()
    expect(JSON.parse(input.text).http_exchanges).toHaveLength(20)
  })
  it('renders provider details as escaped text and distinguishes protocol end from read end', () => {
    const input = details(
      start +
        refuse.replace(
          'Provider supplied diagnostic',
          '<img src=x onerror=alert(1)>'
        ) +
        stop
    )
    const html = renderToStaticMarkup(<NativeApiResponses details={input} />)
    expect(html).toContain('不是 CC stdout')
    expect(html).toContain('HTTP 200')
    expect(html).toContain('reasoning_extraction')
    expect(html).toContain('message_stop：已观察')
    expect(html).toContain('HTTP EOF：未确认')
    expect(html).toContain('&lt;img')
    expect(html).not.toContain('<img')
  })
  it('reserves preload setup advice for unavailable capture, not a consumed refusal terminal', () => {
    expect(
      nativeTraceHint({
        status: 'partial_capture',
        reason: 'api_response_not_fully_read',
      })
    ).not.toContain('VM 概览')
    expect(
      nativeTraceHint({
        status: 'partial_capture',
        reason: 'api_response_not_fully_read',
      })
    ).toContain('EOF')
    expect(
      nativeTraceHint({
        status: 'unavailable',
        reason: 'native_trace_not_observed',
      })
    ).toContain('VM 概览')
    expect(nativeTraceHint({ status: 'captured' })).toBe('')
  })
})
