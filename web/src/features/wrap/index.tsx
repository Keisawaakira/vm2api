import { useMemo, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { VIEW_TITLES } from '@/config/nav'
import type { Vm } from '@/types/panel-vm'
import type { StatusTone } from '@/types/status'
import { toast } from 'sonner'
import { fmtBytes } from '@/lib/format'
import { cn } from '@/lib/utils'
import { isCodexVm } from '@/lib/vm-kind'
import { wrapSyncKernelFails } from '@/lib/wrap-health'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { CircularProgress } from '@/components/ui/circular-progress'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { CardGridSkeleton } from '@/components/page-skeletons'
import { QueryGate } from '@/components/query-gate'
import { StatusMark } from '@/components/status-mark'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { dataplaneLabel } from '@/features/vm/dataplane-contract'
import {
  inferenceEngineLabel,
  normalizeInferenceEngine,
} from '@/features/vm/engine-contract'
import {
  KernelPipeline,
  type Station,
  type StationId,
} from '@/features/wrap/kernel-pipeline'
import {
  installReleaseKernel,
  makeWrapSample,
  promoteWrapSample,
  setKernelDataplane,
  syncWrapSample,
  uploadCragKernelBinary,
  uploadKernelBinary,
  wrapSampleQueryOptions,
  type WrapKernelPayload,
  type WrapSample,
  type WrapSyncReport,
} from '@/features/wrap/queries'

const MAX_KERNEL_UPLOAD_BYTES = 32 * 1024 * 1024

const TONE_OK: StatusTone = { key: 'ok', cls: 'ok', text: '就绪' }
const TONE_NONE: StatusTone = { key: 'none', cls: 'none', text: '未知' }

function sampleDirLabel(dir?: string) {
  if (!dir) return 'share/wrap-cli'
  const parts = dir.replace(/\\/g, '/').split('/')
  const i = parts.lastIndexOf('share')
  if (i >= 0) return parts.slice(i).join('/')
  return parts.slice(-2).join('/')
}

function kernelPathLabel(p?: string) {
  if (!p) return '—'
  const parts = p.replace(/\\/g, '/').split('/')
  const i = Math.max(
    parts.lastIndexOf('bin'),
    parts.lastIndexOf('wrap-cli'),
    parts.lastIndexOf('crag')
  )
  if (i >= 0) return parts.slice(i).join('/')
  return parts.slice(-2).join('/')
}

function osOf(vm: Vm) {
  const runtime = vm.runtime && typeof vm.runtime === 'object' ? vm.runtime : {}
  const os = String(runtime.os || runtime.image || vm.kernel || '').trim()
  return os || '—'
}

function engineOf(vm: Vm) {
  return vm.resolved_inference_engine || vm.inference_engine || 'auto'
}

function selectedDataplane(
  value: string | null | undefined
): 'wrap' | 'cc' | 'crag' {
  return value === 'cc' || value === 'crag' ? value : 'wrap'
}

function dataplaneOf(vm: Vm): 'wrap' | 'cc' | 'crag' | '—' {
  if (isCodexVm(vm)) return '—'
  return selectedDataplane(vm.resolved_dataplane)
}

function DataplaneOption({
  value,
  title,
  desc,
  current,
  disabled,
  children,
}: {
  value: 'wrap' | 'cc' | 'crag'
  title: string
  desc: string
  current: boolean
  disabled?: boolean
  children?: ReactNode
}) {
  return (
    <div
      className={cn(
        'rounded-lg border border-border/60 transition-colors',
        current && 'border-primary/50 bg-primary/5',
        disabled && 'opacity-60'
      )}
    >
      <Label
        className={cn(
          'flex items-start gap-3 p-4 font-normal',
          disabled ? 'cursor-not-allowed' : 'cursor-pointer'
        )}
      >
        <RadioGroupItem value={value} className='mt-0.5' disabled={disabled} />
        <span className='min-w-0 flex-1 space-y-2'>
          <span className='flex items-center justify-between gap-2'>
            <span className='text-sm leading-none font-medium'>{title}</span>
            {current ? (
              <span className='text-xs text-muted-foreground'>当前</span>
            ) : null}
          </span>
          <span className='block text-xs leading-snug text-muted-foreground'>
            {desc}
          </span>
        </span>
      </Label>
      <div className='space-y-3 px-4 pb-4'>{children}</div>
    </div>
  )
}

type HopJob = {
  phase: 'download' | 'slots' | 'done'
  done: number
  total: number
  current: string
  failed: string[]
}

function hopProgressValue(job: HopJob) {
  if (job.phase === 'download') return 8
  if (!job.total) return 0
  return Math.round((job.done / job.total) * 100)
}

function slotSyncFailed(report: WrapSyncReport, id: string) {
  const item = report.items?.find((row) => row.id === id) || report.items?.[0]
  if (!item) return report.ok === false
  if (item.ok === false) return true
  return item.kernel?.ok === false
}

function mergeSyncReports(
  prev: WrapSyncReport | null,
  next: WrapSyncReport
): WrapSyncReport {
  const map = new Map<string, NonNullable<WrapSyncReport['items']>[number]>()
  for (const item of prev?.items || []) {
    if (item?.id) map.set(item.id, item)
  }
  for (const item of next.items || []) {
    if (item?.id) map.set(item.id, item)
  }
  const items = Array.from(map.values())
  const okCount = items.filter(
    (item) => item?.ok !== false && item?.kernel?.ok !== false
  ).length
  return {
    ...prev,
    ...next,
    items,
    total: Math.max(next.total ?? 0, prev?.total ?? 0, items.length),
    ok_count: okCount,
    failed_count: items.filter(
      (item) => item?.ok === false || item?.kernel?.ok === false
    ).length,
  }
}

/** 上一次同步里这台槽的结果。没跑过同步就没有状态，不假装成功。 */
function slotSyncTone(
  item?: NonNullable<WrapSyncReport['items']>[number]
): StatusTone | null {
  if (!item) return null
  if (item.ok === false)
    return { key: 'bad', cls: 'bad', text: item.error || '同步失败' }
  if (item.kernel?.ok === false)
    return { key: 'warn', cls: 'warn', text: '文件已写，进程未起' }
  if (item.kernel?.skipped)
    return { key: 'off', cls: 'off', text: '已写文件（未重启）' }
  return { key: 'ok', cls: 'ok', text: '已重装' }
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className='flex items-center justify-between gap-2 text-sm'>
      <span className='text-muted-foreground'>{label}</span>
      {children}
    </div>
  )
}

