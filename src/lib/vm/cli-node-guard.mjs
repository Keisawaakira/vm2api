/**
 * One cli-node per slot: the kernel's `-p` worker. An interactive `claude`
 * in a live panel shell may exist beside it. Anything else is a leak from a
 * closed terminal (cli-node ignores SIGHUP) and is killed.
 */
import { execDetached } from '../cluster/docker-remote.mjs'
import { slotContainerName } from '../transport/rust-kernel-supervisor.mjs'
import { isCodexVm } from './vm-kind.mjs'
import { slotHost } from './slot-host.mjs'

export const CLI_NODE_GUARD_INTERVAL_MS = 15_000

/**
 * @param {Array<{ pid: number, worker: boolean, panelToken?: string|null }>} processes
 * @param {string[]} liveTokens panel shells that are still connected
 * @returns {number[]}
 */
export function selectCliNodePidsToKill(processes, liveTokens = []) {
  const live = new Set(liveTokens.filter(Boolean))
  const workers = processes.filter((proc) => proc.worker).sort((a, b) => a.pid - b.pid)
  const keep = workers[0]?.pid ?? null
  const kill = []
  for (const proc of processes) {
    if (proc.pid === keep) continue
    if (proc.worker) {
      kill.push(proc.pid)
      continue
    }
    if (proc.panelToken && live.has(proc.panelToken)) continue
    kill.push(proc.pid)
  }
  return kill
}

// $0 is "guard"; "$@" are live KIN_PANEL_SHELL tokens.
const GUARD_SCRIPT = `
is_cli() {
  command=$(tr '\\0' '\\n' < "$1/cmdline" 2>/dev/null | head -n 1)
  case "\${command##*/}" in cli-node|cli-node-fixed) return 0 ;; *) return 1 ;; esac
}
is_worker() {
  grep -zEq '^CLAUDE_CODE_KIN_NATIVE_SLOTS=.+$' "$1/environ" 2>/dev/null && return 0
  grep -zFxq -- '-p' "$1/cmdline" 2>/dev/null || grep -zFxq -- '--print' "$1/cmdline" 2>/dev/null
}
keep=
for d in /proc/[0-9]*; do
  is_cli "$d" || continue
  is_worker "$d" || continue
  pid=\${d#/proc/}
  if [ -z "$keep" ] || [ "$pid" -lt "$keep" ]; then keep=$pid; fi
done
for d in /proc/[0-9]*; do
  pid=\${d#/proc/}
  [ "$pid" = "$keep" ] && continue
  is_cli "$d" || continue
  if is_worker "$d"; then kill -KILL "$pid" 2>/dev/null || true; continue; fi
  panel=$(tr '\\0' '\\n' < "$d/environ" 2>/dev/null | sed -n 's/^KIN_PANEL_SHELL=//p' | head -n 1)
  if [ -n "$panel" ]; then
    for token in "$@"; do
      [ "$token" = "$panel" ] && continue 2
    done
  fi
  kill -KILL "$pid" 2>/dev/null || true
done
exit 0
`

export function createCliNodeGuard({
  listTargets,
  liveTokens = () => [],
  exec = execDetached,
  intervalMs = CLI_NODE_GUARD_INTERVAL_MS,
  logger = console,
} = {}) {
  let timer = null
  let inTick = false

  async function tick() {
    if (inTick) return
    inTick = true
    try {
      const tokens = liveTokens().filter(Boolean)
      const vms = (listTargets?.() || []).filter((vm) => vm?.id && !isCodexVm(vm))
      for (const vm of vms) {
        try {
          const connect = slotHost(vm).dockerApi()
          const container = slotContainerName({ vm })
          await exec(connect, container, ['/bin/sh', '-c', GUARD_SCRIPT, 'guard', ...tokens])
        } catch (err) {
          logger.warn?.(`[cli-node-guard] ${vm.id} ${err?.message || err}`)
        }
      }
    } finally {
      inTick = false
    }
  }

  return {
    tick,
    start({ immediate = true } = {}) {
      if (timer) return
      if (immediate) void tick()
      timer = setInterval(() => void tick(), intervalMs)
      timer.unref?.()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}
