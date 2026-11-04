# Rebase test onto v1.3.46

2026-09-24. Bounded R2 integration authorized by user. [Context](../context.md).

Status: local rebase and verification complete; independent review accepted source integration. New upstream DNS fixture was made portable without production edits. Known OAuth/crag/runtime limits remain. See the [report](../reports/2026-09-24-main-1.3.46-integration.md).

Target main `2e9d7d0`, starting test `0de66ec`. Preserve main's DNS/config/telemetry/probe and manual-limit behavior alongside fork request conversion, measured usage, auxiliary TTL isolation, stream terminal truth and committed/cancelled replay safety.

1. Freeze refs and baseline snapshots; inspect old known issues against exact changed files.
2. Rebase six local commits. Resolve actual conflicts by behavior, not whole-file replacement; keep attribution and unrelated untracked material.
3. Run targeted shared/new-upstream tests, compare full Node failure sets to both baselines, and validate frontend format/tests/build.
4. Fresh independent source review, then commit/report and verify ancestry, tree cleanliness and exact remote state. No force-push/deploy.

Only demonstrated integration defects justify additional production edits. The existing OAuth fatal-code and crag lifecycle issues remain explicitly uncorrected; do not broaden this routine rebase into another Go/platform or native-engine repair attempt. No service/native execution, paid inference, global tooling install or modification of the old patch/CPA checkout.

Acceptance is source-rebase correctness, not production readiness: all fork contracts represented, new main changes retained, no new unexplained test failure, review complete, tracked tree clean. Keep final-wire/cache/quota and platform limitations explicit in the dated report rather than claiming them resolved.