function HopProgress({ job }: { job: HopJob }) {
  const label =
    job.phase === 'download'
      ? '拉取 GitHub wrap kernel、cli-node、cc-node 和 crag kernel'
      : job.phase === 'done'
        ? job.failed.length
          ? `内核重装结束，失败 ${job.failed.length}`
          : `最新内核已重装 ${job.done}/${job.total}`
        : `正在按当前数据面换 ${job.current || '槽'} 的内核`
  return (
    <div className='space-y-1.5'>
      <div className='flex items-center justify-between gap-3 text-xs text-muted-foreground'>
        <span>{label}</span>
        <span>
          {job.phase === 'download' ? '下载中' : `${job.done}/${job.total}`}
        </span>
      </div>
      <Progress
        value={hopProgressValue(job)}
        className='h-2'
        indicatorClassName={job.phase === 'done' ? undefined : 'animate-pulse'}
      />
      {job.failed.length ? (
        <p className='text-xs text-destructive'>
          失败：{job.failed.join('、')}
        </p>
      ) : null}
    </div>
  )
}

function Flag({ ok, label }: { ok?: boolean; label: string }) {
  return (
    <Row label={label}>
      <StatusMark
        tone={
          ok
            ? { key: 'ok', cls: 'ok', text: '有' }
            : { key: 'bad', cls: 'bad', text: '缺' }
        }
      />
    </Row>
  )
}

function KernelPayload({
  payload,
  kind = 'kernel',
}: {
  payload?: WrapKernelPayload | null
  kind?: 'kernel' | 'cli'
}) {
  const label =
    payload?.source === 'configured'
      ? '仓内最新 kernel'
      : payload?.source === 'sample'
        ? kind === 'cli'
          ? '仓内 CLI'
          : '母样本 kernel'
        : kind === 'cli'
          ? '未找到 CLI'
          : '未找到 kernel'
  return (
    <div className='space-y-2 text-sm'>
      <Row label='来源'>
        <span className='font-medium'>{label}</span>
      </Row>
      <Row label='文件'>
        <code className='text-xs'>{kernelPathLabel(payload?.path)}</code>
      </Row>
      <Row label='大小'>
        <span className='font-mono text-xs'>
          {payload?.size ? fmtBytes(payload.size) : '—'}
        </span>
      </Row>
      <Row label='mtime'>
        <span className='font-mono text-xs'>{payload?.mtime || '—'}</span>
      </Row>
    </div>
  )
}

function buildStations(
  data: WrapSample | undefined,
  slots: number,
  synced: number
): Station[] {
  const kernelSource = data?.kernel?.source
  const sampleOk = !!(data?.kernel_bin && data?.wrapper)
  const repoPayloads = [data?.kernel, data?.cli_node, data?.cc_node, data?.crag]
  const repoReady = repoPayloads.some((payload) => Boolean(payload?.size))
  return [
    {
      id: 'image',
      label: '镜像',
      caption: 'bin/ · share/wrap-cli',
      tone: { key: 'ok', cls: 'ok', text: '入口写入' },
    },
    {
      id: 'repo',
      label: '仓内二进制',
      caption: kernelPathLabel(data?.kernel?.path || data?.cli_node?.path),
      tone:
        kernelSource === 'missing' || (!kernelSource && !repoReady)
          ? { key: 'bad', cls: 'bad', text: '缺二进制' }
          : kernelSource === 'sample'
            ? { key: 'warn', cls: 'warn', text: '回落母样本' }
            : TONE_OK,
    },
    {
      id: 'sample',
      label: '母样本',
      caption: sampleDirLabel(data?.dir),
      tone: data?.ok
        ? TONE_OK
        : sampleOk
          ? { key: 'warn', cls: 'warn', text: '缺 shim' }
          : { key: 'bad', cls: 'bad', text: '不完整' },
    },
    {
      id: 'slots',
      label: '槽内 CLI',
      caption: slots ? `${slots} 个槽位` : '还没有槽位',
      tone: !slots
        ? { key: 'none', cls: 'none', text: '无槽位' }
        : synced === 0
          ? TONE_NONE
          : synced >= slots
            ? { key: 'ok', cls: 'ok', text: '本次全部重装' }
            : {
                key: 'caution',
                cls: 'caution',
                text: `本次 ${synced}/${slots}`,
              },
    },
  ]
}

