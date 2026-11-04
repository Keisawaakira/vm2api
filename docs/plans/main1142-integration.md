# main1.3.142 integration — locally verified 2026-10-11

## Scope / authority

Operator requests rebase to newest main; prior owner-approved CPA mapping, system preservation, CLI-only fixed/shared kernel and direct-parent rebase remain binding. State baseline and inspected boundaries: `docs/context.md`. R1 history transport plus bounded R2 integration changes, not a new architecture. Parent is sole writer; no delegated work. No pushes, deployment, real model/credential requests, active-slot changes or restoration of deleted historical packages. Rewritten history is handled with explicit --onto, not replaying hundreds of equivalent ancestors.

## Target relations

1. Shared source/identity contracts survive rebase: caller text/boundaries, finite dispatch accounting and fail-closed native errors are unchanged unless an evidenced compatibility correction is necessary.
2. Artifacts have an explicit producer: Docker builds the merged web source and Go helpers, verifies pinned original payloads, and includes the fork's existing active fixed CLI packages without choosing stock code silently.
3. Every original/fixed request and diagnostic operation targets the selected slot namespace. New KVM use cannot accidentally execute in the outer runner or claim request capture from its PID.

## File/interface work (bounded to concrete seams)

- Rebase `3c2bf7a4` from old base `af30a588` onto `fc01a3da`; preserve the eight v1124 deletions and earlier retired rounds. Generated web output follows the new ignored/source-build contract.
- Dockerfile, deploy/Dockerfile.arm64-control, install/update scripts and build tests: retain fixed inputs, restore the shared candidate JSON at the correct web-relative path, use deploy/payload.json for original files. Inputs are source plus pinned blobs; outputs are verifiable built trees. No release uploads or speculative storage service.
- Protocol/cache/failover and logs: integrate upstream admission, critical-band, inline effort and tenant-owner fields. Public Chat still uses its accepted CPA conversion; Messages keeps supported per-turn controls. Add actual-handler red/green cases for any changed behavior, with no network model calls.
- Runtime/usage/trace: use existing slot-exec interfaces where needed, preserving selected VM/user/env. Exercise KVM command construction and file/readiness ownership with mocks; no real KVM claims.
- Tests/docs: fix only evidenced stale expectations, platform fixtures or missing close calls. Current fixed source/ELF bindings and patched functions must still run; historical-only missing samples may explicitly skip, current payload failure may not.

## Acceptance / stop conditions

Run changed upstream tests plus fork protocol/caching/guard/trace/usage/runtime preservation suites, full web tests/format/forced TS/build, focused mock panel and offline Python checks if touched. Check downloaded/cached payload hashes and unchanged fixed hashes. Build the exact source-only Docker web layout without a root Node tree hiding missing inputs. Verify tracked/ignored membership and clean git archive inputs. Main may remove web/dist from Git but must never distribute stock web for fork features.

A concrete upgrade seam was reproduced: the upstream Compose updater would checkout stock release tags and remove fork code. Fixed-registry checkouts now return the existing host_upgrade_required response with the explicit fork test-branch command, without launching any helper; non-fork updater behavior is retained and tested. No new upgrade architecture was implemented.

If an integration cannot preserve contracts without a new API/security architecture, stop that expansion and ask the owner; do not quietly broaden the task. No arbitrary reset/clean, no native invocation of unknown binaries. Rebase may autostash only this parent-owned context update; record its restoration. Final report separates local checks from unrun Docker/Linux/KVM/provider acceptance and names actual changes, residual limits and a recoverable branch.
