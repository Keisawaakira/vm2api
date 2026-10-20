# Live short-response / cache pair investigation

Read-only inspection, 2026-09-24. No code/config edits, container restart, paid inference, credential API call or remote push was performed. This report is runtime evidence, not proof of final native implementation correctness.

## Observed runtime
- Local and WSL `/opt/vm2api` revision: `463a97cde36aacf21e27ce4c524fe685ba7b9e97` (rebased CPA integration over v1.3.46).
- Running vm2api image revision matches; started 09:26:45 UTC, restart count 0.
- Slot provider is local_cli / wrap; persona zero, auto cache policy, kernel default 1h, 20 slots.
- Installed slot artifacts match host distribution copies. Kernel SHA-256 `03a26a39d9e32ebf60a6bc00a0e9bd471ce4c7f523c6f6359aed342ac9801e13`; CLI SHA-256 `4ce47b79821aa53f1c9b5790dea5c50b90cc35f23aa19aae94dd46a938cb0f69`.
- Read `kin.db` with SQLite URI mode=ro, Docker logs and safe config summaries. No secrets or prompt contents copied here.

## User's two requests (completion timestamps UTC)

| Field | First, short | Second, normal |
|---|---:|---:|
| request prefix | 0298b8ce | f34322b0 |
| finished | 11:02:26.649 | 11:05:10.110 |
| duration ms | 36,142 | 130,059 |
| first token ms | 31,201 | 3,788 |
| output tokens | 149 | 5,243 |
| uncached input | 3 | 3 |
| cache read | 0 | 140,292 |
| cache creation | 140,292 (reported 1h) | 0 |
| stop_reason | end_turn | end_turn |
| final_state / status | verified / 200 | verified / 200 |
| outer attempts | 1 | 1 |
| local list-price USD estimate | 1.406660 | 0.201236 |

Both are streaming Chat / claude-opus-4-6, max_tokens=128000, reasoning_effort=max, no client tools. Both have 287 inbound messages (42 system + 245 conversation), outgoing Node system length 99,841 characters and the same serialized body lengths. Node cache-prefix diagnostics are turn 1/2, break=null. These are pre-native observations, not final vendor-payload hashes.

During inspection a third request appeared (801c0ecd, 11:09:24.879 UTC, 106,989ms, 4,153 output): read 140,292, uncached 3, no writes, end_turn/verified. Prefix turn 3, break=null. This was not initiated by the investigation.

## Cache interpretation
- Second and third observed input hit rate = 140292/(140292+3) = **99.99786165%**. Unlike the Sep 23 sample with ~139k uncached input, this pair has no large uncacheable input remainder in the returned usage.
- First request is cold: the earlier request in the log is nearly a day older. 1h cache writes cost 2x ordinary input at the local standard API rates; cache reads cost 0.1x. Cold write + one warm read costs about 2.1x one prompt's ordinary input price, versus 2x for two uncached inputs. Savings appear with more warm reuse; 5m has a lower 1.25x write premium but expires sooner.
- First cache-write estimate is $1.402920, second cache-read estimate $0.070146, second output estimate $0.131075. Combined estimates $1.607896; first request accounts for ~87.5% of that amount.
- These are API list-price estimates, NOT a formula for Claude subscription utilization. The logs cannot prove the vendor's internal subscription cost weighting.
- Warm identical-prefix reuse is demonstrated for this sample; growing-history turns and final native marker scope/TTL remain separate evidence requirements.

## Quota sampling
`account_allocations` sources are headers: first .00, second .14, third .17 for the 5h window. The .17 snapshot is stored at 11:09:24.876 UTC. A separate official-usage snapshot is older (10:48:35 UTC, 5h zero). Response header samples and post-generation account observations have different timing; do not assign the full .14 or .17 increase to the warm second request or convert it from local USD pricing. Header timing/update lag or other account activity cannot be fully attributed from these records.

## Short output: established facts and remaining gap
- This is not the old converter blindly mapping a missing stop_reason to stop: current source checks a nonempty reason and suppresses duplicate finish/error output; it includes the other AI's stream/retry fixes.
- Runtime recorded only 149 output tokens and end_turn/verified. No timeout, max_tokens stop, transport error or container restart is recorded for the short request. The single kin-01 SIGKILL log was at startup 09:26:47 UTC, well before either request.
- `verified` is the gateway's acceptance result, not independent proof of an intact Anthropic stream. `go-worker-client.mjs` can obtain stop reason from worker headers/trailers as well as SSE; the stored record does not distinguish them.
- Debug records contain request previews/summaries, not the recent response text or ordered raw SSE. The only native conversation JSONL is an earlier 01:05 probe, unrelated to these requests. Consequently, the present evidence cannot distinguish an actual model end/refusal from premature native wrapper finalization, or prove a Chat adapter cut this response.

## Smallest useful next step
Without changing cache policy or inserting forced continuations, record per-request NON-CONTENT stream provenance at the kernel→Node boundary: SSE stop_reason, header/trailer stop_reason separately, saw_message_stop, worker terminal state, counts/character lengths of text/thinking deltas, output token detail, client-disconnect timing and final Chat finish/DONE sequence. Then reproduce once with user approval. Short reply content supplied/redacted by the user can help distinguish ordinary/refusal completion, but length alone is not a failure criterion.

If ordinary gaps are under 5 minutes, a new-conversation 5m comparison may reduce cold-write premium. Existing warm conversations pin TTL, so a menu change need not affect them immediately. No setting was changed during this inspection.
