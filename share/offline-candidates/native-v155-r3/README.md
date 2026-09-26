# native-v155-r3 — current CC/Crag offline test round

**Offline-only, not approved for production.** This candidate is derived from the exact r2 artifact. r1/r2 and the approved wrap-fixed binaries/manifests are unchanged.

R2's supplied CC and Crag traces both ended before a model request with `API Error: logForDebugging is not defined`. Crag now preserved that detail correctly. The API-client module also contained the next failing reference, `isDebugToStdErr()`. The real implementations in this bundle are `logForDebugging2()` and `isDebugToStdErr2`.

R3 changes only the API-client module's four logger references, four stderr-mode references, and its `init_debug` dependency, plus the offline revision guard. It does not remove logging, add empty stubs, alter system/workload handling, modify provider arguments, or change Crag kernel framing. The original logger implementation and stderr getter are retained. The manifest and patch record preserve exact byte spans and checksums.

Local checks run the extracted API factory and fetch wrapper with the real logger and workload functions, controlled SDK/network boundaries, debug on/off, OAuth/API-key and provider branches. The old module reproduces both missing references; corrected bindings preserve constructor arguments, headers, body and synthetic reply bytes. This is not an executed Linux ELF or a real-provider acceptance test.

## Test this round

Update the control plane, frontend and candidate files. In Settings → Logs enable Debug/raw nonstream/offline probing, then explicitly select and save one of the only two current choices:

- **CC + wrap kernel** (`candidate-cc-r3`)
- **Crag + CC** (`candidate-crag-r3`)

Use master-key Claude Chat with the same caller JSON and `stream:false`. Download complete JSONL, including failed stages; suggested names are `cand3-cc.jsonl` and `cand3-crag.jsonl`.

The shared current-round catalog is `src/lib/transport/offline-candidate-round.json`. Old saved choices require reselection and are refused before public probe dispatch, not silently rebound. Historical files/logs and low-level regression support remain, but the user-facing picker does not accumulate them.

All previous sandbox/base-hash/uploaded-hash/loopback-only restrictions remain. R3's native guard requires `VM2API_OFFLINE_CANDIDATE=native-v155-r3`. HTTP422 is the normal diagnostic receipt. No promotion is inferred from a successful mock response; final API system/history/parameter behavior still requires the new traces.
