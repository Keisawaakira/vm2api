#!/usr/bin/env bash
#
# vm2api 一键安装 / 更新
# 参考 sub2api deploy/install.sh 与 CLIProxyAPI installer：
#   拉取 fork 分支/指定 tag → 本机构建 → 保留配置 → 替换控制面。
#
# 安装:
#   curl -fsSL https://raw.githubusercontent.com/Keisawaakira/vm2api/main/deploy/install.sh | sudo bash
# 更新:
#   curl -fsSL https://raw.githubusercontent.com/Keisawaakira/vm2api/main/deploy/install.sh | sudo bash -s -- upgrade
# 检查:
#   sudo bash /opt/vm2api/deploy/install.sh check
#
set -euo pipefail

if [ -z "${BASH_VERSION:-}" ]; then
  echo "请用 bash 运行（需要 bash 4+）" >&2
  exit 1
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

GITHUB_REPO="${VM2API_GITHUB_REPO:-Keisawaakira/vm2api}"
SOURCE_REF="${VM2API_REF:-main}"
INSTALL_DIR="${VM2API_DIR:-/opt/vm2api}"
SERVICE_NAME="vm2api"
DEFAULT_PORT="${PORT:-8787}"
TARGET_VERSION=""
ASSUME_YES=0
NO_START=0
SYNC_WRAP=1
FROM_SOURCE=1
DEFAULT_ADMIN_USER="admin"
DEFAULT_ADMIN_PASSWORD="123456"
WROTE_DEFAULT_PASSWORD=0

info() { echo -e "${BLUE}[信息]${NC} $*"; }
ok() { echo -e "${GREEN}[成功]${NC} $*"; }
warn() { echo -e "${YELLOW}[警告]${NC} $*"; }
err() { echo -e "${RED}[错误]${NC} $*" >&2; }

is_interactive() {
  [ -e /dev/tty ] && [ -r /dev/tty ] && [ -w /dev/tty ]
}

need_root() {
  if [ "$(id -u)" -ne 0 ]; then
    err "请用 root 运行：curl ... | sudo bash   或   sudo bash deploy/install.sh $*"
    exit 1
  fi
}

usage() {
  cat <<EOF
用法: $(basename "$0") [命令] [选项]

命令:
  install              安装到 ${INSTALL_DIR}（默认）
  upgrade | update     更新 fork 分支源码并构建（保留 .env / vms / data）
  check                显示本地提交与远端分支/tag
  changelog            打印本地 CHANGELOG.md
  status               当前版本、容器、探活
  uninstall            停控制面（默认保留 .env / vms / data）

选项:
  --version vX.Y.Z     指定 tag（优先于 --ref）
  --ref BRANCH         源码分支/tag（默认 ${SOURCE_REF}）
  --dir PATH           安装目录（默认 ${INSTALL_DIR}）
  --yes                非交互
  --no-start           只拉代码，不 compose up
  --no-sync-wrap       升级后不自动替换并重启槽内 CLI / kernel
  --from-source        clone 仓库并在本机构建镜像（默认）
  --image              使用该仓库发布的 GHCR 镜像/Release（已有源码仍构建）
                       fork 没有发布镜像时不要使用 --image
  -h, --help           帮助
EOF
}

target_ref() {
  if [ -n "$TARGET_VERSION" ]; then
    echo "$TARGET_VERSION"
  elif [ "$FROM_SOURCE" = 1 ] || [ -d "${INSTALL_DIR}/.git" ]; then
    echo "$SOURCE_REF"
  else
    latest_release_tag
  fi
}

normalize_tag() {
  local v="${1:-}"
  v="${v#v}"
  if [ -z "$v" ]; then
    echo ""
    return
  fi
  echo "v${v}"
}

version_of_tag() {
  echo "${1#v}"
}

local_version() {
  if [ -f "${INSTALL_DIR}/VERSION" ]; then
    tr -d '[:space:]' <"${INSTALL_DIR}/VERSION"
    return
  fi
  echo "not_installed"
}

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    err "需要 Docker Compose（docker compose 或 docker-compose）"
    exit 1
  fi
}

