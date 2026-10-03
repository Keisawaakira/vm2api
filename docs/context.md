# Current context: CC service startup repair and main1.3.96

Locally verified2026-10-03 UTC. Parent only, no subagents, push/deploy, real credentials/provider/model calls, actual Linux ELF execution or runtime slot changes. Current evidence: Temp/vm2api-service-issue-20261003-0826UTC/; detailed dated investigation: docs/reports/2026-10-03-cc-service-startup.md. Final commit identity is recorded by that bundle's closure.json.

## Baseline/rebase

Start testccb30be, equivalent to b643684 minus four owner-deleted v189/v191 executables. Deletions preserved. Backup: backup/test-before-service-main196-20261003-0826UTC. Service repair first committed f7540a5, then fork and repair rebased onto origin/main362caf9c9273786f19313ad93e232a6fadc54357(v1.3.96), yielding0c7b785/af691a6 before final integration.17 upstream commits. Dist rebuilt from merged frontend; only source conflict was an OAuth test, not production code.

Main adds official-vs-converted setup-token types, reset-credit UA/scope corrections, local-exit OAuth support, Arch hostname fallback and named-slot credential ownership. Inference kernel/CLI/kin-egress did not change; kin-worker and kin-oauth-auth did.

## Incident and confirmed defect

serviceIssue contains a generic routing synchronization error and a protected request503/kernel_unavailable with attempt_count0, zero hops and not_sent. Its client JSON reports kernel down/watchdog pending. No live sync items/startup stderr/image hash or successful CLI quota sample was supplied. This is not a cache miss or short cloud response.

Current v194 CC and prior v191 contained native references to init_jobSession/getJobSessionId/runWithJobSession but no declarations. Actual initializer replay fails with ReferenceError; independent complete-module scope analysis finds exactly those3 unbound native references. Prior small lifecycle tests incorrectly supplied them as SDK fixtures and missed package dependency closure. This explains a concrete startup hazard consistent with the incident, not a retroactive capture of the user's missing stderr.

## Current repair and invariants

- cc-fixed-v196-r1 derives from v194 with3 fixed-length bootstrap/state spans. Real upstream AsyncLocalStorage job module, one-time state initialization and getSessionId job/host fallback; no stub functions or global session swapping. Ordinary metadata now uses the requested per-job session like the upstream wrapper. All v194 system/cache/initialization/workload/debug/lifecycle/terminal/classifier spans remain byte-identical. State export map and neighboring function compaction are checked as equivalent.
- Script: scripts/refresh-fixed-cc-session.mjs. It pins CC/reference hashes, audits complete-module bindings using installed frontend ESLint, validates source/ELF/no-bytecode/unchanged outside/UPX/roundtrip and all inherited repair bytes. Registry/manifest require session_contract:native_job_session_v1 for CC. Normal option remains cc-fixed; no candidate/rollback menu.
- Full-source native unbound references3→0. Bootstrap/session controls use real AsyncLocalStorage and actual initializer/dispatcher/getAPIMetadata, not manufactured definitions.22 new controls +135 retained controls pass in Node and Bun1.3.14 compiled miniature. This is not complete Linux/kernel/cloud execution.
- Settings preserve the existing dataplane_runtime failure report in ApiError.details, show bounded per-VM codes/reasons/errors and refresh persisted routing after committed-but-unapplied failure. No automatic retry/rollback; explicitly sync/restart the failed VM via existing data-plane page.
- Rebase seam: cookie-auth now honors explicit empty proxy_url for px-local, while null/undefined/whitespace still fail before spawn. Actual helper envelopes tested with fake child boundary. Panel official token fixtures follow the new official-setup-token label without losing inference-only/no-refresh/identity checks. No TTL policy changes.

## Active binaries

- CC fixed: share/cc-fixed/v196-r1/cc-node27161424B SHA393826e6543dec018bcebbbcd52f8579ce8bb6ad66768c8a4bf7cf9ae28142a9; unpacked d458505eee26a000878cab3bc9bcc846a7bf04f2ad9b4356a3a300c2f5c6a6a6. Two complete builds reproduce all binary/metadata bytes.
- Wrap fixed stays v194-r1,27164656B SHA4a9e49c02f4c06e52c2f2ebce1aa6097f43b44b6bcf54c01e9e8c82c802665a7.
- Shared kernel unchanged12848504B SHAfccd1a3564c9d24175aeaff1d12ccf3aca31e64cf45d954804df2ced4c45f610. No private kernel copy/patch.
- Main kin-worker16531172B SHAf310d6470bb8e01488ff347ee9b0149ee599a0087cc50b8e2871517a0aa42f61; kin-oauth-auth14432262B SHAf24e99feb393b77e32a73a1f0aab5330fdb3b1d5975acec97756245d5b65895c. Stock CLIc711a966, stockCCbe5eec49 and egress3e720a1a unchanged.

## Cache/verification boundary

Both fixed variants already use node_dual_anchor_v1. Cache/thinking helpers, wrap binary and CCH/undici observer byte-compare equal to the input checkout. The operator's CLI25% cold/3% warm observation is not a matched CLI/CC experiment; serviceIssue has no successful usage pair. Do not rank implementations or infer a subscription change from that ratio. Fixing the session dependency is not a claim of quota savings or format compliance.

Final scope:37 Node files844=818 pass/26 explicit skips/0fail; frontend217+format/forced TS/Vite; mock panel8 and Python17. Skip details in node-final.log; full suite/actual Go/native Linux/cloud not run. Logs unchanged. Existing remote fixed fail-closed, readonly credential authority, ordinary CPA/system/60000/cache contract, cancellation/budget and bootstrap usage remain preserved. Deferred retry-flag metadata note is unchanged.

Deploy complete source/dist/assets. Pause traffic; sync/reapply the SAME cc-fixed selection and restart kernel/CLI to load the new CC. Update/reload kin-worker for main1.3.95+ changes. Check sync/health before model inference; if still failing, retain the displayed per-VM report. Do not overwrite routing/vms/data/env, redeem credits or deliberately consume large inference quotas as a test.
