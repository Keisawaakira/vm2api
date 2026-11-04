# Rebase test onto main v1.3.39

2026-09-24. R2 bounded integration, authorized by the user's rebase request. [Context](../context.md).

Status: locally implemented, regression-tested and independently reviewed. Full-suite failures match the pre-rebase baseline; runtime/deployment acceptance is not claimed. See the [integration report](../reports/2026-09-24-main-1.3.39-integration.md).

## Stable contracts

Main's current provider-status/rate-limit/recycling behavior coexists with test's explicit stream failure, committed-output safety, truthful usage and normalized cache policy. Account and native identity changes are distinguishable from input-cache observations. Passing an envelope test does not certify final native cache layout.

## Scope and sequence

1. Freeze main `2d7c16f`, prior test `8e2923e`, and a rollback branch; characterize both baselines.
2. Compare upstream source against known issues, distinguishing unchanged code, partial fixes and binary-only claims.
3. Rebase the four test commits, resolving by contract rather than choosing whole files. Preserve upstream imports, semantic error wrappers, rate-limit hooks, persona handling and model gates alongside test corrections.
4. Run the 111 existing focused cases plus new upstream tests. Add bounded integration cases for any actual gap: precommit error mapping/recycle, committed/cancelled safety and raw usage. Observe red before new code changes; preserve behavior intentionally changed by upstream unless unsafe or owner adjudication is needed.
5. Compare full-suite failures to both pinned baselines, test/build the merged frontend, get fresh independent review and inspect final ancestry/tree. Record results and leave local test usable.

## Accepted integration corrections

Fresh frozen-source review plus post-rebase TDD reproduced two small gaps: confirmed auth can bypass the outer committed stop, and official usage can inherit a previous/global mask. Preserve confirmed-credential retirement while stopping replay; reset official client masking for the selected attempt. The source surface is the existing classifier, cooldown application and handler, not a new retry or persona system. Four auth assertions and four override/retry usage assertions failed before fixes. Upstream's restored 401 now correctly avoids cleanup recycling, so update the two legacy recycle-count assertions to zero while retaining their cancellation/error/usage checks.

## Limits and closure

Parent is sole writer/Git owner. Reviewers use frozen inputs until the rebased tree is stable. No new engine, opaque cache-flag change, arbitrary continuation, retries beyond the existing policies, unrelated cleanup, native binary execution, inference, service operations or remote push. The old patch and independent CPA checkout stay untouched.

New production correction budget: only demonstrated rebase/integration defects, preferably within the existing protocol/transport/pool boundaries. If semantics require a new product decision, stop that slice and ask. Roll back via the preserved branch or abort an unfinished rebase; do not reset away user work.

Acceptance: main ancestor of test; original request/usage/stream/cache contracts represented; latest-main rejection and recovery contracts retained; no new unexplained failure; tracked tree clean after commits; independent review. Existing platform/installer failures are reported, not hidden. Live subscription/cache-efficiency attribution is not part of local closure.
