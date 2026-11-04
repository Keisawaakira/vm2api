# CC fixed startup failure and main1.3.96 integration

Date:2026-10-03 UTC. Parent-only investigation and implementation; no live deployment, credentials/provider/model request, real Linux ELF execution or subagent review. Evidence bundle: `Temp/vm2api-service-issue-20261003-0826UTC/`.

## Input evidence

The operator supplied `logs/serviceIssue/cc-node fixed error.txt` and `vm2api-raw-debug-cc-node-error.jsonl`. The text is the generic routing-save/synchronization failure. The protected request log is503 `kernel_unavailable`, `attempt_count:0`, raw capture `not_sent` with zero inference hops. Its protected client JSON says the kernel is down and watchdog recovery is pending. There is no startup stderr, sync item report, native image hash or successful cloud usage in this sample. It is not evidence of a short model response or cache miss.

The current checkout started at testccb30be: the previous b643684 delivery squashed onto main1.3.94, with four v189/v191 executables deliberately removed. Those removals are preserved. Current v194 assets still match their manifests.

## Confirmed native dependency defect

Full decoded CC v194 source contains references but no declarations for:

- `init_jobSession`
- `getJobSessionId`
- `runWithJobSession`

The copied native initializer invokes `init_jobSession` before starting the native loop. Executing that actual initializer with only existing unrelated SDK initializers mocked produces `ReferenceError: init_jobSession is not defined`. The complete-module ESLint scope analysis independently finds exactly those three unresolved references inside the native region; the reference stock CLI has none. v191 also carried these references without their module.

Earlier lifecycle miniature controls supplied these names as SDK fixtures. They verified cancellation/error behavior but masked the missing full-package dependency. This was a validation gap, not an operator configuration error. The defect can cause handshake/startup failure and fits the supplied outcome, but absent live stderr/image identity prevents certifying it as the sole cause of that historical failure.

## Corrective change

Current `cc-fixed-v196-r1` derives from v194 SHAac6d4848. The hash-bound maintenance script `scripts/refresh-fixed-cc-session.mjs` adds the reference job-session module using the existing real AsyncLocalStorage import, initializes it with state and updates `getSessionId()` to read the active job before the original host fallback.

Three fixed-length spans change. Whitespace-only compaction of the state export map and adjacent unchanged session function makes room; mappings and neighboring function behavior are checked. All prior v194 system, cache, initialization, workload/debug, terminal, cancellation/error and classifier repair intervals remain byte-identical. The new per-job metadata session behavior is intentional and matches the referenced wrapper; this is not a cache-algorithm or thinking-budget change.

New package:27161424 bytes, SHA256 `393826e6543dec018bcebbbcd52f8579ce8bb6ad66768c8a4bf7cf9ae28142a9`; unpacked SHA256 `d458505eee26a000878cab3bc9bcc846a7bf04f2ad9b4356a3a300c2f5c6a6a6`. Registry/manifest require `session_contract:native_job_session_v1`. Formal option remains `cc-fixed`; no new candidate or rollback menu. Wrap-fixed remains v194 unchanged. Kernel still uses the original shared path, with no private kernel patch/copy.

Startup/session controls use the real module, not fake definitions of the missing names. They check one-time initialization, interleaved job IDs, actual native dispatcher to outbound metadata, rejection cleanup and unchanged host-session fallback.22 new controls plus135 retained native controls pass in Node and a Bun1.3.14 compiled miniature. Full source binding audit now finds zero unresolved native-region references, without adding unresolved names elsewhere; it does not certify all optional code in the vendor bundle. A separate conservative initializer graph was exploratory only: browser/build-time/guarded references there are not represented as runtime failures or as a complete runtime certification.

## Switch error visibility

The backend already returns `routing_committed:true` and `dataplane_runtime.items` on this failure. Frontend normalization previously discarded that top-level report. It now preserves it as structured error details and shows a bounded summary of failed VM IDs, stage codes/reasons and error text. Settings refresh the actual persisted routing after such a failure; this does not retry or silently roll back any VM. Synchronization/restart is an explicit action in the existing data-plane page, not an implication of saving the same value again.

## Rebase and compatibility

After the service repair was committed, both fork and service commits were rebased onto main362caf9 (v1.3.96), replayed as0c7b785/af691a6 before final integration. Main changed OAuth/setup-token semantics, named-slot credential ownership, Arch hostname fallback and kin-worker/kin-oauth-auth; it did not change inference kernel/CLI or kin-egress.

A reproduced merge seam was corrected: the fork's old cookie-auth guard rejected the explicit empty string for local exit. Empty string now passes through the actual helper envelope unchanged; null/undefined/whitespace remain rejected before spawn. Tests use a fake child boundary, never the real credential service. Existing panel exchange tests now expect the new `official-setup-token` classification while preserving scope, no-refresh and identity behavior. The upstream Linux-helper test is explicitly platform-gated on this Windows host.

## Cache comparison limits

Both formal fixed variants already use `node_dual_anchor_v1`: selected-session TTL and Node dual-message anchors, plus native system/tool cache handling. These helpers/strategies are byte-preserved in this task. The operator's CLI25% cold/3% warm observation is compatible with effective reuse but lacks matched request/output sizes, exact quota snapshots and a same-window CC control. `serviceIssue` has no successful CLI/CC usage pair, so it cannot rank the cache implementations or prove a subscription-quota change. The failed not-sent request supplies no model usage for that comparison. Do not infer subscription cost directly from a displayed cache flag or a two-request percentage ratio.

## Verification and remaining boundary

-37 affected Node files:844 tests,818 passed,26 explicit skips,0 failed. Includes full-image scope audit, independent unpack/interval hashes, bootstrap/compiled controls, installation/config/trace and rebase seams.
- Frontend217 tests, format/forced TypeScript/Vite build passed. Merged dist rebuilt. Mock panel e2e8 and Python17 passed.
- Two complete final CC binary/metadata builds match; original wrap/kernel/caching/thinking/CCH bytes and supplied logs are preserved.
- No full-suite, real Docker/SSH/process cleanup, native Linux kernel/CC, real provider or live quota validation. No automatic switch, credential exchange, continuation or credit redemption.

Deploy the complete result, pause traffic, synchronize/reapply the same cc-fixed selection and restart its kernel/CLI. Update/reload kin-worker for upstream1.3.95/1.3.96 changes. Check synchronization/health before sending an expensive inference. If it still fails, retain the now-visible per-VM report/startup details; do not treat this local fix as proof of a successful production restart.
