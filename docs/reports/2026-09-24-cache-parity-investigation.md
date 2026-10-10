# Cache parity investigation and direct test integration

Date: 2026-09-24, local UTC+08:00. Evidence report, not a guarantee of native cache efficiency or subscription savings.

## Versions and delivery

- Fetched main: `5b7d429` / v1.3.35. Remote main was rechecked during this work and still matched. Local main was fast-forwarded to it.
- Original test: `dc78689`, forked at `e6a8137`. Rollback ref: `backup/test-before-main-rebase-20260923-233218`.
- Original Chat/TTL commits were replayed as `fdcef79` and `045a025`. Range-diff shows the Chat change unchanged, and the TTL change preserved with main's new cliHop/prefix context.
- Independently validated stream source changes were integrated directly as `74b0849`, retaining main's new relay/header/cliHop/prefix handling. The original AI patch was not used as correctness authority and `repair_短输出.patch` was not changed or applied as the integration method.
- CPA source reference: independent nested checkout at `673131f5`. It was fetched/inspected but not modified.
- Cache/replay changes described below are directly in the test source tree. No remote push, deployment, WSL/service startup, native-binary execution or paid inference was performed.

## Conclusions

1. Latest main really fixes the earlier ordinary Chat first-to-second-turn system-prefix movement. The old v1.3.33 finding is obsolete for this example; preserve `44d66e1` rather than recreating its lift.
2. The fork's request conversion, credential-aware defaults, account-qualified post-selection TTL pin and measured-usage accounting remain valuable. Main is not a superset of those changes.
3. Additional defects were found beyond the old stream patch: policy inspected raw rather than accepted Chat shape; helpers shared ordinary TTL state; JSON delivery lost selected TTL; inner auth refresh could replay a committed/cancelled request. These are now corrected and regression-tested.
4. The largest remaining architectural difference is final cache-marker ownership: CPA settles markers in its source-visible HTTP request; vm2api removes Node markers and delegates final layout to precompiled kernel/CLI code. Source-level tests do not establish equality of those final requests.
5. The user's reported warm-request consumption near 11% of a five-hour window remains a runtime attribution question. No token-list-price-to-subscription-percent formula was assumed, and no claim of fabricated cache counts or resolved subscription efficiency is made.

## Comparison of the complete path

| Stage | Current test / retained upstream behavior | CPA reference behavior | Assessment |
|---|---|---|---|
| Chat conversion | Fork preserves supported block/cache annotations, tools/results, media and effort mapping. Main also supports developer text, but flattens more block structure. | Source-visible role accumulator and block/tool conversion. | Preserve fork semantics; do not claim main lacks the developer role entirely. |
| System/persona prefix | Main now keeps trailing system turns for every supported CLI-hop caller; Haiku/unsupported-model handling remains. Billing-stripped relay recognition uses its beta/body/identity gates. | Translation plus configurable cloaking/reconciliation; confirmed native callers are not cloaked. | The ordinary fixed-system growing-history example is stable after main integration. Input-dependent tools, persona, model and other changes can still change prefixes. |
| Cache markers | Normal slot CLI path removes caller/tool/system/message/root markers before native reconstruction. Rich Node HTTP marker helpers are bypassed by that path's early return. | Executor ensures system/latest-cacheable-message anchors when it owns placement, applies limits and TTL ordering, then sends the resulting body. | Ported helper tests are not proof that the active native request uses CPA's anchors. Do not blindly flip preservation flags or null out TTL. |
| Scalar TTL selection | Uses accepted pre-persona converted/intercepted body, with original subagent provenance retained separately. Header and credential/default policy stay intact. | Marker/profile/helper policy is applied to the translated outgoing body; explicit fields and profile gates matter. | Fixed raw Chat message/function/title mismatches without resurrecting filtered raw fields. Native scalar selection still cannot express arbitrary per-anchor mixed TTL/scope. |
| Helpers and ordinary pins | Probes/titles/subagents do not read or refresh ordinary conversation TTL pins. Explicit header/block/accepted Messages-root 1h subagents are honored. Ordinary pins remain account-qualified and post-selection. | Helper/subagent policy is recomputed by its executor; optional affinity has separate scope/TTL. | Fixed interference in both request orders and idle-clock refresh. The active fork already avoided main's provisional-session-key problem; no routing redesign was needed. |
| Stream versus JSON | Both deliver the selected TTL and cliHop/preservation options to the same upstream transport; only client response formatting differs. | ExecuteStream settles request policy explicitly; other execution paths have their own contracts. | Fixed JSON forwarding omission. It is not the cause of the user's specifically streaming report. |
| Account/native slot | Main capacity-spill fix preserves durable account/VM binding. Repository kernel/CLI updates include the maintainer's native pin/prompt-identity changes. | Optional session-affinity selector is configuration-gated; direct HTTP executor has no vm2api native-slot layer. | Do not assume the user's CPA enabled affinity. Binary internals and installed slot versions remain unverified; a spill can still start cold. |
| Retries and repairs | Outer failover and inner transport/auth recovery are separate. Inner recovery is now precommit/non-aborted, with checks after awaits. Existing valid precommit recovery remains. | Manager/executor can also retry under configuration and credential rules; each executor's final body is inspectable. | Fixed committed-auth replay hazard. Outer attempt_count is still not a count of all native/provider calls. No inferred charging or telemetry engine was added. |
| Usage and client display | Start/delta/header/trailer observations are reconciled; raw usage reaches body/logging; client hiding remains separate. Actual stop metadata and explicit failures govern terminal delivery. | Client and internal usage parsers observe upstream counts; some generic internal CachedTokens metrics fall back to writes. | Compare explicit read/write fields, not generic cache badges. Final opt-in client usage is cumulative, not an increment to sum. |
| Pricing and quota | Fork retains measured 5m/1h buckets and labels unclassified estimates. Five-hour utilization is sampled from upstream header/usage windows, separately from local price arithmetic. | Quota observations/cooldown and token reporting are also separate; actual deployed configuration is unknown. | Do not restore main's requested-TTL rebucketing, or equate local USD estimates with subscription consumption. |

