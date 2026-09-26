# Claude Chat CPA conversion and caller-system preservation

2026-09-24, UTC+08:00. M2 source/test acceptance; temporary raw logging is the next milestone, not part of this report.

## Baseline / contract

Rebased test `463a97c` onto main `12dc3d8` as `c462c06`, preserving the prior stream/cache/usage/retry fixes and new pricing/fast-mode/Haiku affinity. Backup: `backup/test-before-cpa-debug-20260924-204454`. The user requests CPA transformations and explicitly forbids loss/merging of caller system blocks. This stronger preservation rule overrides CPA's optional cloaking, which itself can discard caller text.

Reference is CPA `c404af96`. Its actual registered converter/SDK-summary/thinking/response functions run through `test/support/cpa-oracle/`; official portable Go1.26.8 and locked dependencies remain in the temporary evidence directory. No reference production/module files, native binaries, services or provider requests were changed/executed.

## Source changes

- Chat system/developer text blocks retain count, order, whitespace and original text through actual Node worker-envelope serialization. Supported string/text/input_text/output_text forms are explicit; nontext system shapes return 400. Identity metadata remains separate.
- Chat bypasses Node persona/overlay/search injection, heuristic prefix/fingerprint/header deletion, block joins, context-budget rewriting, final CCH rewriting and client usage masks. Explicit operator intercepts remain authoritative. Native slot persona is not disabled or certified transparent.
- Function tool/schema/choice/stop and structured output mappings follow CPA. `response_format` appends a separate system instruction rather than `output_config.format`; a non-wire converter-owned hint preserves title-helper TTL classification only if that instruction survives interception unchanged.
- Pinned-model amount/summary/suffix rules use actual capability records. Missing/default fills do not override explicit auto/none/max. Forced tool choice removes thinking/effort without changing the choice. Native Haiku handling and unlisted vm-model fallback are named exceptions.
- A Chat-specific SSE accumulator retains original tool JSON strings, initial content and buffered multi-message content. Streaming tools finish at block_stop; unknown indices cannot contaminate tool0; empty arguments are `{}`. JSON uses upstream identity/model; cached usage aliases match CPA.
- Real errors, negative terminals, incomplete transport, cancellation and no-replay-after-commit remain protected. Negotiated final usage and authoritative native metadata remain stronger local contracts, not literal CPA equivalence.

## Discriminating evidence

Initial preservation TDD: 33/33 failed against old behavior. Initial parity TDD: 27 failures among 128 comparisons. The expanded actual-handler suite exercises supported global/slot/inherit combinations, both client modes, native/API Claude readers, 52 special/ordinary caller blocks, account retry and serialized request identity/TTL.

Independent review found two remaining defects rather than accepting writer self-report:

1. Native trailer-only stop made merge selection discard the private Chat state, reserializing tool arguments and losing earlier buffered messages. The fix applies successful authoritative stop to the Chat assembler before merge selection, retaining all failure guards. Ten handler controls cover raw arguments, multi-message accumulation and failures; two previously failed.
2. Known-model suffix -1/auto/minimal/xhigh handling differed from actual CPA. Explicit suffix extraction/validation now distinguishes body auto and supports midpoint/capability/nearest-level rules. Nine actual CPA fixtures and real-handler checks cover the correction; the new group initially had 14 failures.

The oracle now contains 136 cases / 17 capability records. Two independent review passes re-executed it offline and matched persisted outputs with only response creation timestamps normalized. Eighteen comparisons for two unlisted CPA aliases are explicitly skipped as compatibility exceptions; they are not platform skips or proof of native model support.

## Verification / review

- Parent rerun of new blockers/controls: 28/28 passed, no skips.
- Writer final affected run: 299 passed / 0 failed / 18 declared alias skips (317 total).
- Full Node: 2084 tests, 2009 passed, 25 failed, 50 skipped, zero cancelled; 8/174 files failed. Exact file+test-name comparison with rebased baseline has no new/resolved failures. The initial eight new assertions were narrowly updated for intentional CPA fields; no blanket skips or removal of persona-helper coverage.
- Independent follow-up: parity angle passed 28 + 111 cases and re-executed all136 oracle cases; preservation angle passed176 tests/probes and independently checked raw baseline failure names. Both closed their reported blockers.
- Rebased frontend baseline:130 tests, format/build passed; M2 did not change frontend files. M3 will need a fresh combined check.
- Formatting and whitespace checks passed. Working source will be committed separately from the raw-logging milestone.

## Boundaries

See `test/support/cpa-oracle/README.md` and `docs/PROTOCOL.md` for precise deviations: caller preservation; native identity/cache/Haiku; negotiated usage; initial-data/refusal and truthful terminal behavior; unlisted model compatibility; parsed-schema lexical whitespace; explicit operator interception. Strict Chat drops unsupported vendor fields such as speed/service_tier; other protocols' fast-mode handling remains. The actual tested boundary is Node -> kernel/API-kernel, not hidden Anthropic wire.

No production short-output trace or model-format compliance was measured. No push or deployment. Evidence root: `C:/Users/zemingxi/AppData/Local/Temp/vm2api-cpa-debug-20260924-2045/`, including initial/follow-up reviews, red/green logs, full-baseline comparisons and oracle artifacts.
