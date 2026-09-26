import {
  CACHE_TTL_OPTIONS,
  cacheBreakpointsFromCompat,
  cacheTtlFromCompat,
  detectProxiedOfficialCcFromCompat,
  type CacheTtl,
} from '@/lib/cache-breakpoints'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { SettingRow } from '@/components/setting-row'

type Compat = Record<string, unknown>

export function CacheBreakpointsPane({
  compat,
  onChange,
}: {
  compat: Compat
  onChange: (next: Compat) => void
}) {
  const cfg = cacheBreakpointsFromCompat(compat)
  const ttl = cacheTtlFromCompat(compat)
  const proxied = detectProxiedOfficialCcFromCompat(compat)

  return (
    <>
      <Card>
        <CardHeader className='pb-2'>
          <CardTitle className='text-sm'>缓存</CardTitle>
        </CardHeader>
        <CardContent>
          <SettingRow
            label='默认 TTL'
            desc='自动：OAuth / Setup Token 1h，API Key 5m。HTTP 仅补缺失 TTL；cli-hop 由 native CLI 按槽配置生成标记。费用按上游分项，缺失部分以 5m 估算。'
          >
            <Select
              value={ttl}
              onValueChange={(v) =>
                onChange({ ...compat, cache_ttl: v as CacheTtl })
              }
            >
              <SelectTrigger className='w-40'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CACHE_TTL_OPTIONS.map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className='pb-2'>
          <CardTitle className='text-sm'>缓存断点</CardTitle>
        </CardHeader>
        <CardContent className='space-y-3'>
          <p className='text-xs leading-relaxed text-muted-foreground'>
            HTTP 保留显式 TTL 和合法的 1h → 5m 顺序，只修复后置 1h。wrap 与 crag
            共用的 cli-hop 会清除入站缓存标记，最终前缀由所选内核/CLI
            构建；此开关不关闭原生缓存。0 注入不代表不使用缓存。
          </p>
          <SettingRow label='启用'>
            <Switch
              checked={cfg.enabled}
              onCheckedChange={(on) =>
                onChange({
                  ...compat,
                  cache_breakpoints: { ...cfg, enabled: on },
                })
              }
              aria-label='启用缓存断点'
            />
          </SettingRow>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className='pb-2'>
          <CardTitle className='text-sm'>被中转的官方流量</CardTitle>
        </CardHeader>
        <CardContent>
          <SettingRow
            label='识别中转来的官方 Claude Code'
            desc='UA 被换成 Go-http-client，但 body 仍带官方计费块和合法 user_id。命中则整包按官方处理。'
          >
            <Switch
              checked={proxied}
              onCheckedChange={(on) =>
                onChange({ ...compat, detect_proxied_official_cc: on })
              }
              aria-label='识别被中转的官方 Claude Code'
            />
          </SettingRow>
        </CardContent>
      </Card>
    </>
  )
}
