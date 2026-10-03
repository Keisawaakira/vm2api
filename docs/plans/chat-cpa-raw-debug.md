# CPA Chat conversion, caller-owned system, and temporary raw diagnostics

2026-09-24. User-authorized bounded protocol/logging refinement. [Context](../context.md). Parent owns design/Git; one source writer at a time. Independent readers use frozen inputs until a milestone is stable.

## Baseline / orientation

- Target main `12dc3d8`; starting test `463a97c`; common base `2e9d7d0`. Preserve all existing test safety/accounting contracts while rebasing the single integration commit onto new pricing/fast-mode/Haiku-affinity changes.
- CPA reference `c404af96`, frozen under the evidence directory recorded in context. Do not alter the nested reference checkout.
- Demonstrated drift: valid caller format requirements disappear after persona heuristics; multiple system blocks can be joined before whole-prefix deletion; only derived/capped logs exist; helper-level resemblance has been called parity without checking the active pipeline.
- Existing native transport is retained. Its opaque final wire cannot be made observable by pretending the Node envelope or an assembled response is a capture.

## User-owned invariants and authority

The user's September 24 request explicitly chooses CPA transformations, caller-system preservation, and nonstream raw diagnostics to investigate ignored formatting. Their specific requirement — caller blocks must not be misdeleted and their count must remain — overrides any reference cloaking/filtering that would itself remove/reorder caller material. The user explicitly accepts restricting temporary capture to `stream:false`; streaming protocol correctness remains required.

| ID | Positive relation | Kind / status | Evidence / authority |
|---|---|---|---|
| A1 | Chat protocol mappings follow executable pinned CPA fixtures; project transport safety remains a separate layer. | prescriptive / chartered | User's explicit CPA request; parity fixtures + independent review required; not self-ratified. |
| A2 | Caller system text blocks are ordered immutable request material, distinct from generated context. | prescriptive / chartered | User's explicit preservation requirement and demonstrated loss; full handler-envelope checks required. |
| A3 | Raw observations retain source and provenance separately from assembled/client representations. | prescriptive / chartered | User's debug/export request; real reader -> storage -> authorized detail/export tests required. |

Values trace (AI-drafted): the trigger is proven loss and missing response evidence. Reuse current adapters, JSON debug records, retention and exports; avoid a second logging subsystem. Reject text-based provenance guessing and source-only/helper-only parity claims. Reject copying CPA's cloak when it violates the caller invariant. Reject silently changing the native transport or enabling crag. Falsifiers: any required caller marker/count/ordering changes, golden protocol mismatch without a named exception, or a raw label applied to transformed/truncated content without disclosure. The owner's discriminant is the unacceptable deletion of caller formatting rules and preference for inspectable nonstream data over new streaming-debug complexity.

## Sequence and budget

### M1 — rebase / reference freeze
- Preserve refs and frozen trees; compare both baselines.
- Replay 463a97c onto 12dc3d8, resolve actual conflicts by retaining measured usage and new pricing/fast/affinity behavior.
- Run focused old/new regressions before new feature edits. Rollback via backup or abort an unfinished rebase, never discard user work.

### M2 — conversion and caller-system (accepted source design)
- Rebase is complete at `c462c06`; 207 focused old/new tests passed. Source comparison is in `cpa-reference-review.md`. Portable official Go1.26.8 is checksum-verified under the evidence directory; no global installation. Executable CPA fixtures are now feasible and required for ordinary mappings.
- Scope is the Claude Chat adapter and its active Node processing, not copying CPA's HTTP cloaking. The user-specific caller invariant takes precedence over reference empty-block/cloaking deletion. Stronger error/cancel/committed-output and initial-content preservation remain explicit safety exceptions rather than hidden claims of literal parity.
- Chat requests bypass Node persona rewriting/search injection and client-usage masking; native slot persona configuration is unchanged and is not certified prompt-free. Chat-only preparation must not strip, join, normalize whitespace/budget text, move, or CCH-rewrite caller system blocks. Other protocols retain their current behavior.
- Use an explicit Chat preparation/preservation option through the existing request/transport seam. Build native session metadata separately from content so account/session affinity remains while caller text is untouched. Preserve native cache-marker ownership/selected TTL as a clearly documented transport boundary, not a claimed CPA HTTP-wire port.
- Keep public helper compatibility where possible. A Chat-only response accumulator may preserve raw tool JSON strings and metadata while the existing Message assembler/verifier independently decides transport success. JSON output must not be rebuilt solely from parsed tool objects if that loses CPA argument text. Do not duplicate the whole gateway or remove error/terminal protections to get a golden comparison green.
- Enumerate request/response/effort/executor behavior against CPA source; generate golden fixtures from actual CPA functions where possible using temporary Go >=1.26 tooling, not a deployed proxy.
- Preserve each accepted Chat system/developer text block in input order with its text unchanged. No joining, content-pattern deletion, or relocation into user content. Protocol mapping from Chat roles to Messages system array is explicit; arbitrary invalid content shapes are not a promise of native support.
- Keep identity/session/credentials separate from caller instructions. The active Chat path must not run persona/CLI transformations that defeat preservation. Other protocols keep their existing behavior unless a narrow shared correctness fix is required.
- Match JSON and SSE conversion, including empty tool arguments, unknown tool indices, multiple blocks, stop/error/usage fields and request parameter mapping. Preserve no-replay-after-commit/cancel and truthful raw accounting.
- Tests must traverse actual handler and worker-envelope boundaries, not only pure conversion helpers. New preservation/parity cases must fail before the fix.

