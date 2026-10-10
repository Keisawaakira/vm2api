# CLIProxy-aligned cache TTL repair — local implementation evidence

Status: local source implementation verified; WSL/kernel wire acceptance and independent review remain open. No commit/push/deployment performed.

## Baseline / reference
- vm2api HEAD: `90f96fb6c86fe3b5636df8c2adcafa228b788bee`.
- CLIProxyAPI reference: `e01806f971b1758b23bb067d93f7d2acd73d2c70`, Claude execute/stream, cloaking cache helpers and helper/subagent classification. License retained in `src/lib/protocol/CLIProxyAPI-LICENSE.txt`.
- Scope approved by user: “可以，你说的都是问题，按CLIProxy修吧”. [Plan](../plans/cache-ttl-cliproxy.md).

## Implemented contracts
- Auto cache default: OAuth/setup-token 1h, API key 5m, resolved after account selection on each attempt. Existing explicit console 5m/1h remains a fill default. A block's explicit TTL is preserved.
- Ordered repair preserves legal early 1h→later 5m; only 1h following a 5m marker is downgraded. Probes/title helpers/default subagents use short TTL, with explicit subagent opt-in handling.
- Default cache placement preserves caller anchors; no redundant tools marker when system covers the prefix. HTTP rolling selector fills only the last eligible message, skips assistant thinking tails; CLI message injection remains delegated to kernel/CLI. Deferred tool cache validation still runs when system covers tools.
- Confirmed native clients are excluded from Node default cache injection/TTL fill. CLI envelope preservation cannot also request forced TTL rewriting.
- Built-in persona cache markers are ttl-less. Zero still means reduced persona, not disabled cache. Plain caller system template expansion preserves explicit caller block boundaries instead of flattening them away (where leftover text maps exactly).
- Usage is never reclassified to a requested TTL. Shared extraction gives nested upstream split precedence over aliases, preserves explicit zeros, stores missing split as NULL. Partial/unreported write tokens remain unclassified.
- Unknown write-cost portion is conservatively estimated at 5m price and explicitly marked (`cache_creation_estimated`, `cache_creation_unclassified_tokens`); log details show the estimate. Historical classified/billed records are not rewritten.
- Kernel JSON projects credential-aware resolved defaults. Debug dump is labeled Node→kernel envelope, not final wire capture. UI, validation, protocol and panel docs align with auto/fill semantics.

## Evidence
- Red: seven new contract tests failed before the main repair (mixed ordering, explicit TTL, credential defaults, CLI placement/native exemption, usage preservation and unknown pricing).
- Additional red→green tests covered zero-persona caller-boundary loss, API-key HTTP injection default, and deferred tool validation with system coverage.
- Final focused Node suite: **265 pass, 13 platform skips, 0 fail** (278 cases, 11 files).
- Frontend: **124/124 tests, 23/23 files passed**; `pnpm -C web build` (TypeScript + Vite) passed.
- Final full Node suite: **151/158 files pass; 7 files fail**. All 24 failure locations exactly match a separate untouched `git archive HEAD` baseline with the same dependencies (sorted failure-location diff empty): api-backend, backup-service, db-migration-sub2api, host-path, pool-scheduler, session-oauth-seam, wrap-cli-runtime. Windows Unix sockets, tar/path assumptions, cleanup permissions and executable expectations remain unresolved baseline/environment issues, not a claim of full-suite green.
- Biome/Prettier on touched files and `git diff --check` pass.

## Limits / deployment acceptance
- No kernel/Claude CLI source exists in this checkout; shipped binaries were NOT patched/rebuilt. Preservation envelope/config is tested, final runtime compliance is not. No actual Docker/Anthropic call or independent audit was performed.
- Existing settings may still explicitly select 1h/5m or pin TTL in saved persona templates. To follow credentials, select auto; clear template TTL or restore new defaults if desired. Explicit caller/template choices are intentionally not overwritten.
- Commit all new modules and tests (not only tracked files) before pushing the fork. In WSL, run the fork installer and verify running image revision matches source HEAD. Do not use the upstream panel updater.
- Verify mixed TTL and raw upstream usage on the final kernel/CLI→Anthropic hop. Node `outbound_body` alone cannot certify it. Short TTL writes are not themselves a cache failure; compare stable-prefix repeated requests and cache reads on the same account.