export function WrapSamplePage() {
  const qc = useQueryClient()
  const sample = useQuery(wrapSampleQueryOptions())
  const dash = useQuery(dashboardQueryOptions())
  const vms = useMemo<Vm[]>(() => dash.data?.vms || [], [dash.data])
  const [restart, setRestart] = useState(true)
  const [selected, setSelected] = useState<string[]>([])
  const [pendingDataplane, setPendingDataplane] = useState<
    'wrap' | 'cc' | 'crag' | null
  >(null)
  const [promoteId, setPromoteId] = useState<string | null>(null)
  const [makeOpen, setMakeOpen] = useState(false)
  const [glibcVm, setGlibcVm] = useState('')
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [releaseOpen, setReleaseOpen] = useState(false)
  const [hopOpen, setHopOpen] = useState(false)
  const [hopIds, setHopIds] = useState<string[]>([])
  const [pullLatest, setPullLatest] = useState(true)
  const [hopJob, setHopJob] = useState<HopJob | null>(null)
  const [hopBusy, setHopBusy] = useState(false)
  const [station, setStation] = useState<StationId>('repo')
  const [lastSync, setLastSync] = useState<WrapSyncReport | null>(null)
  const hopToken = useRef(0)
  const fileRef = useRef<HTMLInputElement>(null)

  const rustVms = useMemo(
    () => vms.filter((vm) => engineOf(vm) === 'rust'),
    [vms]
  )
  const reinstallIds = selected.length ? selected : vms.map((vm) => vm.id)

  const syncById = useMemo(() => {
    const map = new Map<string, NonNullable<WrapSyncReport['items']>[number]>()
    for (const item of lastSync?.items || []) {
      if (item?.id) map.set(item.id, item)
    }
    return map
  }, [lastSync])

  const syncedOk = useMemo(
    () =>
      (lastSync?.items || []).filter(
        (item) => item?.ok !== false && item?.kernel?.ok !== false
      ).length,
    [lastSync]
  )

  const invalidate = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: wrapSampleQueryOptions().queryKey }),
      qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
    ])
  }

  const openHop = (ids: string[], pull: boolean) => {
    setHopIds(ids)
    setPullLatest(pull)
    setHopOpen(true)
  }

  const runHop = async (ids: string[], pull: boolean) => {
    if (!ids.length || hopBusy) return
    const token = hopToken.current + 1
    hopToken.current = token
    const alive = () => hopToken.current === token
    setHopBusy(true)
    setHopJob({
      phase: pull ? 'download' : 'slots',
      done: 0,
      total: ids.length,
      current: ids[0] || '',
      failed: [],
    })
    const failed: string[] = []
    try {
      if (pull) {
        await installReleaseKernel({ ids: [], restart: false })
        if (!alive()) return
      }
      for (let i = 0; i < ids.length; i++) {
        if (!alive()) return
        const id = ids[i]
        setHopJob({
          phase: 'slots',
          done: i,
          total: ids.length,
          current: id,
          failed: [...failed],
        })
        try {
          const report = await syncWrapSample({ ids: [id], restart })
          if (alive()) setLastSync((cur) => mergeSyncReports(cur, report))
          if (slotSyncFailed(report, id)) failed.push(id)
        } catch {
          failed.push(id)
        }
      }
      if (!alive()) return
      setHopJob({
        phase: 'done',
        done: ids.length,
        total: ids.length,
        current: '',
        failed: [...failed],
      })
      if (failed.length) {
        toast.error(`内核重装 ${ids.length - failed.length}/${ids.length}`)
      } else {
        toast.success(`内核重装 ${ids.length}/${ids.length}`)
      }
      setStation('slots')
      await invalidate()
    } catch (error) {
      if (!alive()) return
      toast.error(error instanceof Error ? error.message : '内核重装失败')
      setHopJob((cur) =>
        cur
          ? { ...cur, phase: 'done', failed: failed.length ? failed : ['下载'] }
          : cur
      )
    } finally {
      if (alive()) setHopBusy(false)
    }
  }

  const promote = useMutation({
    mutationFn: (id: string) => promoteWrapSample(id),
    onSuccess: async (_data, id) => {
      toast.success(`已把 ${id} 收成母本`)
      setPromoteId(null)
      await invalidate()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const make = useMutation({
    mutationFn: () => makeWrapSample({ glibc_vm: glibcVm || undefined }),
    onSuccess: async () => {
      toast.success('已重整 wrap 文件')
      setMakeOpen(false)
      await invalidate()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const upload = useMutation({
    mutationFn: (file: File) => uploadKernelBinary(file),
    onSuccess: async () => {
      toast.success('已写入仓内 wrap kernel。再重装铺到槽')
      setUploadFile(null)
      await invalidate()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const releaseUpdate = useMutation({
    mutationFn: () => installReleaseKernel({ ids: [], restart: false }),
    onSuccess: async (result) => {
      setReleaseOpen(false)
      const tag = result.release?.tag || 'Release'
      const cli = result.release?.cli_node_size
        ? `，cli-node ${fmtBytes(result.release.cli_node_size)}`
        : ''
      const cc = result.release?.cc_node_size
        ? `，cc-node ${fmtBytes(result.release.cc_node_size)}`
        : ''
      const crag = result.release?.crag_size
        ? `，crag ${fmtBytes(result.release.crag_size)}`
        : ''
      toast.success(`已下载 ${tag}${cli}${cc}${crag}。尚未铺到槽`)
      await invalidate()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const dataplane = useMutation({
    mutationFn: (next: 'wrap' | 'cc' | 'crag') => {
      const ids = selected.filter((id) => {
        const vm = vms.find((item) => item.id === id)
        return Boolean(vm && !isCodexVm(vm))
      })
      if (selected.length && !ids.length) {
        return Promise.reject(
          new Error('所选槽都是 Codex，Claude 内核切不到它们')
        )
      }
      return setKernelDataplane({
        dataplane: next,
        ids: ids.length ? ids : undefined,
        all: ids.length === 0,
        restart,
      })
    },
    onSuccess: async (report, next) => {
      setPendingDataplane(null)
      setLastSync(report)
      setStation('slots')
      const failed = Number(report.failed_count || 0)
      if (failed) {
        toast.error(
          `已切 ${next}，${report.ok_count || 0}/${report.total || 0} 槽成功`
        )
      } else {
        toast.success(
          next === 'crag'
            ? '已切换到 crag + cc-node'
            : next === 'cc'
              ? '已切换到 cc-node + kernel'
              : '已切换到 cli-node + kernel'
        )
      }
      await invalidate()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const uploadCrag = useMutation({
    mutationFn: (file: File) => uploadCragKernelBinary(file),
    onSuccess: async () => {
      toast.success('已写入 Crag kernel。再点切换铺到槽')
      await invalidate()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const cragFileRef = useRef<HTMLInputElement>(null)

  const toggle = (id: string, on: boolean) => {
    setSelected((cur) =>
      on ? Array.from(new Set([...cur, id])) : cur.filter((x) => x !== id)
    )
  }

  const pickKernelFile = (file?: File) => {
    if (!file) return
    if (file.size > MAX_KERNEL_UPLOAD_BYTES) {
      toast.error('kernel 不能超过 32MB')
      return
    }
    if (!file.size) {
      toast.error('kernel 文件为空')
      return
    }
    setUploadFile(file)
  }

  const data = sample.data
  const complete = data?.ok === true
  const busy =
    dataplane.isPending ||
    releaseUpdate.isPending ||
    upload.isPending ||
    uploadCrag.isPending ||
    make.isPending ||
    hopBusy
  const stations = buildStations(data, vms.length, syncedOk)

  return (
    <PageHeader
      title={VIEW_TITLES.wrap}
      extra={
        <div className='flex flex-wrap gap-2'>
          <input
            ref={fileRef}
            type='file'
            className='hidden'
            onChange={(event) => {
              pickKernelFile(event.target.files?.[0])
              event.target.value = ''
            }}
          />
          <Button
            size='sm'
            variant='outline'
            disabled={releaseUpdate.isPending || hopBusy}
            loading={releaseUpdate.isPending}
            onClick={() => setReleaseOpen(true)}
          >
            拉取 wrap/crag
          </Button>
          <Button
            size='sm'
            variant='outline'
            disabled={upload.isPending || hopBusy}
            loading={upload.isPending}
            onClick={() => fileRef.current?.click()}
          >
            本地上传
          </Button>
          <Button
            size='sm'
            variant='outline'
            disabled={make.isPending || hopBusy}
            loading={make.isPending}
            onClick={() => setMakeOpen(true)}
          >
            重整母本
          </Button>
          <Button
            size='sm'
            disabled={!complete || !reinstallIds.length || hopBusy}
            loading={hopBusy && hopIds.length !== 1}
            onClick={() => openHop(reinstallIds, true)}
          >
            {selected.length
              ? `重装当前内核 ${selected.length}`
              : '重装当前内核'}
          </Button>
        </div>
      }
    >
      <QueryGate
        loading={sample.isLoading || dash.isLoading}
        error={sample.error || dash.error}
        skeleton={
          <CardGridSkeleton cards={2} className='grid gap-4 lg:grid-cols-2' />
        }
      >
        <p className='mb-4 max-w-3xl text-sm leading-relaxed text-muted-foreground'>
          kernel 顺着这条链路走：镜像 → 仓内二进制 → 母样本 → 槽内
          CLI。三种数据面都在同一条管线里切换：默认{' '}
          <code>cli-node + kernel</code>，<code>cc-node + kernel</code> 用同一份
          wrap kernel，<code>crag + cc-node</code> 用 crag kernel。Codex
          槽会过滤，不改凭证、不删容器。
        </p>

        <KernelPipeline
          stations={stations}
          active={station}
          onSelect={setStation}
          busy={busy}
          trailing={
            <>
              <CircularProgress
                value={syncedOk}
                max={vms.length || 1}
                size={52}
                label='本次'
                showPercentage={false}
              />
              <div className='min-w-0 text-xs'>
                <p className='font-medium'>
                  {lastSync
                    ? `本次重装 ${syncedOk}/${lastSync.total ?? vms.length}`
                    : '本次还没重装'}
                </p>
                <p className='text-muted-foreground'>
                  {lastSync
                    ? '结果见下方槽位表的「上次结果」列'
                    : '选槽后点右上角重装，结果会写回表里'}
                </p>
              </div>
            </>
          }
        />

        <Card className='mt-4'>
          <CardHeader>
            <CardTitle>
              {station === 'image'
                ? '镜像 — 二进制从哪来'
                : station === 'repo'
                  ? '仓内二进制 — wrap / cc / crag'
                  : station === 'sample'
                    ? '母样本 — 制作与提升'
                    : '槽内 CLI — 同步与重装'}
            </CardTitle>
          </CardHeader>
          <CardContent className='text-sm'>
            {station === 'image' ? (
              <div className='grid gap-3 leading-relaxed text-muted-foreground lg:grid-cols-2'>
                <div className='space-y-2'>
                  <p>
                    镜像安装（<code>docker compose pull</code>）下，
                    <code>bin/kin-*</code> 与 <code>share/wrap-cli</code>
                    由镜像入口在每次启动时写入挂载目录；源码模式则用仓内构建产物。
                  </p>
                  <p>
                    下面展示的路径都是<b>控制面容器内</b>
                    路径；宿主上的真实位置由安装目录决定，不再固定{' '}
                    <code>/opt/vm2api</code>。
                  </p>
                </div>
                <div className='space-y-2 border-l-2 border-[color:var(--status-caution)] pl-3'>
                  <p className='font-medium text-foreground'>
                    升级会覆盖你上传的 kernel
                  </p>
                  <p>
                    「本地上传」改的是挂载目录里的文件。下次{' '}
                    <code>compose pull</code>{' '}
                    升级后，入口会用新镜像里的版本覆盖它。要长期固定自编
                    kernel，把它打进镜像或升级后重新上传并重装槽位。
                  </p>
                </div>
              </div>
            ) : null}

            {station === 'repo' ? (
              <div className='space-y-4'>
                {data?.meta?.release_tag ? (
                  <div className='rounded-md border bg-muted/30 p-3'>
                    <Row label='GitHub Release'>
                      <span className='font-mono text-xs'>
                        {data.meta.release_tag}
                      </span>
                    </Row>
                  </div>
                ) : null}
                <RadioGroup
                  value={selectedDataplane(data?.dataplane)}
                  onValueChange={(value) => {
                    if (value !== 'wrap' && value !== 'cc' && value !== 'crag')
                      return
                    if (value === selectedDataplane(data?.dataplane)) return
                    setPendingDataplane(value)
                  }}
                  disabled={dataplane.isPending || hopBusy}
                  className='grid gap-3 lg:grid-cols-3'
                >
                  <DataplaneOption
                    value='wrap'
                    title='cli-node + kernel'
                    desc='默认。patched cli-node，一进程 20 native 槽。kernel.json.claude_bin 指向仓内 cli-node。'
                    current={
                      data?.dataplane !== 'cc' && data?.dataplane !== 'crag'
                    }
                    disabled={!data?.ok}
                  >
                    <KernelPayload payload={data?.kernel} />
                    <div className='pt-1 text-xs font-medium text-muted-foreground'>
                      cli-node
                    </div>
                    <KernelPayload payload={data?.cli_node} kind='cli' />
                    <Flag ok={Boolean(data?.cli_node?.size)} label='cli-node' />
                    <Flag ok={data?.kernel_bin} label='kernel.bin' />
                  </DataplaneOption>
                  <DataplaneOption
                    value='cc'
                    title='cc-node + kernel'
                    desc='同一份 wrap kernel。claude_bin 指向仓内 cc-node。'
                    current={data?.dataplane === 'cc'}
                    disabled={!data?.cc_node?.size}
                  >
                    <KernelPayload payload={data?.kernel} />
                    <div className='pt-1 text-xs font-medium text-muted-foreground'>
                      cc-node
                    </div>
                    <KernelPayload payload={data?.cc_node} kind='cli' />
                    <Flag ok={Boolean(data?.cc_node?.size)} label='cc-node' />
                    <Flag ok={data?.kernel_bin} label='kernel.bin' />
                  </DataplaneOption>
                  <DataplaneOption
                    value='crag'
                    title='crag + cc-node'
                    desc='crag kernel，一进程多槽。claude_bin 指向仓内 cc-node。'
                    current={data?.dataplane === 'crag'}
                    disabled={!data?.crag?.ok || !data?.cc_node?.size}
                  >
                    <KernelPayload payload={data?.crag || undefined} />
                    <Flag
                      ok={Boolean(data?.crag?.ok)}
                      label='share/crag/kin-kernel'
                    />
                    <Flag ok={Boolean(data?.cc_node?.size)} label='cc-node' />
                    <input
                      ref={cragFileRef}
                      type='file'
                      className='hidden'
                      onChange={(event) => {
                        const file = event.target.files?.[0]
                        event.target.value = ''
                        if (!file) return
                        if (file.size > MAX_KERNEL_UPLOAD_BYTES) {
                          toast.error('kernel 不能超过 32MB')
                          return
                        }
                        uploadCrag.mutate(file)
                      }}
                    />
                    <Button
                      size='sm'
                      variant='outline'
                      disabled={uploadCrag.isPending || hopBusy}
                      loading={uploadCrag.isPending}
                      onClick={(event) => {
                        event.preventDefault()
                        cragFileRef.current?.click()
                      }}
                    >
                      上传 Crag ELF
                    </Button>
                  </DataplaneOption>
                </RadioGroup>
                <div className='flex flex-wrap items-center gap-2'>
                  <Button
                    size='sm'
                    variant='outline'
                    disabled={releaseUpdate.isPending || hopBusy}
                    loading={releaseUpdate.isPending}
                    onClick={() => setReleaseOpen(true)}
                  >
                    拉取 wrap/crag
                  </Button>
                  <Button
                    size='sm'
                    variant='outline'
                    disabled={upload.isPending || hopBusy}
                    loading={upload.isPending}
                    onClick={() => fileRef.current?.click()}
                  >
                    本地上传 wrap kernel
                  </Button>
                  <p className='text-xs leading-relaxed text-muted-foreground'>
                    拉取只更新仓内 linux amd64 wrap kernel、cli-node、cc-node 与
                    crag kernel；本地上传只覆盖 wrap
                    kernel，槽位要再重装才生效。
                  </p>
                </div>
              </div>
            ) : null}

            {station === 'sample' ? (
              <div className='grid gap-4 lg:grid-cols-2'>
                <div className='space-y-2 rounded-md border bg-muted/40 p-3'>
                  <Row label='目录'>
                    <code className='text-xs'>{sampleDirLabel(data?.dir)}</code>
                  </Row>
                  <Flag ok={data?.kernel_bin} label='kernel.bin' />
                  <Flag ok={data?.wrapper} label='kernel wrapper' />
                  <Flag ok={data?.glibc_shim} label='glibc 2.39 shim' />
                </div>
                <div className='space-y-3 leading-relaxed text-muted-foreground'>
                  <p>
                    重整母本会用当前 <code>share/wrap-cli</code> 里的 cli-node
                    补 wrapper / shim，并叠上仓内最新
                    kernel。晋升母本从槽内收回已跑通的 cli-node，不复制凭证或
                    SOCKS。
                  </p>
                  <label className='flex cursor-pointer items-center gap-2 text-foreground'>
                    <Checkbox
                      checked={restart}
                      onCheckedChange={(v) => setRestart(v === true)}
                    />
                    <span>
                      切换或同步后重启 rust kernel，让槽用上对应二进制
                    </span>
                  </label>
                  <Button
                    size='sm'
                    variant='outline'
                    disabled={make.isPending || hopBusy}
                    loading={make.isPending}
                    onClick={() => setMakeOpen(true)}
                  >
                    重整母本
                  </Button>
                </div>
              </div>
            ) : null}

            {station === 'slots' ? (
              <div className='space-y-3 leading-relaxed text-muted-foreground'>
                <p>
                  按各槽当前数据面铺内核：cli-node + kernel、cc-node +
                  kernel，或 crag + cc-node。可先从 GitHub Release 拉 linux
                  amd64 文件。不改凭证、不改 SOCKS、不删容器。
                </p>
                <div className='flex flex-wrap items-center gap-2'>
                  <Button
                    size='sm'
                    disabled={!complete || vms.length === 0 || hopBusy}
                    loading={hopBusy && hopIds.length > 1}
                    onClick={() =>
                      openHop(
                        vms.map((vm) => vm.id),
                        true
                      )
                    }
                  >
                    一键全部重装最新内核
                  </Button>
                  <Button
                    size='sm'
                    variant='outline'
                    disabled={!complete || !reinstallIds.length || hopBusy}
                    loading={hopBusy && hopIds.length !== 1}
                    onClick={() => openHop(reinstallIds, false)}
                  >
                    {selected.length
                      ? `重装所选 ${selected.length} 槽`
                      : '重装全部当前内核'}
                  </Button>
                  <label className='flex cursor-pointer items-center gap-2 text-foreground'>
                    <Checkbox
                      checked={restart}
                      onCheckedChange={(v) => setRestart(v === true)}
                    />
                    <span>重启 rust kernel</span>
                  </label>
                </div>
                {hopJob ? <HopProgress job={hopJob} /> : null}
                {lastSync ? (
                  <p className='text-foreground'>
                    上次同步：成功 {lastSync.ok_count ?? 0}，失败{' '}
                    {lastSync.failed_count ?? 0}，进程未起{' '}
                    {wrapSyncKernelFails(lastSync.items)}。
                  </p>
                ) : null}
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card className='mt-4'>
          <CardHeader className='flex-row items-center justify-between gap-2 space-y-0'>
            <CardTitle>槽位</CardTitle>
            {vms.length ? (
              <div className='flex items-center gap-2'>
                <span className='text-xs text-muted-foreground tabular-nums'>
                  已选 {selected.length}/{vms.length}
                </span>
                <Button
                  size='sm'
                  variant='ghost'
                  disabled={!selected.length}
                  onClick={() => setSelected([])}
                >
                  清空
                </Button>
              </div>
            ) : null}
          </CardHeader>
          <CardContent>
            {vms.length === 0 ? (
              <EmptyState
                reason='还没有槽位。'
                actionLabel='去虚拟机'
                to='/vm'
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className='w-8'>
                      <Checkbox
                        aria-label='全选槽位'
                        checked={
                          selected.length === vms.length
                            ? true
                            : selected.length
                              ? 'indeterminate'
                              : false
                        }
                        onCheckedChange={(v) =>
                          setSelected(v === true ? vms.map((vm) => vm.id) : [])
                        }
                      />
                    </TableHead>
                    <TableHead>槽</TableHead>
                    <TableHead>OS</TableHead>
                    <TableHead>引擎</TableHead>
                    <TableHead>内核</TableHead>
                    <TableHead>母本</TableHead>
                    <TableHead>上次结果</TableHead>
                    <TableHead className='text-right'>动作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {vms.map((vm) => {
                    const engine = engineOf(vm)
                    const rust = engine === 'rust'
                    const source = data?.meta?.source_vm === vm.id
                    const tone = slotSyncTone(syncById.get(vm.id))
                    const plane = dataplaneOf(vm)
                    return (
                      <TableRow
                        key={vm.id}
                        data-state={
                          selected.includes(vm.id) ? 'selected' : undefined
                        }
                      >
                        <TableCell>
                          <Checkbox
                            checked={selected.includes(vm.id)}
                            onCheckedChange={(v) => toggle(vm.id, v === true)}
                            aria-label={`选择 ${vm.id}`}
                          />
                        </TableCell>
                        <TableCell className='font-mono text-xs'>
                          <Link
                            to='/vm/$id'
                            params={{ id: vm.id }}
                            className='underline underline-offset-4'
                          >
                            {vm.id}
                          </Link>
                        </TableCell>
                        <TableCell className='text-muted-foreground'>
                          {osOf(vm)}
                        </TableCell>
                        <TableCell>
                          {inferenceEngineLabel(
                            normalizeInferenceEngine(engine, 'auto')
                          )}
                        </TableCell>
                        <TableCell className='font-mono text-xs'>
                          {plane === '—' ? '—' : dataplaneLabel(plane)}
                        </TableCell>
                        <TableCell className='text-muted-foreground'>
                          {source ? '当前母本' : rust ? '可收成' : '只收文件'}
                        </TableCell>
                        <TableCell>
                          {tone ? (
                            <StatusMark tone={tone} />
                          ) : (
                            <span className='text-xs text-muted-foreground'>
                              —
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className='flex justify-end gap-2'>
                            <Button
                              size='sm'
                              variant='outline'
                              disabled={!rust || promote.isPending || hopBusy}
                              onClick={() => setPromoteId(vm.id)}
                            >
                              晋升母本
                            </Button>
                            <Button
                              size='sm'
                              variant='outline'
                              disabled={!complete || hopBusy}
                              loading={
                                hopBusy &&
                                hopIds.length === 1 &&
                                hopIds[0] === vm.id
                              }
                              onClick={() => openHop([vm.id], false)}
                            >
                              替换此槽
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
            {rustVms.length === 0 ? (
              <p className='mt-3 text-xs text-muted-foreground'>
                没有 rust cli-hop 槽时仍会铺文件，但不会重启 kernel。
              </p>
            ) : null}
          </CardContent>
        </Card>
      </QueryGate>
      <ConfirmDialog
        open={pendingDataplane != null}
        onOpenChange={(open) => {
          if (!open) setPendingDataplane(null)
        }}
        title={
          pendingDataplane === 'crag'
            ? '切到 crag + cc-node？'
            : pendingDataplane === 'cc'
              ? '切到 cc-node + kernel？'
              : '切到 cli-node + kernel？'
        }
        desc={
          pendingDataplane === 'crag'
            ? `${selected.length ? `所选 ${selected.length} 个 Claude 槽` : '全部 Claude 槽'}将铺 crag kernel，claude_bin 指向 /home/kincli/.kin/cc-node，并重启 rust kernel。Codex 不动。不改凭证、不删容器。`
            : pendingDataplane === 'cc'
              ? `${selected.length ? `所选 ${selected.length} 个 Claude 槽` : '全部 Claude 槽'}将铺 wrap kernel 和 cc-node，并重启 rust kernel。Codex 不动。不改凭证、不删容器。`
              : `${selected.length ? `所选 ${selected.length} 个 Claude 槽` : '全部 Claude 槽'}将铺 wrap kernel 和 cli-node，并重启 rust kernel。Codex 不动。不改凭证、不删容器。`
        }
        confirmText='切换'
        cancelBtnText='取消'
        isLoading={dataplane.isPending}
        handleConfirm={() => {
          if (pendingDataplane) dataplane.mutate(pendingDataplane)
        }}
      />

      <ConfirmDialog
        open={!!promoteId}
        onOpenChange={(open) => {
          if (!open) setPromoteId(null)
        }}
        title='收成母本？'
        desc={`把 ${promoteId || '此槽'} 里已跑通的 cli-node 收成以后重装用的母本。不拷凭证。kernel 仍用仓内文件。`}
        confirmText='晋升'
        cancelBtnText='取消'
        isLoading={promote.isPending}
        handleConfirm={() => {
          if (promoteId) promote.mutate(promoteId)
        }}
      />
      <ConfirmDialog
        open={makeOpen}
        onOpenChange={setMakeOpen}
        title='重整 wrap 文件？'
        desc='用当前 share/wrap-cli 里已有的 cli-node，补 kernel wrapper / shim，并叠上仓内最新 kernel。缺 cli-node 会失败。Debian 12 可从一台 Ubuntu 槽拷 glibc 2.39 shim。'
        confirmText='重整'
        cancelBtnText='取消'
        isLoading={make.isPending}
        handleConfirm={() => make.mutate()}
      >
        <div className='space-y-1'>
          <p className='text-sm'>glibc shim 来源槽（可选）</p>
          <Select
            value={glibcVm || 'none'}
            onValueChange={(v) => setGlibcVm(v === 'none' ? '' : v)}
          >
            <SelectTrigger aria-label='glibc shim 来源槽'>
              <SelectValue placeholder='不拷 shim' />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='none'>不拷 shim</SelectItem>
              {vms.map((vm) => (
                <SelectItem key={vm.id} value={vm.id}>
                  {vm.id} · {osOf(vm)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={!!uploadFile}
        onOpenChange={(open) => {
          if (!open) setUploadFile(null)
        }}
        title='上传 kernel？'
        desc={`用 ${uploadFile?.name || '所选文件'}（${fmtBytes(uploadFile?.size || 0)}）覆盖仓内 kernel。不会自动改槽。`}
        confirmText='上传'
        cancelBtnText='取消'
        isLoading={upload.isPending}
        handleConfirm={() => {
          if (uploadFile) upload.mutate(uploadFile)
        }}
      />
      <ConfirmDialog
        open={releaseOpen}
        onOpenChange={setReleaseOpen}
        title='拉取 GitHub 内核？'
        desc='下载最新 Release 的 linux amd64 wrap kin-kernel、cli-node、cc-node 和 crag kin-kernel 到仓内。不改槽、不重启。'
        confirmText='下载'
        cancelBtnText='取消'
        isLoading={releaseUpdate.isPending}
        handleConfirm={() => releaseUpdate.mutate()}
      />
      <ConfirmDialog
        open={hopOpen}
        onOpenChange={(open) => {
          if (!open) setHopOpen(false)
        }}
        title={
          hopIds.length === 1
            ? `替换 ${hopIds[0]}？`
            : hopIds.length === vms.length
              ? '一键重装全部槽的最新内核？'
              : `重装所选 ${hopIds.length} 槽？`
        }
        desc={
          hopIds.length === 1
            ? '按该槽当前数据面铺内核并重启 rust kernel。不改凭证，不删容器。'
            : pullLatest
              ? '先从 GitHub 拉 wrap kernel、cli-node、cc-node 和 crag kernel，再按各槽数据面逐槽换上。不改凭证，不删容器。'
              : '按各槽当前数据面铺仓内内核并显示进度。不改凭证，不删容器。'
        }
        confirmText={
          hopIds.length === 1
            ? '替换'
            : hopIds.length === vms.length
              ? '全部重装'
              : '开始重装'
        }
        cancelBtnText='取消'
        isLoading={hopBusy}
        handleConfirm={() => {
          const ids = hopIds
          const pull = ids.length === 1 ? false : pullLatest
          setHopOpen(false)
          void runHop(ids, pull)
        }}
      >
        {hopIds.length === 1 ? null : (
          <label className='flex items-center gap-2 text-sm'>
            <Checkbox
              checked={pullLatest}
              onCheckedChange={(v) => setPullLatest(v === true)}
            />
            先拉取 GitHub 最新 wrap/crag
          </label>
        )}
      </ConfirmDialog>
    </PageHeader>
  )
}
