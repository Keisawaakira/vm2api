# native-v155-r2 — CC/Crag offline candidate only

**Not approved for normal inference.** Local syntax, exact-byte, compression roundtrip and extracted-function checks pass; new Linux capture acceptance is still required. The r1 assets are unchanged and remain available for comparison.

## Changes relative to CC r1

1. The bundle already contains a real AsyncLocalStorage workload module exposing `getWorkload2()` and `runWithWorkload()`. Its User-Agent builder incorrectly called the nonexistent `getWorkload()`. R2 initializes the existing module and calls the correct getter. It does not add another context/store, replace workload with a constant, or change the existing caller-system/CLI initialization patches.
2. Crag `runSlot` retains text from assistant API errors instead of replacing every cause with `api_error`. The existing failure envelope, session correlation and success behavior stay in place.
3. The offline entry marker changes to `native-v155-r2`. A public/non-loopback API address or another revision's marker still refuses entry.

Only the declared JavaScript spans differ; no Rust kernel, native machine code or ELF/Bun layout is rebuilt. `manifest.json` and `patches.json` record exact hashes and modified regions. The existing workload module is recorded for local source verification and remains byte-identical in the executable.

## Test

Keep normal production dataplane unchanged. In Settings → Logs, enable Debug + raw nonstream diagnostic + offline probe, then select:

- `candidate-cc-r2`: wrap kernel + CC r2.
- `candidate-crag-r2`: Crag kernel + CC r2.

Use the same master-key Claude Chat JSON with explicit `stream:false`. Download full original JSONL even if the result is incomplete; suggested names are `cand2-cc.jsonl` and `cand2-crag.jsonl`. HTTP422 is a diagnostic receipt, not a model answer.

The loader and sandbox verify original/base/kernel/candidate/uploaded hashes. Real credentials, slot homes and external networking are not used, and failures never fall back to real inference. Candidate choices cannot be installed through the normal dataplane API.

Crag kernel request framing remains unchanged: previous captures placed caller system inside user content and omitted some structured request fields. Starting the API successfully does not certify that mapping. Inspect the new final API JSON, model/thinking/effort/max_tokens, complete messages, error details and fixed long reply before deciding further work or promotion.
