# cc-fixed v155-r3 — accepted CC + wrap kernel pair

The owner conditionally authorized promotion on **2026-09-26**, subject to the supplied R3 trace comparison. The **CC + wrap kernel** case passed: the caller system block and245 messages were preserved, max_tokens128000/adaptive+summarized/effort=max remained, and the fixed long response matched the accepted CLI trace byte-for-byte at the kernel boundary. Metadata identity IDs were fresh. CC additionally sends its existing context_management clear_thinking/keep=all configuration and native billing attribution (version fingerprint suffix, cc_is_subagent=true, cc_turn_origin=sdk). Its attribution generator is unchanged from original CC. These differences are retained rather than claiming complete cli-node equivalence; their real-provider/quota effects remain unverified. This is one zero/Opus4.6/text-only/nonstream offline sample, not proof for all authentication modes, models, tools, concurrency or real-provider billing.

**Crag did not pass and is not promoted here.** Its API request contained caller system as user content, only the last user turn, max_tokens64000 and no effort=max. A complete mock response is not request-semantic acceptance.

## Selection

Deploy the control plane/frontend and this complete bundle. In the normal dataplane page choose **cc-node 修复版 + kernel** (`cc-fixed`), select the intended Claude slots, and apply with restart enabled after pausing traffic. No default or running slot is changed automatically. Turn off the offline probe setting explicitly before normal inference; completion of a test round never silently restores real upstream traffic.

The installed files are `.kin/cc-node-fixed` and its pinned `.kin/kin-kernel.bin`. Native `kernel.json.dataplane` remains the existing **cc** family and `claude_bin` points to the dedicated executable. Original CC and the previously approved wrap-fixed remain available and unchanged. Normal release sync, recovery and resets respect the selected fixed pair. Missing/unapproved/hash-mismatched assets fail closed without replacing them with an original binary.

The latest control-plane main v1.3.58 reverted its experimental kernel update. Its net native bytes match the tested v155 kernel; this bundle pins those exact bytes rather than adopting an untested replacement. Docker carries an `image-cc-fixed/v155-r3` fallback.

## Derivation and limits

`scripts/promote-cc-candidate.mjs` verifies the input candidate against the accepted capture and strips **only183 bytes of the offline entry guard**, replacing them with spaces. Everything else in the accepted R3 uncompressed executable remains byte-identical, including the CC initialization repair. Restoring the entire original entry would undo that repair and is deliberately not done.

The build verifies complete JavaScript syntax, ELF/Bun layout, exact bytes outside the guard, UPX integrity and exact unpack roundtrip. Six extracted-entry controls verify version behavior, initialization order, init failure and matching native-loop arguments. No promoted Linux ELF was executed locally. Manifest approval is the owner's scoped decision, not a claim of new real-provider/runtime certification.