Primary source areas: `src/lib/protocol/{convert,chat-messages,cache-request,cache-ttl,handle-protocol,outbound-attempt}.mjs`, `src/lib/identity/crs-persona.mjs`, `src/lib/transport/{kernel-router,go-worker-client,rust-kernel-client,rust-kernel-supervisor}.mjs`, pool/usage/pricing modules; CPA `internal/runtime/executor/claude_executor_stream.go`, `claude_executor_cloaking.go`, `helps/claude_diagnostics.go`, Chat translation and auth selector/manager modules.

## Implemented corrections and preservation

- Retained latest-main all-client trailing-system, relayed-client, cliHop-envelope, prefix-diagnostic and capacity-binding changes.
- Retained test's actual request/effort behavior and truthful measured usage; did not import requested-TTL-based reclassification from main.
- Re-derived four stream failures against rebased source, then integrated the source repair: 4 failed before / 4 passed after. All 59 detailed stream/transport cases pass on the direct branch.
- Captured cache policy before persona/CLI stripping/clamping, using accepted normalized content. Original parent metadata contributes a classification signal only; discarded raw tools and cache markers cannot re-enter policy.
- Isolated auxiliary requests from ordinary TTL pins, including long-TTL subagents. Real first-request-to-bound-request and selected-account failover tests protect the existing correct post-selection pin.
- Forwarded TTL through JSON assembly without changing native preservation/cliHop flags.
- Guarded both inner replay paths against commitment/cancellation, and checked cancellation after credential refresh and recycle awaits. Original failure/known usage survives aborted recovery.
- Fresh review identified one small pre-existing supported-input edge: Messages root automatic-cache 1h was not recognized by subagent opt-in detection. Added the root node and four real handler cases. Unsupported raw Chat root fields remain excluded.

## Fresh verification

- Mechanical rebase/request-preservation gate: 187 tests, 178 passed / 9 existing platform skips / 0 failed.
- Stream source integration: 59/59 detailed tests plus 4/4 re-derived cases passed.
- New cache/router TDD: 48 cases, 19 pass / 29 fail before production changes; 48/48 afterward. Passing preservation cases are not misrepresented as reproduced defects.
- Root-1h follow-up TDD: 4/4 failed before the one-line correction, 4/4 passed afterward.
- Final combined cache/replay/stream gate: 111/111 passed, no skips.
- Independent review accepted the bounded integration, including 201 preservation tests. Follow-up independently accepted the root case, ran all 111 cases and additional compatibility probes; no scoped blocker remains.
- Full latest-main baseline: 7/155 test files fail at 24 named cases. Original test baseline: 8/158 files fail at 25 named cases. Direct integrated test: 8/165 files fail at the same 25 named cases, with no new failure versus the two baselines. This is not a full-green claim.
- Existing failures: `api-backend`, `backup-service`, `db-migration-sub2api`, `host-path`, `install-script`, `pool-scheduler`, `session-oauth-seam`, `wrap-cli-runtime`. They include Windows socket/path/permission/cleanup issues plus the inherited installer assertion mismatch. No unrelated fixes or assertion weakening were used to hide them.
- Rebased frontend snapshot, with source content identical to the current web tree: 124 tests passed; format check and production build passed. Used Dockerfile-pinned pnpm 10.18.2 without a global installation. Backend-only corrections do not change that web tree.
- Go/native/platform runtime and live quota comparisons were not executed. New in-memory tests exercise actual handler/conversion/interception/persona/failover/sticky/router/envelope logic, injecting only selected account availability, native lifecycle and HTTP boundaries.

Local evidence bundle for this run: `C:/Users/zemingxi/AppData/Local/Temp/vm2api-main-rebase-20260923-2330/`. It contains frozen audits, rebase/stream evidence, implementation and independent reviews, baseline/final logs and failure comparisons. The original test rollback branch remains the durable source rollback point.

## Remaining evidence needed for the 11% report

The historical runtime `678fc4f`/67,215 cache-read sample is not a measurement of this branch. A later authorized comparison needs same-account/model/settings, stable session identity, an identical replay and growing-history turns, raw U/R/C/output observations, outer/inner retry information, same-source quota samples with timestamps/reset windows, and final native marker/layout information. Numeric metadata and hashes can usually avoid recording full prompts or credentials.

The final native body, cache anchors/TTL/scope, process identity, internal calls and actual upstream work after cancellation cannot be certified from available JS. A Node envelope or `cache_prefix.break:null` is not a vendor cache-hit verdict. This work does not replace the native engine, add forced continuation, disable normal cache pins, enable full-body tracing, or promise CPA-equivalent subscription savings.
