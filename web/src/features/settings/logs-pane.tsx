import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { SettingRow } from '@/components/setting-row'
import roundData from '../../../../src/lib/transport/offline-candidate-round.json'

const round: {
  id: string
  notice?: string
  choices: { value: string; label: string }[]
} = roundData

type LogsPaneProps = {
  value: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
}

export function LogsPane({ value: logging, onChange }: LogsPaneProps) {
  const hasCandidates = round.choices.length > 0
  const savedChoice = String(logging.offline_kernel_dataplane || '')
  const currentChoice = round.choices.some(
    (choice) => choice.value === savedChoice
  )
  return (
    <Card>
      <CardHeader>
        <CardTitle>日志</CardTitle>
      </CardHeader>
      <CardContent className='divide-y'>
        <SettingRow label='记录模式'>
          <Select
            value={String(logging.mode || 'normal')}
            onValueChange={(mode) => onChange({ ...logging, mode })}
          >
            <SelectTrigger className='w-40'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='off'>关闭</SelectItem>
              <SelectItem value='normal'>普通</SelectItem>
              <SelectItem value='debug'>Debug</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          label='临时原始非流式诊断'
          desc='默认关闭。仅 Debug 下显式 stream:false 的 Claude Chat 请求；精确正文可能包含密钥/隐私，仅管理员可查看。Node 观测不是隐藏的 Anthropic wire。每请求最多 16 MiB / 16 hops，最多 4 个并发采集，可能不完整。下载/备份副本不随保留期删除。'
        >
          <Switch
            checked={logging.raw_nonstream_debug === true}
            onCheckedChange={(raw_nonstream_debug) =>
              onChange({ ...logging, raw_nonstream_debug })
            }
          />
        </SettingRow>
        <SettingRow
          label='离线 kernel / CLI 验证（停止新推理）'
          desc={`${round.notice || ''} 先开启 Debug 和原始非流式诊断。开启后，新推理只接受 master key 的 Claude Chat stream:false；其它请求拒绝，不回退真实上游。每次在无外网临时 Docker 容器内依次测试假 CLI、真实 CLI 副本 + 假 Anthropic，使用假凭证，内存上限 1 GiB，每阶段约 30 秒（初始化/清理另计）。返回 HTTP 422 诊断结果，不是模型回答。不会终止已开始的请求或后台/管理员流量。`}
        >
          <Switch
            checked={logging.offline_kernel_probe === true}
            disabled={
              logging.offline_kernel_probe !== true &&
              (!hasCandidates ||
                logging.mode !== 'debug' ||
                logging.raw_nonstream_debug !== true)
            }
            onCheckedChange={(offline_kernel_probe) => {
              if (offline_kernel_probe && !hasCandidates) return
              onChange({
                ...logging,
                offline_kernel_probe,
                ...(offline_kernel_probe && !currentChoice && round.choices[0]
                  ? { offline_kernel_dataplane: round.choices[0].value }
                  : {}),
              })
            }}
          />
        </SettingRow>
        {logging.offline_kernel_probe === true ? (
          <SettingRow
            label='离线验证搭配'
            desc={`仅显示本轮 ${round.id} 的待测项，不改变真实槽位配置。候选 CLI 是独立重打包的实验文件；文件/基础版本/哈希不符时拒绝，不退回正式版。原始请求最多 1 MiB，日志保留实际版本和哈希。`}
          >
            <div className='space-y-2'>
              {hasCandidates ? (
                <Select
                  value={currentChoice ? savedChoice : ''}
                  onValueChange={(offline_kernel_dataplane) => {
                    if (
                      round.choices.some(
                        (choice) => choice.value === offline_kernel_dataplane
                      )
                    )
                      onChange({ ...logging, offline_kernel_dataplane })
                  }}
                >
                  <SelectTrigger className='w-80 max-w-full'>
                    <SelectValue placeholder='选择本轮候选' />
                  </SelectTrigger>
                  <SelectContent>
                    {round.choices.map((choice) => (
                      <SelectItem key={choice.value} value={choice.value}>
                        {choice.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p
                  role='status'
                  className='max-w-sm text-xs text-muted-foreground'
                >
                  {round.notice ||
                    '本轮暂无待测候选；关闭离线验证后才恢复正常推理。'}
                </p>
              )}
              {hasCandidates && !currentChoice ? (
                <p
                  role='status'
                  className='max-w-sm text-xs text-muted-foreground'
                >
                  已保存的选择不属于本轮，请重新选择并保存后测试；不会自动换成另一个版本。
                </p>
              ) : null}
            </div>
          </SettingRow>
        ) : null}
        <SettingRow label='保留天数'>
          <Input
            className='w-24'
            type='number'
            min={1}
            max={90}
            value={Number(logging.retain_days ?? 7)}
            onChange={(event) =>
              onChange({
                ...logging,
                retain_days: Number(event.target.value),
              })
            }
          />
        </SettingRow>
        <SettingRow
          label='Debug 保留天数'
          desc='request_log_debug 行。不超过上面的保留天数。'
        >
          <Input
            className='w-24'
            type='number'
            min={1}
            max={90}
            value={Number(logging.debug_retain_days ?? 3)}
            onChange={(event) =>
              onChange({
                ...logging,
                debug_retain_days: Number(event.target.value),
              })
            }
          />
        </SettingRow>
        <SettingRow
          label='存储上限 MB'
          desc='0 表示不按体积清理。超出删最旧 debug 行。'
        >
          <Input
            className='w-24'
            type='number'
            min={0}
            value={Number(logging.max_mb ?? 2048)}
            onChange={(event) =>
              onChange({
                ...logging,
                max_mb: Number(event.target.value),
              })
            }
          />
        </SettingRow>
      </CardContent>
    </Card>
  )
}
