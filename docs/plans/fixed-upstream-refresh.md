# Fixed CLI / shared upstream kernel

Implemented and locally verified,2026-09-28. Context: ../context.md. Owner authorizes direct normal use after local checks. After learning that no Rust kernel was privately patched, owner explicitly asks to reuse the original/native kernel path rather than produce versioned fixed kernel copies. No new rollback/candidate option is wanted.

## Target and scope

Approved CLI bytes and hashes remain fixed. The kernel follows the existing native selector and update/sync path. An installed data plane has an approved CLI plus an independently identified shared upstream kernel; old manifest.kernel is historical evidence only.

- `wrap-fixed.mjs`: retain approved CLI identity/size/hash/ELF gates; stop requiring/loading the old bundled kernel.
- `wrap-cli-runtime.mjs`: assemble fixed CLI with the existing kernelPayloadPath selection; use it consistently in preflight, install, inspect, recovery/sync and panel description. Validate selected kernel ELF; no fallback to the old fixed copy.
- `offline-kernel-probe.mjs`: reuse this runtime resolution and label shared kernel provenance separately. CLI and source hash checks remain.
- Existing fixed CLI directories/bytes and dataplane names remain unchanged. Remove this round's uncommitted v174 package-builder/outputs from the active repo; preserve them only as external scratch evidence.
- UI/API docs explain shared kernel updates and required sync/restart, without implying that the new runtime was already captured or that every future CLI/kernel combination is certified.

## Verification / closure

Red/green controls: current bin beats the old bundled kernel; later source update reaches the slot without changing CLI; normal sample fallback; explicit KIN_KERNEL_BIN agrees with ordinary installation; missing/invalid selected source fails; old bundled kernel is not required or silently used; no new menu variants. Run fixed install/config/offline/trace, native CLI code-preservation and frontend gates.

Parent is sole writer; bounded read-only review completed with no blocker. No provider/model request, live-slot operation, push, automatic continuation or change of thinking mode. Actual Linux/cloud behavior remains a deployment observation, not a consequence of static checks. On validation failure, do not commit or announce completion; retain evidence and repair the bounded defect.

Rejected alternatives: freezing a private kernel copy every release, repacking unchanged CLI bytes, inventing a general revision selector, adding historical menus, and treating prior CLI capture as proof of the newly selected kernel's runtime behavior.
