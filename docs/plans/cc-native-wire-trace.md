# CC native wire trace

User-authorized on 2026-09-27: prioritize the actual CC outbound/response path, export the complete diagnostic chain, investigate multi-round/first-round loss, inspect Pi's adaptive switch, and rebase. The parent is the only writer. One read-only Pi reviewer investigates that clone; a second read-only reviewer checks the new capture boundary, with bounded follow-ups for concrete findings.

## Baseline and destination

Rebase from test8acafbf onto main46be5c0 (v1.3.63 plus full-OAuth-scope fix). Preserve the owner's deleted historical candidate binaries and both immutable approved fixed pairs. New upstream ordinary wrap kernel does not replace the fixed kernel. Pi reference is the independent clone at2b0a123.

The existing raw log begins at Node/kernel; it cannot establish what CC sends or consumes. The desired relation is one admitted diagnostic request -> one nonce-bearing native job -> every observed API exchange and CC output frame -> the existing protected raw log. A native HTTP exchange is not inferred from a Node hop, and a successful/partial capture is distinct from inference success.

## Scope and chosen mechanism

Use Bun preload and a small shell launcher around the **unchanged cc-fixed ELF**. The initial AsyncLocalStorage/enterWith prototype passed Bun1.4.2 but crashed a compiled Bun1.3.14 control (the fixed CC runtime version), so that mechanism was rejected before shipping. The implementation does not change async context: it associates the preserved messages object with its native job, follows exact serialization/CCH parse cycles, and matches final request bytes. Indistinguishable bodies (including late or previously retired serializations) are marked ambiguous and omitted rather than guessed. Bounded ownership hashes are registered before admission; exhaustion disables correlation for that host. Compiled Bun1.3.14 controls now cover concurrent fetch/HTTP2 jobs and the CCH cycle. This remains a local miniature-host control, not a Linux CC run.

- Opt-in `logging.cc_native_trace`, default false; requires the existing Debug + raw nonstream enrollment. Only `cc-fixed` is supported initially. No automatic slot switch/restart; applying/restarting the selected data plane installs/loads the hook. Disabling stops new tickets immediately even if the hook remains loaded.
- Launcher sets the preload path, then execs the original fixed CLI with identical arguments. Existing incompatible Bun preload options are rejected, not silently replaced. Binary/approved manifests remain immutable.
- An admitted Node hop creates a bounded, private, expiring ticket in that VM's trace directory and adds a reserved trace nonce under metadata (never changes session/device ID strings). The preload recognizes only actual stdin native-job frames, claims a matching ticket, removes only this reserved control field, and associates the request/messages identities with that job. No authorized ticket means no native body capture.
- Observe final global/undici-fetch and node:http2 request bytes, response status/allowlisted headers/body bytes, and CC's actual stdout protocol frames. Bun's live module-export replacement API (named mock.module) updates captured HTTP2 imports; its replacement delegates to the original transport and never fabricates replies. Fetch readers are observed passively, without clone/tee/drain; json() consumption is explicitly a parsed view if raw bytes were not observed. Do not toggle thinking, change prompts/tools, issue continuation requests, suppress errors or add retries. Preserve original response objects, write return values and abort signals.
- Node collects after transport settlement. Only kernel success with an actually observed native producer may wait for CC's own terminal and already-observed pending responses, capped by the admission-time inference deadline and client cancellation. Absent producers and failed sends retain a short startup grace. This opt-in diagnostic can delay nonstream responses but never starts another call. File paths, size, nonce, sequence, response metadata, terminal and API counts are validated before attachment under `raw_debug.hops[]`; then that request's files are removed. Missing/partial/unmatched evidence is explicit. Existing admin-only raw detail/export, hidden default views, retention and byte limits remain authoritative.
- HTTP/2 bodies may still be compressed; preserve original bytes and label any bounded decompressed view separately. Do not advertise parsed or decompressed objects as original wire bytes.

## Limits and safety

No plaintext auth/cookie headers, secrets from process environments, real local credentials, production service startup or real-provider replay. Private bodies are intentionally sensitive and remain behind explicit raw-log access. Tickets and sidecars use fixed names under the selected VM, no-follow/size checks, single-use claims and bounded retention. Log errors never trigger another upstream call. Stream cancellation/negative terminal handling stays unchanged. Logging does not wait indefinitely for response EOF or future API calls; it records its observation window.

