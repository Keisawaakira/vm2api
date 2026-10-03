import type { OfficialCcStatus } from '@/types/panel-vm'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CcNativeTraceReadiness } from './detail-status-board'
import {
  OfficialCcFacts,
  officialCcDiagnostic,
  officialCcErrorHint,
} from './official-cc-card'

describe('runtime diagnostics are actionable without repeating model calls', () => {
  it('explains loading instead of blaming a user key', () => {
    const html = renderToString(
      <CcNativeTraceReadiness
        value={{
          enabled: true,
          raw_enabled: true,
          configured: true,
          state: 'preload_not_observed',
        }}
      />
    )
    expect(html).toContain('尚未看到预载启动记录')
    expect(html).toContain('无需发送模型请求')
    expect(html).toContain('重新应用 CC 修复版并重启 kernel')
  })
  it('a matching process still requires per-request capture evidence', () => {
    const html = renderToString(
      <CcNativeTraceReadiness
        value={{
          enabled: true,
          raw_enabled: true,
          configured: true,
          state: 'ready',
        }}
      />
    )
    expect(html).toContain('原来的 user key')
    expect(html).toContain('native_trace.status')
  })
  it('does not equate hello success with quota success', () => {
    const html = renderToString(
      <OfficialCcFacts
        cc={{ status: 'error', hello_ok: true, usage_ok: false }}
      />
    )
    expect(html).toContain('hello 已完成，额度检查未通过')
    expect(html).not.toContain('额度已探测')
    expect(officialCcErrorHint('usage=failed')).toContain('无需反复运行 hello')
    expect(
      officialCcErrorHint('Missing user:profile scope', 'usage')
    ).toContain('授权权限')
  })
  it('exports reparsed semantic text with honest truncation flags, not a successful new bootstrap', () => {
    const cc: OfficialCcStatus = {
      status: 'error',
      step: 'usage',
      hello_ok: true,
      usage_ok: false,
      usage_diagnostics: {
        source: 'existing_cli_files',
        code: 'usage_output_parsed',
        message: 'historical text parsed',
        cli_exit_code: 0,
        stdout_available: true,
        stderr_available: true,
        stdout_bytes: 4330,
        stderr_bytes: 0,
        truncated: false,
        file_truncated: false,
        limits_present: true,
        stdout_text: 'Current session: 5% used',
        stdout_text_chars: 24,
        stdout_text_truncated: false,
        stdout_excerpt_truncated: false,
      },
    }
    const result = officialCcDiagnostic('vm-01', cc)
    expect(result.status).toBe('error')
    expect(result.usage_ok).toBe(false)
    expect(result.usage_diagnostics?.stdout_text).toBe(
      'Current session: 5% used'
    )
    expect(result.usage_diagnostics?.file_truncated).toBe(false)
    expect(
      officialCcErrorHint(
        'historical text parsed',
        'usage',
        'usage_output_parsed'
      )
    ).toContain('无需')
  })
  it('worker quota diagnostics retain HTTP status without inventing a CLI exit code', () => {
    const cc: OfficialCcStatus = {
      status: 'error',
      step: 'usage',
      hello_ok: true,
      usage_ok: false,
      exit_code: null,
      usage_http_status: 403,
      usage_diagnostics: {
        source: 'existing_slot_worker_result',
        code: 'permission_error',
        message: 'scope missing',
        cli_exit_code: null,
        http_status: 403,
        stdout_available: true,
        stderr_available: false,
        stdout_bytes: 123,
        stderr_bytes: 0,
        truncated: false,
        limits_present: false,
      },
    }
    const result = officialCcDiagnostic('vm-01', cc)
    expect(result.usage_http_status).toBe(403)
    expect(result.usage_diagnostics?.http_status).toBe(403)
    expect(result.usage_diagnostics?.cli_exit_code).toBeNull()
    expect(result.status).toBe('error')
  })
  it('exports diagnostic fields, not arbitrary account/credential metadata', () => {
    const cc: OfficialCcStatus = {
      status: 'error',
      step: 'usage',
      hello_ok: true,
      usage_ok: false,
      access_token: 'NEVER_EXPORT_TOKEN',
      arbitrary: 'NEVER_EXPORT_OTHER',
      usage_diagnostics: {
        source: 'existing_cli_files',
        code: 'scope_error',
        message: 'scope missing',
        cli_exit_code: 1,
        stdout_available: true,
        stderr_available: true,
        stdout_bytes: 100,
        stderr_bytes: 20,
        truncated: false,
        limits_present: false,
      },
    }
    const diagnostic = officialCcDiagnostic('vm-01', cc)
    expect(diagnostic.error).toBe('scope missing')
    expect(diagnostic.hello_ok).toBe(true)
    expect(JSON.stringify(diagnostic)).not.toContain('NEVER_EXPORT')
  })
})
