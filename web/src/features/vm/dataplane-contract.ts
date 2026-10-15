export type KernelDataplane = 'wrap' | 'wrap-fixed' | 'cc' | 'cc-fixed' | 'crag'

export const HOP_TRANSPORT_LABEL = 'Rust · cli-hop'

export const DATAPLANE_HINT =
  '固定 Rust cli-hop。原版 wrap 仍为默认；wrap-fixed 与 cc-fixed 合并新版缓存连续性，并保留 caller system 独立块；无需切回原版。kernel 与原版同源，正常同步即可跟进上游。新 CLI 已通过本地验证，实机效果仍需观察。Crag 尚未通过 Chat 请求保留验收。同步/切换前请暂停业务请求，更新后重启生效。'

export function dataplaneLabel(value: unknown): string {
  if (value === 'wrap-fixed') return 'cli-node 修复版 + kernel'
  if (value === 'cc-fixed') return 'cc-node 修复版 + kernel'
  if (value === 'crag') return 'crag + cc-node'
  if (value === 'cc') return 'cc-node + kernel'
  return 'cli-node + kernel'
}
