# Chat → Claude / fork deployment implementation evidence

Status: implemented locally; focused checks pass; live deployment and independent acceptance pending.

## Inputs and changes
- vm2api baseline HEAD: `30c063dbadc3466f356e88c141ae566fa3068408`.
- CLIProxyAPI reference: `555662940411a07460e9d24d14477a5f50dffdb5` (sibling checkout). Ported request/message/cache/tool/schema behavior with attribution at `src/lib/protocol/CLIProxyAPI-LICENSE.txt`.
- Preserved and extended pre-existing uncommitted reasoning changes; no commit, push, local remote rewrite or WSL service mutation performed.
- Adaptive max/xhigh becomes `thinking: {type: adaptive, display: summarized}` plus `output_config.effort: max`, survives Node CLI hop. Explicit summary exclusion changes visibility only. Manual budgets follow CLIProxy levels and fit caller output ceilings where valid. Chat default is 32000.
- Documented adaptations in PROTOCOL: VM identity, native structured output, upstream SSE, native tool extensions, legacy auto budget and existing Haiku CLI policy remain vm2api-owned.
- Installer defaults to `Keisawaakira/vm2api@main` source; stages image→source migration preserving runtime data/config, refuses dirty tracked checkouts, fetches selected fork ref even from detached/shallow checkout, builds with both compose files. Local image and OCI revision labels distinguish built source from upstream images. Build/health failure exits nonzero.
- Management-panel updater is still upstream Release/tag based; README/DEPLOY explicitly route fork updates through WSL installer, not panel.

## Fresh checks
Environment: Windows / Git Bash, Node v24.14.1. Installed locked dependencies with `npm ci --ignore-scripts --no-audit --no-fund`.

1. Red: six new request tests failed on pre-implementation working state (cache/turn loss, file loss, tools options, system-only fallback, whitespace effort/exclusion, legacy budget).
2. Red: four installer tests failed before implementation (wrong default, missing compose override, wrong checkout, swallowed health failure).
3. Green: 96 tests across `chat-claude-parity`, `openai-reasoning-convert`, `install-script`, `convert-cache-shape`, `convert-stream`, `anthropic-policy`, `cli-hop-body`, `images-materialize` all passed. Includes adaptive model/effort matrix; real local git moving-branch test; mocked Docker invocation; migration data preservation.
4. `bash -n deploy/install.sh`, `git diff --check`, Biome format check of all seven changed/new JS test/source files passed.
5. Full `npm run test:unit`: **147/155 test files passed, 8 failed**. A separate `git archive HEAD` baseline with the same dependencies reproduced all 27 failing test locations across those eight files; sorted failure-location diff was empty.

Baseline failures (not silently fixed under this request):
- `api-backend`: Windows Unix-domain socket EACCES.
- `backup-service`: GNU tar interprets Windows drive path as remote host.
- `cache-breakpoints`: existing `ReferenceError: applyCacheTtlToBody is not defined` in outbound-attempt (also in untouched HEAD).
- `db-migration-sub2api`, `pool-scheduler`: Windows EPERM during cleanup.
- `host-path`: Linux path assumptions on Windows.
- `session-oauth-seam`: Unix helper spawn ENOENT on Windows.
- `wrap-cli-runtime`: Windows executable-permission expectation.

## Acceptance gaps
- No Docker/Go/shellcheck executables available here. No actual image build/compose validation, Go suite, live WSL capture or Anthropic inference run performed.
- Installer tests execute Bash and local git but mock Docker; they do not establish container runtime success.
- No independent reviewer available; this report is implementer evidence, not independent closure/ratification.
- Source must be committed/pushed to fork before WSL can download it. Verify installed git HEAD against running container OCI revision, then perform a Chat request and inspect final request effort/visibility. A longer visible thought is not by itself proof of effort.
