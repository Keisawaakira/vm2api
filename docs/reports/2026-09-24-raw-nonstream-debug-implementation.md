# Temporary raw nonstream diagnostics

September 24, 2026 (UTC+08:00). Implemented over accepted M2 commit `0fc9322`, which is based on main `12dc3d8`. A later main v1.3.48 integration is a separate final gate. This report attests Node/SQLite/UI source and fixtures, not native/provider inference.

## Implemented contract

- `logging.raw_nonstream_debug`, default false, requires effective Debug plus authenticated original-Claude Chat and explicit boolean `stream:false`; server off overrides request debug headers for raw capture. Candidate enrollment is bounded before mutation, then discarded for non-Claude dispatch after interception. Original Codex→Claude rewrites are conservatively excluded.
- The original valid UTF-8 JSON string is retained from the single HTTP body read, preserving whitespace, duplicate keys and numeric spelling. Captured requests use new server IDs for logging/attempts/response headers, while retaining original caller correlation separately. Ordinary request IDs are unchanged.
- Actual finalized Node-bound body JSON and response chunks are observed below parser/commit gates. Native and API-kernel sends carry real hop/attempt/repair/local-connect provenance; they do not claim provider invocation. Raw JSON/SSE text and separate initial/trailing metadata are distinct from derived Message/client JSON.
- Collector bounds:16 MiB aggregate retained text/metadata/derived data,16 retained hops,4 active collectors. Limits do not truncate inference; omissions/truncated contiguous UTF-8 prefixes/read incompleteness are explicit. They are not process-RSS guarantees.
- Existing debug JSON rows/retention are reused, no migration/new store. Raw rows are insert-if-absent and protected against later legacy upsert ID reuse. Unredacted data lives only inside raw_debug; summaries and ordinary debug previews do not receive it.
- SQL removes raw_debug before list/default-detail transfer to Node. Explicit admin include_raw is required for full detail/export; super/user cannot bypass it. Existing ordinary owner ACL and summary CSV/JSONL remain.
- Raw export preselects actual serialized BLOB byte lengths, sends exact stored JSONL records up to32 MiB and the existing row cap, reports unavailable/oversized/limit omissions, and never clips records. Supports exact single-record IDs and backpressure/disconnect/error handling.
- Existing UI has a warning toggle, lazy admin reveal, bounded full JSONL download, separately labeled source/hop/read/capture status, and a24000-character preview only. Custom export headers are exposed; missing headers no longer make a successful nonempty single-record download look unavailable.

User instructions and record layout are documented in `docs/PANEL_API.md` under temporary raw diagnostics. No deployed setting was enabled, no service started and no model request issued.

## Observed failures and corrections

Initial reader/store tests were red before the feature. Additional discriminators found and corrected:

- Failure to restore the raw flag and effective logging settings after a failed routing save. The final API PUT and legacy admin PUT/POST paths snapshot/restore actual live logging, including absent config sections and environment-derived values; dormant engine rollback receives the same snapshot.
- API response already received, but date Retry-After or bookkeeping errors could throw before observation and leave it live/unread. The API wrapper now owns cleanup, records actual status/metadata before bookkeeping, preserves thrown failure, and labels unread evidence partial. Valid HTTP-date Retry-After remains a normal429 rejection. This cleanup is independent of raw enrollment.
- Truncated UTF-8 components could append later ASCII after skipping an unfittable emoji. They now freeze a contiguous retained prefix while counting remaining observations.
- A normally completed destroyed response could be misclassified as cancellation; writableFinished now distinguishes it. This is Node write completion, not client application receipt.
- Export write-error wakeups must not continue to another record; raw export stops on close/error, not only on false drain.
- A proxy hiding custom count headers is not evidence of zero exported rows; single-record UI can download the nonempty body and reports statistics as unknown.

Parent's final regression group observed16 failures/2 passing controls, then18/18 passed. This group covers four API response/lifecycle cases and14 effective-logging rollback/success cases. Three added UI header-response cases were red then green. All fixes stayed in existing seams; no generic tracing/configuration framework was added.

## Verification / review

