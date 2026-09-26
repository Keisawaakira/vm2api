export type KernelDataplane = 'wrap' | 'wrap-fixed' | 'cc' | 'cc-fixed' | 'crag'

export const HOP_TRANSPORT_LABEL = 'Rust · cli-hop'

export const DATAPLANE_HINT =
  '固定 Rust cli-hop。原版 wrap 仍为默认；wrap-fixed 与 cc-fixed 是独立固定的修复搭配，已通过提供的离线请求保留检查。Crag 尚未通过 Chat 请求保留验收。切换建议在无业务请求时进行。'

export function dataplaneLabel(value: unknown): string {
  if (value === 'wrap-fixed') return 'cli-node 修复版 + kernel'
  if (value === 'cc-fixed') return 'cc-node 修复版 + kernel'
  if (value === 'crag') return 'crag + cc-node'
  if (value === 'cc') return 'cc-node + kernel'
  return 'cli-node + kernel'
}
