import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Tabs } from '@/components/ui/tabs'
import { VmAccountTab } from './detail-account-tab'

function renderAccount(
  account: Record<string, unknown> = {},
  extra: Partial<Vm> = {}
) {
  const client = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
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
})
