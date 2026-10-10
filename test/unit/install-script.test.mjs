import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const script = readFileSync(new URL('../../deploy/install.sh', import.meta.url), 'utf8')
const functions = script.split('\nCOMMAND="install"')[0]
function shell(code, expected = 0) {
  const result = spawnSync('bash', ['-s'], {
    input: `${functions}\n${code}`,
    encoding: 'utf8',
    env: { ...process.env, VM2API_GITHUB_REPO: '', VM2API_REF: '' },
  })
  assert.equal(result.status, expected, result.stderr + result.stdout)
  return result.stdout
}

test('fork installer defaults to branch source, not inherited upstream release', () => {
  shell(`
    [ "$GITHUB_REPO" = Keisawaakira/vm2api ]
    [ "$FROM_SOURCE" = 1 ]
    [ "$(target_ref)" = main ]
    TARGET_VERSION=v1.2.3
    [ "$(target_ref)" = v1.2.3 ]
  `)
})

test('source start explicitly uses build compose and never pulls the release image', () => {
  const output = shell(`
    INSTALL_DIR=$(mktemp -d)
    trap 'rm -rf "$INSTALL_DIR"' EXIT
    mkdir "$INSTALL_DIR/.git"
    touch "$INSTALL_DIR/VERSION" "$INSTALL_DIR/CHANGELOG.md" "$INSTALL_DIR/docker-compose.yml" "$INSTALL_DIR/docker-compose.build.yml"
    git() { echo abc123; }
    compose() { printf 'COMPOSE:%s\\n' "$*"; }
    wait_health() { return 0; }
    start_stack
  `)
  assert.match(output, /COMPOSE:-f docker-compose.yml -f docker-compose.build.yml up -d --build/)
  assert.doesNotMatch(output, /COMPOSE:pull/)
})

test('ARM64 source build uses its native control-plane overlay without pulling upstream images', () => {
  const output = shell(`
    HOST_ARCH=arm64
    INSTALL_DIR=$(mktemp -d)
    trap 'rm -rf "$INSTALL_DIR"' EXIT
    mkdir "$INSTALL_DIR/.git"
    touch "$INSTALL_DIR/VERSION" "$INSTALL_DIR/CHANGELOG.md" "$INSTALL_DIR/docker-compose.yml" "$INSTALL_DIR/docker-compose.arm64.yml"
    git() { echo abc123; }
    compose() { printf 'COMPOSE:%s\\n' "$*"; }
    wait_health() { return 0; }
    start_stack
  `)
  assert.match(output, /COMPOSE:-f docker-compose.yml -f docker-compose.arm64.yml up -d --build/)
  assert.doesNotMatch(output, /COMPOSE:pull|COMPOSE:.*docker-compose.build.yml/)
})

test('source update fetches the selected fork ref and rejects local tracked edits', () => {
  const output = shell(`
    INSTALL_DIR=$(mktemp -d)
    trap 'rm -rf "$INSTALL_DIR"' EXIT
    mkdir "$INSTALL_DIR/.git"
    git() {
      printf 'GIT:%s\\n' "$*" >> "$INSTALL_DIR/git.log"
      case "$1" in status) return 0 ;; rev-parse) echo abc123 ;; esac
    }
    checkout_tag main
    cat "$INSTALL_DIR/git.log"
  `)
  assert.match(output, /abc123/)
  assert.match(output, /fetch --depth 1 https:\/\/github.com\/Keisawaakira\/vm2api.git main/)
  assert.match(output, /GIT:reset --hard FETCH_HEAD/)
  assert.ok(output.indexOf('GIT:status --porcelain') < output.indexOf('GIT:reset --hard FETCH_HEAD'))
  assert.doesNotMatch(output, /checkout -f|GIT:clean/)
  const dirty = shell(
    `
    INSTALL_DIR=$(mktemp -d)
    trap 'rm -rf "$INSTALL_DIR"' EXIT
    mkdir "$INSTALL_DIR/.git"
    git() { if [ "$1" = status ]; then echo ' M src/server.mjs'; else echo UNEXPECTED_GIT_MUTATION; fi; }
    checkout_tag main
  `,
    1,
  )
  assert.doesNotMatch(dirty, /UNEXPECTED_GIT_MUTATION/)
})

