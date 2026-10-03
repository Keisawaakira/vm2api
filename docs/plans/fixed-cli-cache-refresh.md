# Fixed CLI refresh with native cache continuity — 2026-09-30

Status: implemented and locally verified; native/provider runtime effects remain unverified. Parent is sole writer. No delegation, deployment, provider requests, new candidate menu or kernel copy.

## Baseline, scope and authority

Source test acf660c, upstream 8b7ba44 (v1.3.86). Ordinary cli-node changed to packed SHA256 10140f71c2f2b59a274b4418d8deeb77189c31c58d3a9e02d87b7afc382f7d80; original cc-node and approved fixed CC are unchanged. Current context before this task is frozen in Temp/vm2api-fixed-cache-186-20260930/context-before.md. Backup backup/test-before-fixed-cache186-20260930-1745.

Operator requested the new cache behavior without switching system preservation back to upstream. Prior permission permits locally verified fixed CLI refresh for normal use; it does not authorize live-slot changes or claim native/provider acceptance. Kernel remains shared upstream; no fixed kernel rebuild/candidate/rollback UI.

Target relations: native caller system remains a separate exact snapshot, while generated framework blocks remain separate; Node message anchors and native generated system/tools anchors use the selected TTL and stay within the native marker bound; fixed binary lineage and validation are inspectable and fail closed. Public Chat mapping, manual/adaptive thinking, no-replay/error handling and passive tracing remain unchanged except using the refreshed fixed cache capability.

## Minimal implementation

1. Rebase wrap-fixed system snapshot/append repair onto the exact new upstream cli-node. Do not reapply stale offsets or restore an old entrypoint. Preserve upstream initialization, generation and cache logic.
2. Original CC did not update. Carry its approved system, initialization, workload/debug and error-detail repairs forward. Port the new native system/tool retiming and marker-budget semantics into its cache module, compare against exact extracted upstream cache code. Do not substitute the wrap executable for CC or change Crag kernel/request semantics.
3. Hash-pinned reproducible script using fixed-length JavaScript spans, original ELF/Bun/resource layout, and explicit tool paths. New versioned CLI-only artifacts; old revisions remain historical, not menu choices. All outside-span bytes must match; full JS syntax, no bytecode, UPX integrity and exact decompression roundtrip must pass.
4. Point existing wrap-fixed/cc-fixed loaders to locally verified new manifests. Enable Node dual-anchor policy for refreshed fixed paths; preserve ordinary cc/crag legacy policy. Update active fixtures/trace identity/layout tests and frontend description; no new user-facing switches or default changes.

## Verification

- Red/green extracted-source tests for plain/empty/whitespace/Environment/billing/agent system blocks, ordering/count/Unicode, non-kin and supported layouts, marker migration without content loss, no internal snapshot on wire; no stale entrypoint restoration.
- Differential native cache checks: explicit5m/1h, inherited/explicit system/tools marks, deferred/server tools, thinking exclusion, >4 markers, no-marker cases; new CC behavior equals new upstream module for supported request shapes.
- Real handler/runner/router/envelope checks for native/fixed/legacy routes, stream/JSON, selected-slot overrides, pinned TTL and thinking parameters. Existing trace configuration, fixed install/sync and raw export tests; frontend TS/build and committed dist.
- Independently rerun regeneration and compare packed/unpacked artifact hashes. No Linux ELF/provider test is claimed; if a guard or semantic check fails, keep old active fixed paths, retain diagnostics and stop rather than silently fallback.

Closure: 61 extracted-source tests, 8 compiled Bun1.3.14 controls, byte-identical regenerated executables/metadata, and six preserved prior CC repair spans. Final affected Node set: 629 passed / 20 explicitly skipped / 0 failed; frontend178 + formatting/TS/build passed. Existing fixed names now resolve to v186-r1 CLI-only packages, with no new candidate UI or live-slot change. No subagents or Linux/provider execution.

Evidence directory: C:/Users/zemingxi/AppData/Local/Temp/vm2api-fixed-cache-186-20260930/.
