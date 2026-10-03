#!/usr/bin/env bash
# =============================================================================
# bootstrap-vps.sh — harden one Ubuntu x86_64 VPS and bootstrap the compose
# stack of docs/PREVIEW.md on it. Provider-neutral: any VPS or VM with a
# login user that has passwordless sudo (`ubuntu` below). docs/PREVIEW.md §14
# is the procedure; docs/adr/0008 is why it is provider-neutral.
#
# Run it ON the box, as the login user (never as root), either way:
#
#   # piped (non-interactive: it never prompts, it lists what is missing)
#   ssh ubuntu@<host> 'bash -s -- --hostname app.example.invalid \
#       --acme-email ops@example.invalid --ref <40-hex commit>' < scripts/bootstrap-vps.sh
#
#   # copied (interactive: prompts, hidden, for the owner-supplied values)
#   scp scripts/bootstrap-vps.sh ubuntu@<host>:
#   ssh -t ubuntu@<host> 'bash bootstrap-vps.sh --hostname … --acme-email … --ref …'
#
# --ref is REQUIRED on any real run that checks out the repo, and it must be a
# full commit SHA: every run deploys the commit that was reviewed, never
# whatever `main` happens to be at that moment.
#
# Add --dry-run first: every probe runs, every change is printed, none is made.
#
# IDEMPOTENT. Each stage checks before it changes, so re-running is how you
# resume. The run STOPS (exit 3) at two points and expects a re-run:
#   1. right after SSH hardening + firewall first change something — the
#      anti-lockout checkpoint: test a NEW key login before going on;
#   2. before `boot`, while an owner-supplied value or the key escrow is
#      missing.
#
# Exit codes: 0 done · 1 refused or failed · 2 usage · 3 stopped for an
#             owner action (re-run after it).
#
# NEVER prints or logs a secret. Generated values go straight from `openssl
# rand` into /opt/hames/.env (mode 600) through the environment, never argv.
#
# An unmanaged VPS is the customer's to secure, whichever provider sells it.
# The hardening stages apply the baseline that VPS providers' own hardening
# guides converge on, in this order: updates · SSH keys only · SSH port,
# opt-in with --ssh-port · a host firewall · fail2ban. A provider-edge
# firewall, the restricted-user question and backups happen outside the box
# and are owner actions (docs/PREVIEW.md §14).
# =============================================================================

# -----------------------------------------------------------------------------
# Constants. Nothing here identifies a host: the hostname is a REQUIRED
# argument, because this repo is public and no deployment's name belongs in it.
# -----------------------------------------------------------------------------
readonly REPO_URL="https://github.com/mknw/hames-playground"
# The two HAMES_* overrides exist for scripts/bootstrap-vps.test.sh, which
# points them at a scratch directory. A deployment leaves them unset.
readonly APP_DIR="${HAMES_APP_DIR:-/opt/hames}"
readonly ENV_FILE="$APP_DIR/.env"
readonly STATE_DIR="${HAMES_STATE_DIR:-/var/lib/hames-bootstrap}"
readonly ESCROW_MARKER="$STATE_DIR/keys-escrowed"
readonly SSHD_DROPIN="/etc/ssh/sshd_config.d/00-hames-hardening.conf"
readonly F2B_JAIL="/etc/fail2ban/jail.local"
# The header every file this script manages carries; jail.local without it
# is somebody else's, and is never overwritten.
readonly MANAGED_BY="Managed by scripts/bootstrap-vps.sh"
readonly COMPOSE_FILES="docker-compose.yaml:docker-compose.prod.yaml"
readonly COMPOSE_PROFILE="app"
readonly MIN_COMPOSE="2.24.0" # docker-compose.prod.yaml's `!override` needs it
# Docker's apt signing key (docs.docker.com/engine/install/ubuntu).
readonly DOCKER_GPG_FPR="9DC858229FC7DD38854AE2D88D81803C0EBFCD88"

# docker_key_problem COLONS — why `gpg --show-keys --with-colons` output is not
# exactly Docker's one key (empty: it is). Exactly ONE primary key, and it is
# Docker's: Signed-By trusts every key in the file, so an appended key must
# fail too.
docker_key_problem() {
  local npub fpr
  npub=$(grep -c '^pub:' <<<"$1") || npub=0
  fpr=$(awk -F: '$1 == "pub" { want = 1; next } want && $1 == "fpr" { print $10; exit }' <<<"$1")
  if ((npub != 1)); then
    printf '%s\n' "the key file holds $npub primary keys, not 1"
  elif [[ $fpr != "$DOCKER_GPG_FPR" ]]; then
    printf '%s\n' "its fingerprint is '${fpr:-unreadable}', expected $DOCKER_GPG_FPR"
  fi
}
# PR #260's merge: encryption at rest. A ref older than this cannot read the
# rows a newer one wrote (docs/PREVIEW.md §10), so it is never deployed here.
readonly ENCRYPTION_BOUNDARY="56ac2b44af11d65c85cabc3096102c3cdc76d2ed"
# The preview tool surface, sorted (docs/PREVIEW.md §3a; pinned for the overlay
# by app/src/__tests__/lib/preview-tool-surface.test.ts).
readonly PREVIEW_SERVERS="context7 fetch memory neo4j-cypher web_search"
# 16 since #403: with `read_only: true` the Neo4j server does not offer
# write_neo4j_cypher (it was 17). Derived, not yet read off a live box — a 17
# here means the gateway still lists the write tool (docs/PREVIEW.md, step 1b).
readonly PREVIEW_TOOL_COUNT=16
readonly KEYS_RE="AUTH_SESSION_SECRET|TOKEN_ENCRYPTION_KEY|DATA_ENCRYPTION_KEY"

readonly STAGES=(preflight updates ssh firewall fail2ban docker checkout env hostname images boot seed smoke)

# -----------------------------------------------------------------------------
# Output. Everything goes to stdout so a piped run's transcript keeps its order.
# -----------------------------------------------------------------------------
say() { printf '%s\n' "$*"; }
ok() { printf '  ok      %s\n' "$*"; }
chg() { printf '  CHANGE  %s\n' "$*"; }
note() { printf '          %s\n' "$*"; }
warn() { printf '  WARN    %s\n' "$*"; }
fail() { printf '  FAIL    %s\n' "$*"; }
banner() { printf '\n== %s ==\n' "$*"; }

DRY_RUN=0
WOULD_STOP=() # dry-run: the gates a real run would have stopped at

# refuse MSG — a precondition failed and going on is unsafe. Exits 1; in a dry
# run it records the refusal and returns, so the rest of the plan stays visible.
# Callers `return` straight after it.
refuse() {
  if ((DRY_RUN)); then
    printf '  WOULD REFUSE: %s\n' "$*"
    WOULD_STOP+=("refuse: $*")
    return 0
  fi
  printf '\nREFUSED: %s\n' "$*"
  exit 1
}

# owner_stop MSG... — the next step needs the owner. Exits 3 (re-run after it).
owner_stop() {
  if ((DRY_RUN)); then
    printf '  WOULD STOP for the owner: %s\n' "$1"
    WOULD_STOP+=("owner: $1")
    return 0
  fi
  printf '\nSTOPPED for an owner action — re-run this script afterwards:\n'
  printf '  %s\n' "$@"
  exit 3
}

# run CMD... — a command that CHANGES the box. Printed, then run unless dry.
# Never hand it a secret: its arguments are printed (and visible in `ps`).
run() {
  local shown="$*"
  [[ $shown == "dc "* ]] && shown="docker compose ${shown#dc }"
  printf '  +       %s\n' "$shown"
  ((DRY_RUN)) && return 0
  local rc=0
  "$@" || rc=$?
  ((rc == 0)) || printf '  FAILED  (exit %s): %s\n' "$rc" "$*"
  return "$rc"
}

