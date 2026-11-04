// Once HTTP headers are sent, failures must be SSE errors, not a silent successful-looking EOF.
const errorSent = new WeakSet()

export function markProtocolStreamError(res) {
  errorSent.add(res)
}

/** Client response disconnects happen after the request body has already finished. */
export function watchClientDisconnect(req, res, controller) {
  const abort = () => {
    if (!controller.signal.aborted) controller.abort(new Error('client_aborted'))
  }
  const close = () => {
    if (!res.writableEnded) abort()
  }
  req.once('aborted', abort)
  res.once?.('close', close)
  if (!res.writableEnded && (req.aborted || res.destroyed)) abort()
  return () => {
    req.off('aborted', abort)
    res.off?.('close', close)
  }
}

export function canWriteProtocolStream(res) {
  return !res.destroyed && !res.writableEnded && !errorSent.has(res)
}

/** Native events are parsed before writing so provider errors share the same lifecycle. */
export function writeAnthropicStreamEvent(res, event) {
  if (!event || !canWriteProtocolStream(res)) return
  if (event.type === 'error') writeProtocolStreamError(res, 'anthropic.messages', event)
  else res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
}

export function writeProtocolStreamError(res, protocol, body = {}) {
  if (res.destroyed || res.writableEnded || errorSent.has(res)) return false
  const error = body.error || {
    type: 'upstream_error',
    code: 'stream_incomplete',
    message: 'Upstream stream ended before completion',
  }
  errorSent.add(res)
  if (protocol === 'anthropic.messages') {
    res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error })}\n\n`)
  } else if (protocol === 'openai.responses') {
    res.write(
      `event: error\ndata: ${JSON.stringify({ type: 'error', code: error.code || error.type || 'upstream_error', message: error.message, param: null })}\n\n`,
    )
  } else {
    res.write(`data: ${JSON.stringify({ error })}\n\n`)
  }
  return true
}

export function finishProtocolStream(res, { protocol, ok, errorBody, cancelled = false } = {}) {
  if (res.destroyed || res.writableEnded) return
  if (!cancelled) {
    if (!ok) writeProtocolStreamError(res, protocol, errorBody)
    else if (!errorSent.has(res) && protocol !== 'anthropic.messages') res.write('data: [DONE]\n\n')
  }
  res.end()
}