require_cmds() {
  local missing=()
  for c in git curl docker; do
    command -v "$c" >/dev/null 2>&1 || missing+=("$c")
  done
  if [ ${#missing[@]} -gt 0 ]; then
    err "缺少依赖: ${missing[*]}"
    info "Ubuntu: apt-get update && apt-get install -y git curl ca-certificates docker.io"
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    err "Docker 未运行，或当前用户不能访问 docker.sock"
    exit 1
  fi
  compose version >/dev/null
}

github_api() {
  local url="$1"
  local args=(-fsSL --connect-timeout 10 --max-time 30
    -H "Accept: application/vnd.github+json"
    -H "User-Agent: vm2api-installer"
    -H "X-GitHub-Api-Version: 2022-11-28")
  if [ -n "${GITHUB_TOKEN:-}${VM2API_GITHUB_TOKEN:-}" ]; then
    args+=(-H "Authorization: Bearer ${GITHUB_TOKEN:-$VM2API_GITHUB_TOKEN}")
  fi
  curl "${args[@]}" "$url"
}

latest_release_tag() {
  local json tag
  json="$(github_api "https://api.github.com/repos/${GITHUB_REPO}/releases/latest" 2>/dev/null || true)"
  tag="$(printf '%s' "$json" | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
  if [ -n "$tag" ]; then
    normalize_tag "$tag"
    return
  fi
  tag="$(git ls-remote --tags --refs "https://github.com/${GITHUB_REPO}.git" 2>/dev/null \
    | awk -F/ '{print $NF}' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -t. -k1,1 -k2,2n -k3,3n | tail -n1 || true)"
  if [ -z "$tag" ]; then
    err "拿不到 GitHub 最新 Release。可设 GITHUB_TOKEN，或指定 --version vX.Y.Z"
    exit 1
  fi
  echo "$tag"
}

release_notes() {
  local tag="$1"
  github_api "https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${tag}" 2>/dev/null \
    | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin)
    print((d.get("body") or "").strip())
except Exception:
    pass' 2>/dev/null || true
}

print_changelog_slice() {
  local file="$1"
  local from_ver="$2"
  local to_ver="$3"
  if [ ! -f "$file" ]; then
    return
  fi
  python3 - "$file" "$from_ver" "$to_ver" <<'PY'
import re, sys
path, current, target = sys.argv[1], sys.argv[2].lstrip("v"), sys.argv[3].lstrip("v")
text = open(path, encoding="utf-8").read()
chunks = re.split(r"^## ", text, flags=re.M)[1:]
def ver(h):
    m = re.match(r"v?(\d+\.\d+\.\d+)", h)
    return m.group(1) if m else None
def tup(v):
    if not v: return (0,0,0)
    return tuple(int(x) for x in v.split(".")[:3])
cur, tgt = tup(current), tup(target)
shown = 0
for chunk in chunks:
    heading, _, body = chunk.partition("\n")
    heading = heading.strip()
    v = ver(heading)
    if not v or v == "unreleased":
        continue
    tv = tup(v)
    if tv > cur and tv <= tgt:
        print(f"## {heading.strip()}")
        print(body.strip())
        print()
        shown += 1
if shown == 0:
    sys.exit(0)
PY
}


gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
    return
  fi
  python3 -c 'import secrets; print(secrets.token_hex(32))'
}

env_get() {
  local name="$1"
  local envf="${2:-${INSTALL_DIR}/.env}"
  [ -f "$envf" ] || return 0
  grep -E "^${name}=" "$envf" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d "'" | tr -d '"' | tr -d '\r'
}

env_set() {
  local name="$1"
  local value="$2"
  local envf="${INSTALL_DIR}/.env"
  if grep -qE "^${name}=" "$envf" 2>/dev/null; then
    sed -i "s|^${name}=.*|${name}=${value}|" "$envf"
  else
    printf '%s=%s\n' "$name" "$value" >>"$envf"
  fi
}

env_set_if_empty() {
  local name="$1"
  local value="$2"
  if [ -z "$(env_get "$name")" ]; then
    env_set "$name" "$value"
    return 0
  fi
  return 1
}

ensure_git_safe() {
  if [ -d "${INSTALL_DIR}/.git" ]; then
    git config --global --add safe.directory "${INSTALL_DIR}" 2>/dev/null || true
  fi
}

