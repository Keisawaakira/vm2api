# native-v155-r1 — offline-only CLI candidates

Status: local checks completed; **Linux execution / user capture acceptance pending**. These are not official release artifacts and are not approved for production inference.

## Selection

Use Settings → Logs with Debug + raw nonstream capture + offline kernel probe enabled. Select `candidate-wrap`, `candidate-cc`, or `candidate-crag`. Keep master-key Claude Chat `stream:false`. Normal dataplane selectors do not accept these values. The candidate directories are not copied into production slot homes.

- `candidate-wrap`: the v1.3.55 wrap kernel + patched cli-node.
- `candidate-cc`: the same wrap kernel + patched cc-node.
- `candidate-crag`: the existing Crag kernel + patched cc-node. Crag's user-message framing / missing structured request fields were NOT repaired by this CLI patch and must still be inspected.

The loader checks the manifest, packed CLI hash, released-CLI base hash, selected kernel hash, and supported layout (zero/identity). Missing/mismatched files fail closed. The sandbox verifies its uploaded binary hashes again before starting native processes.

Each candidate also refuses entry unless `VM2API_OFFLINE_CANDIDATE=native-v155-r1` and `ANTHROPIC_BASE_URL` is the literal local HTTP fake-service address. The probe supplies these inside its network-isolated container. Do not manually copy these files into `.kin/`, modify their manifest to bypass a mismatch, or set this marker for real inference.

## Changes

1. The native query helper snapshots caller system string blocks without trimming/merging. The final API builder appends those independent text blocks after the existing native generated blocks. Zero/identity native framework prompts remain; this is not a persona redesign.
2. When the final generated system block has a non-global cache marker, that same marker/TTL is moved to the last caller block. No extra marker is added, disabled caching remains disabled, and global markers are not moved onto private caller text. Real cache efficiency is unverified.
3. The cc-node early native/crag routes initialize the existing CLI runtime in noninteractive mode first. The configuration guard is not removed.
4. Entry is restricted to the offline candidate harness.

## Method and checks

The inputs are the exact release hashes in `manifest.json`. Their Bun1.3.14/0d9b296a ELF `.bun` graphs contain one JavaScript module and no bytecode, sourcemap or module-info cache. Only declared fixed-length JavaScript spans changed. ELF layout, other source bytes, runtime machine code and resources are unchanged in the decompressed comparison.

The builder checks whole-module JS syntax, runs the isolated source-contract tests, compresses with UPX, tests compressed integrity and compares a fresh decompression against the expected patched bytes. UPX integrity testing alone is not the acceptance gate. `patches.json` contains the exact source changes and byte offsets; `manifest.json` records hashes/tool versions/check scope.

This is a binary-preserving repack, not a rebuild of the vendor's original TypeScript project. Native API startup, request preservation, successful mock reply handling and later real-provider behavior still require runtime evidence. A successful capture does not auto-promote the artifact.

Reproduce into a new empty directory, with an explicit trusted UPX path and the recorded Bun minifier version:

```sh
node scripts/build-offline-native-candidates.mjs --upx /path/to/upx --bun /path/to/bun --output /tmp/native-v155-r1 --evidence /tmp/native-v155-r1-checks
```

The builder rejects changed release inputs and existing destination binaries. It never overwrites production slot / release directories. The format reference used for the parser is `oven-sh/bun@0d9b296af33f2b851fcbf4df3e9ec89751734ba4`, `src/standalone_graph/StandaloneModuleGraph.zig`.
