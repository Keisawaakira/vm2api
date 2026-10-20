import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Tabs } from '@/components/ui/tabs'
import { meQueryOptions } from '@/features/auth/queries'
import { VmAccountTab } from './detail-account-tab'
import { vmTodayCounts } from './detail-today'

function renderAccount(
  account: Record<string, unknown> = {},
  extra: Partial<Vm> = {},
  role: 'admin' | 'super' | 'user' | null = 'admin'
) {
  const client = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
  })
  if (role)
    client.setQueryData(meQueryOptions().queryKey, {
      user: 'fixture-user',
      role,
    })
  const vm: Vm = {
    id: 'vm-fixture',
    status: 'stopped',
    has_token: false,
    has_refresh: false,
    ...extra,
  }
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <Tabs value='account'>
          <VmAccountTab
            id={vm.id}
            vm={vm}
            acc={account}
            dash={{ data: undefined }}
            credType='none'
            officialCc={false}
            u5={0}
            u7={0}
            tierKey='none'
            todayReadCache={0}
            todayWriteCache={0}
            todayHit={null}
            today={vmTodayCounts(vm)}
            busy={() => false}
            canRefresh={false}
            refreshBlocked='尚未导入凭证'
            onNeedProxy={() => {}}
            onAction={() => {}}
            onCredentialCommitted={() => {}}
          />
        </Tabs>
      </QueryClientProvider>
    )
  } finally {
    client.clear()
  }
}

describe('VM Account tab rendering', () => {
  it('opens a new credential-free account and keeps import controls visible', () => {
    const html = renderAccount()
    expect(html).toContain('导入凭证')
    expect(html).toContain('凭证类型')
  })
  it('renders a plain probe failure without hiding import controls', () => {
    expect(
      renderAccount({
        last_probe: { ok: false, error: 'No credentials available' },
      })
    ).toContain('No credentials available')
  })
  it('renders a structured backend probe failure as text rather than crashing the route', () => {
    const html = renderAccount({
      last_probe: {
        ok: false,
        error: {
          code: 'no_credential',
          message: 'No credentials available',
          token: 'DO_NOT_RENDER',
        },
      },
    })
    expect(html).toContain('No credentials available')
    expect(html).not.toContain('DO_NOT_RENDER')
    expect(html).toContain('导入凭证')
  })
  it('keeps import controls hidden for read-only and unknown roles', () => {
    for (const role of ['super', null] as const) {
      const html = renderAccount({}, {}, role)
      expect(html).not.toContain('导入凭证')
      expect(html).toContain('无凭证')
    }
  })
  it('keeps the credential controls available for an authenticated tenant', () => {
    expect(renderAccount({}, {}, 'user')).toContain('导入凭证')
  })
})