guide_changelog_error() {
  echo ""
  warn "错误类型 1：构建找不到 CHANGELOG.md"
  echo "  识别: COPY VERSION CHANGELOG.md ./  或  \"/CHANGELOG.md\": not found"
  echo "  原因: .dockerignore 的 *.md 把 CHANGELOG.md 挡在构建上下文外（v1.2.7）。"
  echo "  在 ${INSTALL_DIR} 执行:"
  echo "    grep -q '!CHANGELOG.md' .dockerignore || echo '!CHANGELOG.md' >> .dockerignore"
  echo "    docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build"
  echo "  或一键升到已修复版本:"
  echo "    curl -sSL https://raw.githubusercontent.com/${GITHUB_REPO}/main/deploy/install.sh | sudo bash -s -- upgrade"
  echo ""
}

guide_auth_error() {
  local port
  port="$(env_get PORT)"
  port="${port:-$DEFAULT_PORT}"
  echo ""
  warn "错误类型 2：管理台 Missing credentials / 鉴权失效"
  echo "  识别: 总览「加载失败」或 toast「鉴权失效，请重新登录」"
  echo "  处理: 打开登录页，不要直接进总览"
  echo "    http://127.0.0.1:${port}/cc#/login"
  if [ "${WROTE_DEFAULT_PASSWORD:-0}" = 1 ]; then
    echo "  默认账密: admin / 123456（本次写入的空密码默认值，登录后请改）"
  else
    echo "  已有密码见:"
    echo "    grep '^VM2API_ADMIN_PASSWORD=' ${INSTALL_DIR}/.env"
  fi
  echo ""
}

print_login_banner() {
  local port
  port="$(env_get PORT)"
  port="${port:-$DEFAULT_PORT}"
  echo ""
  info "管理台登录: http://127.0.0.1:${port}/cc#/login"
  info "探活:       curl -sS --noproxy '*' http://127.0.0.1:${port}/health"
  if [ "${WROTE_DEFAULT_PASSWORD:-0}" = 1 ]; then
    info "默认账号:   ${DEFAULT_ADMIN_USER}"
    info "默认密码:   ${DEFAULT_ADMIN_PASSWORD}（仅空字段写入；请登录后尽快改）"
  else
    info "管理台密码见 ${INSTALL_DIR}/.env 的 VM2API_ADMIN_PASSWORD"
  fi
  info "若总览报鉴权失效: 先打开上面的登录页"
}

ensure_build_context() {
  local ignore="${INSTALL_DIR}/.dockerignore"
  local changelog="${INSTALL_DIR}/CHANGELOG.md"
  local version="${INSTALL_DIR}/VERSION"
  if [ ! -f "$version" ]; then
    err "缺少 ${version}。控制面镜像无法构建。"
    guide_changelog_error
    exit 1
  fi
  if [ ! -f "$changelog" ]; then
    err "缺少 ${changelog}。Docker 会报 COPY CHANGELOG.md not found。"
    guide_changelog_error
    exit 1
  fi
  if [ -f "$ignore" ] && ! grep -qE '^!CHANGELOG\.md$' "$ignore"; then
    echo '!CHANGELOG.md' >>"$ignore"
    warn "已在 .dockerignore 补上 !CHANGELOG.md（避免 *.md 挡住构建）"
  fi
}

ensure_env() {
  local envf="${INSTALL_DIR}/.env"
  if [ ! -f "$envf" ]; then
    local example="${INSTALL_DIR}/.env.example"
    if [ ! -f "$example" ]; then
      err "没有 .env.example，无法生成 .env"
      exit 1
    fi
    cp "$example" "$envf"
  fi
  chmod 600 "$envf" || true
  env_set_if_empty VM2API_ADMIN_USER "$DEFAULT_ADMIN_USER" || true
  if env_set_if_empty VM2API_ADMIN_PASSWORD "$DEFAULT_ADMIN_PASSWORD"; then
    WROTE_DEFAULT_PASSWORD=1
    ok "已补默认管理台账密  ${DEFAULT_ADMIN_USER} / ${DEFAULT_ADMIN_PASSWORD}（只填空，已有密码未改）"
  else
    info "保留已有管理台密码"
  fi
  env_set_if_empty VM2API_API_KEY "$(gen_secret)" || true
  env_set_if_empty VM2API_DB_SECRET "$(gen_secret)" || true
  chmod 600 "$envf" || true
}

