# Chat → Claude and fork deployment plan

Status: implemented locally; focused verification passed; full baseline failures and live/independent acceptance remain open. Context: [current inspection](../context.md). Evidence: [implementation report](../reports/2026-09-22-chat-claude-fork-implementation.md).

## Scope / authority
R2 bounded refinement authorized by user's request: “请你直接修复，将cliproxy的整个chat-》message的转换搬过来”; fork target “https://github.com/Keisawaakira/vm2api.git”. Human accepts live WSL behavior; local verification is not independent acceptance.

AI-drafted structural target (prescriptive, chartered by the bounded request, closure_authority=false): the request's reasoning/content/tool semantics are represented in the final Claude body; deployment builds that same checked-out source. Values trace: demonstrated max→budget/high mismatch and image-only compose; reuse existing Node modules and compose override rather than add a Go translator service. Reject one-line budget increase and repo-URL-only patch: neither fixes the complete path. Falsifier: hop changes max/display or installer still uses upstream image. No new public architecture.

## Invariants / non-goals
- Preserve user's existing uncommitted edits; no automatic commits/pushes or live service changes.
- Preserve native Messages, response/SSE conversion, VM identity, Codex/web-search support and native structured output. These are explicit vm2api adaptations rather than byte-identical CLIProxy output.
- User-supplied token ceilings remain user-owned; manual budgets fit within them. Do not promise fixed reasoning duration.
- Keep `.env`, `vms`, `data`; refuse dirty tracked source overwrites. Build failure must not report success. No destructive clean or automatic rollback of user data.

## Files / interfaces / review budget
- Existing thinking helpers: source reasoning + target model → adaptive effort or manual budget, summarized visibility unless explicitly excluded.
- `chat-messages.mjs` request message/schema/choice helpers, imported from `convert.mjs`; `images.mjs` gains file blocks. Port reference behavior for role accumulation, cache controls, last duplicate tool result, tool ID sanitation, object-only arguments, schema unions, allowed/parallel tools. Keep changes confined to request conversion (~400 implementation lines).
- `deploy/install.sh`: repo/ref selection → safe source checkout and explicit two-file compose build; image→source migration staged without touching runtime state. `docker-compose.build.yml` marks local build/no pull.
- New unit tests for request and installer behavior; existing docs describe adaptation/deployment commands and license attribution accompanies port.

## Steps / evidence gates
1. Add discriminating failing tests (whitespace/legacy reasoning and complex message/tool conversion; source compose/ref behavior).
2. Implement conversion; run focused regression suite and inspect final hop max/display/format.
3. Implement fork branch default, safe source migration and build override; bash syntax and mocked executable installer checks (no production Docker).
4. Run available full Node unit suite, review diff and record unavailable checks. Independent audit/live WSL remain explicit acceptance gaps, never self-certified.

Stop/partial behavior: no publish/deploy; if tooling/network fails, preserve changes and report exact unverified layer. Cancellation of staged source fetch leaves original runtime data untouched; build errors leave old container running until compose replacement succeeds.