- Parent final related Node run:196 passed, no failures/skips.
- Parent full run before final main update:2146 tests,2071 passed,25 failed,50 skipped, zero cancelled;8/178 files failed. Exact file+test-name comparison to rebased baseline1872 tests has no new/resolved failures. Eighteen of the skipped cases are the documented CPA-alias comparisons from M2, not platform skips.
- Parent frontend:138 tests /26 files, format and TypeScript/production build passed. Existing nonfatal large-bundle warning is not a compile failure.
- Independent capture follow-up:80 raw/terminal tests,45 M2 checks and8 independent probes passed; the original API exception triggers passed with raw on/off.
- Independent privacy/UI follow-up:18 Node cases,8 frontend cases, independent12-case rollback matrix and6 actual-component download scenarios passed. Initial broader review also verified projected SQL, admin/owner gates, raw row immutability, cap behavior, actual QueryObserver laziness and transpiled TSX event behavior.
- No blocker remained in either bounded follow-up. Frontend validation is unit/SSR/event-handler/build evidence, not a deployed browser/proxy audit.

The implementation worker reached its run deadline during final reporting, after successful source/full tests and a last optional sample-writing test hook. Parent reran/formatted that hook, generated/inspected the actual exports, reran the full/targeted/frontend gates, and applied the independently found corrections. The timeout was not treated as implementation acceptance.

## Concrete exported artifacts

Evidence root: `C:/Users/zemingxi/AppData/Local/Temp/vm2api-cpa-debug-20260924-2045/`.

- `m3-native-raw-export-sample.jsonl`:424717 bytes, actual reader→handler→mock HTTP boundary→SQLite→authorized export, source node_kernel.
- `m3-api-raw-export-sample.jsonl`:424499 bytes through the corresponding API-kernel path.
- Each retains the exact210202-byte original caller JSON, separate two-block system request,404-byte CRLF/emoji/EOF-tail SSE and separate derived outputs. They are synthetic in-memory inference fixtures, not provider calls. IDs/timestamps vary per rerun; final bundle manifest records current hashes.
- The earlier201-byte `m3-raw-export-sample.jsonl` is only a synthetic store/export fixture, not the full pipeline proof.

Initial/follow-up review reports, red/green logs, complete failure-set comparisons, source-shape checks and frontend outputs remain alongside the artifacts.

## Residual boundaries

Raw records may contain secrets; downloaded/backup copies outlive retention. Input can exceed evidence limits, and JSON escaping can make a legally captured row exceed export size; explicit omissions are not full evidence. Cleanup issues destruction before promise settlement but does not certify every operating-system socket close or native/provider cancellation acknowledgment. Exact native prompt/cache/effort behavior and the real short-output root cause remain unverified. Existing Go OAuth/crag risks were not repaired. No remote push or deployment occurred.

## Final v1.3.48 rebase and combined acceptance

Final source tip is `9f8a158` on main `493db3e` (v1.3.48). Backup `backup/test-before-main148-20260924-232052` retains the accepted pre-late-rebase tree `1e9466f`. All three replayed commits are patch-equivalent in range-diff: c462c06→051f890, 0fc9322→509f63b, 1e9466f→9f8a158. The accepted-tree→final delta has the same stable patch ID as upstream12dc3d8→493db3e; no conflict resolution altered the accepted implementation.

- New upstream sticky aliases, empty-pool error priority and Haiku device_id behavior remain. Independent migration checks upgraded in-memory schema001–022 to023, preserving legacy sticky rows and byte-identical raw JSON; fresh initialization, nullable column/index, rebind preservation and idempotency passed. No live database was migrated here.
- Independent actual-handler probes covered three device metadata encodings and21 mocked sends: raw on/off changes only protected request IDs, not tenant/device parent selection, sticky keys or outbound session identity. Accepted caller/CPA/raw/ACL/terminal contracts also passed the final integration review.
- Parent final core:338 pass /0 fail /18 declared CPA-alias skips; two targeted new/updated pool-scheduler contracts also pass. The broader431-case selection had412 pass /1 failure /18 skips; the one failure is the independently reproduced pre-existing Windows pool-scheduler teardown EPERM, not hidden by the narrower green gate.
- Parent final full Node:2148 tests,2073 pass,25 fail,50 skip, zero cancelled,8/178 files failing. Exact failure names match the original/rebased/pre-late-rebase baselines. This is no-regression acceptance, not a globally green suite.
- Final frontend:138 tests, format and production build pass. Actual handler raw JSONL exports were regenerated and asserted on the final branch. Final manifest stores their hashes and the test/review artifact hashes.
- Fresh M4 review found no new integration blocker:199 passing focused tests/probes plus successful migration assertions, and the same known teardown failure. The reviewer did not claim full/frontend/native execution.

Evidence additions: `main148-range-diff.txt`, `main148-final-comparison.json`, `final-main148-review.md`, `main148-core-green.log`, `main148-new-pool-green.log`, `main148-final-artifacts.log` and `final-evidence-manifest.json` in the existing evidence root. Final closure adds documentation only; production behavior remains the tested9f8a158 tree.
