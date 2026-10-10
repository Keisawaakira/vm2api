import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCCNativeTrace } from '../../src/lib/transport/cc-native-trace.mjs'
import { CC_TRACE_KEY, CC_TRACE_VERSION } from '../../src/lib/transport/cc-native-trace-hook.mjs'
const id = 'a'.repeat(64)
const request = { model: 'fixture', system: [], messages: [], metadata: { user_id: 'fixture' } }
const encode = (rows) => rows.map((row) => JSON.stringify(row) + '\n').join('')
const sequence = (rows) => rows.map((row, n) => ({ ...row, n: n + 1 }))
function fixture() {
  return sequence([
    { type: 'trace_start', version: CC_TRACE_VERSION, id, job_id: 'job', slot_id: 'slot', runtime: {} },
    {
      type: 'native_input',
      text: JSON.stringify({
        type: 'kin_job_start',
        job_id: 'job',
        slot_id: 'slot',
        request: { ...request, metadata: { ...request.metadata, [CC_TRACE_KEY]: id } },
      }),
    },
    { type: 'native_request_cleaned', request },
    {
      type: 'api_request',
      api: 1,
      transport: 'fixture',
      method: 'POST',
      url: 'http://fixture/v1/messages',
      headers: {},
    },
    { type: 'api_request_body', api: 1, bytes: 2, b64: Buffer.from('{}').toString('base64') },
    { type: 'api_response', api: 1, status: 200, headers: {} },
    { type: 'api_response_body', api: 1, bytes: 2, b64: Buffer.from('ok').toString('base64') },
    { type: 'api_end', api: 1, complete: true },
    { type: 'native_stdout', text: JSON.stringify({ type: 'kin_job_done', job_id: 'job', slot_id: 'slot' }) + '\n' },
    { type: 'native_terminal', reason: 'kin_job_done' },
    { type: 'trace_end', id, api_calls: 1, dropped_records: 0, pending_responses: 0, producer_error: false },
  ])
}
const parse = (rows) => parseCCNativeTrace(encode(rows), { id, done: true })

test('a complete native evidence fixture is accepted', () => assert.equal(parse(fixture()).status, 'captured'))
test('modern native wire names are accepted without rewriting saved input or stdout', () => {
  const rows = fixture()
  for (const row of rows) {
    if (row.type === 'native_input' || row.type === 'native_stdout') {
      const frame = JSON.parse(row.text)
      frame.type = frame.type.replace(/^kin_/, '')
      row.text = JSON.stringify(frame)
    }
    if (row.type === 'native_terminal') row.reason = 'job_done'
  }
  const result = parse(rows)
  assert.equal(result.status, 'captured', JSON.stringify(result.evidence_issues))
  assert.equal(result.lifecycle.find((row) => row.type === 'native_terminal').reason, 'job_done')
  assert.notEqual(
    parse(rows.map((row) => (row.type === 'native_terminal' ? { ...row, reason: 'job_error' } : row))).status,
    'captured',
  )
})
test('missing native input/stdout/lifecycle is not complete even with contiguous numbering', () => {
  const rows = sequence(
    fixture().filter(
      (row) => !['native_input', 'native_request_cleaned', 'native_stdout', 'native_terminal'].includes(row.type),
    ),
  )
  assert.notEqual(parse(rows).status, 'captured')
})
test('response metadata cannot be absent from successfully complete evidence', () => {
  const rows = sequence(fixture().filter((row) => row.type !== 'api_response'))
  const report = parse(rows)
  assert.notEqual(report.status, 'captured')
  assert.ok(report.evidence_issues.includes('api_response_missing'))
  assert.equal(report.http_exchanges[0].response.body.text, 'ok')
})
test('pre-response transport failure stays partial and retains its error', () => {
  const rows = fixture().filter((row) => !['api_response', 'api_response_body'].includes(row.type))
  rows.find((row) => row.type === 'api_end').complete = false
  rows.splice(5, 0, { type: 'api_error', api: 1, code: 'ECONNRESET' })
  const report = parse(sequence(rows))
  assert.notEqual(report.status, 'captured')
  assert.equal(report.http_exchanges[0].error_code, 'ECONNRESET')
})
test('duplicate sequence cannot duplicate captured response bytes', () => {
  const rows = fixture()
  rows.splice(7, 0, { ...rows[6] })
  const report = parse(rows)
  assert.notEqual(report.status, 'captured')
  assert.equal(report.http_exchanges[0].response.body.text, 'ok')
})
test('claimed API count must reconcile with captured exchanges', () => {
  const rows = fixture()
  rows.at(-1).api_calls = 2
  assert.notEqual(parse(rows).status, 'captured')
})
test('duplicate API identities cannot replace prior evidence', () => {
  const rows = fixture()
  rows.splice(4, 0, { ...rows[3], url: 'http://replacement.invalid/v1/messages' })
  const report = parse(sequence(rows))
  assert.notEqual(report.status, 'captured')
  assert.equal(report.http_exchanges[0].request.url, 'http://fixture/v1/messages')
})
test('input nonce or terminal mismatch is not certified', () => {
  const rows = fixture()
  rows[1].text = rows[1].text.replace(id, 'b'.repeat(64))
  assert.notEqual(parse(rows).status, 'captured')
  const wrongEnd = fixture()
  wrongEnd.find((row) => row.type === 'native_terminal').reason = 'kin_job_error'
  assert.notEqual(parse(wrongEnd).status, 'captured')
})
test('zero-API early native failure remains a legitimate complete error observation', () => {
  const rows = fixture().filter((row) => !row.type.startsWith('api_'))
  rows.find((row) => row.type === 'native_stdout').text =
    JSON.stringify({ type: 'kin_job_error', job_id: 'job', slot_id: 'slot', error: 'early fixture failure' }) + '\n'
  rows.find((row) => row.type === 'native_terminal').reason = 'kin_job_error'
  rows.at(-1).api_calls = 0
  assert.equal(parse(sequence(rows)).status, 'captured')
})