wait_health() {
  local port url i
  port="$(grep -E '^PORT=' "${INSTALL_DIR}/.env" 2>/dev/null | tail -n1 | cut -d= -f2- || true)"
  port="${port:-$DEFAULT_PORT}"
  url="http://127.0.0.1:${port}/health"
  info "等待控制面 ${url}"
  for i in $(seq 1 45); do
    if curl -fsS --noproxy '*' "$url" >/dev/null 2>&1; then
      ok "探活通过"
      return 0
    fi
    sleep 2
  done
  warn "探活超时。看日志: docker logs ${SERVICE_NAME}"
  return 1
}

read_env_key() {
  local name="$1"
  grep -E "^${name}=" "${INSTALL_DIR}/.env" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d "'" | tr -d '"'
}

sync_wrap_cli() {
  local key port response
  key="$(read_env_key VM2API_API_KEY)"
  port="$(read_env_key PORT)"
  port="${port:-$DEFAULT_PORT}"
  if [ -z "$key" ]; then
    warn "没有 VM2API_API_KEY，跳过 wrap-cli/sync。可稍后："
    echo "  curl -sS -X POST http://127.0.0.1:${port}/api/panel/wrap-cli/sync -H \"Authorization: Bearer \$VM2API_API_KEY\" -H 'Content-Type: application/json' -d '{\"restart\":true}'"
    return 1
  fi
  info "同步槽内 wrap CLI / kernel"
  response="$(curl -fsS -X POST "http://127.0.0.1:${port}/api/panel/wrap-cli/sync" \
    -H "Authorization: Bearer ${key}" \
    -H "Content-Type: application/json" \
    -d '{"restart":true}')" || return 1
  printf '%s' "$response" | python3 -c 'import json, sys
d = json.load(sys.stdin)
r = d.get("data") or {}
failed = int(r.get("failed_count") or 0)
total = int(r.get("total") or 0)
ok = int(r.get("ok_count") or 0)
print(f"wrap-cli/sync: {ok}/{total}, failed={failed}")
raise SystemExit(0 if d.get("ok") and failed == 0 else 1)'
  ok "槽内 wrap CLI / kernel 已同步"
}

RAW_BASE="https://raw.githubusercontent.com/${GITHUB_REPO}"

# 有 .git 就是源码安装（本机构建），否则是镜像安装（只拉预构建镜像）。
install_mode() {
  if [ -d "${INSTALL_DIR}/.git" ]; then
    echo source
  else
    echo image
  fi
}

fetch_file() {
  local tag="$1" rel="$2" dest="$3" optional="${4:-0}"
  if curl -fsSL --connect-timeout 10 --max-time 60 "${RAW_BASE}/${tag}/${rel}" -o "${dest}.new"; then
    mv -f "${dest}.new" "$dest"
    return 0
  fi
  rm -f "${dest}.new"
  if [ "$optional" = 1 ]; then
    return 0
  fi
  err "下载失败: ${RAW_BASE}/${tag}/${rel}"
  exit 1
}

# 镜像安装：只落部署文件，不 clone 仓库，不在本机构建。
fetch_release_files() {
  local tag="$1"
  mkdir -p "${INSTALL_DIR}/deploy"
  info "下载部署文件 ${tag} → ${INSTALL_DIR}"
  fetch_file "$tag" docker-compose.yml "${INSTALL_DIR}/docker-compose.yml"
  fetch_file "$tag" .env.example "${INSTALL_DIR}/.env.example"
  fetch_file "$tag" VERSION "${INSTALL_DIR}/VERSION"
  fetch_file "$tag" CHANGELOG.md "${INSTALL_DIR}/CHANGELOG.md" 1
  fetch_file "$tag" deploy/install.sh "${INSTALL_DIR}/deploy/install.sh" 1
  chmod +x "${INSTALL_DIR}/deploy/install.sh" 2>/dev/null || true
  mkdir -p "${INSTALL_DIR}/vms" "${INSTALL_DIR}/data" "${INSTALL_DIR}/bin" \
    "${INSTALL_DIR}/share" "${INSTALL_DIR}/src/config"
}

