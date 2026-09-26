# wrap-fixed v155-r1 — owner-approved selectable CLI fix

The owner approved production selection on **2026-09-26** after the supplied r1 CLI offline capture preserved the complete caller system and matched the original observable non-system request/response behavior for that input. This is not a claim that every model, header, tool, concurrency mode or real-provider billing behavior was tested.

## Use

Deploy the control plane/frontend and this complete directory. In the existing dataplane page, select **cli-node 修复版 + kernel** (`wrap-fixed`) and the desired Claude slots; leave restart enabled to activate the selection. Without selected slots, the global default changes for inherited slots only. Explicit per-slot overrides and Codex are left alone. Pause business requests before switching/restarting.

Default `wrap` is unchanged and remains available for rollback. This folder is separate from `share/wrap-cli`, and normal original-release downloads/sync do not overwrite this pinned pair. Nothing automatically changes the active routing or VM settings when the files are deployed.

Installed paths:

- `.kin/cli-node-fixed`: the promoted CLI, not the original `.kin/cli-node`.
- `.kin/kin-kernel.bin`: the verified v1.3.55 wrap kernel bundled here.
- `kernel.json` retains native family `wrap`, with `claude_bin=/home/kincli/.kin/cli-node-fixed`.

The source pair is hash-checked before installation. Missing/unapproved/mismatched files refuse the selection rather than falling back to original wrap. The Docker image has an immutable `image-wrap-fixed/v155-r1` fallback for installations without a source checkout. The fixed slot cannot be captured into the original wrap template through the old promote-sample action.

## Derivation

The CLI is derived from the exact user-tested `native-v155-r1` candidate. Its two caller-system patches are byte-identical. The only difference from that candidate's uncompressed executable is restoration of the original entrypoint span, removing the offline-only guard and its whitespace minification. Original entry behavior and the rest of the runtime/resources are preserved. The plain `--version` remains the bundle's existing2.8.4; HTTP attribution is separately overridden to2.1.280 as before.

The caller blocks remain independent and follow the existing generated framework blocks. The final non-global system cache marker moves to the caller tail without increasing marker count or changing TTL. This is caller preservation, not removal of every native framework prompt.

`manifest.json` records the owner approval, original/candidate/final hashes and validation scope. `patches.json` records the two modifications relative to the original distributed CLI. The builder performs full embedded-JS syntax checks, ELF/Bun layout and unchanged-byte checks, UPX integrity and exact decompression comparison. No Linux native or real-provider call was executed locally for the promoted derivative.

Reproduction uses `scripts/build-native-revisions.mjs` with the exact original/r1 files and explicit trusted UPX/Bun paths, writing to a new empty output root. Do not edit this manifest to bless a different kernel or CLI. For another offline check of the actual promoted hash, choose `wrap-fixed` in the logging probe's pairing selector; it still uses the isolated fake API and normal diagnostic422 receipt.
