# No-format investigation: CCH ownership and suffix display

2026-09-30 request; baseline test3c7cb5e. Parent-only bounded repair, implemented and locally verified. No provider/model request, deployment, credentials, configuration or binary changes. Raw logs remain immutable. Evidence directory Temp/vm2api-no-format-20260930/.

## Evidence and invariant

The two supplied logs are dated Sep28 (manual10000, old repaired CC) and Sep30 (manual60000, current v186 repaired CC). Caller system blocks and selected manual budgets reach the CC stdin. CC stdout matches kernel and Chat text/reasoning. Both reports are partial: one undici correlation_gap/unowned_api_send and zero owned API exchanges. Current hook is loaded. Native stampCchBody performs a literal string replacement after serialization; the existing synthetic fixture's parse/stringify CCH mutation does not cover this path.

Preserve actual request/response bytes and owner identity independently. A trace may inherit ownership only from a previously observed exact serialized value through the exact native CCH replacement operation; never associate by latest job, similar text, response model or timing. Unowned, expired, ambiguous and retired values remain unowned/partial. No forced read, async-context changes, invented API evidence, second inference request or hidden native modification.

## Changes and tests

1. Add a fixture using native stampCchBody's literal replacement and actual CCH checksum calculation; demonstrate unowned send in existing hook. Cover string/byte sends, repeated API calls, late response/early native stop, concurrent owners and earlier unadmitted bodies. Compare traced/untraced outgoing and stdout bytes under compiled Bun1.3.14.
2. Narrowly observe that raw-string replacement and transfer existing exact ownership to the returned string, without changing arguments, return values or exceptions. Observe unknown/retired inputs conservatively even before admission. Preserve all current collector/grace/size/read-completeness controls.
3. Log model comparison recognizes supported Claude thinking suffixes as request parameters, not a new model. Preserve original names in storage/export, do not migrate old records. Frontend corrects the same old false flag only for this known normalization; expose requested suffix meaning without pretending it is observed cloud execution or actual thinking usage. Genuine model changes and absent/unknown names retain existing mismatch behavior.
4. Run trace/evidence/readiness, model-log and frontend regressions; rebuild committed web/dist. No changes to inference model parsing, budgets, system preservation or fixed binaries. Captured cloud response for the supplied historical records remains unavailable and cannot be backfilled.

Verification: compiled Bun1.3.14 native-CCH cases (including identical/unknown/retired-style ownership controls, bytes, multiple responses, early terminal and cancellation) pass; a zero-checksum unchanged-value counterexample was also observed red then fixed. Actual current CC CCH code matches12 neutral fixture inputs. Actual converters reproduce both historical requests/replies. Backend/UI red cases now pass, including actual detail component rendering. Final affected Node:464 passed/18 existing skips/0 failed; frontend181 plus format/TS/build passed. Raw logs and all binaries/inference settings remain unchanged.

This repair is logging-only and does not establish a root cause for live format noncompliance. No review delegation is authorized for this turn; fresh executable controls and byte comparisons provide bounded local evidence only.
