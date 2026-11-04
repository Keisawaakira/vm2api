import { useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { OfficialCcStatus } from '@/types/panel-vm'
import type { StatusTone } from '@/types/status'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { StatusMark } from '@/components/status-mark'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { vmOfficialCcQueryOptions, vmQueryOptions } from '@/features/vm/queries'

const STEP_LABELS: Record<string, string> = {
  queued: '排队',
  wipe: '清空初装环境',
  refresh: '刷新过期票',
  login: '写入官方登录文件',
  hello: '首次对话 hello',
  usage: '槽内 /usage 额度',
  profile: '读取账号等级与模型',
  seed: '后置覆写播种',
  telemetry: '写入遥测',
  resident: 'hello 后常驻',
  done: '完成',
}

export function officialCcStepLabel(step?: string): string {
  return STEP_LABELS[String(step || '')] || step || '准备'
}

export function officialCcErrorHint(
  err?: string | null,
  step?: string,
  diagnosticCode?: string
): string {
  if (diagnosticCode === 'usage_output_parsed')
    return '保留的历史额度输出已重新解析；无需为这份诊断重跑 hello，下载即可查看实际文本。'
  const s = String(err || '')
  if (!s) return ''
  if (/invalid_grant|refresh token not found|could not be refreshed/i.test(s))
    return '刷新票已失效。请重新换票；若票是新的，可再点一次「执行官方初装」。'
  if (/not logged in|please run \/login/i.test(s))
    return '官方 CLI 未登录。确认换票已写入后，再执行一次官方初装。'
  if (
    step === 'usage' ||
    /\/usage|usage probe|official-cc-usage|usage=fail/i.test(s)
  )
    return /scope|permission|权限/i.test(s)
      ? '额度读取可能缺少授权权限。先下载诊断核对实际 scope；hello 成功不等于额度接口权限完整。'
      : '这是额度检查失败，不等于 hello 失败。先刷新并下载已有初装诊断，无需反复运行 hello。'
  if (/timed out|timeout/i.test(s))
    return '官方对话超时。先检查本次退出信息，再决定是否重试。'
  if (/no live oauth|no_credential|credential/i.test(s))
    return '此槽没有可用 OAuth。先换票，再执行官方初装。'
  if (/already_running/i.test(s)) return '初装已在运行，稍等或刷新进度。'
  if (/disabled/i.test(s))
    return '设置里关闭了换票后自动初装。可在本页手动执行。'
  if (/bridge/i.test(s)) return '槽位 SOCKS5 桥没起来。检查代理后再次执行。'
  return '可在本页再次执行官方初装。'
}

export function officialCcDiagnostic(vmId: string, cc: OfficialCcStatus) {
  const d = cc.usage_diagnostics
  return {
    vm_id: vmId,
    source: 'official_cc_bootstrap_diagnostic',
    claude_version:
      typeof cc.claude_version === 'string' ? cc.claude_version : null,
    started_at: typeof cc.started_at === 'string' ? cc.started_at : null,
    finished_at: typeof cc.finished_at === 'string' ? cc.finished_at : null,
    status: cc.status,
    step: cc.step,
    hello_ok: cc.hello_ok,
    usage_ok: cc.usage_ok,
    usage_attempts: cc.usage_attempts,
    usage_http_status: cc.usage_http_status,
    exit_code: cc.exit_code,
    error: d?.message || cc.error,
    usage_diagnostics: d
      ? {
          source: d.source,
          code: d.code,
          message: d.message,
          cli_exit_code: d.cli_exit_code,
          http_status: d.http_status,
          stdout_available: d.stdout_available,
          stderr_available: d.stderr_available,
          stdout_bytes: d.stdout_bytes,
          stderr_bytes: d.stderr_bytes,
          truncated: d.truncated,
          file_truncated: d.file_truncated,
          limits_present: d.limits_present,
          stdout_text: d.stdout_text,
          stdout_text_chars: d.stdout_text_chars,
          stdout_text_truncated: d.stdout_text_truncated,
          stdout_excerpt_truncated: d.stdout_excerpt_truncated,
          stdout_excerpt: d.stdout_excerpt,
          stderr_excerpt: d.stderr_excerpt,
        }
      : null,
  }
}

function downloadDiagnostic(vmId: string, cc: OfficialCcStatus) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(officialCcDiagnostic(vmId, cc), null, 2)], {
      type: 'application/json',
    })
  )
  const link = document.createElement('a')
  link.href = url
  link.download = `vm2api-${vmId}-official-init-diagnostic.json`
  link.click()
  URL.revokeObjectURL(url)
}