test('image-to-source migration preserves runtime state and configuration', () => {
  shell(`
    ROOT=$(mktemp -d)
    trap 'cd /; rm -rf "$ROOT"' EXIT
    INSTALL_DIR="$ROOT/install"
    mkdir -p "$INSTALL_DIR/data" "$INSTALL_DIR/vms" "$INSTALL_DIR/src/config"
    echo old > "$INSTALL_DIR/docker-compose.yml"
    echo secret > "$INSTALL_DIR/.env"
    echo database > "$INSTALL_DIR/data/db"
    echo slot > "$INSTALL_DIR/vms/slot"
    echo custom > "$INSTALL_DIR/src/config/routing.json"
    git() {
      if [ "$1" = clone ]; then
        local stage="\${@: -1}"
        mkdir -p "$stage/.git" "$stage/src/config"
        echo new > "$stage/docker-compose.yml"
        echo build > "$stage/docker-compose.build.yml"
        echo default > "$stage/src/config/routing.json"
      elif [ "$1" = rev-parse ]; then echo abc123; fi
    }
    ensure_git_safe() { :; }
    fresh_clone main
    [ "$(< "$INSTALL_DIR/.env")" = secret ]
    [ "$(< "$INSTALL_DIR/data/db")" = database ]
    [ "$(< "$INSTALL_DIR/vms/slot")" = slot ]
    [ "$(< "$INSTALL_DIR/src/config/routing.json")" = custom ]
    [ "$(< "$INSTALL_DIR/docker-compose.yml")" = new ]
    [ -f "$INSTALL_DIR/docker-compose.build.yml" ]
    [ -d "$INSTALL_DIR/.git" ]
  `)
})

test('source upgrade follows a moving remote branch, even from an old detached checkout', () => {
  shell(`
    ROOT=$(mktemp -d)
    trap 'cd /; rm -rf "$ROOT"' EXIT
    REMOTE="$ROOT/remote"
    INSTALL_DIR="$ROOT/install"
    command git init -q -b main "$REMOTE"
    command git -C "$REMOTE" config user.name fixture
    command git -C "$REMOTE" config user.email fixture@example.invalid
    echo one > "$REMOTE/source"
    command git -C "$REMOTE" add source
    command git -C "$REMOTE" commit -qm one
    command git clone -q "$REMOTE" "$INSTALL_DIR"
    echo two > "$REMOTE/source"
    command git -C "$REMOTE" commit -qam two
    git() {
      if [ "$1" = fetch ]; then
        command git fetch --depth 1 "$REMOTE" "\${@: -1}"
      else command git "$@"; fi
    }
    checkout_tag main
    [ "$(< "$INSTALL_DIR/source")" = two ]
    [ "$(command git remote get-url origin)" = https://github.com/Keisawaakira/vm2api.git ]
    echo three > "$REMOTE/source"
    command git -C "$REMOTE" commit -qam three
    checkout_tag main
    [ "$(< "$INSTALL_DIR/source")" = three ]
  `)
})

function buildScenario(attempts, expectedStatus) {
  const cases = attempts
    .map(({ log, status }, i) => `${i + 1}) printf '%s\\n' '${log.replaceAll("'", "'\\''")}'; return ${status} ;;`)
    .join('\n')
  return shell(
    `
    INSTALL_DIR=$(mktemp -d)
    trap 'rm -rf "$INSTALL_DIR"' EXIT
    mkdir "$INSTALL_DIR/.git"
    touch "$INSTALL_DIR/VERSION" "$INSTALL_DIR/CHANGELOG.md"
    git() { echo abc123; }
    wait_health() { return 0; }
    compose() {
      local n=0
      if [ -f "$INSTALL_DIR/attempts" ]; then n=$(< "$INSTALL_DIR/attempts"); fi
      n=$((n + 1)); echo "$n" > "$INSTALL_DIR/attempts"
      echo "BUILD_ATTEMPT_$n"
      case "$n" in
        ${cases}
        *) echo UNEXPECTED_RETRY; return 99 ;;
      esac
    }
    start_stack
  `,
    expectedStatus,
  )
}

