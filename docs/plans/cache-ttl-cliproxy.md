# Cache TTL / usage repair

Status: local source implementation verified; kernel wire/live WSL acceptance remains open. Evidence: [implementation report](../reports/2026-09-23-cache-ttl-implementation.md). User authorization: “可以，你说的都是问题，按CLIProxy修吧”. R2 scoped refinement of existing request/usage contracts. Inspection baseline and unknown runtime boundary: [context](../context.md).

## Target and scope
AI-drafted target, chartered for implementation by that request (not independently ratified): caller cache intent survives to the Node→kernel envelope; usage facts survive to logs and costs. Current drift is multiple TTL rewrites plus rewriting observed usage to configured intent. Prefer existing helpers and focused changes over new transport or database architecture. No binary patching, runtime deployment, historical billing rewrites, commits/pushes, or credential disclosure.

## Contracts
- OAuth/setup-token default 1h; API-key default 5m. Add auto console default; existing explicit 5m/1h remains a default for NEW/ttl-less markers, never a forced rewrite of explicit markers.
- Native confirmed clients own placement/default TTL. Ordinary translated requests fill sections without destroying existing anchors; no extra tools marker when system already covers tools. CLI hop continues delegating message placement to its kernel, without deleting caller anchors.
- Only 1h AFTER 5m is invalid in tools→system→messages order; preserve a valid mixed prefix. Top-level automatic caching is evaluated after explicit markers (automatic tail).
- Upstream nested usage split wins over aliases; explicit zeros remain zeros. Missing/partial split remains unclassified in logs. Price unknown write tokens conservatively at 5m, explicitly mark estimate; never label estimated tokens as observed 5m/1h. Configured TTL cannot rewrite usage.
- Built-in zero preset uses a ttl-less ephemeral marker resolved by credential policy, not its own TTL default. Existing saved explicit templates remain caller/operator choices.

## Files / steps
1. Red tests on helpers, mixed usage, pricing, logging and CLI envelope.
2. `cache-ttl.mjs`, `outbound-attempt.mjs`, `handle-protocol.mjs`: preserve/fill/ordered repair and credential-aware resolution. Keep returned shapes stable.
3. Shared pure cache-usage extraction used by `pricing.mjs` and `request-log.mjs`; remove main-path reclassification. No schema migration or retroactive correction; summaries can derive estimate status from total-vs-split.
4. Kernel config projects resolved default by credential; envelope requests preservation with no forced TTL. Actual kernel behavior is a shipped-binary boundary: inspect available source/config and report any unverifiable part.
5. Align Node/web persona cache defaults and UI explanations/options; targeted tests, available full Node/web checks, diff review.

Review budget: confined to cache request semantics, cost/log classification and their UI/contracts; no new engine. Interruptions leave local reversible edits only. Evidence: red→green checks, direct mixed-order/usage examples, template parity, no synthesized split in storage. Existing tests that assert wrong semantics must be revised against the above contracts. Independent reviewer and actual WSL/kernel wire capture remain required for production acceptance; self-review is not that acceptance.
