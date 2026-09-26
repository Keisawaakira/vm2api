# Executable CPA Chat oracle

Reference: `c404af96ebacedf8168b3c2bdbf4449a21cd1c1e`. Tested with the portable official Go 1.26.8 Windows SDK. No CPA server, model updater, provider request, native kernel or CLI is executed.

## Regenerate

From the vm2api root:

```sh
node test/support/cpa-oracle/generate.mjs <frozen-cpa-directory> <go-executable> <temporary-cache-root>
```

The script checks the reference SHA, copies `main.go` to a temporary command beneath the reference module (required for Go internal imports), invokes `go run -mod=readonly` with `GOTOOLCHAIN=local` and temporary `GOCACHE`/`GOMODCACHE`/`GOPATH`, and removes that command afterward. Locked module downloads are permitted. It writes `test/fixtures/cpa/goldens.json` and the exact thinking/output-ceiling projection in `src/lib/protocol/chat-cpa-capabilities.json`; it does not alter the reference translators or module files. Go dependency verification remains enabled.

`inputs.json` contains exact request JSON strings and ordered event objects. Events are compacted into actual single-line SSE before invoking CPA (passing indented JSON directly to a line-oriented buffered converter would be an invalid oracle). Inputs use fixed upstream IDs, requested/upstream models and tool IDs. Goldens retain real timestamps. Node comparisons normalize response `created` timestamps only, never fixed identities, model names, text, arguments or field presence.

Executed stages:

1. `ConvertOpenAIRequestToClaude` from the actual registered package.
2. SDK `TranslateRequest(OpenAI, Claude)` including summary extraction/application.
3. `helps.ApplyThinkingWithSourcePayload`, with the registered Claude thinking applier and embedded pinned capabilities.
4. SDK registered `TranslateStream(Claude, OpenAI)` and `TranslateNonStream(Claude, OpenAI)` on the same SSE history.

There are 136 fixture cases and 17 embedded Claude capability records. Tests compare final request+summary+thinking fields and streaming/buffered responses. Eighteen unknown CPA aliases are explicitly skipped as parity comparisons (CPA uses a user-defined fallback there); the approved vm compatibility mapping is tested separately. Executor forced-tool/sampling normalization is a small source-aligned Node function tested through real preparation, not represented as an executed CPA HTTP executor/cloaking stage.

## Intentional boundaries and deviations

- Caller system/developer **text and block boundaries** override CPA's empty-string deletion and optional HTTP cloaking. Empty/whitespace strings survive. Bare string array items, `input_text` and `output_text` are supported text extensions; nontext system shapes produce HTTP 400 before any send. Explicit operator intercepts remain authoritative, not automatic cleanup.
- No Node persona/search injection, budget rewriting, system joining/prefix/fingerprint deletion, text relocation or CCH sealing on Chat. No Chat client usage masking. Native slot persona configuration is unchanged and opaque.
- Caller metadata identity/settings are still sanitized; selected slot/account/session identity is separately constructed. CPA's deterministic `metadata.user_id` is not substituted for native identity. Request tests assert this exception separately before comparing all remaining fields.
- CLI cache controls are still removed, and selected TTL is carried separately in the worker envelope. A converter-owned, non-wire response-format hint preserves existing schema-title TTL classification only while its generated instruction remains unchanged after interception. No native cache/wire claim follows.
- Haiku is disabled only at the existing CLI preparation boundary. Pinned models use actual CPA capabilities; unlisted vm-valid models retain vm policy. Routing catalogs are not replaced. Known-model Chat uses top-level `reasoning_effort`, not the old nested amount alias. Explicit auto/none/max are not overwritten by generic fill. Forced tools remove thinking/effort, never change the caller's choice to auto.
- `response_format` appends its own final system instruction, not `output_config.format`. Parsed ingress cannot retain raw schema JSON lexical whitespace; generated schema JSON uses `JSON.stringify`. All caller-owned text remains exact. Golden request strings deliberately supply canonical compact schema JSON so their generated instruction text is directly comparable, not normalized after conversion.
- Chat drops unsupported vendor fields such as speed/service_tier/root thinking/root output_config/stop_sequences, consistent with its CPA mapping. Other Messages/Responses/legacy Completions shaping remains on existing adapters. Remote image materialization remains native CLI compatibility.
- SSE uses raw upstream ID, requested model, one created time, role-only opening, completed tools at block_stop, unknown-index exclusion, `{}` fallback and raw argument strings. JSON uses upstream model and accumulated SSE data. Additive usage exposes CPA cached_tokens/cached_creation_tokens/cache_write_tokens aliases.
- Negotiated usage is retained: `include_usage:true` keeps null intermediate usage and emits one reconciled EOF trailer; omitted include_usage keeps message-delta usage and no unsolicited trailer. Native reconciled usage wins over SSE snapshots.
- Initial message/block text/thinking/tool input is preserved despite CPA losses. Nonempty initial tool objects (and initial Message tool objects) may flush at a real terminal without block_stop; partial JSON deltas are not treated as completed streamed tools. Refusal text remains an explicit extension; signature/redacted placeholders are not fabricated into reasoning.
- Streaming second message_start or content after a terminal becomes a sticky error with no successful DONE/replay. Allowed usage/stop/metadata follow-ups remain accepted. Nonstream concatenates sequences with last ID/model and preserves every tool even when indices are reused (CPA's index map can overwrite earlier tools). Incomplete sequences and explicit failures still fail the Message verifier.
- Real length/refusal/sensitive reasons are not replaced with tool_calls merely because tools exist. EOF metadata can correct nonstream stop reasons; an already-delivered contradictory streaming finish cannot be retracted.

These fixtures certify inspectable conversion stages and the tested Node serialization boundary, not the closed native kernel/CLI's final Anthropic request, prompt, cache efficiency, thinking execution or live short-output cause. Raw diagnostics are a separate feature; see [the panel API documentation](../../../docs/PANEL_API.md).