const TRACK: [string, string][] = [
  ['queued', '排队'],
  ['wipe', '清空'],
  ['login', '写入'],
  ['hello', 'hello'],
  ['stats', '额度'],
  ['seed', '播种'],
  ['done', '完成'],
]

function trackIndex(step?: string): number {
  const map: Record<string, number> = {
    queued: 0,
    wipe: 1,
    refresh: 1,
    login: 2,
    hello: 3,
    usage: 4,
    profile: 4,
    seed: 5,
    telemetry: 5,
    resident: 6,
    done: 6,
  }
  const n = map[String(step || '')]
  return n == null ? -1 : n
}

export function OfficialCcTrack({ cc }: { cc: OfficialCcStatus | null }) {
  const st = cc?.status || ''
  const idx = st === 'ok' ? TRACK.length - 1 : trackIndex(cc?.step)
  return (
    <ol className='flex flex-wrap items-center gap-2' aria-label='初装进度'>
      {TRACK.map(([key, label], i) => {
        const on = idx > 0 && i < idx
        const cur =
          st === 'ok' ? i === TRACK.length - 1 : i === Math.max(idx, 0)
        const bad = st === 'error' && cur
        const color = bad
          ? 'var(--status-bad)'
          : on
            ? 'var(--status-ok)'
            : cur
              ? 'var(--status-caution)'
              : 'var(--status-none)'
        return (
          <li key={key} className='inline-flex items-center gap-1 text-[11px]'>
            <span
              aria-hidden='true'
              className='inline-block size-2 rounded-full'
              style={{ background: color }}
            />
            <span
              className={
                cur || on || bad ? 'text-foreground' : 'text-muted-foreground'
              }
            >
              {label}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

export function OfficialCcFacts({ cc }: { cc: OfficialCcStatus | null }) {
  if (!cc) {
    return (
      <p className='text-xs text-muted-foreground'>
        用本槽凭证跑一次官方初装。成功后按设置写入官方身份并开遥测。
      </p>
    )
  }
  const quota =
    cc.hello_ok && (cc.usage_ok || cc.stats_ok)
      ? '额度已探测'
      : cc.hello_ok
        ? 'hello 已完成，额度检查未通过'
        : ''
  const resident = cc.resident_ok ? '常驻中' : cc.resident ? '常驻未拉起' : ''
  const tel =
    cc.telemetry_enabled && cc.telemetry_official
      ? '遥测已对齐'
      : cc.telemetry_enabled
        ? '遥测已写'
        : ''
  const bits = [cc.account_tier, quota, resident, tel].filter(Boolean)
  return (
    <p className='text-xs text-muted-foreground'>
      {bits.length ? bits.join(' · ') : '初装尚未产出探测结果。'}
    </p>
  )
}

function toneOf(status?: string): StatusTone {
  if (status === 'ok') return { key: 'ok', text: '已完成', cls: 'ok' }
  if (status === 'running') return { key: 'warn', text: '进行中', cls: 'warn' }
  if (status === 'error') return { key: 'bad', text: '失败', cls: 'bad' }
  return { key: 'none', text: '未初装', cls: 'none' }
}

/** `blockedReason` 非空时禁用「执行官方初装」并在按钮旁给出原因（如远端节点）。 */
export function OfficialCcCard({
  vmId,
  blockedReason = '',
}: {
  vmId: string
  blockedReason?: string
}) {
  const qc = useQueryClient()
  const queryOptions = vmOfficialCcQueryOptions(vmId)
  const key = queryOptions.queryKey
  const q = useQuery(queryOptions)

  const cc = q.data
  const running = cc?.status === 'running'

  // The poll stopping is the only signal a background job finished — say so.
  const seen = useRef<string>('')
  useEffect(() => {
    const st = cc?.status
    if (!st || st === 'running') {
      if (st === 'running') seen.current = 'running'
      return
    }
    if (seen.current !== 'running') return
    seen.current = st
    if (st === 'ok') {
      toast.success(
        '官方初装完成' +
          (cc?.account_tier ? ` · ${cc.account_tier}` : '') +
          (cc?.telemetry_official ? ' · 遥测已对齐' : '')
      )
    } else if (st === 'error') {
      const message = cc?.usage_diagnostics?.message || cc?.error
      const hint = officialCcErrorHint(
        message,
        cc?.step,
        cc?.usage_diagnostics?.code
      )
      toast.error((message || '官方初装失败') + (hint ? `。${hint}` : ''))
    }
    qc.invalidateQueries({ queryKey: vmQueryOptions(vmId).queryKey })
    qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey })
  }, [cc, qc, vmId])

  const run = useMutation({
    mutationFn: () =>
      api(`/api/panel/vms/${encodeURIComponent(vmId)}/official-cc-bootstrap`, {
        method: 'POST',
        body: JSON.stringify({ force: true, manual: true }),
      }),
    onSuccess: (r) => {
      const d = (r as { scheduled?: boolean; reason?: string }) || {}
      if (d.scheduled === false && d.reason === 'already_initialized') {
        toast.success('此槽已初装过，未再跑官方 CLI')
      } else if (d.scheduled === false && d.reason === 'disabled') {
        toast.info('设置里关闭了换票后自动初装，本次为手动执行')
      } else if (
        d.scheduled === false &&
        d.reason === 'credential_mode_unsupported'
      ) {
        // 与「刷新凭证」的同名 400 语义不同：这里是初装不适用，不是凭证坏了
        toast.info('官方初装只支持完整 OAuth 凭证，此槽不适用')
      } else if (d.scheduled === false && d.reason) {
        toast.info(`官方初装未排队 · ${d.reason}`)
      } else {
        toast.success('已排入官方初装，正在跟踪进度')
      }
      qc.invalidateQueries({ queryKey: key })
    },
    onError: (e: Error) => toast.error(e.message || '官方初装失败'),
  })

  const tone = toneOf(cc?.status)
  const errorMessage = cc?.usage_diagnostics?.message || cc?.error
  const hint =
    cc?.status === 'error'
      ? officialCcErrorHint(errorMessage, cc.step, cc.usage_diagnostics?.code)
      : ''
  const runLabel = running
    ? '初装进行中…'
    : cc?.status === 'error'
      ? '再次执行官方初装'
      : cc?.status === 'ok'
        ? '重新执行官方初装'
        : '执行官方初装'

  return (
    <Card>
      <CardHeader className='pb-2'>
        <CardTitle className='flex items-center gap-2 text-sm'>
          官方 Claude Code 初装
          <StatusMark tone={tone} variant='pill' />
          {running ? (
            <span className='text-xs font-normal text-muted-foreground'>
              {officialCcStepLabel(cc?.step)}
            </span>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className='space-y-3'>
        <OfficialCcTrack cc={cc || null} />
        <div className='flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground'>
          {cc?.account_tier ? <span>{cc.account_tier}</span> : null}
          {cc?.available_models?.length ? (
            <span title={cc.available_models.join('\n')}>
              {cc.available_models.length} 个可用模型
            </span>
          ) : null}
          {cc?.hello_ok && (cc?.usage_ok || cc?.stats_ok) ? (
            <span>额度已探测</span>
          ) : cc?.hello_ok ? (
            <span>hello 已完成</span>
          ) : null}
          {cc?.resident_ok ? (
            <span>
              常驻中{cc.resident_pid ? ` · pid ${cc.resident_pid}` : ''}
            </span>
          ) : cc?.resident ? (
            <StatusMark
              tone={{ key: 'warn', text: '常驻未拉起', cls: 'warn' }}
            />
          ) : null}
          {cc?.telemetry_enabled && cc?.telemetry_official ? (
            <span>遥测已对齐</span>
          ) : cc?.telemetry_enabled ? (
            <span>遥测已写</span>
          ) : null}
          {!cc ? (
            <span>
              用本槽凭证跑一次官方初装。成功后按设置写入官方身份并开遥测。
            </span>
          ) : null}
        </div>

        {errorMessage ? (
          <div className='space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs'>
            <div>
              <span className='font-medium'>错误</span> ·{' '}
              <span className='font-mono break-all'>{errorMessage}</span>
            </div>
            {hint ? <div className='text-muted-foreground'>{hint}</div> : null}
          </div>
        ) : null}

        <div className='flex flex-wrap items-center gap-2'>
          {cc ? (
            <Button
              size='sm'
              variant='outline'
              disabled={running}
              onClick={() => downloadDiagnostic(vmId, cc)}
            >
              下载初装诊断
            </Button>
          ) : null}
          <Button
            size='sm'
            variant={cc?.status === 'error' ? 'default' : 'outline'}
            disabled={running || run.isPending || !!blockedReason}
            onClick={() => run.mutate()}
          >
            {run.isPending ? '提交中…' : runLabel}
          </Button>
          <Button
            size='sm'
            variant='ghost'
            disabled={running || q.isFetching}
            onClick={() => q.refetch()}
          >
            {running
              ? '每 2.5s 自动刷新'
              : q.isFetching
                ? '读取中…'
                : '刷新进度'}
          </Button>
          {blockedReason ? (
            <span className='text-xs text-muted-foreground'>
              {blockedReason}
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}