R3 runtime decisions (turn continuation, model effort, production fixed binary replacement) are outside this observational change. In particular, normal end_turn will not be changed into automatic continuation. The regex hypothesis is not used as the diagnosis.

## Files and validation

- `src/lib/transport/cc-native-trace-{preload,hook}.mjs`: isolated producer and transport observers.
- `src/lib/transport/cc-native-trace.mjs`: trusted Node tickets, collection and installed hook paths.
- Existing fixed materializer/supervisor, logging config/rollback, worker transport and raw collector: small integration points.
- Existing log UI/raw export: status and optional native views, no second export store.
- Focused tests: disabled/no-ticket/forged/expired cases; concurrent jobs and unrelated JSON; request/response byte equivalence with/without tracing; no auth-header exposure; HTTP/2 framing/compression; UTF-8/limits/errors/cancellation; actual Node handler-to-export fixture. Run a compiled Bun miniature native host with fake/local transports, plus static checks of the fixed CLI's stdin/API/stdout seams. No live providers.
- Keep the prior offline candidate round closed and historical binary deletions intact. The new observer has no replacement ELF. Deployment acceptance requires the first real trace to confirm the nonce traversed the kernel and that the expected hook/image were observed; missing evidence must remain unavailable/partial rather than be substituted with Node-only data.

Acceptance must distinguish implemented/local controls from the still-unavailable deployment-native capture. The user then supplies the actual short-response trace; this round must not claim its unique cause without that evidence.

## 2026-09-27 evening follow-up

The supplied cc-path log enrolled a managed key and sent the nonce, but returned unavailable/native_trace_not_observed. No native API body exists to reconstruct. Add bounded metadata-only process readiness snapshots, expose them through existing VM detail/overview and unavailable raw reports, and explain activation without changing keys or issuing model calls. Never use these aggregate counters to attribute unadmitted bodies.

Full-entry inspection corrects the earlier fallback lead: the pinned native loop explicitly sets CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1. Nine original stdin/dispatch/stdout functions compiled under Bun1.3.14 confirm that flag and local capture, with query boundaries simulated. The runJob-only ordinary-assistant filtering control does not establish default native fallback reachability or the live short-answer cause.

Bootstrap usage diagnostics must preserve explicit terminal errors and read bounded sanitized existing output on status refresh. Keep hello/usage success separate; no new auth endpoint, speculative fallback, credential rewrite or automatic reinitialization. New download surfaces whitelist diagnostic fields only. Follow-up implementation and validation are by the main agent; no new subagent or actual Linux/provider execution.

## Authorized undici/cloud-response repair (2026-09-27)

The two cc-path-r2 logs have real native stdin/stdout but no HTTP evidence. Exact-source reproduction identifies the uncovered undici.fetch selector. Add observation at that actual boundary, preserving the existing Agent/dispatcher rather than forcing global fetch or node:http2. Use the same ownership and privacy contract; unsupported bodies or binding failure stay explicit.

Cloud response evidence is the API response stream delivered to the SDK, not CC stdout. EOF is distinct from message_stop and native job_done. Existing pending API responses may outlive native terminal and remain observed until completion/cancellation/deadline. A consumer that cancels or returns before EOF must be partial; hypothetical unread future cloud output cannot be inferred or forced by draining the stream. Test actual multiple-call and late-content shapes, not only long single replies.

Repair /usage semantic text extraction (assistant.message.content, bare message content, result text, empty-result fallback); preserve explicit errors and structured quota precedence. Diagnostic exports distinguish bounded file reads from semantic text/excerpt clipping and can re-read old outputs without rerunning initialization. Tests should execute the original undici selector under compiled Bun1.3.14, compare trace-on/off byte/attempt behavior, and cover concurrency, early terminals, cancellation and error priority. Fixed binaries and inference behavior remain unchanged.

Local closure: exact-selector compiled Bun controls cover multiple calls, late bytes, early SDK cancellation, unadmitted ownership and expiry. Reviewer accepted trace behavior and independently found two usage-container regressions; shared container normalization closed both, including incomplete structured-report precedence. Final affected Node gate is605 passes/28 declared pre-existing skips; frontend167 passes/format/build. This is local acceptance of the diagnostic/parse correction, not proof of the live short-answer cause or a ratification of a new inference policy. Evidence is in Temp/vm2api-undici-fix-20260927/.