const cachedChangelog = '#17 CACHED COPY VERSION CHANGELOG.md ./'
const missingCandidate = 'failed to solve: failed to calculate checksum: "/share/offline-candidates": not found'
const missingChangelog = 'failed to solve: failed to calculate checksum: "/CHANGELOG.md": not found'
for (const error of [missingCandidate, 'src/page.tsx: error TS2307: Cannot find module fixture']) {
  test(`cached CHANGELOG COPY does not misclassify unrelated build error: ${error}`, () => {
    const output = buildScenario([{ log: cachedChangelog + '\n' + error, status: 1 }], 1)
    assert.match(output, /BUILD_ATTEMPT_1/)
    assert.doesNotMatch(output, /BUILD_ATTEMPT_2|UNEXPECTED_RETRY|错误类型 1|compose 因 CHANGELOG/)
    assert.ok(output.includes(error))
  })
}

test('an actual missing CHANGELOG retries once and may succeed', () => {
  const output = buildScenario(
    [
      { log: missingChangelog, status: 1 },
      { log: 'BUILD_OK', status: 0 },
    ],
    0,
  )
  assert.match(output, /BUILD_ATTEMPT_2/)
  assert.match(output, /compose 因 CHANGELOG/)
  assert.doesNotMatch(output, /BUILD_ATTEMPT_3|UNEXPECTED_RETRY|错误类型 1/)
})

test('legacy missing CHANGELOG gets a bounded retry and the relevant guide', () => {
  const legacy = 'COPY failed: file not found in build context: stat CHANGELOG.md: file does not exist'
  const output = buildScenario(
    [
      { log: legacy, status: 1 },
      { log: legacy, status: 1 },
    ],
    1,
  )
  assert.match(output, /BUILD_ATTEMPT_2/)
  assert.match(output, /错误类型 1/)
  assert.doesNotMatch(output, /BUILD_ATTEMPT_3|UNEXPECTED_RETRY/)
})

test('a different failure after retry is not reported as CHANGELOG failure', () => {
  const output = buildScenario(
    [
      { log: missingChangelog, status: 1 },
      { log: missingCandidate, status: 1 },
    ],
    1,
  )
  assert.match(output, /BUILD_ATTEMPT_2/)
  assert.ok(output.includes(missingCandidate))
  assert.doesNotMatch(output, /BUILD_ATTEMPT_3|UNEXPECTED_RETRY|错误类型 1/)
})

test('build and failed health check are hard installer failures', () => {
  shell(
    `
    INSTALL_DIR=$(mktemp -d)
    trap 'rm -rf "$INSTALL_DIR"' EXIT
    mkdir "$INSTALL_DIR/.git"
    touch "$INSTALL_DIR/VERSION" "$INSTALL_DIR/CHANGELOG.md"
    git() { echo abc123; }
    compose() { echo BUILD_FAILED; return 1; }
    start_stack
  `,
    1,
  )
  shell(
    `
    INSTALL_DIR=$(mktemp -d)
    trap 'rm -rf "$INSTALL_DIR"' EXIT
    mkdir "$INSTALL_DIR/.git"
    touch "$INSTALL_DIR/VERSION" "$INSTALL_DIR/CHANGELOG.md"
    git() { echo abc123; }
    compose() { return 0; }
    wait_health() { return 1; }
    start_stack
  `,
    1,
  )
})
