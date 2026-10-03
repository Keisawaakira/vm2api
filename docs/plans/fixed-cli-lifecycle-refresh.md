# Fixed CLI lifecycle refresh and v1.3.91 integration

Implemented and locally verified2026-10-02. Parent was sole writer; no delegation. Context: docs/context.md. Owner's standing approval permits locally verified fixed CLI updates without a new candidate round; kernel follows the original shared path. This is bounded maintenance, not authority to change caller prompts, budgets, cache accounting, live slots or subscription policy.

## Baselines and invariants

- Investigation baseline4c0e211, rebased as04681bf on main6a32923. Preserve intentional deletions of v155 and v186 historical binaries.
- Current fixed v189 inputs remain available and hash-pinned; original CC is unchanged. New original wrap CLI packed a32241fb000f9696f846efcc32ab72d07714465edbc16fe914b33f62d65c83cc, unpacked201054c429f3b8baa76b2690172a4393ea37f19c7fa52516fdd2b4a63c98748b. All raw evidence is frozen in Temp/vm2api-cache-issue-20261002/.
- Positive target: every actual inference send has one cancellable identity; observed errors/usage stay attached to that send; recovery belongs to the bounded layer responsible for it. Caller system/order and the existing cache contract remain stable.
- Existing full-cloud capture is unavailable in the five logs; header snapshots do not certify a per-call settlement. Do not infer a pricing formula, charged budget, hidden retry count or official quota change from local estimates.

## Scope

1. Merge main cancellation/error/watchdog changes with fork Chat/raw capture/no-replay/actual execution accounting. Do not restore request-triggered container recycling merely to satisfy obsolete tests. Preserve upstream proxy routing and per-account billing display fixes.
2. Wrap: take the new original CLI with all upstream lifecycle fixes; reapply only the established caller snapshot and independent system-block preservation. No blind reuse of old offsets.
3. CC: retain the approved current image and port native cancellation/ping/raw-error/no-hidden-retry behavior. The new upstream generic job-error helper names must be isolated to avoid collisions with CC's existing bundled names. SDK class/initializer references must resolve to existing CC implementations, not fake replacements. Native bridge keeps caller snapshot while forwarding the new error callback.
4. Publish separate CLI-only v191-r1 directories under the existing formal names after verification. No kernel copies, automatic slot changes, added candidate menu or discarded old-source metadata.

## Interfaces and checks

- Build script: explicit root/output/evidence/UPX/Bun, source hashes, distinct bounded spans. Fail closed on unknown code/space mismatch. Artifacts expose lineage, exact changes, limits and local-only verification.
- Executed source controls: native cancel must not block ping or another slot; cancellation ack only after the matching job settles; unknown/completed cancel is idempotent; errors retain code/status/type/message/retry-after; successful streams/usage are unchanged. Exercise actual extracted dispatcher/functions with neutral fake SDK/transport boundaries, including delayed and failed work.
- Native retry guard: exact native query-source branch stops interactive hidden retries/fallback; non-native behavior retained. Test successful and failing paths, not only syntax or regex existence.
- Node controls: per-send request_id matches the authenticated cancel body; no duplicate inference on cancellation/commitment; raw capture attaches only to inference, not the administrative cancel request; errors remain observable without crashing on best-effort cancel failure.
- Cache/system controls: active artifacts run the established block-order/blank/fingerprint/TTL suite; body and budget fields must not drift. Original saved five requests replay identically through merged production conversion/pricing.
- Packaging: full JS syntax, ELF/Bun graph stability, no bytecode, bytes outside changed regions unchanged, UPX integrity and exact decompression. Regenerate packages/metadata independently and compare bytes. Only actual compiled miniature controls count as such; never label them full Linux CLI execution.
- Final: relevant upstream+fork Node tests; frontend tests/types/format/build with fresh web/dist; Docker input contracts; Python probe tests. Record skipped platform/historical-source cases honestly. No live Docker/SSH/WSL/kernel/CLI or provider requests.

## Boundaries

Generated changes are capped to the cancellation/transport/native protocol integration and existing fixed builder/registry/tests/docs. No cache rollback or new TTL settings: the supplied warm requests already report97–99.995% reads and older captures used1h too. No claim that native lifecycle fixes explain those five successful requests or cure end_turn formatting. New findings outside this scope are reported rather than silently bundled.

## Observed closure evidence

- Rebase completed as04681bf on6a32923; final integration is recorded by the containing commit and evidence/closure.json.
- Source red17 failures against old/missing behavior, then40/40 source tests pass including Bun1.3.14 compiled controls. Each package executes65 basic source checks before recording local validation; both final binaries and all metadata reproduce exactly.
- Scope-adjacent discriminators found two small fixes: asynchronous cancel-body errors must not crash Node, and a duplicate exclusive trace-file create must flag reused/partial evidence even when Windows claim renames both succeeded. Both failures were reproduced before correction; no inference semantics or cache policy changed for them.
- Final56 selected Node files:1270 pass/54 explicit skips/0 fail; frontend192+format/types/build; Python17. Saved five-log production replay93 checks passes before and after integration. Historical deletions preserved.
- No independent subagent audit, live Linux CLI/kernel, Docker/remote node or provider execution. These results are local evidence, not a cloud quota/format acceptance claim.