# put_file PATH MODE OWNER:GROUP < content — write a NON-secret root-owned file
# only if its content differs. Returns 0 if it changed (or would), 1 if not, so
# call it as a condition: `if put_file …; then …; fi`.
put_file() {
  local path=$1 mode=$2 owner=$3 new
  new=$(
    cat
    printf x
  )
  new=${new%x}
  if sudo test -f "$path" && [[ "$(
    sudo cat "$path"
    printf x
  )" == "${new}x" ]]; then
    ok "unchanged $path"
    return 1
  fi
  chg "write $path"
  ((DRY_RUN)) && return 0
  sudo install -d -m 0755 "$(dirname "$path")"
  printf '%s' "$new" | sudo tee "$path" >/dev/null
  sudo chown "$owner" "$path"
  sudo chmod "$mode" "$path"
}

# matches ERE TEXT — grep TEXT already in hand. Never `producer | grep -q`:
# under `set -o pipefail` grep -q exits at its first match, the producer dies of
# SIGPIPE (141), and the pipeline reads as FAILED, so a match is reported as
# absent. Capture first, then match.
matches() { grep -qE -- "$1" <<<"$2"; }

pkg_installed() { [[ "$(dpkg-query -W -f='${Status}' "$1" 2>/dev/null)" == *'install ok installed'* ]]; }

apt_get() { run sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get -qq -y -o Dpkg::Use-Pty=0 "$@"; }

apt_install() {
  local missing=() p
  for p in "$@"; do pkg_installed "$p" || missing+=("$p"); done
  if ((${#missing[@]} == 0)); then
    ok "installed: $*"
    return 0
  fi
  apt_get install "${missing[@]}"
}

# version_ge A B — A >= B in version order.
version_ge() {
  local lowest
  lowest=$(printf '%s\n%s\n' "$2" "$1" | sort -V)
  [[ ${lowest%%$'\n'*} == "$2" ]]
}

# reserved_name NAME — a name Let's Encrypt can never issue for or mail.
reserved_name() {
  local n=${1,,}
  n=${n#*@}
  [[ $n =~ \.(invalid|test|example|localhost)$ || $n =~ (^|\.)example\.(com|net|org)$ ]]
}

# -----------------------------------------------------------------------------
# The repo-root .env. Owned by the login user, mode 600. Values are read into
# command substitutions only, and written through the environment of `awk`, so
# no value is ever on a command line or on the terminal.
# -----------------------------------------------------------------------------

# env_get KEY — the last KEY= line's value, one layer of quotes removed.
env_get() {
  local line
  line=$(grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -n1) || true
  line=${line#*=}
  if [[ $line == \'*\' || $line == \"*\" ]]; then line=${line:1:${#line}-2}; fi
  printf '%s' "$line"
}

# env_set KEY VALUE — upsert KEY='VALUE' (single-quoted: literal for Compose).
env_set() {
  local key=$1 tmp
  if [[ $2 == *"'"* || $2 == *$'\n'* ]]; then
    refuse "$key: the value contains a single quote or a newline; fix it in $ENV_FILE by hand"
    return 0
  fi
  ((DRY_RUN)) && return 0
  tmp=$(mktemp "$ENV_FILE.XXXXXX") # mktemp creates it 0600
  HAMES_V=$2 awk -v k="$key" '
    BEGIN { v = ENVIRON["HAMES_V"]; done = 0 }
    index($0, k "=") == 1 { if (!done) { print k "=\047" v "\047"; done = 1 }; next }
    { print }
    END { if (!done) print k "=\047" v "\047" }' "$ENV_FILE" >"$tmp"
  mv "$tmp" "$ENV_FILE"
}

# gen_secret KIND — hex for the two database passwords (spliced into a
# postgresql:// URL, so URL-safe per .env.example); base64 for the three keys
# (.env.production.example's own recipe; HKDF-normalised by the app).
gen_secret() {
  case $1 in
    hex) openssl rand -hex 24 ;;
    b64) openssl rand -base64 32 ;;
  esac
}

# fill_generated KEY KIND — generate KEY on the box ONLY while it is empty.
# A value that exists is never regenerated: replacing DATA_ENCRYPTION_KEY makes
# every stored conversation unreadable, and the database passwords are applied
# only when a volume is first created (docs/PREVIEW.md §7, §11).
fill_generated() {
  if [[ -n "$(env_get "$1")" ]]; then
    ok "kept existing $1"
    return 0
  fi
  ((DRY_RUN)) && {
    chg "generate $1 on the box (value not shown)"
    keys_generated_now "$1"
    return 0
  }
  local v
  # Fail CLOSED: a generator that failed or printed something short must never
  # become an empty or weak value that a later run then treats as "kept".
  v=$(gen_secret "$2" 2>/dev/null) || v=""
  if [[ ! $v =~ ^[A-Za-z0-9+/=]{40,}$ ]]; then
    unset v
    refuse "could not generate $1 (is openssl installed?); nothing was written"
    return 0
  fi
  env_set "$1" "$v"
  unset v
  chg "generated $1 on the box (value not shown)"
  keys_generated_now "$1"
}

# keys_generated_now KEY — note that one of the three escrowed keys was made in
# THIS run. Nobody can have escrowed a key that did not exist when they said
# so, so --keys-escrowed is ignored for the rest of the run.
KEYS_GENERATED=0
keys_generated_now() { if [[ $1 =~ ^($KEYS_RE)$ ]]; then KEYS_GENERATED=1; fi; }

keys_fingerprint() {
  {
    env_get AUTH_SESSION_SECRET
    printf '\n'
    env_get TOKEN_ENCRYPTION_KEY
    printf '\n'
    env_get DATA_ENCRYPTION_KEY
  } | sha256sum | cut -d' ' -f1
}

# The owner-supplied values `boot` cannot do without: KEY|label|secret?
readonly OWNER_REQUIRED=(
  "AZURE_TENANT_ID|Entra tenant (directory) id|0"
  "AZURE_CLIENT_ID|Entra application (client) id|0"
  "AZURE_CLIENT_SECRET|Entra client secret VALUE, not its id|1"
  "ANTHROPIC_API_KEY|Anthropic API key|1"
  "VITE_ALLOWED_EMAILS|this deployment's allow-list: comma-separated, *@domain wildcards|0"
)
# The private tier: all three or none (CLAUDE.md, docs/PREVIEW.md §6).
readonly VERDA_TRIO=(VERDA_INFERENCE_ENDPOINT VERDA_INFERENCE_API_KEY SMALL_LLM_BASE_URL)

# owner_missing — print each owner-required key that is empty or a placeholder.
owner_missing() {
  local entry key v
  for entry in "${OWNER_REQUIRED[@]}"; do
    key=${entry%%|*}
    v=$(env_get "$key")
    # The template's allow-list is the contoso placeholder, not a real list.
    if [[ -z $v || ($key == VITE_ALLOWED_EMAILS && $v == '*@contoso.com') ]]; then
      printf '%s\n' "$key"
    fi
  done
}

# env_problems — docs/PREVIEW.md §6's preflight greps, plus the rest of what a
# boot needs from .env. One line per problem; nothing printed means clean.
env_problems() {
  local k n=0 v
  grep -q 'example\.com' "$ENV_FILE" && printf '%s\n' ".env still carries an example.com placeholder (§6: grep -n 'example\\.com' .env)"
  for k in AUTH_SESSION_SECRET TOKEN_ENCRYPTION_KEY DATA_ENCRYPTION_KEY ANTHROPIC_API_KEY \
    POSTGRES_PASSWORD NEO4J_PASSWORD; do
    [[ -n "$(env_get "$k")" ]] || printf '%s\n' "$k is empty"
  done
  for k in "${VERDA_TRIO[@]}"; do [[ -n "$(env_get "$k")" ]] && n=$((n + 1)); done
  if ((n != 0 && n != 3)); then
    printf '%s\n' "private tier: $n of ${VERDA_TRIO[*]} set — all three or none (a partial tier is refused at run time)"
  fi
  for k in VERDA_INFERENCE_ENDPOINT SMALL_LLM_BASE_URL; do
    v=$(env_get "$k")
    [[ -z $v || $v == */v1 ]] || printf '%s\n' "$k must end in /v1"
  done
  [[ "$(env_get USE_VERDA_INFERENCE)" == 1 && $n -ne 3 ]] && printf '%s\n' "USE_VERDA_INFERENCE=1 without all of ${VERDA_TRIO[*]}"
  [[ "$(env_get STASH_DIRECT_REDIS)" == 1 ]] || printf '%s\n' "STASH_DIRECT_REDIS must be '1' (the preview gateway has no redis server; §3a)"
  grep -qE '^VITE_DEV_BYPASS_AUTH=' "$ENV_FILE" && printf '%s\n' "VITE_DEV_BYPASS_AUTH is set in .env — it must stay unset"
  [[ "$(env_get COMPOSE_FILE)" == "$COMPOSE_FILES" ]] || printf '%s\n' "COMPOSE_FILE must be $COMPOSE_FILES"
  [[ "$(env_get COMPOSE_PROFILES)" == "$COMPOSE_PROFILE" ]] || printf '%s\n' "COMPOSE_PROFILES must be $COMPOSE_PROFILE"
  return 0
}

# -----------------------------------------------------------------------------
# Compose. Always through sudo (the login user's docker-group membership only
# applies from its NEXT login), always with the overlay and the profile named
# explicitly — the same two values .env carries, so a drifted .env cannot
# select the laptop file.
# -----------------------------------------------------------------------------
dc() { (cd "$APP_DIR" && sudo env COMPOSE_FILE="$COMPOSE_FILES" COMPOSE_PROFILES="$COMPOSE_PROFILE" docker compose "$@"); }

have_compose() { command -v docker >/dev/null 2>&1 && sudo docker compose version >/dev/null 2>&1; }

# gateway_image — the mcp-gateway image the stack would run. The rendered
# config when Compose is available (it is client-side: no daemon needed);
# otherwise a static read of the two files, the overlay's value winning.
# Compose's stderr is NOT discarded below: when the render fails, its own
# error prints right above the refusal instead of a guess.
gateway_image() {
  if have_compose && [[ -f $ENV_FILE ]]; then
    local json
    json=$(dc config --format json) || return 1
    python3 -c 'import json,sys; print(json.load(sys.stdin)["services"]["mcp-gateway"].get("image",""))' <<<"$json"
    return
  fi
  local f img=""
  for f in "$APP_DIR/docker-compose.yaml" "$APP_DIR/docker-compose.prod.yaml"; do
    [[ -f $f ]] || continue
    local found
    found=$(awk '
      /^  [A-Za-z0-9_-]+:/ { svc = $1 }
      svc == "mcp-gateway:" && /^    image:/ { sub(/^    image:[ \t]*/, ""); gsub(/["\047]/, ""); print; exit }' "$f")
    [[ -n $found ]] && img=$found
  done
  printf '%s\n' "$img"
}

# dynamic_tools_state — features."dynamic-tools" in the tracked
# docker-config.json the gateway mounts as its Docker config. Empty when the
# file or the key is missing, which the gateway reads as ON (#422).
dynamic_tools_state() {
  python3 -c 'import json, sys; print(json.load(open(sys.argv[1])).get("features", {}).get("dynamic-tools", ""))' \
    "$APP_DIR/docker-config.json" 2>/dev/null || true
}

# assert_dynamic_tools_off — with the feature on, the gateway adds its own
# management tools (mcp-find, mcp-add, mcp-config-set, …) to every agent's
# tool list (#412, #420). The tracked file is the switch; this script never
# writes it, and never puts a registry credential in it.
assert_dynamic_tools_off() {
  local st
  st=$(dynamic_tools_state)
  if [[ $st == disabled ]]; then
    ok "docker-config.json: dynamic-tools disabled"
  elif ((DRY_RUN)) && [[ ! -d $APP_DIR/.git ]]; then
    note "(dry run: no checkout yet, so docker-config.json is checked on the real run)"
  else
    refuse "docker-config.json sets features.dynamic-tools to '${st:-<missing>}', not 'disabled'; the gateway's default is ON, which puts its management tools on every agent (#422). Deploy a ref that has #422."
  fi
}

# image_pinned IMAGE — true only for a content-addressed reference.
image_pinned() { [[ $1 =~ @sha256:[0-9a-f]{64}$ ]]; }

# assert_gateway_pinned — #417: the latest upstream gateway release refuses
# this stack's --catalog path and 401s the app, and the base compose file names
# the image without a tag. A fresh host would pull exactly that release. So
# nothing is pulled or booted until the image is digest-pinned in compose.
assert_gateway_pinned() {
  local img
  img=$(gateway_image) || img=""
  if [[ -z $img ]]; then
    if ((DRY_RUN)) && [[ ! -d $APP_DIR/.git ]]; then
      note "(dry run: no checkout yet, so the gateway pin is checked on the real run)"
      return 0
    fi
    refuse "could not read the mcp-gateway image from the compose files (docker compose config's own error, if any, is just above)"
    return 0
  fi
  if image_pinned "$img"; then
    ok "mcp-gateway image is digest-pinned: $img"
    return 0
  fi
  refuse "the mcp-gateway image is '$img', not digest-pinned (<image>@sha256:<64 hex>). The latest upstream release breaks this stack (#417). Land the pinning PR, then re-run with --ref pointing at it."
}

# rendered_exposure — Compose's rendered INTENT (docs/PREVIEW.md §2): every
# published port on loopback except Caddy's, and the gateway allow-listed.
rendered_exposure() {
  local json
  json=$(dc config --format json) || return 1
  python3 -c '
import json, sys
c = json.load(sys.stdin)["services"]
for name, svc in sorted(c.items()):
    for p in svc.get("ports", []):
        ip = p.get("host_ip", "")
        if name == "caddy":
            if str(p.get("published")) not in ("80", "443"):
                print("caddy publishes %s, not only 80/443" % p.get("published"))
        elif ip not in ("127.0.0.1", "::1"):
            print("%s publishes %s on %r" % (name, p.get("published"), ip or "0.0.0.0"))
cmd = c.get("mcp-gateway", {}).get("command", []) or []
if "--enable-all-servers" in cmd or not any(a.startswith("--servers=") for a in cmd):
    print("mcp-gateway is not allow-listed with --servers= (the overlay did not apply)")
' <<<"$json"
}

# public_listeners ALLOWED_PORTS — read `ss -H -ln[tu]` on stdin; print every
# socket listening on a non-loopback address whose port is not allowed.
public_listeners() {
  local allowed=" $1 " state recvq sendq laddr rest addr port
  while read -r state recvq sendq laddr rest; do
    [[ -n ${laddr:-} ]] || continue
    port=${laddr##*:}
    addr=${laddr%:*}
    addr=${addr#[}
    addr=${addr%]}
    case $addr in
      127.* | ::1 | ::ffff:127.* | *%lo | fe80:*) continue ;; # loopback, link-local
    esac
    [[ $allowed == *" $port "* ]] && continue
    printf '%s %s %s %s %s\n' "$state" "$recvq" "$sendq" "$laddr" "${rest:-}"
  done
}

# authorized_keys_problem FILE USER — why FILE would not let USER in by key
# (empty output means it would). Checks what sshd's StrictModes checks.
authorized_keys_problem() {
  local f=$1 user=$2 dir
  dir=$(dirname "$f")
  [[ -s $f ]] || {
    printf '%s\n' "$f is missing or empty"
    return
  }
  ssh-keygen -l -f "$f" >/dev/null 2>&1 || {
    printf '%s\n' "$f holds no valid public key"
    return
  }
  local p
  for p in "$f" "$dir" "$(dirname "$dir")"; do
    [[ "$(stat -c %U "$p")" == "$user" || "$(stat -c %U "$p")" == root ]] ||
      printf '%s\n' "$p is not owned by $user"
    (("0$(stat -c %a "$p")" & 022)) && printf '%s\n' "$p is group- or world-writable (sshd StrictModes refuses the key)"
  done
  return 0
}

# =============================================================================
# Stages
# =============================================================================

stage_preflight() {
  banner "1/13 preflight — architecture, OS, capacity, sudo"
  if ((EUID == 0)); then
    refuse "run as the login user (ubuntu) with sudo, not as root: PermitRootLogin no would lock a root-only operator out"
    return 0
  fi
  if sudo -n true 2>/dev/null; then ok "passwordless sudo for $(id -un)"; else
    refuse "$(id -un) needs passwordless sudo (a piped run cannot answer a password prompt)"
  fi

  # #412: the stack has amd64-only images. Not a warning — an arm64 box boots
  # half a stack and fails at run time.
  local arch
  arch=$(uname -m)
  if [[ $arch == x86_64 ]]; then ok "architecture $arch"; else
    refuse "architecture is $arch; this stack needs x86_64 (amd64-only images, #412)"
  fi

  local id="" ver=""
  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091 # the host's own file, read at run time
    id=$(. /etc/os-release && printf '%s' "${ID:-}")
    # shellcheck disable=SC1091
    ver=$(. /etc/os-release && printf '%s' "${VERSION_ID:-}")
  fi
  case "$id/$ver" in
    ubuntu/24.04 | ubuntu/26.04) ok "Ubuntu $ver" ;;
    ubuntu/*) warn "Ubuntu $ver is not one this script was tested on (24.04, 26.04); continuing" ;;
    *) refuse "OS is '${id:-unknown} ${ver}'; this script is for Ubuntu (apt, ufw, Docker's Ubuntu repo)" ;;
  esac

  local mem_kb disk_kb cpus
  mem_kb=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
  disk_kb=$(df -Pk / | awk 'NR == 2 {print $4}')
  cpus=$(nproc)
  # docs/PREVIEW.md §1 sizes one stack at 16 GiB ("not generous") and 64 GiB of
  # disk; the image build alone peaks near 2.3 GB RSS.
  if ((mem_kb < 4 * 1024 * 1024)); then
    refuse "RAM is $((mem_kb / 1024)) MiB; under 4 GiB the stack and its build do not fit"
  elif ((mem_kb < 15 * 1024 * 1024)); then
    warn "RAM is $((mem_kb / 1024)) MiB; docs/PREVIEW.md §1 sizes the stack at 16 GiB"
  else ok "RAM $((mem_kb / 1024 / 1024)) GiB"; fi
  if ((disk_kb < 20 * 1024 * 1024)); then
    refuse "free disk on / is $((disk_kb / 1024 / 1024)) GiB; images alone need ~10 GiB plus build cache"
  elif ((disk_kb < 40 * 1024 * 1024)); then
    warn "free disk on / is $((disk_kb / 1024 / 1024)) GiB; tight for images, build cache and data"
  else ok "free disk $((disk_kb / 1024 / 1024)) GiB"; fi
  if ((cpus < 4)); then warn "$cpus vCPU; the build and Neo4j will be slow"; else ok "$cpus vCPU"; fi
  [[ -d /run/systemd/system ]] || warn "systemd is not PID 1 here; service changes are written but cannot take effect"

  # The two names Let's Encrypt is asked about. Reserved ones are fine for a
  # dry run; `boot` refuses them (an ACME failure counts against the limits).
  if reserved_name "$HOSTNAME_ARG"; then warn "--hostname $HOSTNAME_ARG is a reserved placeholder; boot will refuse it"; fi
  if reserved_name "$ACME_EMAIL_ARG"; then warn "--acme-email uses a reserved domain; boot will refuse it"; fi
}

stage_updates() {
  banner "2/13 updates — apt upgrade, unattended security upgrades"
  apt_get update
  apt_get -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold --with-new-pkgs upgrade
  apt_install ca-certificates curl git gnupg openssl python3 unattended-upgrades
  # Security origin only: that is what 50unattended-upgrades allows by default,
  # and Docker's repo is not in it, so the engine is never upgraded under the
  # stack unattended. No automatic reboot (Ubuntu's default) — see below.
  if put_file /etc/apt/apt.conf.d/20auto-upgrades 0644 root:root <<EOF; then :; fi
// $MANAGED_BY: refresh lists and apply security
// updates daily (origins: /etc/apt/apt.conf.d/50unattended-upgrades).
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
  run sudo systemctl enable --now unattended-upgrades.service apt-daily.timer apt-daily-upgrade.timer
  if [[ -f /var/run/reboot-required ]]; then
    warn "a reboot is pending (/var/run/reboot-required). Reboot when convenient; the stack restarts itself (restart: unless-stopped)."
  fi
}

# SSH ports. 22 unless --ssh-port moves it, and the move takes two runs so
# the box is never without a port that is known to work:
#   run A (--ssh-port P):            listen on 22 AND P; ufw opens P first;
#   run B (--ssh-port P --ssh-port-verified, after a key login on P worked):
#                                    listen on P only, then close 22 in ufw.
desired_ssh_ports() {
  if ((SSH_PORT == 22)); then
    echo 22
  elif ((SSH_PORT_VERIFIED)); then
    echo "$SSH_PORT"
  else
    echo "22 $SSH_PORT"
  fi
}

# closes_22 — the verified end of a port move: 22 is no longer an SSH port.
closes_22() { [[ " $(desired_ssh_ports) " != *" 22 "* ]]; }

# listening PORT — something (sshd, or systemd holding ssh.socket) listens on
# TCP PORT on this box.
listening() { [[ -n "$(sudo ss -H -ltn "sport = :$1" 2>/dev/null)" ]]; }

sshd_dropin_content() {
  cat <<EOF
# $MANAGED_BY. Sorts first on purpose: sshd keeps
# the first value it reads, and later drop-ins (50-cloud-init.conf) may differ.
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
  local p
  if [[ "$(desired_ssh_ports)" != 22 ]]; then
    # On Ubuntu 24.04+ sshd is socket-activated, and sshd-socket-generator
    # turns these Port lines into ssh.socket's ListenStream at daemon-reload
    # (/run/systemd/generator/ssh.socket.d/addresses.conf). That is the
    # supported way to edit the socket: some hardening guides edit
    # /lib/systemd/system/ssh.socket instead, a packaged file an upgrade
    # overwrites.
    for p in $(desired_ssh_ports); do printf 'Port %s\n' "$p"; done
  fi
}

# apply_sshd PORTS_CHANGED — make sshd serve the drop-in. Auth options need a
# reload; a port change needs the socket rebuilt. Returns 1 if the socket does
# not end up listening on every desired port.
apply_sshd() {
  if ((!$1)); then
    # Reload, not restart: existing sessions are untouched either way, and a
    # socket-activated sshd that is not running reads the file on next connect.
    run sudo systemctl try-reload-or-restart ssh.service
    return 0
  fi
  run sudo systemctl daemon-reload
  ((DRY_RUN)) && {
    run sudo systemctl restart ssh.socket
    return 0
  }
  local gen=/run/systemd/generator/ssh.socket.d/addresses.conf p
  if systemctl is-enabled --quiet ssh.socket 2>/dev/null; then
    # Port 22 alone is the packaged unit's own ListenStream; the generator
    # writes nothing for it, so only a non-default set is read back.
    [[ "$(desired_ssh_ports)" == 22 ]] || for p in $(desired_ssh_ports); do
      if ! sudo grep -qs "^ListenStream=0.0.0.0:$p\$" "$gen"; then
        fail "ssh.socket was not regenerated for port $p ($gen); sshd-socket-generator missing?"
        return 1
      fi
    done
    run sudo systemctl restart ssh.socket
  else
    run sudo systemctl try-reload-or-restart ssh.service
  fi
  sleep 1
  for p in $(desired_ssh_ports); do
    listening "$p" || {
      fail "nothing listens on port $p after the change"
      return 1
    }
  done
  return 0
}

# SSH. Keys only, no root, no passwords: the hardening baseline, step for
# step, except the port, which moves only on request (--ssh-port). Why it is
# not the default: with no password to guess, key-only login plus fail2ban
# already defeats the brute force a port move hides from, and a move is up to
# five places that must agree (sshd, ssh.socket, ufw, fail2ban, any provider
# firewall), any one of which missed is a lockout. What it buys is a quieter
# auth log.
stage_ssh() {
  banner "3/13 ssh — keys only, no root, no passwords; port $(desired_ssh_ports | tr ' ' '+')"
  local user home keys problems
  user=$(id -un)
  home=$(getent passwd "$user" | cut -d: -f6)
  keys="$home/.ssh/authorized_keys"
  # ANTI-LOCKOUT, part 1: never disable passwords for an account that has no
  # working key. Checked BEFORE anything is written.
  problems=$(authorized_keys_problem "$keys" "$user")
  if [[ -n $problems ]]; then
    refuse "no usable SSH key for $user: $(tr '\n' ';' <<<"$problems") — add one first (ssh-copy-id $user@<host>) and log in with it"
    return 0
  fi
  ok "$keys holds $(ssh-keygen -l -f "$keys" | wc -l) usable key(s)"
  command -v sshd >/dev/null 2>&1 || [[ -x /usr/sbin/sshd ]] || {
    refuse "sshd not found"
    return 0
  }
  if ! sudo grep -qE '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d/\*\.conf' /etc/ssh/sshd_config; then
    refuse "/etc/ssh/sshd_config does not include sshd_config.d/*.conf, so a drop-in would be ignored"
    return 0
  fi
  local eff0
  if ! eff0=$(sudo /usr/sbin/sshd -T 2>&1); then
    refuse "sshd -T cannot read the CURRENT configuration, so nothing was changed: $(head -n1 <<<"$eff0")"
    return 0
  fi
  if ! matches '^authorizedkeysfile .*\.ssh/authorized_keys' "$eff0"; then
    refuse "sshd's AuthorizedKeysFile does not read ~/.ssh/authorized_keys; the key checked above would not be used"
    return 0
  fi
  # Closing 22 is allowed only once the new port is known to work: it must be
  # listening already (run A did that), and the operator must say a key login
  # on it succeeded (--ssh-port-verified).
  if ((SSH_PORT != 22 && SSH_PORT_VERIFIED && !DRY_RUN)) && ! listening "$SSH_PORT"; then
    refuse "--ssh-port-verified, but nothing listens on $SSH_PORT yet: run once with --ssh-port $SSH_PORT alone, log in on it, then add --ssh-port-verified"
    return 0
  fi
  # ufw opens a new port BEFORE sshd moves to it: the firewall changes before
  # the service restarts, never after. Inactive ufw stores it.
  if ((SSH_PORT != 22)) && command -v ufw >/dev/null 2>&1; then
    run sudo ufw allow "$SSH_PORT/tcp"
  fi

  local had_dropin=0 old="" new ports_changed=0
  if sudo test -f "$SSHD_DROPIN"; then
    had_dropin=1
    old=$(sudo cat "$SSHD_DROPIN")
  fi
  new=$(sshd_dropin_content)
  [[ "$(grep '^Port ' <<<"$old" || true)" != "$(grep '^Port ' <<<"$new" || true)" ]] && ports_changed=1
  if put_file "$SSHD_DROPIN" 0644 root:root <<<"$new"; then
    LOCKOUT_CHANGED=1
    if ((DRY_RUN)); then
      note "effective now: $(sudo /usr/sbin/sshd -T 2>/dev/null | grep -E '^(port|passwordauthentication|kbdinteractiveauthentication|permitrootlogin) ' | tr '\n' ' ')"
      apply_sshd "$ports_changed"
      return 0
    fi
    # ANTI-LOCKOUT, part 2: a config sshd cannot parse is removed before any
    # reload or restart can trip over it.
    if ! sudo /usr/sbin/sshd -t; then
      if ((had_dropin)); then printf '%s\n' "$old" | sudo tee "$SSHD_DROPIN" >/dev/null; else sudo rm -f "$SSHD_DROPIN"; fi
      refuse "sshd -t rejected the configuration; the previous drop-in was restored and sshd was NOT reloaded"
      return 0
    fi
  fi
  if ((!DRY_RUN)); then
    local eff kv bad=() p
    eff=$(sudo /usr/sbin/sshd -T) || eff=""
    for kv in "passwordauthentication no" "kbdinteractiveauthentication no" "permitrootlogin no" "pubkeyauthentication yes"; do
      grep -qx "$kv" <<<"$eff" || bad+=("$kv")
    done
    for p in $(desired_ssh_ports); do grep -qx "port $p" <<<"$eff" || bad+=("port $p"); done
    if ((${#bad[@]})); then
      refuse "sshd's effective config is not '${bad[*]}' — another file under /etc/ssh overrides $SSHD_DROPIN"
      return 0
    fi
    ok "effective: keys only, no root login; port(s) $(desired_ssh_ports)"
  fi
  ((LOCKOUT_CHANGED)) || return 0
  if ! apply_sshd "$ports_changed"; then
    # ANTI-LOCKOUT, part 3: the socket did not come up as asked. Put the last
    # known-good drop-in back and rebuild from it before stopping.
    if ((had_dropin)); then printf '%s\n' "$old" | sudo tee "$SSHD_DROPIN" >/dev/null; else sudo rm -f "$SSHD_DROPIN"; fi
    sudo systemctl daemon-reload || true
    sudo systemctl restart ssh.socket 2>/dev/null || sudo systemctl try-reload-or-restart ssh.service || true
    refuse "sshd did not end up listening on $(desired_ssh_ports); the previous drop-in was restored"
    return 0
  fi
}

# Firewall. Deny in, allow out, the SSH port(s), 80 and 443, on v4 AND v6.
# Read the caveat: Docker publishes ports through its own iptables NAT rules,
# which divert the packets BEFORE ufw's INPUT chain sees them. ufw therefore
# does not guard a Docker-published port at all. What keeps Postgres, Neo4j,
# Redis, the gateway, doc-convert and the app private is
# docker-compose.prod.yaml binding every one of them to 127.0.0.1; `smoke`
# proves the result with `ss`.
stage_firewall() {
  banner "4/13 firewall — ufw: deny incoming, allow SSH ($(desired_ssh_ports | tr ' ' '+')), 80, 443 (v4 + v6)"
  apt_install ufw
  if sudo grep -qs '^IPV6=yes' /etc/default/ufw; then ok "ufw manages IPv6 too"; else
    run sudo sed -i 's/^IPV6=.*/IPV6=yes/' /etc/default/ufw
  fi
  # ANTI-LOCKOUT: every SSH port is allowed, and read back, BEFORE ufw is
  # enabled.
  local p
  for p in $(desired_ssh_ports); do
    run sudo ufw allow "$p/tcp"
    if ((!DRY_RUN)) && ! matches "^ufw allow $p/tcp\$" "$(sudo ufw show added 2>/dev/null)"; then
      refuse "ufw does not list 'allow $p/tcp' after adding it; not enabling the firewall"
      return 0
    fi
  done
  run sudo ufw allow 80/tcp
  run sudo ufw allow 443/tcp
  run sudo ufw allow 443/udp
  run sudo ufw default deny incoming
  run sudo ufw default allow outgoing
  if command -v ufw >/dev/null 2>&1 && matches '^Status: active' "$(sudo ufw status 2>/dev/null)"; then
    ok "ufw already active"
  else
    run sudo ufw --force enable
    LOCKOUT_CHANGED=1
  fi
  # The last step of a port move: 22 closes only once sshd no longer listens
  # on it, i.e. after stage_ssh moved to the verified port alone.
  if closes_22 && matches '^ufw allow 22/tcp$' "$(sudo ufw show added 2>/dev/null)"; then
    if ((!DRY_RUN)) && listening 22; then
      refuse "something still listens on 22; not closing it in ufw"
      return 0
    fi
    run sudo ufw delete allow 22/tcp
    LOCKOUT_CHANGED=1
  fi
  ((DRY_RUN)) || sudo ufw status verbose | sed 's/^/          /'
  note "Docker-published ports bypass ufw; the overlay's loopback binds are the control (smoke checks them)."
  edge_firewall_rules
}

# A firewall in front of the box (a provider's edge or network firewall, a
# cloud security group) filters before traffic arrives, and it is configured
# in the provider's console, so it is an OWNER action. The rules mirror ufw's.
# Where that firewall is stateless for UDP, the replies to the box's own DNS
# and NTP queries need rules of their own; where it filters IPv4 only, ufw
# stays the only filter for IPv6.
edge_firewall_rules() {
  local p n=2
  say "  OWNER: if the provider offers a firewall in front of the box, mirror"
  say "  ufw there. For one that applies rules in order, first match wins:"
  say "    0  Accept  TCP  state: established   (replies to the box's own connections)"
  say "    1  Accept  UDP  source port 53       (DNS replies, if UDP is stateless there)"
  for p in $(desired_ssh_ports); do
    say "    $n  Accept  TCP  destination port $p   (SSH; add your source IP if it is fixed)"
    n=$((n + 1))
  done
  say "    $n  Accept  TCP  destination port 80   (ACME HTTP-01, redirect to 443)"
  say "    $((n + 1))  Accept  TCP  destination port 443"
  say "    $((n + 2))  Accept  UDP  destination port 443  (HTTP/3)"
  say "    $((n + 3))  Accept  UDP  source port 123      (NTP replies, if UDP is stateless there)"
  say "    $((n + 4))  Accept  ICMP"
  say "    $((n + 5))  Deny    everything else (the last rule)"
  say "  Keep it in step with ufw: a port move changes the SSH rule(s) too."
}

# The checkpoint between the lockout-capable stages and everything else.
checkpoint_lockout() {
  ((LOCKOUT_CHANGED)) || return 0
  if ((DRY_RUN)); then
    say ""
    say "  WOULD STOP here (anti-lockout checkpoint): a real run exits 3 after"
    say "  changing sshd or the firewall, so a NEW key login is tested first."
    WOULD_STOP+=("checkpoint: test a new key login, then re-run")
    return 0
  fi
  local p port_args="" next
  for p in $(desired_ssh_ports); do [[ $p == 22 ]] || port_args="-p $p "; done
  if ((SSH_PORT != 22 && !SSH_PORT_VERIFIED)); then
    next="re-run with the same arguments plus --ssh-port-verified to close 22"
  else
    next="re-run this script with the same arguments; these stages will report 'ok'"
  fi
  cat <<EOF

ANTI-LOCKOUT CHECKPOINT — sshd and/or the firewall changed in this run.

  1. Keep the session you opened BEFORE this run open (an sshd reload, a
     socket restart and enabling ufw all leave existing sessions alone).
  2. From a NEW terminal, prove a fresh login works with the key ALONE:
       ssh ${port_args}-o PreferredAuthentications=publickey -o PasswordAuthentication=no \\
           $(id -un)@<host> true && echo 'NEW KEY LOGIN OK'
  3. If it fails, revert from the session kept open in step 1:
       sudo rm -f $SSHD_DROPIN
       sudo systemctl daemon-reload && sudo systemctl restart ssh.socket
       sudo ufw allow 22/tcp
     If no session is left, use the provider's out-of-band access: a web,
     serial or KVM console (it logs in with the account's password, if it
     has one), or a rescue / recovery boot. From a rescue system: find the
     disk with lsblk, mount it on /mnt, delete /mnt$SSHD_DROPIN, set
     ENABLED=no in /mnt/etc/ufw/ufw.conf, then boot normally. A mistake in a
     firewall in front of the box is undone in the provider's console, not
     from rescue.
     A fail2ban ban drops the kept session too: from another address,
     sudo fail2ban-client set sshd unbanip <ip>; else the console or a
     rescue boot, or wait 30 minutes.
  4. Only after 'NEW KEY LOGIN OK': close the old session, then
     $next.

EOF
  exit 3
}

# valid_ip ADDR — an IPv4 or IPv6 address, optionally /prefix. It is written
# into jail.local, so nothing else may get through.
valid_ip() {
  [[ $1 =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}(/([0-9]|[12][0-9]|3[0-2]))?$ ||
    $1 =~ ^[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*(/([0-9]|[1-9][0-9]|1[01][0-9]|12[0-8]))?$ ]]
}

# session_client_ip — this SSH session's client address, as the server sees it
# (and so as fail2ban would): SSH_CONNECTION's first field, else SSH_CLIENT's.
session_client_ip() {
  local c=${SSH_CONNECTION:-${SSH_CLIENT:-}}
  c=${c%% *}
  if [[ -n $c ]] && valid_ip "$c"; then printf '%s\n' "$c"; fi
}

# f2b_ignore_list — what the sshd jail never bans: loopback, plus the
# operator. That is --f2b-ignore when given ("none": loopback only), else this
# session's own client address. Without it, three mistyped user names from the
# operator's machine ban that address for 30 minutes, and the ban drops the
# session the anti-lockout procedure keeps open, too.
f2b_ignore_list() {
  local list="127.0.0.1/8 ::1" ip
  if [[ -n $F2B_IGNORE ]]; then
    [[ $F2B_IGNORE == none ]] || list+=" ${F2B_IGNORE//,/ }"
  else
    ip=$(session_client_ip)
    [[ -n $ip ]] && list+=" $ip"
  fi
  printf '%s\n' "$list"
}

# The [sshd] jail with the values VPS hardening guides commonly give; the
# port follows --ssh-port, and during a move it is both.
f2b_jail_content() {
  local ports
  ports=$(desired_ssh_ports | tr ' ' ',')
  [[ $ports == 22 ]] && ports=ssh
  cat <<EOF
# $MANAGED_BY, with the hardening baseline's [sshd]
# values. The port follows --ssh-port; during a move it is both. ignoreip is
# the operator's address (--f2b-ignore, else the session that ran this).
[sshd]
enabled  = true
port     = $ports
filter   = sshd
maxretry = 3
findtime = 5m
bantime  = 30m
ignoreip = $(f2b_ignore_list)
EOF
}

stage_fail2ban() {
  banner "5/13 fail2ban — sshd jail (the baseline's values)"
  apt_install fail2ban
  # The sshd jail goes in jail.local: maxretry 3, findtime 5m, bantime 30m.
  # jail.local overrides jail.conf and Ubuntu's jail.d/defaults-debian.conf,
  # which keeps its systemd backend. Unban a mistyped operator with:
  # sudo fail2ban-client set sshd unbanip <ip>
  if sudo test -f "$F2B_JAIL" && ! sudo grep -qF "$MANAGED_BY" "$F2B_JAIL"; then
    refuse "$F2B_JAIL exists and is not this script's; merge the [sshd] values by hand (maxretry 3, findtime 5m, bantime 30m, port $(desired_ssh_ports | tr ' ' ','), ignoreip $(f2b_ignore_list))"
    return 0
  fi
  local ignore ip
  ignore=$(f2b_ignore_list)
  if [[ -n $F2B_IGNORE ]]; then
    ok "never banned: $ignore (--f2b-ignore)"
  elif ip=$(session_client_ip) && [[ -n $ip ]]; then
    ok "never banned: $ignore — $ip is THIS session's address (from SSH_CONNECTION); --f2b-ignore <ip>[,<ip>] sets it instead"
    if ((INTERACTIVE && !DRY_RUN)); then
      local yn
      printf '  Exempt %s from fail2ban bans? [Y/n] ' "$ip" >/dev/tty
      IFS= read -r yn </dev/tty
      if [[ $yn =~ ^[Nn] ]]; then
        F2B_IGNORE=none
        ignore=$(f2b_ignore_list)
      fi
    fi
  else
    warn "no operator address to exempt (no SSH_CONNECTION, no --f2b-ignore): three mistyped user names from your machine ban it for 30 minutes, kept session included"
  fi
  local changed=0
  if put_file "$F2B_JAIL" 0644 root:root <<<"$(f2b_jail_content)"; then changed=1; fi
  if ((!DRY_RUN)) && ! sudo fail2ban-client -t >/dev/null 2>&1; then
    refuse "fail2ban-client -t rejects the configuration (see: sudo fail2ban-client -t)"
    return 0
  fi
  run sudo systemctl enable fail2ban.service
  if ((changed)); then run sudo systemctl restart fail2ban.service; else run sudo systemctl start fail2ban.service; fi
  if ((!DRY_RUN)) && [[ -d /run/systemd/system ]]; then
    for _ in 1 2 3 4 5 6; do
      sudo fail2ban-client status sshd >/dev/null 2>&1 && break
      sleep 2
    done
    if sudo fail2ban-client status sshd >/dev/null 2>&1; then ok "jail sshd is running"; else
      fail "jail sshd is not running (sudo systemctl status fail2ban)"
      return 1
    fi
  fi
}

# Docker Engine + the compose plugin from Docker's own apt repository — not the
# snap, not Ubuntu's docker.io. Docker group membership for the login user is a
# trade-off stated once: it is root-equivalent, and this user already has
# passwordless sudo, so it grants nothing new; it is what lets the backup cron
# (docs/PREVIEW.md §9) and an operator run `docker compose` without sudo.
stage_docker() {
  banner "6/13 docker — Engine + compose plugin (Docker's apt repo)"
  if command -v snap >/dev/null 2>&1 && snap list docker >/dev/null 2>&1; then
    refuse "Docker is installed as a snap; remove it (sudo snap remove docker) — this stack needs Docker's apt packages"
    return 0
  fi
  local p conflicts=()
  for p in docker.io docker-compose docker-compose-v2 docker-doc podman-docker containerd runc; do
    pkg_installed "$p" && conflicts+=("$p")
  done
  if ((${#conflicts[@]})); then
    refuse "conflicting packages installed: ${conflicts[*]}. Remove them by hand (they may hold containers), then re-run"
    return 0
  fi

  if pkg_installed docker-ce && pkg_installed docker-compose-plugin; then
    ok "docker-ce and docker-compose-plugin installed"
  else
    apt_install ca-certificates curl gnupg
    run sudo install -m 0755 -d /etc/apt/keyrings
    run sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    run sudo chmod a+r /etc/apt/keyrings/docker.asc
    if ((!DRY_RUN)); then
      local colons problem
      colons=$(gpg --show-keys --with-colons /etc/apt/keyrings/docker.asc 2>/dev/null) || colons=""
      problem=$(docker_key_problem "$colons")
      if [[ -n $problem ]]; then
        sudo rm -f /etc/apt/keyrings/docker.asc
        refuse "Docker's apt key file is wrong: $problem; key removed"
        return 0
      fi
      ok "Docker apt key: exactly one key, fingerprint $DOCKER_GPG_FPR"
    fi
    local codename
    # shellcheck disable=SC1091
    codename=$(. /etc/os-release && printf '%s' "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
    # Docker publishes a suite per Ubuntu codename, usually some weeks after
    # the release (26.04's `resolute` is there: checked 2026-10-03). There is
    # deliberately no fallback: the snap and Ubuntu's docker.io are what this
    # stage exists to avoid, and pointing a new release at the previous
    # codename's suite installs binaries built against other libraries.
    # Refuse, and re-run once Docker publishes the suite.
    if ! command -v curl >/dev/null 2>&1; then
      note "(curl is not installed yet, so the suite check for '$codename' runs on the real run)"
    elif ! curl -fsSI --max-time 20 "https://download.docker.com/linux/ubuntu/dists/$codename/Release" >/dev/null 2>&1; then
      refuse "Docker's apt repository has no suite for '$codename' yet (https://download.docker.com/linux/ubuntu/dists/); re-run once it does"
      return 0
    else
      ok "Docker's apt repository publishes '$codename'"
    fi
    if put_file /etc/apt/sources.list.d/docker.sources 0644 root:root <<EOF; then :; fi
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $codename
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
    apt_get update
    apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi

  # Unrotated json-file logs grow until the disk is full; the gateway runs
  # --verbose. Written only when absent, so a hand-tuned daemon.json survives.
  if sudo test -f /etc/docker/daemon.json; then
    ok "/etc/docker/daemon.json exists; left as is"
  elif put_file /etc/docker/daemon.json 0644 root:root <<'EOF'; then
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "5" }
}
EOF
    pkg_installed docker-ce && run sudo systemctl restart docker.service
  fi
  run sudo systemctl enable --now docker.service containerd.service

  if ((!DRY_RUN)) || have_compose; then
    local v
    v=$(sudo docker compose version --short 2>/dev/null || true)
    v=${v#v}
    if [[ -z $v ]]; then
      refuse "docker compose is not available after the install"
      return 0
    elif version_ge "$v" "$MIN_COMPOSE"; then
      ok "docker compose $v (>= $MIN_COMPOSE, which the overlay's !override needs)"
    else
      refuse "docker compose $v is older than $MIN_COMPOSE; docker-compose.prod.yaml's !override needs it"
      return 0
    fi
  fi
  if [[ " $(id -nG "$(id -un)") " == *" docker "* ]]; then ok "$(id -un) is in the docker group"; else
    run sudo usermod -aG docker "$(id -un)"
    note "takes effect at the next login; this script uses sudo for docker throughout"
  fi
}

# The checkout: the PUBLIC repo at /opt/hames, detached at an exact commit.
# The one tracked file this deployment edits — configs/mcp-config.yaml — is
# restored before a checkout and re-written after it, so moving to a new ref
# never collides with it.
stage_checkout() {
  banner "7/13 checkout — $REPO_URL at ${REF:-<no --ref>} -> $APP_DIR"
  local user
  user=$(id -un)
  if [[ ! -d $APP_DIR/.git ]]; then
    if [[ -e $APP_DIR ]] && [[ -n "$(ls -A "$APP_DIR" 2>/dev/null)" ]]; then
      refuse "$APP_DIR exists, is not empty and is not a git checkout"
      return 0
    fi
    run sudo install -d -o "$user" -g "$user" -m 0755 "$APP_DIR"
    run git clone --quiet "$REPO_URL" "$APP_DIR"
    if ((DRY_RUN)); then
      note "(dry run: no checkout exists, so the ref is not resolved)"
      return 0
    fi
  fi
  if [[ "$(git -C "$APP_DIR" remote get-url origin)" != "$REPO_URL" ]]; then
    refuse "$APP_DIR's origin is not $REPO_URL"
    return 0
  fi
  # Uncommitted changes to tracked files (other than the managed config) are
  # somebody's edits on a live box. Refuse rather than discard them.
  local dirty
  dirty=$(git -C "$APP_DIR" status --porcelain --untracked-files=no | grep -v ' configs/mcp-config.yaml$' || true)
  if [[ -n $dirty ]]; then
    refuse "$APP_DIR has local changes to tracked files: $(tr '\n' ' ' <<<"$dirty")"
    return 0
  fi
  run git -C "$APP_DIR" fetch --quiet --prune --tags origin
  local sha
  if [[ -z $REF ]]; then
    # Only a dry run gets here without --ref (main refuses a real one).
    note "(dry run without --ref: a real run requires the reviewed commit's full SHA)"
    sha=$(git -C "$APP_DIR" rev-parse HEAD)
  elif ! sha=$(git -C "$APP_DIR" rev-parse --verify --quiet "$REF^{commit}"); then
    # A reviewed commit no branch or tag carries yet (a PR head): GitHub serves
    # a reachable commit by its id.
    run git -C "$APP_DIR" fetch --quiet origin "$REF" || true
    if ! sha=$(git -C "$APP_DIR" rev-parse --verify --quiet "$REF^{commit}"); then
      if ((DRY_RUN)); then
        note "(dry run: $REF is not fetched, so it is resolved on the real run)"
        return 0
      fi
      refuse "commit $REF does not exist in $REPO_URL"
      return 0
    fi
  fi
  if ! git -C "$APP_DIR" merge-base --is-ancestor "$ENCRYPTION_BOUNDARY" "$sha"; then
    refuse "$REF ($sha) predates #260's encryption at rest; deploying it cannot read rows a newer build wrote (docs/PREVIEW.md §10)"
    return 0
  fi
  if [[ "$(git -C "$APP_DIR" rev-parse HEAD)" == "$sha" ]]; then
    ok "already at $sha"
  else
    run git -C "$APP_DIR" update-index --no-skip-worktree configs/mcp-config.yaml
    run git -C "$APP_DIR" checkout --quiet -- configs/mcp-config.yaml
    run git -C "$APP_DIR" checkout --quiet --detach "$sha"
  fi
  ok "deploying $(git -C "$APP_DIR" log -1 --format='%h %s' "$sha")"

  # docs/PREVIEW.md §3a, verbatim: exactly the overlay's five servers. The
  # tracked file is the DEVELOPMENT set (redis, filesystem, playwright) —
  # harmless behind the overlay's --servers allow-list, but the file and the
  # allow-list should say the same thing. No literal password: the
  # `mcp-config` service fills the placeholder from .env.
  if put_file "$APP_DIR/configs/mcp-config.yaml" 0644 "$user:$user" <<'EOF'; then :; fi
# /opt/hames/configs/mcp-config.yaml — written by scripts/bootstrap-vps.sh
# from docs/PREVIEW.md §3a. Deliberately NOT the tracked development set: these
# are exactly the servers docker-compose.prod.yaml's --servers allow-list names.
neo4j-cypher:
  enabled: true
  uri: bolt://neo4j:7687
  username: neo4j
  password: ${NEO4J_PASSWORD} # filled from .env by the `mcp-config` render service
  database: neo4j
  read_only: true # agents are read-only against Neo4j (#403), the preview included

fetch:
  enabled: true

web_search:
  enabled: true

context7:
  enabled: true

memory:
  enabled: true
EOF
  run git -C "$APP_DIR" update-index --skip-worktree configs/mcp-config.yaml
  # docker-config.json, the gateway's Docker config, is TRACKED and never
  # written here: it is the switch that keeps the gateway's management tools
  # off (#422; boot checks it). Every catalog image is public, so no registry
  # credential is needed; if one ever is, `docker login` + `docker pull` on the
  # host (docs/PREVIEW.md §3) — the pinned gateway never reads `auths` from
  # this file, and it is tracked in a public repo.
}

# volume_exists NAME — fails CLOSED: an unreachable daemon is an error, not "no".
volume_exists() {
  local out
  out=$(sudo docker volume ls -q --filter "name=^$1\$") || {
    refuse "cannot list Docker volumes (is the daemon running?)"
    return 2
  }
  [[ -n $out ]]
}

stage_env() {
  banner "8/13 env — generate secrets on the box; list what the owner supplies"
  if [[ ! -f $APP_DIR/.env.production.example ]]; then
    if ((DRY_RUN)); then note "(dry run: no checkout yet; showing the plan)"; else
      refuse "no checkout at $APP_DIR (run the checkout stage first)"
      return 0
    fi
  fi
  if [[ -f $ENV_FILE ]]; then ok "$ENV_FILE exists"; else
    chg "create $ENV_FILE from .env.production.example (mode 600)"
    ((DRY_RUN)) || (umask 077 && cp "$APP_DIR/.env.production.example" "$ENV_FILE")
  fi
  if ((!DRY_RUN)); then
    chmod 600 "$ENV_FILE"
    [[ "$(stat -c %U "$ENV_FILE")" == "$(id -un)" ]] || refuse "$ENV_FILE is not owned by $(id -un)"
  fi

  # A data volume that already exists was initialised with the password (and
  # rows encrypted with the key) that .env used to hold. Generating a fresh one
  # now would not change the database — it would lock the app out of it.
  if [[ -f $ENV_FILE ]] && have_compose; then
    local vol key rc
    for vol in hames_postgres_data:POSTGRES_PASSWORD hames_postgres_data:DATA_ENCRYPTION_KEY hames_neo4j_data:NEO4J_PASSWORD; do
      key=${vol#*:}
      [[ -n "$(env_get "$key")" ]] && continue
      rc=0
      volume_exists "${vol%%:*}" || rc=$?
      if ((rc == 0)); then
        refuse "volume ${vol%%:*} exists but $key is empty: restore $ENV_FILE from the escrow instead of generating a new value"
        return 0
      fi
      ((rc == 2)) && return 0
    done
  fi

  fill_generated POSTGRES_PASSWORD hex
  fill_generated NEO4J_PASSWORD hex
  fill_generated AUTH_SESSION_SECRET b64
  fill_generated TOKEN_ENCRYPTION_KEY b64
  fill_generated DATA_ENCRYPTION_KEY b64

  # Owner-supplied values. Prompted (hidden for secrets) only when this run has
  # a terminal; a piped run lists them instead.
  local entry key label secret v missing
  for entry in "${OWNER_REQUIRED[@]}"; do
    IFS='|' read -r key label secret <<<"$entry"
    if ! grep -qx "$key" <<<"$(owner_missing)"; then
      ok "owner value present: $key"
      continue
    fi
    if ((INTERACTIVE && !DRY_RUN)); then
      printf '  %s (%s): ' "$key" "$label" >/dev/tty
      if ((secret)); then
        IFS= read -rs v </dev/tty
        printf '\n' >/dev/tty
      else IFS= read -r v </dev/tty; fi
      [[ -n $v ]] && env_set "$key" "$v" && chg "set $key (value not shown)"
      unset v
    fi
  done
  if ((INTERACTIVE && !DRY_RUN)) && [[ -z "$(env_get VERDA_INFERENCE_ENDPOINT)" ]]; then
    printf '  Configure the private inference tier (Verda + small model) now? [y/N] ' >/dev/tty
    IFS= read -r v </dev/tty
    if [[ $v =~ ^[Yy] ]]; then
      for key in VERDA_INFERENCE_ENDPOINT SMALL_LLM_BASE_URL; do
        printf '  %s (OpenAI base URL, ends in /v1): ' "$key" >/dev/tty
        IFS= read -r v </dev/tty
        [[ -n $v ]] && env_set "$key" "$v" && chg "set $key"
      done
      for key in VERDA_INFERENCE_API_KEY SMALL_LLM_API_KEY; do
        printf '  %s (hidden; Enter to skip): ' "$key" >/dev/tty
        IFS= read -rs v </dev/tty
        printf '\n' >/dev/tty
        [[ -n $v ]] && env_set "$key" "$v" && chg "set $key (value not shown)"
      done
      printf '  Make it the deployment default (USE_VERDA_INFERENCE=1)? [y/N] ' >/dev/tty
      IFS= read -r v </dev/tty
      [[ $v =~ ^[Yy] ]] && env_set USE_VERDA_INFERENCE 1 && chg "set USE_VERDA_INFERENCE=1"
    fi
    unset v
  fi

  if [[ -f $ENV_FILE ]]; then missing=$(owner_missing); else missing=$(printf '%s\n' "${OWNER_REQUIRED[@]%%|*}"); fi
  if [[ -n $missing ]]; then
    warn "owner-supplied values still missing (boot will stop for them):"
    while read -r key; do note "- $key"; done <<<"$missing"
    note "Fill them in $ENV_FILE (or re-run this script from a terminal: it prompts)."
  fi
  local n=0
  for key in "${VERDA_TRIO[@]}"; do [[ -n "$(env_get "$key")" ]] && n=$((n + 1)); done
  note "private tier: $n of 3 endpoints set (0 = Anthropic only; 3 = the tier is available)"

  # docs/PREVIEW.md §7. The keys exist ONLY in this file until the owner copies
  # them out; the backup script deliberately never copies .env.
  if ((KEYS_ESCROWED && KEYS_GENERATED)); then
    warn "--keys-escrowed IGNORED: the keys were generated in this run, so nobody can have escrowed them yet."
  elif ((KEYS_ESCROWED)) && ((!DRY_RUN)); then
    sudo install -d -m 0700 "$STATE_DIR"
    printf '%s %s\n' "$(date -u +%FT%TZ)" "$(keys_fingerprint)" | sudo tee "$ESCROW_MARKER" >/dev/null
    sudo chmod 600 "$ESCROW_MARKER"
    chg "recorded the owner's escrow attestation (a hash of the three keys, not the keys)"
  fi
  if escrow_recorded; then ok "key escrow attested for the current keys"; else
    warn "ESCROW the three keys off this box before boot (docs/PREVIEW.md §7). From the OWNER's own terminal:"
    note "ssh $(id -un)@<host> \"grep -E '^($KEYS_RE)=' $ENV_FILE\""
    note "then put them in the password manager under this environment's name, clear"
    note "the terminal, and re-run this script with --keys-escrowed."
  fi
}

escrow_recorded() {
  ((DRY_RUN && KEYS_ESCROWED && !KEYS_GENERATED)) && return 0
  sudo test -f "$ESCROW_MARKER" || return 1
  [[ "$(sudo cut -d' ' -f2 "$ESCROW_MARKER")" == "$(keys_fingerprint)" ]]
}

# The hostname is a parameter, never a committed value. It lands in .env only.
stage_hostname() {
  banner "9/13 hostname — $HOSTNAME_ARG into .env, DNS check, Entra steps"
  local h=$HOSTNAME_ARG key want cur
  if ((!DRY_RUN)) && [[ ! -f $ENV_FILE ]]; then
    refuse "no $ENV_FILE (run the env stage first)"
    return 0
  fi
  for key in APP_DOMAIN ACME_EMAIL AUTH_REDIRECT_URI AUTH_POST_LOGOUT_REDIRECT_URI; do
    case $key in
      APP_DOMAIN) want=$h ;;
      ACME_EMAIL) want=$ACME_EMAIL_ARG ;;
      AUTH_REDIRECT_URI) want="https://$h/api/auth/callback" ;;
      AUTH_POST_LOGOUT_REDIRECT_URI) want="https://$h/auth/signin" ;;
    esac
    cur=$(env_get "$key")
    if [[ $cur == "$want" ]]; then ok "$key"; else
      [[ $key == APP_DOMAIN && -n $cur && $cur != preview.example.com ]] &&
        warn "APP_DOMAIN changes from $cur: Caddy requests a new certificate and Entra needs the new redirect URI"
      chg "set $key"
      env_set "$key" "$want"
    fi
  done

  # A name under a domain you control beats a provider's default host name:
  # Let's Encrypt's per-domain limit can be shared by every customer of that
  # provider (docs/PREVIEW.md §14, "The hostname").
  if dns_points_here "$h"; then ok "$h resolves to this box"; else
    warn "$h does not resolve to an address on this box yet (boot will stop until it does: an ACME failure counts against the rate limits)"
  fi

  cat <<EOF
  OWNER: Entra changes for this hostname (docs/PREVIEW.md §5), in the Entra
  admin center on the app registration whose id is AZURE_CLIENT_ID:
    a. Authentication -> Web -> Redirect URIs -> add, character for character:
         https://$h/api/auth/callback
       Keep the existing entries (dev's localhost URI included).
    b. Sign-out needs no registration: AUTH_POST_LOGOUT_REDIRECT_URI is set
       to https://$h/auth/signin in .env by this stage.
    c. API permissions -> Microsoft Graph -> Delegated: User.Read, email,
       Mail.Read, Mail.Send, Calendars.ReadWrite, Files.Read.All,
       Sites.Read.All -> Grant admin consent. A requested scope that is not
       consented fails the WHOLE sign-in (trim with AZURE_GRAPH_SCOPES).
    d. AZURE_CLIENT_SECRET must be the secret VALUE, not its id; note its expiry.
EOF
}

# dns_points_here NAME — some address NAME resolves to is on this box.
dns_points_here() {
  local mine theirs
  mine=$(ip -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | sort -u)
  theirs=$(getent ahosts "$1" 2>/dev/null | awk '{print $1}' | sort -u)
  [[ -n $theirs && -n $mine ]] && [[ -n "$(comm -12 <(printf '%s\n' "$mine") <(printf '%s\n' "$theirs"))" ]]
}

# catalog_image SERVER — the image configs/custom-catalog.yaml pins for SERVER.
catalog_image() {
  awk -v s="$1" '
    /^  [^ #][^:]*:/ { k = $1; sub(/:$/, "", k) }
    k == s && /^    image:/ { print $2; exit }' "$APP_DIR/configs/custom-catalog.yaml" 2>/dev/null || true
}

# Images: built ON the box from the pinned commit (the build peaks near
# 2.3 GB RSS). A CI-built image pulled by digest is the multi-environment
# shape (docs/PREVIEW.md §13); a single box needs no registry credential.
stage_images() {
  banner "10/13 images — build on the box, pull the rest"
  if ((!DRY_RUN)) && ! sudo docker info >/dev/null 2>&1; then
    refuse "the Docker daemon is not reachable (sudo systemctl status docker)"
    return 0
  fi
  assert_gateway_pinned
  ((DRY_RUN)) || [[ -f $ENV_FILE ]] || {
    refuse "no $ENV_FILE yet (run the env stage)"
    return 0
  }
  run dc build
  run dc pull --ignore-buildable --quiet
  # The gateway pulls its catalog servers itself, but a failed pull there is a
  # warning and the server just contributes 0 tools (#412). Pulling the five
  # allow-listed images here, on the host, makes a failure stop this run. Any
  # registry login belongs on the host too, never in docker-config.json (#422).
  local srv img
  for srv in $PREVIEW_SERVERS; do
    img=$(catalog_image "$srv")
    if [[ -z $img ]] && ((DRY_RUN)) && [[ ! -d $APP_DIR/.git ]]; then
      run sudo docker pull --quiet "<configs/custom-catalog.yaml's image for $srv>"
      continue
    fi
    if [[ -z $img ]]; then
      refuse "configs/custom-catalog.yaml names no image for MCP server $srv"
      return 0
    fi
    run sudo docker pull --quiet "$img"
  done
  # docs/PREVIEW.md §6: without this image every sandbox run fails at run time.
  run sudo docker build --quiet -t kg-sandbox:base "$APP_DIR/rootfs/"
  if ((SANDBOX_FLAVOURS)); then
    run sudo bash "$APP_DIR/rootfs/build.sh"
  else
    note "the flavoured-sandbox agent also needs kg-sandbox:{image-processing,data,office}: re-run with --sandbox-flavours"
  fi
}

stage_boot() {
  banner "11/13 boot — docker compose up -d (base + prod overlay, profile app)"
  # Every gate below runs before anything starts. A real run stops at the
  # first one that fails; a dry run reports all of them.
  assert_gateway_pinned
  local problems missing
  if [[ -f $ENV_FILE ]]; then
    problems=$(env_problems)
    missing=$(owner_missing)
  else
    problems="no $ENV_FILE"
    missing=""
  fi
  if [[ -n $problems ]]; then
    refuse ".env is not ready: $(tr '\n' ';' <<<"$problems")"
  else ok ".env passes the docs/PREVIEW.md §6 preflight"; fi
  if reserved_name "$HOSTNAME_ARG" || reserved_name "$ACME_EMAIL_ARG"; then
    refuse "--hostname/--acme-email are reserved placeholders; Let's Encrypt cannot issue for or mail them"
  fi
  [[ -n $missing ]] && owner_stop "fill the owner-supplied values in $ENV_FILE: $(tr '\n' ' ' <<<"$missing")"
  escrow_recorded || owner_stop "escrow the three keys off the box (docs/PREVIEW.md §7), then re-run with --keys-escrowed (the env stage records it, on a run after the one that generated the keys)"
  dns_points_here "$HOSTNAME_ARG" || owner_stop "point DNS for $HOSTNAME_ARG at this box and wait for it to resolve (docs/PREVIEW.md §4)"

  assert_dynamic_tools_off
  # GitHub surface (#261 P0-2): a dev config copied onto the box must not
  # bring a github: block or a PAT with it.
  if grep -qsi github "$APP_DIR/configs/mcp-config.yaml" ||
    grep -rqsE 'ghp_|github_pat_' "$APP_DIR/configs/" "$ENV_FILE"; then
    refuse "a github block or a GitHub token is present in configs/ or .env (docs/PREVIEW.md §3a)"
  fi
  if ((DRY_RUN)) && { ! have_compose || [[ ! -f $ENV_FILE ]]; }; then
    note "(dry run: Compose or .env not there yet, so the rendered-config check runs on the real run)"
  else
    local exposure rc=0
    exposure=$(rendered_exposure) || rc=$?
    if ((rc)); then
      refuse "docker compose config failed"
    elif [[ -n $exposure ]]; then
      refuse "the rendered compose config exposes more than Caddy: $(tr '\n' ';' <<<"$exposure")"
    else
      ok "rendered config: every port but Caddy's on loopback; gateway allow-listed"
    fi
  fi

  run dc up -d --remove-orphans
  ((DRY_RUN)) && return 0
  local svc
  for svc in postgres neo4j redis app; do
    if wait_state "$svc" healthy 600; then ok "$svc healthy"; else
      fail "$svc did not become healthy (docker compose logs $svc)"
      return 1
    fi
  done
  for svc in mcp-gateway doc-convert caddy; do
    if wait_state "$svc" running 120; then ok "$svc running"; else
      fail "$svc is not running (docker compose logs $svc)"
      return 1
    fi
  done
}

# wait_state SERVICE healthy|running TIMEOUT_S
wait_state() {
  local id st t=0
  while ((t < $3)); do
    id=$(dc ps -q "$1" 2>/dev/null) || id=""
    id=${id%%$'\n'*}
    if [[ -n $id ]]; then
      st=$(sudo docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null) || st=""
      [[ $st == "$2" || ($2 == running && $st == healthy) ]] && return 0
    fi
    sleep 5
    t=$((t + 5))
  done
  return 1
}

# neo4j_count — node count, read inside the container. The password comes from
# the container's own NEO4J_AUTH and reaches cypher-shell through its
# environment, so it is never on a command line on the host.
neo4j_count() {
  # shellcheck disable=SC2016 # expanded inside the container, on purpose
  dc exec -T neo4j sh -c 'NEO4J_PASSWORD="${NEO4J_AUTH#*/}" cypher-shell -u neo4j --format plain "MATCH (n) RETURN count(n);"' </dev/null 2>/dev/null |
    tail -n1 | tr -dc '0-9'
}

# The seed graph, by the SAFE path only: scripts/import-neo4j.sh, which refuses
# a populated graph without --wipe — and this script never passes --wipe. The
# container is named explicitly, so the import cannot reach another stack's
# graph (the 2026-09-14 incident).
stage_seed() {
  banner "12/13 seed — import the seed graph into an EMPTY graph only"
  if ((NO_SEED)); then
    ok "--no-seed: graph left as it is"
    return 0
  fi
  local file=$SEED_FILE
  [[ $file == /* ]] || file="$APP_DIR/$file"
  if ((DRY_RUN)); then
    run sudo env NEO4J_CONTAINER=hames-neo4j "$APP_DIR/scripts/import-neo4j.sh" "$file"
    note "(only if the graph holds 0 nodes; never with --wipe)"
    return 0
  fi
  [[ -f $file ]] || {
    refuse "seed file not found: $file"
    return 0
  }
  local count name
  count=$(neo4j_count) || count=""
  [[ -n $count ]] || {
    fail "could not read the node count from neo4j"
    return 1
  }
  if ((count > 0)); then
    ok "graph already holds $count nodes; left untouched"
    return 0
  fi
  name=$(dc ps -q neo4j) || name=""
  name=$(sudo docker inspect -f '{{.Name}}' "${name%%$'\n'*}") || {
    fail "cannot find the neo4j container"
    return 1
  }
  name=${name#/}
  # Its output carries no secret (it prints the container and the file).
  (cd "$APP_DIR" && run sudo env NEO4J_CONTAINER="$name" scripts/import-neo4j.sh "$file")
  count=$(neo4j_count) || count=""
  if [[ -n $count ]] && ((count > 0)); then ok "imported: $count nodes"; else
    fail "the import ran but the graph is empty"
    return 1
  fi
}

# Smoke: docs/PREVIEW.md §8, the half that can be checked from the box.
stage_smoke() {
  banner "13/13 smoke — docs/PREVIEW.md §8 (on-box half)"
  if ((DRY_RUN)); then
    note "(dry run: listing the checks)"
    note "1a ss -H -ltn / -lun: nothing on a non-loopback address but SSH ($(desired_ssh_ports | tr ' ' '+')), 80, 443 (+ DHCP client 68/546 udp)"
    note "1b gateway log: enabled servers == {$PREVIEW_SERVERS}; ~$PREVIEW_TOOL_COUNT tools"
    note "1  http://HOST/ redirects to https"
    note "2  https://HOST/api/health answers ok over a VALID certificate"
    note "3  dev bypass off: printenv=false, no [dev-bypass] warning, unauthenticated POST /api/events -> 401"
    note "4  no github block / GitHub token on the box; dynamic-tools disabled; no configs/action-tokens.yaml"
    note "5  the graph is not empty (seed imported)"
    return 0
  fi
  local fails=0 h=$HOSTNAME_ARG out

  out=$(sudo ss -H -ltnp | public_listeners "$(desired_ssh_ports) 80 443") || out="(ss failed)"
  if [[ -z $out ]]; then ok "1a tcp: only SSH ($(desired_ssh_ports | tr ' ' '+')), 80 and 443 listen publicly"; else
    fail "1a tcp listeners on public addresses:"
    note "$out"
    fails=$((fails + 1))
  fi
  out=$(sudo ss -H -lunp | public_listeners "443 68 546") || out="(ss failed)"
  if [[ -z $out ]]; then ok "1a udp: only 443 (+ DHCP client) listen publicly"; else
    fail "1a udp listeners on public addresses:"
    note "$out"
    fails=$((fails + 1))
  fi

  local logs enabled count
  logs=$(dc logs --no-color mcp-gateway 2>&1 || true)
  enabled=$(grep -E 'Those servers are enabled' <<<"$logs" | tail -n1 | sed 's/.*enabled:[[:space:]]*//' | tr ',' '\n' | tr -d ' ' | grep -v '^$' | sort | tr '\n' ' ') || enabled=""
  count=$(grep -Eo '[0-9]+ tools listed' <<<"$logs" | tail -n1 | cut -d' ' -f1) || count=""
  if [[ -z $enabled ]]; then
    fail "1b no 'Those servers are enabled' line in the gateway log (restart it: docker compose restart mcp-gateway, then re-run --only smoke)"
    fails=$((fails + 1))
  elif [[ ${enabled% } != "$PREVIEW_SERVERS" ]]; then
    fail "1b gateway enabled '${enabled% }', expected '$PREVIEW_SERVERS' — the overlay allow-list did not apply"
    fails=$((fails + 1))
  else
    ok "1b gateway servers: ${enabled% }"
    if [[ $count == "$PREVIEW_TOOL_COUNT" ]]; then ok "1b $count tools listed"; else
      warn "1b ${count:-?} tools listed (expected $PREVIEW_TOOL_COUNT; ±1 after an MCP image bump is a re-check, 134 is the un-narrowed surface)"
    fi
  fi

  local code
  code=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 15 "http://$h/" || true)
  if [[ $code =~ ^30[178]\ https:// ]]; then ok "1  http redirects to https ($code)"; else
    fail "1  http://$h/ answered '$code', expected a redirect to https"
    fails=$((fails + 1))
  fi
  local health=""
  for _ in $(seq 1 36); do # Caddy's first certificate can take a minute or two
    health=$(curl -fsS --max-time 10 "https://$h/api/health" 2>/dev/null || true)
    [[ $health == *'"status":"ok"'* ]] && break
    sleep 5
  done
  if [[ $health == *'"status":"ok"'* ]]; then ok "2  https://$h/api/health ok over a valid certificate"; else
    fail "2  https://$h/api/health did not answer ok with a valid certificate (docker compose logs caddy)"
    fails=$((fails + 1))
  fi

  local bypass
  bypass=$(dc exec -T app printenv VITE_DEV_BYPASS_AUTH </dev/null 2>/dev/null | tr -d '\r' || true)
  if [[ $bypass == false ]]; then ok "3  VITE_DEV_BYPASS_AUTH=false in the app"; else
    fail "3  VITE_DEV_BYPASS_AUTH is '${bypass:-unset}' in the app"
    fails=$((fails + 1))
  fi
  if matches '\[dev-bypass\]' "$(dc logs --no-color app 2>&1)"; then
    fail "3  the app logged a [dev-bypass] warning"
    fails=$((fails + 1))
  else ok "3  no [dev-bypass] warning in the app log"; fi
  # The functional test: with the bypass off, an unauthenticated turn is
  # refused before any work. With it on, this would start one — so a 401 here
  # is the evidence, not the env var above.
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST -H 'Content-Type: application/json' \
    --data '{"sessionId":"bootstrap-smoke","message":"bypass probe","agentId":"bootstrap-smoke-none"}' \
    "https://$h/api/events" || true)
  if [[ $code == 401 ]]; then ok "3  unauthenticated POST /api/events -> 401"; else
    fail "3  unauthenticated POST /api/events -> $code, expected 401"
    fails=$((fails + 1))
  fi

  if grep -qi github "$APP_DIR/configs/mcp-config.yaml" || grep -rqE 'ghp_|github_pat_' "$APP_DIR/configs/" "$ENV_FILE"; then
    fail "4  a github block or GitHub token is on the box (#261 P0-2)"
    fails=$((fails + 1))
  else ok "4  no github server and no GitHub token in configs/ or .env"; fi
  if [[ "$(dynamic_tools_state)" == disabled ]]; then ok "4  docker-config.json keeps the gateway's management tools off"; else
    fail "4  docker-config.json no longer disables dynamic-tools (#422)"
    fails=$((fails + 1))
  fi
  if [[ -e $APP_DIR/configs/action-tokens.yaml ]]; then
    warn "4  configs/action-tokens.yaml exists: the trigger endpoint is open to its bearer values (#261 keeps it closed by absence)"
  else ok "4  no configs/action-tokens.yaml: POST /api/agents/:id refuses every request"; fi

  if ((NO_SEED)); then ok "5  --no-seed: graph not checked"; else
    count=$(neo4j_count) || count=""
    if [[ -n $count ]] && ((count > 0)); then ok "5  graph holds $count nodes"; else
      fail "5  the graph is empty or unreadable"
      fails=$((fails + 1))
    fi
  fi

  say ""
  if ((fails)); then
    fail "$fails smoke check(s) failed. Do not invite anyone."
    return 1
  fi
  ok "on-box smoke passed. Still yours, from a browser that has never seen the host:"
  note "§8 steps 3-10: sign-in lands on /auth/signin; Entra sign-in works; an account OUTSIDE the"
  note "allow-list lands on /auth/access-denied; a chat turn completes; the graph renders; an upload"
  note "round-trips; sign-out ends the session. And one port scan from OFF the box (nmap -Pn -p- <host>):"
  note "the only check that tests the network path rather than the box's view of itself."
}

# =============================================================================
usage() {
  cat <<'EOF'
Usage: bootstrap-vps.sh --hostname FQDN --acme-email ADDRESS [options]

  --hostname FQDN     public name Caddy gets a certificate for (REQUIRED)
  --acme-email ADDR   Let's Encrypt contact mailbox (REQUIRED)
  --ref SHA           the full 40-hex commit to deploy: the reviewed one.
                      REQUIRED on a real run that includes the checkout stage
  --dry-run           run every probe, print every change, make none
  --only LIST         comma-separated stages, run in canonical order:
                      preflight updates ssh firewall fail2ban docker checkout
                      env hostname images boot seed smoke
  --keys-escrowed     the owner attests the three keys are escrowed off the box
                      (ignored on the run that generates them)
  --seed-file PATH    Cypher file for an EMPTY graph (default: neo4j_dumps/seed-data.cypher)
  --no-seed           leave the graph alone
  --sandbox-flavours  also build the three sandbox flavour images
  --no-prompt         never prompt, even with a terminal
  --ssh-port PORT     move SSH to PORT (49152-65535, the dynamic range). Two
                      runs: the first listens on 22 AND PORT; after a key login
                      on PORT works, add --ssh-port-verified to close 22
  --ssh-port-verified the operator attests a NEW key login on --ssh-port worked
  --f2b-ignore LIST   addresses fail2ban never bans, comma-separated (default:
                      this SSH session's own client address; "none": loopback only)
EOF
}

main() {
  # Never trace: an xtrace line would print every generated and prompted value
  # (`HAMES_V=<value> awk …` in env_set), even under `bash -x script`.
  set +x
  set -euo pipefail
  umask 022
  HOSTNAME_ARG="" ACME_EMAIL_ARG="" REF="" ONLY="" KEYS_ESCROWED=0 F2B_IGNORE=""
  SEED_FILE="neo4j_dumps/seed-data.cypher" NO_SEED=0 SANDBOX_FLAVOURS=0 NO_PROMPT=0
  LOCKOUT_CHANGED=0 SSH_PORT=22 SSH_PORT_VERIFIED=0
  while (($#)); do
    case $1 in
      --hostname) HOSTNAME_ARG=${2:-} && shift ;;
      --acme-email) ACME_EMAIL_ARG=${2:-} && shift ;;
      --ref) REF=${2:-} && shift ;;
      --only) ONLY=${2:-} && shift ;;
      --seed-file) SEED_FILE=${2:-} && shift ;;
      --dry-run) DRY_RUN=1 ;;
      --keys-escrowed) KEYS_ESCROWED=1 ;;
      --no-seed) NO_SEED=1 ;;
      --sandbox-flavours) SANDBOX_FLAVOURS=1 ;;
      --no-prompt) NO_PROMPT=1 ;;
      --ssh-port) SSH_PORT=${2:-} && shift ;;
      --ssh-port-verified) SSH_PORT_VERIFIED=1 ;;
      --f2b-ignore) F2B_IGNORE=${2:-} && shift ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        usage
        printf '\nunknown argument: %s\n' "$1"
        exit 2
        ;;
    esac
    shift
  done
  # Prompts need a terminal on stdin. In `bash -s < script` stdin IS the
  # script, so nothing may read it: detach it here, and read prompts from
  # /dev/tty only.
  INTERACTIVE=0
  [[ -t 0 ]] && ((!NO_PROMPT)) && INTERACTIVE=1
  exec </dev/null

  local fqdn_re='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
  if [[ -z $HOSTNAME_ARG || -z $ACME_EMAIL_ARG ]]; then
    usage
    printf '\n--hostname and --acme-email are required\n'
    exit 2
  fi
  HOSTNAME_ARG=${HOSTNAME_ARG,,}
  if [[ ! $HOSTNAME_ARG =~ $fqdn_re ]]; then
    printf -- '--hostname must be a fully qualified DNS name, not an IP or a bare label: %s\n' "$HOSTNAME_ARG"
    exit 2
  fi
  if [[ ! $ACME_EMAIL_ARG =~ ^[^@[:space:]\']+@[^@[:space:]\']+\.[^@[:space:]\']+$ ]]; then
    printf -- '--acme-email is not an email address: %s\n' "$ACME_EMAIL_ARG"
    exit 2
  fi
  if [[ ! $SSH_PORT =~ ^[0-9]+$ ]] || ((SSH_PORT != 22 && (SSH_PORT < 49152 || SSH_PORT > 65535))); then
    printf -- '--ssh-port must be 22 or in 49152-65535 (the dynamic port range, RFC 6335): %s\n' "$SSH_PORT"
    exit 2
  fi
  if ((SSH_PORT_VERIFIED && SSH_PORT == 22)); then
    printf -- '--ssh-port-verified needs --ssh-port\n'
    exit 2
  fi
  REF=${REF,,}
  if [[ -n $REF && ! $REF =~ ^[0-9a-f]{40}$ ]]; then
    printf -- '--ref must be a full 40-character commit SHA (the reviewed commit), not a branch, a tag or a short SHA: %s\n' "$REF"
    exit 2
  fi
  if [[ -n $F2B_IGNORE && $F2B_IGNORE != none ]]; then
    local a
    for a in ${F2B_IGNORE//,/ }; do
      valid_ip "$a" || {
        printf -- '--f2b-ignore takes IP addresses or CIDRs, comma-separated, or "none": %s\n' "$a"
        exit 2
      }
    done
  fi

  local selected=() s
  if [[ -n $ONLY ]]; then
    IFS=',' read -r -a selected <<<"$ONLY"
    for s in "${selected[@]}"; do
      [[ " ${STAGES[*]} " == *" $s "* ]] || {
        printf 'unknown stage: %s (stages: %s)\n' "$s" "${STAGES[*]}"
        exit 2
      }
    done
  else
    selected=("${STAGES[@]}")
  fi

  local run_list=()
  for s in "${STAGES[@]}"; do
    [[ " ${selected[*]} " == *" $s "* ]] && run_list+=("$s")
  done
  # Every real run deploys the reviewed commit, never whatever main is at
  # that moment — three runs could otherwise ship three commits.
  if [[ -z $REF && " ${run_list[*]} " == *" checkout "* ]] && ((!DRY_RUN)); then
    usage
    printf -- '\n--ref <40-hex commit> is required for a run that checks out the repo\n'
    exit 2
  fi
  say "bootstrap-vps: host=$HOSTNAME_ARG ref=${REF:-<none>}$( ((DRY_RUN)) && printf ' DRY RUN (nothing is changed)')"
  local i
  for ((i = 0; i < ${#run_list[@]}; i++)); do
    s=${run_list[i]}
    "stage_$s"
    # After ssh or firewall changed something, nothing else runs until a NEW
    # login has been tested — unless the very next stage is the firewall,
    # which then carries the checkpoint itself.
    if [[ $s == ssh || $s == firewall ]] && [[ ${run_list[i + 1]:-} != firewall ]]; then
      checkpoint_lockout
    fi
  done

  say ""
  if ((DRY_RUN)); then
    say "Dry run complete: nothing was changed."
    if ((${#WOULD_STOP[@]})); then
      say "A real run would have stopped at:"
      printf '  - %s\n' "${WOULD_STOP[@]}"
    fi
  else
    say "Done: ${selected[*]}"
  fi
}

# The test file sources this script for its functions; everything else runs it.
[[ ${HAMES_BOOTSTRAP_SOURCED:-0} == 1 ]] || main "$@"
