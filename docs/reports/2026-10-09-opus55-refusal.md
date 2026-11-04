# Opus 5.5 refusal: captured provider terminal, then local exact guard

2026-10-09 UTC. Evidence-only investigation of two owner-supplied JSONL files under `logs/5-5-reject`; no provider replay or change to refusal policy. Full private comparison artifacts are in `Temp/vm2api-opus55-reject-20261009/`. Source inspected at83ecb15d; the owner's subsequent aa2459af squash differs only by8 removed historical v1108 files. Active v1124 and functional source are identical.

## Observations

- The requests are identical. First completed13:41:10.950Z with one Node hop; second13:43:18.785Z completed in21ms with zero hops and exact refusal guard.
- All36 caller system blocks (66097 UTF-16 characters),319 user/assistant history messages, `claude-opus-5-5`, adaptive/summarized thinking, `effort:max` and `max_tokens:128000` reached the observed final API request. Two independent framework system blocks precede the caller blocks. This request used no numeric thinking suffix and no explicit safeguards field. Trace runtime image matches current CC730fd4f2.
- The captured API HTTP status is200. Its observed SSE consists of message_start, then message_delta with `stop_reason:refusal` and `stop_details.category:reasoning_extraction`, then message_stop. Output is0 and no content blocks were observed. Input usage reports4 uncached and214465 cache-creation tokens; no subscription-charge conclusion is derived from that.
- The SDK stops consuming via iterator return, so HTTP EOF is not confirmed. Overall trace status correctly remains partial, but an Anthropic refusal terminal was already received. Do not confuse these distinct boundaries or call the response a lost long answer.
- CC emits a generic Usage Policy400/`upstream_invalid_request` job error, hiding the provider's specific terminal details from the Node result. Node's existing refusal classification stores the refusal; a read-only control reproduces the next exact-fingerprint guard. This is not a second independent cloud rejection.

## Interpretation and limits

The provider categorizes the request as reasoning extraction; this is not independent proof of the user's intent or a specific matched phrase. Of the supplied system text, the most relevant wording is in `messages[34].content`, line4: it explicitly describes output HTML comments as the model's thinking process; `messages[33].content`, line32, requires per-paragraph planning/self-check comments. This is a source-based hypothesis, not a proven trigger. Private original wording is intentionally not committed here. Ordinary output tags alone are not shown to be the trigger. No prompt rewrite to defeat a refusal, guard disable/clear, fallback model or extra inference was performed.

New upstream main has model/field beta and SDK wire compatibility changes. Those need independent bounded integration; neither the existence of those changes nor this provider category proves they caused or will remove this refusal.

## Bounded display correction

The admin-only, explicitly revealed raw panel now derives a small API-response summary from existing `native_trace.details.text`. It displays provider HTTP status, each observed Message stop reason/category/explanation, and separately whether message_stop and HTTP EOF were observed. It handles complete raw JSON and delimited SSE, multiple messages, partial final frames and unavailable/encoded bodies conservatively; it does not infer an event from a word appearing in business content. Summary limits are labeled without altering the full export.

Partial API reads no longer get blanket instructions to restart/reload a correctly running preload. Unavailable capture still points to the VM readiness view. Existing raw ACL, lazy fetch and gc0 behavior remain; text is escaped and never rendered as HTML. Backend responses, refusal rows, request fields, native capture status and JSONL bytes are unchanged by this display work.

Before rebase:82 supplied-byte/guard comparisons and12 actual TypeScript/React summary checks passed;15 new frontend cases,369 total frontend tests and33 existing guard/export/routing tests passed, with forced TS/format/build. No actual model/native Linux invocation. Final rebase/native validation is recorded separately in the active context and closure.json; this report does not certify that legitimate future requests will never be refused.
