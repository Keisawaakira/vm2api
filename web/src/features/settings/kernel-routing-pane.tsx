import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SettingRow } from '@/components/setting-row'
import {
  DATAPLANE_HINT,
  HOP_TRANSPORT_LABEL,
  dataplaneLabel,
} from '@/features/vm/dataplane-contract'

const SESSION_SLOT_STEPS = [1, 2, 4, 8, 12, 16, 20]

export function KernelRoutingPane(props: {
  value: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
}) {
  const configured = Number(props.value.session_slots ?? 20)
  const options = SESSION_SLOT_STEPS.includes(configured)
    ? SESSION_SLOT_STEPS
    : [...SESSION_SLOT_STEPS, configured].sort((a, b) => a - b)
  return (
    <Card>
      <CardHeader>
        <CardTitle>Claude 内核</CardTitle>
      </CardHeader>
      <CardContent className='divide-y'>
        <SettingRow label='数据面' desc={DATAPLANE_HINT}>
          <Select
            value={String(props.value.dataplane || 'wrap')}
            onValueChange={(value) =>
              props.onChange({ ...props.value, dataplane: value })
            }
          >
            <SelectTrigger className='w-56'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='wrap'>{dataplaneLabel('wrap')}</SelectItem>
              <SelectItem value='wrap-fixed'>
                {dataplaneLabel('wrap-fixed')}
              </SelectItem>
              <SelectItem value='cc'>{dataplaneLabel('cc')}</SelectItem>
              <SelectItem value='cc-fixed'>
                {dataplaneLabel('cc-fixed')}
              </SelectItem>
              <SelectItem value='crag'>{dataplaneLabel('crag')}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          label='推理路径'
          desc='Node 到槽内核的运输。真正跑 CLI 的是上面的数据面。'
        >
          <span className='text-sm'>{HOP_TRANSPORT_LABEL}</span>
        </SettingRow>
        <SettingRow label='凭证归属'>
          <span className='text-sm'>
            宿主机写 credentials.json，槽内 kernel 与 cli-node / cc-node 只读
          </span>
        </SettingRow>
        <SettingRow label='预开 native 位'>
          <span className='text-sm tabular-nums'>
            {String(props.value.dataplane || 'wrap') === 'crag'
              ? '最多 20（cc-node 一进程）'
              : '20（固定）'}
          </span>
        </SettingRow>
        <SettingRow
          label='默认 session 槽位'
          desc='限制每个 Claude 槽可占用的 CLI 执行位；与同时请求数独立'
        >
          <Select
            value={String(configured)}
            onValueChange={(value) =>
              props.onChange({ ...props.value, session_slots: Number(value) })
            }
          >
            <SelectTrigger className='w-40'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.map((value) => (
                <SelectItem key={value} value={String(value)}>
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
      </CardContent>
    </Card>
  )
}