### M3 — temporary nonstream raw diagnostics (accepted seams)
- Control: `logging.raw_nonstream_debug`, default false, effective debug log mode required; only explicit original `stream:false` Claude Chat requests enroll. Existing per-request debug headers cannot bypass the server toggle. Auth failures/invalid JSON cannot enroll. Codex-platform inference stays out of this scoped capture.
- Reader seam: optional `readBody` callback after successful JSON parse receives original UTF-8 text before any caller mutation. Capture is request-local, append-only and optional; one collector observes each real low-level Node send/read, not just handler events that can be withheld before commit.
- Record seam: one versioned `raw_debug` object in existing debug JSON holds original caller text, ordered attempt/hop IDs and sources, exact Node-bound body JSON, original upstream SSE/JSON text, allowlisted initial/trailing metadata, completion/truncation status and separately labeled derived output. No auth headers, proxy URL/credentials or full API transport envelopes.
- Limits: 16 MiB aggregate raw UTF-8 capture budget per request, at most 16 hops, at most 4 active collectors; excess gets explicit omission/truncation metadata without affecting inference. Export limit is 32 MiB of complete JSONL records, with row/byte truncation reported; never silently clip a body while calling it complete. Keep existing retention, including warning that downloads/backups survive it.
- Access: temporary raw evidence is admin-only, separately requested via `include_raw=1` for detail/export. Legacy details/summary ACL remains. Strip/project raw data from debug-list queries before large-record parsing. Existing CSV/summary JSONL behavior remains; raw JSONL export opts in and uses safe bounded record iteration/backpressure or bounded preselection.
- Finalization: a once-only enrolled-request finalizer persists after upstream cleanup on normal finish, error or client disconnect; callbacks cannot throw into inference. Use a distinct internal capture/persistence identity for raw-enrolled requests so reused external X-Request-ID cannot overwrite/cross-read raw evidence; keep public correlation separately visible.
- UI: warning switch in existing log settings, clearly labeled raw/derived sections in request detail, and explicit raw JSONL export option. No second store, new migration, payload console output or unsafe HTML rendering.
- Add explicit opt-in capture under existing logging settings, default off. Only authenticated Claude Chat calls with client nonstream and active debug logging capture full raw payloads.
- Preserve original request JSON before mutation; capture each Node upstream send/response before parser/persona changes, retaining attempt identity, raw JSON or SSE data plus raw text, and separate derived Messages/client output.
- Reuse `request_log_debug.record_json`, retention and cleanup; avoid schema migration/new storage. Never capture auth headers. Warn that exact bodies can contain sensitive caller data.
- Details and opt-in export include full capture; normal/debug lists must not bulk-return payloads. Size limits and partial/error/cancel captures must be explicit. Uncaptured/expired data is absent, never fabricated from summaries.
- No added capture cost for stream:true or disabled mode; no extra upstream request or auto-continuation.

### M4 — late upstream integration
- During final verification main advanced to `493db3e` (v1.3.48), with sticky alias/empty-pool recovery and Haiku device_id binding plus migration023. Freeze that baseline, preserve the reviewed M2/M3 changes as commits, then rebase them onto it. Do not accept an ancestry check alone: rerun new pool/sticky/migration and shared protocol/raw regressions, inspect conflict resolutions, and compare full failure sets.

Status: M1–M4 are implemented and locally verified, with independent follow-up acceptance. Final source9f8a158 is based on main493db3e(v1.3.48); all three replayed patches compare equal. Native-wire/runtime limitations remain. See the [combined report](../reports/2026-09-24-raw-nonstream-debug-implementation.md) and [M2 report](../reports/2026-09-24-chat-cpa-conversion-implementation.md). Final closure is documentation only; no push/deployment.

Serial review budget: one coherent conversion slice and one logging slice, each independently reviewed before closure. Prefer existing modules with only small domain helpers; no generic protocol/plugin/telemetry engine. Escalate any need to change native binaries, authentication policy, or the user's transport selection.

## Validation and closure

- New TDD failures observed against rebased code; executable CPA goldens compared where tooling permits, otherwise mark the specific verification gap rather than claim equality.
- Full-pipeline system count/order/text preservation across global/slot personas, models, success/retry and supported content shapes; meaningful source-to-envelope artifacts.
- Raw body/response fixtures through actual reader, persistence, owner-filtered detail/export, retention and disabled/streaming controls. Include payloads larger than old 200k preview cap, errors, multiple sends and callback/cancel failure paths.
- Targeted tests, both full Node baselines/final failure-set comparison, frontend tests/format/build and fresh independent protocol plus logging/privacy review. Runtime/native inference is not a gate we can claim passed without running it.
- Commit locally only after accepted checks; no push, deployment, paid requests, service startup, platform shim, or old patch/CPA edits. Record exact enabled settings/export instructions and native limitations. Cancellation leaves completed commits and a precise partial-state report, not false completion.
