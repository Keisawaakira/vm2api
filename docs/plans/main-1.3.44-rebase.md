# Rebase test onto v1.3.44

2026-09-24. R2 integration authorized by the user's request. [Current context](../context.md).

Status: bounded source rebase and Node/frontend verification complete; independent review found no new rebase blocker. The proposed Go repair is deferred without edits after the platform validation block. Known OAuth/crag operational defects are not certified fixed. See the [integration report](../reports/2026-09-24-main-1.3.44-integration.md).

## Stable target

Latest-main dataplane/watchdog/OAuth plumbing coexists with test's request, measured-usage, terminal and committed-retry contracts. Both selectable dataplanes retain source-visible policy and identity provenance; Node evidence never stands in for native cache-efficiency measurement.

## Bounded sequence

1. Preserve local and remote test refs; compare their trees. Keep local validated history and attribution because functional trees are equivalent.
2. Freeze main607fdd6 and test1dbbaae, run baselines, inspect changes and independent risk review.
3. Rebase five commits. Resolve only actual conflicts, retaining new slot OAuth imports, watchdog health behavior, dataplane fields/executable selection, and fork credential-aware TTL/stream/usage/replay logic.
4. Run existing targeted tests and new upstream tests. Add only discriminating tests/fixes for demonstrated integration defects, especially OAuth error/credential contracts and shared wrap/crag configuration. Do not execute installed binaries or services.
5. Compare full-suite failures; validate frontend; fresh independent review; commit coherent local result and record evidence. No push/deploy.

## Accepted compatibility slice

The slot OAuth migration loses fatal refresh codes at the Go command envelope. A bounded safe-code preservation fix was investigated, using the same Go1.25.1 compiler version found in the shipped worker. The official portable SDK was checksum-verified in a temporary directory, with no global installation. Real tests failed to compile the existing Unix-only credential-store flock calls on Windows. Consequently this slice was stopped before any source/test/binary edit: no unexecuted Go repair or platform shim is shipped. Reopen with an authorized Linux validation route; then require error-envelope/classifier red/green coverage and a matching rebuilt shipped worker. The OAuth fatal-code regression and the missing invalid_refresh_token case in the router remain explicit upstream limitations.

Crag lifecycle materialization inconsistencies are an upstream operational limitation, not permission to redesign runtime startup in this rebase. Keep wrap as the existing default, do not enable crag or claim it runtime-validated, record the concrete affected callers, and reopen that repair when crag enablement is requested. The present source integration does not certify either native binary's cache efficiency.

## Limits and verification

Parent owns source and Git; reviewers use frozen inputs until the merged tree is stable. No speculative native protocol rewrite, new cache engine, forced continuation, removal of attribution, unrelated cleanup or edit of the old repair patch. If an unapproved architecture or credential policy choice is required, stop and ask.

New production changes are limited to evidenced compatibility defects in existing seams. Observe new bug assertions fail before fixing; do not weaken old behavior tests merely to get green. Keep inactive-path/opaque-binary limitations explicit. Preserve prior reports; write a new dated integration report instead of rewriting their evidence.

Acceptance: target main ancestor of test; no lost functional remote changes; new upstream features retained; fork terminal/usage/cache contracts retained; no new unexplained failure; fresh review and tracked clean tree. Actual watchdog execution, crag final-wire semantics and subscription savings remain outside local acceptance.