checkout_tag() {
  local ref="$1" repo="https://github.com/${GITHUB_REPO}.git"
  cd "${INSTALL_DIR}"
  if [ ! -d .git ]; then
    err "${INSTALL_DIR} 不是 git 仓库"
    exit 1
  fi
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    err "源码目录有未提交修改；请先提交或备份处理，再升级（不会强制覆盖）"
    exit 1
  fi
  info "fetch ${repo} ${ref}"
  git fetch --depth 1 "$repo" "$ref"
  git reset --hard FETCH_HEAD
  git remote set-url origin "$repo"
  info "源码提交 $(git rev-parse HEAD)"
  chmod 755 bin/kin-* 2>/dev/null || true
}

fresh_clone() {
  local ref="$1" stage
  if [ -d "${INSTALL_DIR}/.git" ]; then
    ensure_git_safe
    checkout_tag "$ref"
    return
  fi
  if [ -e "${INSTALL_DIR}" ] && [ -n "$(ls -A "${INSTALL_DIR}" 2>/dev/null || true)" ] && \
     [ ! -f "${INSTALL_DIR}/docker-compose.yml" ]; then
    err "${INSTALL_DIR} 非空且不是 vm2api 安装目录；拒绝覆盖"
    exit 1
  fi
  mkdir -p "$(dirname "$INSTALL_DIR")"
  stage="$(mktemp -d "${INSTALL_DIR}.source.XXXXXX")"
  info "clone ${GITHUB_REPO}@${ref} → ${stage}"
  if ! git clone --branch "$ref" --depth 1 "https://github.com/${GITHUB_REPO}.git" "$stage"; then
    rm -rf "$stage"
    err "拉取失败，原安装未改动"
    exit 1
  fi
  if [ -e "$stage/.env" ] || [ -e "$stage/vms" ] || [ -e "$stage/data" ]; then
    err "源码包含运行时数据目录；拒绝迁移。暂存目录: $stage"
    exit 1
  fi
  mkdir -p "$INSTALL_DIR"
  if [ -d "$INSTALL_DIR/src/config" ]; then
    mkdir -p "$stage/src/config"
    cp -a "$INSTALL_DIR/src/config/." "$stage/src/config/"
  fi
  # Stage excludes runtime .env/vms/data; existing config wins during image migration.
  cp -a "$stage/." "$INSTALL_DIR/"
  rm -rf "$stage"
  cd "$INSTALL_DIR"
  ensure_git_safe
  info "源码提交 $(git rev-parse HEAD)"
  chmod 755 bin/kin-* 2>/dev/null || true
}

start_stack() {
  local mode auto_sync_wrap log
  mode="$(install_mode)"
  if [ "$NO_START" = 1 ]; then
    warn "--no-start：跳过 compose up"
    return
  fi
  cd "${INSTALL_DIR}"
  auto_sync_wrap="${KIN_AUTO_SYNC_WRAP:-0}"
  if [ "$mode" = image ]; then
    info "docker compose pull && up -d（拉预构建镜像，本机不构建）"
    if ! compose pull; then
      err "拉取控制面镜像失败。检查网络与 registry 可达性，或用 --from-source 走本机构建。"
      exit 1
    fi
    if KIN_AUTO_SYNC_WRAP="$auto_sync_wrap" compose up -d; then
      wait_health || { err "控制面探活失败"; exit 1; }
      return
    fi
    err "docker compose 失败。日志: docker logs ${SERVICE_NAME}"
    exit 1
  fi
  ensure_build_context
  export VM2API_SOURCE_REVISION
  VM2API_SOURCE_REVISION="$(git rev-parse HEAD)"
  info "docker compose up -d --build（源码 ${VM2API_SOURCE_REVISION}；只重建控制面，不 docker rm 槽）"
  log="$(mktemp)"
  if KIN_AUTO_SYNC_WRAP="$auto_sync_wrap" compose -f docker-compose.yml -f docker-compose.build.yml up -d --build >"$log" 2>&1; then
    cat "$log"
    rm -f "$log"
    wait_health || { err "控制面探活失败"; exit 1; }
    return
  fi
  cat "$log"
  if grep -qE 'CHANGELOG\.md|"/CHANGELOG\.md": not found' "$log"; then
    warn "compose 因 CHANGELOG.md 失败，补 .dockerignore 后重试一次"
    ensure_build_context
    if KIN_AUTO_SYNC_WRAP="$auto_sync_wrap" compose -f docker-compose.yml -f docker-compose.build.yml up -d --build; then
      rm -f "$log"
      wait_health || { err "控制面探活失败"; exit 1; }
      return
    fi
    guide_changelog_error
    rm -f "$log"
    exit 1
  fi
  err "docker compose 失败"
  guide_changelog_error
  rm -f "$log"
  exit 1
}

