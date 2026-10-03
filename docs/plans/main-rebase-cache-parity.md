# Test rebase and cache-parity repair

Date: 2026-09-23. Risk: R2 integration; existing transport architecture is retained. User asks for direct test-branch integration and a whole-cache comparison. [Context](../context.md).

Status: implemented and independently reviewed locally on 2026-09-24 (UTC+08:00). Final focused tests pass; full-suite failures match the recorded baselines. Native cache efficiency and deployment remain unverified. See the [investigation report](../reports/2026-09-24-cache-parity-investigation.md).

## Baseline / positive contracts

- Original test `dc78689` on `e6a8137`; target main `5b7d429`; CPA reference `673131f5`. A rollback branch preserves original test.
- Stable caller content produces a stable inspectable prefix; intentional request changes and final native transformations remain distinguishable.
- Cache policy (TTL/placement intent) stays separate from measured cache reads/writes and subscription samples.
- Stream/JSON client delivery shares upstream policy. Explicit failure outranks complete-looking text, and committed content is not silently replayed.
- Main's all-client trailing-system, relay classification and capacity pin fixes coexist with test's Chat/effort/multimodal and measured-usage changes.

## Execution / seams

1. Rebase the two test commits onto pinned main, preserving both sides' contracts. Only the newly refreshed context file needs autostash; the pre-task tracked tree was clean and untracked user material stays untouched. Resolve conflicts from current source/tests, not by choosing an entire side. Keep a mechanical rebase distinct from new functional fixes.
2. Audit the complete active path against CPA: Chat/body normalization, persona/identity/billing, model/thinking/tools, cache ownership/anchors/scope, explicit/default/mixed TTL, account/session/native slot affinity, outer/inner retries, usage provenance, local pricing/UI and upstream quota windows. Label active Rust CLI-hop versus inactive HTTP helpers.
3. Integrate only still-needed streaming/usage fixes into the rebased source, using discriminating regression tests from the independently validated scenarios. Do not apply the old repair patch wholesale; preserve new main parameters and diagnostics.
4. Correct confirmed bounded cache-policy defects with red/green tests (including delivery-mode parity) and retain intentional native ownership. Native cache flags/placement, engine changes, unsupported model changes and billing assumptions are not to be guessed from CPA's different transport.
5. Fresh independent review plus focused and full-suite comparison against pinned main/original test; inspect final diff/history and leave a usable local test branch. No remote history rewrite or live rollout.

## Accepted audit correction slice (2026-09-24 local)

- Normalize the cache-policy view from the accepted Chat→Claude request before persona/CLI changes. Retain original metadata needed for subagent classification. Do not use an indiscriminate raw-body spread that reintroduces tools/markers rejected by conversion.
- Ordinary conversation TTL remains pinned after account selection. Auxiliary probes/titles/subagents must not read or update that ordinary pin; explicit 1h subagents must not inherit an unrelated ordinary 5m pin. Verify both request orders and ordinary pin stability.
- Forward the resolved cacheTtl unchanged through JSON assembly alongside cliHop/preservation options. It is an API consistency correction, not the explanation for the user's streaming report.
- Inner transport/auth refresh replays are allowed only before commitment and while not aborted. Recheck cancellation after refresh and before any subsequent send; preserve existing valid precommit recovery and original failure/known usage otherwise.
- Protect main's all-caller prefix/relay fixes and test's post-selection account-qualified pin with full-chain tests. A pure test choosing two different provisional keys is not evidence that test's active handler uses those keys.
- Keep per-send/native-call provenance gaps explicit in the report; do not add a general telemetry framework or charge customers for synthetic/missing usage.

## File boundaries / review budget

- Existing protocol, identity, pool, transport, accounting and relevant test modules are the work surface; add a small helper only for a demonstrated shared contract.
- Preserve the existing docs/control plane: this plan, replaceable context, and one dated cache-comparison report. Old reports remain historical evidence, not current closure claims.
- One writer at a time. Read-only audits use frozen source snapshots. Parent owns rebase/conflict decisions and final acceptance; a writer receives only the accepted correction slice.
- Do not modify the independent CPA repository, untracked patch/artifacts, native binaries beyond what the main rebase contains, credentials, deployment state or quota formulas. No hidden continuation/retry engine.

## Verification / failure handling

- Rebase gate: target main is an ancestor of test; original custom commits remain represented; no unresolved conflict markers; backup ref remains valid.
- TDD gate: reproduce each new claimed defect before fixing it; test public request/envelope and stream artifacts, not only isolated helper counters.
- Cache gate: compare stable replay and growing history separately; preserve explicit fields, mixed-TTL ordering and raw usage where the active contract permits. Do not claim final native markers from a Node-only test.
- Stream gate: actual errors/negative metadata/EOF failures, real disconnect versus upstream reset, initial and final usage, metadata-only terminal reason, tool JSON, and no replay after commitment.
- Baseline gate: characterize existing Windows/platform/installer failures; no new unexplained failures. Run format/diff checks and fresh review.
- If a merge or test exposes an unapproved public-contract/architecture decision, stop that slice and ask rather than silently choosing it. If interrupted, preserve rebase state and backup refs; never reset away user work.

## Rejected shortcuts / closure

Do not replace the active native transport with CPA's HTTP executor merely to imitate its helpers, flip opaque preservation flags without wire evidence, infer cache-write buckets from requested TTL, or call the warm 11% report solved after changing only display values. Report which differences are fixed, intentional, still source-auditable, or blocked by unavailable native/runtime evidence. Finish with local commit/branch IDs, tests, remaining risks, and no push/deploy claim.