print_banner() {
  echo ""
  echo -e "${CYAN}==============================================${NC}"
  echo -e "${CYAN}  vm2api${NC}"
  echo -e "${CYAN}==============================================${NC}"
}

cmd_install() {
  need_root
  require_cmds
  print_banner
  local tag
  tag="$(target_ref)"
  info "目标 ${GITHUB_REPO}@${tag}"
  if [ "$FROM_SOURCE" = 1 ] || [ -d "${INSTALL_DIR}/.git" ]; then
    fresh_clone "$tag"
    ensure_git_safe
    ensure_env
  else
    fetch_release_files "$tag"
    ensure_env
    env_set VM2API_IMAGE_TAG "$tag"
    env_set VM2API_IMAGE "${VM2API_IMAGE:-ghcr.io/${GITHUB_REPO,,}}"
  fi
  start_stack
  ok "安装完成  ${INSTALL_DIR}  @ $(local_version)"
  if [ "$NO_START" = 0 ] && [ "$SYNC_WRAP" = 1 ]; then
    sync_wrap_cli || { err "槽内 wrap CLI / kernel 同步失败，安装未完成"; exit 1; }
  fi

  print_login_banner
  info "以后更新: curl -sSL https://raw.githubusercontent.com/${GITHUB_REPO}/main/deploy/install.sh | sudo bash -s -- upgrade"
}

cmd_upgrade() {
  need_root
  require_cmds
  print_banner
  if [ ! -f "${INSTALL_DIR}/docker-compose.yml" ]; then
    err "未安装。先: curl -sSL https://raw.githubusercontent.com/${GITHUB_REPO}/main/deploy/install.sh | sudo bash"
    exit 1
  fi
  local current tag
  current="$(local_version)"
  tag="$(target_ref)"
  info "当前 ${current}  →  目标 ${GITHUB_REPO}@${tag}"
  if [ "v${current}" = "$tag" ]; then
    ok "已经是 ${tag}，仍会对齐镜像与部署文件"
  fi
  if [ "$FROM_SOURCE" = 1 ] || [ "$(install_mode)" = source ]; then
    fresh_clone "$tag"
    ensure_git_safe
    ensure_env
  else
    fetch_release_files "$tag"
    ensure_env
    env_set VM2API_IMAGE_TAG "$tag"
    env_set VM2API_IMAGE "${VM2API_IMAGE:-ghcr.io/${GITHUB_REPO,,}}"
  fi
  echo ""
  info "本版 changelog"
  local notes=""
  if [[ "$tag" == v[0-9]* ]]; then
    print_changelog_slice "${INSTALL_DIR}/CHANGELOG.md" "$current" "$(version_of_tag "$tag")" || true
    notes="$(release_notes "$tag" || true)"
  else
    info "分支构建 ${tag}；版本号可能不变，以源码提交/镜像 revision 为准"
  fi
  if [ -n "$notes" ]; then
    echo "$notes"
    echo ""
  fi
  start_stack
  if [ "$NO_START" = 0 ] && [ "$SYNC_WRAP" = 1 ]; then
    sync_wrap_cli || { err "槽内 wrap CLI / kernel 同步失败，升级未完成"; exit 1; }

  elif [ "$NO_START" = 1 ]; then
    warn "--no-start：控制面未启动，已跳过槽内 CLI / kernel 同步"
  else
    warn "--no-sync-wrap：已跳过槽内 CLI / kernel 同步"
  fi
  ok "已更新到 $(local_version)"
  print_login_banner
}

cmd_check() {
  local current tag
  current="$(local_version)"
  tag="$(target_ref)"
  if [ "$FROM_SOURCE" = 1 ] || [ "$(install_mode)" = source ]; then
    echo "当前版本: ${current}"
    if [ -d "${INSTALL_DIR}/.git" ]; then git -C "$INSTALL_DIR" rev-parse HEAD; fi
    echo "远端: ${GITHUB_REPO}@${tag}"
    git ls-remote "https://github.com/${GITHUB_REPO}.git" "$tag"
    return
  fi
  echo "当前: ${current}"
  echo "最新: ${tag}"
  if [ "v${current}" = "$tag" ]; then
    ok "已是最新"
  else
    warn "有新版本 ${tag}"
    echo ""
    echo "一键更新:"
    echo "  curl -sSL https://raw.githubusercontent.com/${GITHUB_REPO}/main/deploy/install.sh | sudo bash -s -- upgrade"
    echo ""
    if [ -f "${INSTALL_DIR}/CHANGELOG.md" ]; then
      print_changelog_slice "${INSTALL_DIR}/CHANGELOG.md" "$current" "$(version_of_tag "$tag")" || true
    fi
    local notes
    notes="$(release_notes "$tag" || true)"
    if [ -n "$notes" ]; then
      echo "## ${tag} Release notes"
      echo "$notes"
    fi
  fi
}

cmd_changelog() {
  local file="${INSTALL_DIR}/CHANGELOG.md"
  if [ ! -f "$file" ]; then
    file="$(cd "$(dirname "$0")/.." && pwd)/CHANGELOG.md"
  fi
  if [ ! -f "$file" ]; then
    err "找不到 CHANGELOG.md"
    exit 1
  fi
  cat "$file"
}

cmd_status() {
  local current port
  current="$(local_version)"
  echo "目录:    ${INSTALL_DIR}"
  echo "版本:    ${current}"
  if [ -d "${INSTALL_DIR}/.git" ]; then
    echo "git:     $(git -C "${INSTALL_DIR}" describe --tags --always 2>/dev/null || echo unknown)"
  fi
  if command -v docker >/dev/null 2>&1; then
    docker ps --filter "name=${SERVICE_NAME}" --format '容器:    {{.Names}}  {{.Status}}' || true
  fi
  port="$(read_env_key PORT 2>/dev/null || true)"
  port="${port:-$DEFAULT_PORT}"
  if curl -fsS --noproxy '*' "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
    echo "探活:    ok  http://127.0.0.1:${port}/health"
  else
    echo "探活:    down"
  fi
}

cmd_uninstall() {
  need_root
  print_banner
  if [ "$ASSUME_YES" != 1 ] && is_interactive; then
    echo -n "停止并删除控制面容器，保留 .env / vms / data。继续? [y/N] " >/dev/tty
    read -r ans </dev/tty || true
    case "$ans" in
      y|Y|yes|YES) ;;
      *) info "已取消"; exit 0 ;;
    esac
  fi
  if [ -d "${INSTALL_DIR}" ]; then
    (cd "${INSTALL_DIR}" && compose down) || docker rm -f "${SERVICE_NAME}" 2>/dev/null || true
  fi
  ok "控制面已停。数据仍在 ${INSTALL_DIR}/{.env,vms,data}"
  info "若要整目录删除: rm -rf ${INSTALL_DIR}"
}

COMMAND="install"
while [ $# -gt 0 ]; do
  case "$1" in
    install|upgrade|update|check|changelog|status|uninstall)
      COMMAND="$1"
      shift
      ;;
    --version)
      TARGET_VERSION="$(normalize_tag "$2")"
      shift 2
      ;;
    --ref)
      SOURCE_REF="$2"
      FROM_SOURCE=1
      shift 2
      ;;
    --image)
      FROM_SOURCE=0
      shift
      ;;
    --dir)
      INSTALL_DIR="$2"
      shift 2
      ;;
    --yes|-y)
      ASSUME_YES=1
      shift
      ;;
    --no-start)
      NO_START=1
      shift
      ;;
    --sync-wrap)
      SYNC_WRAP=1
      shift
      ;;
    --no-sync-wrap)
      SYNC_WRAP=0
      shift
      ;;
    --from-source)
      FROM_SOURCE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      err "未知参数: $1"
      usage
      exit 1
      ;;
  esac
done

case "$COMMAND" in
  install) cmd_install ;;
  upgrade|update) cmd_upgrade ;;
  check) cmd_check ;;
  changelog) cmd_changelog ;;
  status) cmd_status ;;
  uninstall) cmd_uninstall ;;
  *) usage; exit 1 ;;
esac
