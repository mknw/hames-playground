#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
#
# Pins the parts of scripts/bootstrap-vps.sh that decide whether a box is
# safe, WITHOUT a VPS, a Docker daemon or root: the script is sourced
# for its functions (HAMES_BOOTSTRAP_SOURCED=1), its two paths point at a
# scratch directory (HAMES_APP_DIR, HAMES_STATE_DIR), and `sudo`, `docker` and
# `uname` are shims on PATH.
#
#   1. public_listeners  — flags any non-loopback listener off the allowed ports
#   2. image_pinned / gateway_image — only a content digest counts as pinned
#   3. env stage         — generates the five secrets, never prints one, never
#                          regenerates one, keeps .env at mode 600
#   4. env_set           — writes values literally, refuses a quote
#   5. owner_missing / env_problems — the boot gate's inputs
#   6. escrow            — an attestation is for the CURRENT keys only
#   7. authorized_keys_problem — the anti-lockout precondition
#   8. arguments + preflight — usage errors exit 2; non-x86_64 is refused
#   9. review findings, by their labels: same-run escrow (S1), the fail2ban
#      ignoreip (L1), a required full-SHA --ref (C1), one Docker key (C2)
#  10. the anti-lockout ORCHESTRATION: the ssh and firewall stages and
#      main's checkpoint, run for real against a fake box, asserting what was
#      called and in which order; the fail2ban stage's jail.local ownership
#      guard, run the same way; plus the rendered-exposure and volume gates
#
# Linux only (GNU stat, as on the box and in CI).
# Run: scripts/bootstrap-vps.test.sh   (no arguments, exits 0 on green)

set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SCRIPT="${BOOTSTRAP_SCRIPT:-$ROOT/scripts/bootstrap-vps.sh}"

if [[ ${1:-} != --clones-only && ${1:-} != --clone-mutations && "$(uname -s)" != Linux ]]; then
  echo "bootstrap-vps.test.sh needs Linux (GNU stat); CI runs it on ubuntu-latest" >&2
  exit 1
fi

failures=0
tmproot=$(mktemp -d)
trap 'rm -rf "$tmproot"' EXIT

pass() { printf 'ok   %s\n' "$1"; }
flunk() {
  printf 'FAIL %s\n' "$1"
  [[ -n ${2:-} ]] && printf '%s\n' "$2" | sed 's/^/     /'
  failures=$((failures + 1))
}

# ------------------------------------------------------------------- shims
# With FAKEROOT unset the shims change nothing but `sudo`, `docker` and
# `uname`. With FAKEROOT set (section 9), `sudo` also maps every /etc and
# /run/systemd path under it, maps /usr/sbin/sshd to a fake sshd, logs every
# privileged call to $CALLLOG, and the fake ufw / ss / systemctl / sshd keep
# their state under FAKEROOT — enough to run the ssh and firewall stages, and
# main's checkpoint, with no root and no real sshd.
mkdir -p "$tmproot/bin"
SHIMBIN="$tmproot/bin"
export SHIMBIN
cat >"$tmproot/bin/sudo" <<'SHIM'
#!/usr/bin/env bash
# Runs the command as the caller: the test never needs root.
[[ ${1:-} == -n ]] && shift
if [[ -n ${FAKEROOT:-} ]]; then
  args=()
  for a in "$@"; do
    case $a in
      /etc/* | /run/systemd/*) a="$FAKEROOT$a" ;;
      /usr/sbin/sshd) a="$SHIMBIN/sshd" ;;
    esac
    args+=("$a")
  done
  echo "sudo ${args[*]}" >>"$CALLLOG"
  [[ ${args[0]} == chown ]] && exit 0
  exec "${args[@]}"
fi
# Opt-in, one line per call: which reads a case needed root for.
[[ -z ${SHIM_SUDO_LOG:-} ]] || printf 'sudo%s\n' "$(printf ' %q' "$@")" >>"$SHIM_SUDO_LOG"
exec "$@"
SHIM
cat >"$tmproot/bin/docker" <<'SHIM'
#!/usr/bin/env bash
# No daemon. Unless a case sets SHIM_COMPOSE_JSON (a rendered config) or
# SHIM_COMPOSE=1, `have_compose` is false, so the static paths run.
args=" $* "
if [[ ${SHIM_CLONES:-0} == 1 ]]; then
  printf '%s|%s|%s\n' "${COMPOSE_FILE:-}" "${COMPOSE_PROFILES:-}" "$*" >>"$CLONE_LOG"
  # #672: the running Caddy and what it serves. $CLONE_CADDY holds its
  # container id (absent: no running Caddy), $CLONE_CADDY_MOUNTS the
  # `docker inspect` mount listing, $CLONE_CADDY_SERVED what `docker exec`
  # reads back out of a mounted file.
  if [[ $args == *compose.service=caddy* ]]; then
    [[ -f $CLONE_CADDY ]] && cat "$CLONE_CADDY"
    exit 0
  fi
  if [[ $args == *'{{range .Mounts}'* ]]; then
    [[ ${CLONE_CADDY_INSPECT_FAIL:-0} == 0 ]] || exit 1
    [[ -n ${CLONE_CADDY_MOUNTS:-} ]] && cat "$CLONE_CADDY_MOUNTS"
    exit 0
  fi
  if [[ $args == *" exec "* && $args == *" cat "* ]]; then
    [[ -n ${CLONE_CADDY_SERVED:-} ]] && cat "$CLONE_CADDY_SERVED"
    exit 0
  fi
  if [[ $args == *" config "* ]]; then
    [[ ${SHIM_RENDER_FAIL:-0} == 0 ]] || { echo synthetic-secret >&2; exit 1; }
    # Compose renders the caddy service's ACME_EMAIL/APP_DOMAIN out of .env
    # with its OWN parser: `export KEY=...`, spaces around `=`, a leading
    # space, the last line winning. The shim mirrors that for these two keys,
    # so a gate reading .env's text (env_get) is distinguishable from one
    # reading the render (#664 review).
    python3 - "$SHIM_COMPOSE_JSON" "${HAMES_APP_DIR:-}" <<'PYS'
import json, pathlib, re, sys
cfg = json.loads(pathlib.Path(sys.argv[1]).read_text())
env = {}
dot_env = pathlib.Path(sys.argv[2], ".env") if sys.argv[2] else None
for line in (dot_env.read_text().splitlines() if dot_env and dot_env.is_file() else []):
    m = re.match(r"[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(.*)$", line)
    if m:
        v = m.group(2).strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        env[m.group(1)] = v
for key in ("ACME_EMAIL", "APP_DOMAIN"):
    if not env.get(key):
        sys.exit(1)  # Compose's ${KEY:?} refuses unset and empty values.
svc = cfg.setdefault("services", {}).setdefault("caddy", {})
svc["environment"] = {k: env[k] for k in ("ACME_EMAIL", "APP_DOMAIN") if k in env}
print(json.dumps(cfg))
PYS
    # A render Compose abandons AFTER printing: stdout is a valid render, the
    # command still fails — the scenario the preflight's pipefail exists for.
    [[ ${SHIM_RENDER_PARTIAL_FAIL:-0} == 0 ]] || exit 1
    exit 0
  fi
  if [[ $args == *" ps -aq "* ]]; then
    [[ ${SHIM_PS_FAIL:-0} == 0 ]] || exit 1
    [[ ! -f $CLONE_ALIVE ]] || echo synthetic-app-dev
    exit 0
  fi
  if [[ $args == *" up "* ]]; then
    if [[ $args == *" --remove-orphans "* && $COMPOSE_FILE != *:docker-compose.clones.yaml* ]]; then
      rm -f "$CLONE_ALIVE"
    fi
    exit 0
  fi
  if [[ $args == *" logs "* && $args == *" mcp-gateway "* ]]; then
    echo 'Those servers are enabled: context7,fetch,neo4j-cypher,web_search'
    echo '7 tools listed'
  fi
  [[ $args != *" printenv "* ]] || echo false
  exit 0
fi
if [[ $args == *" version "* && $args != *" compose "* ]]; then
  echo "29.2.1"
  exit 0
fi
if [[ $args == *" compose "* ]]; then
  [[ -n ${SHIM_COMPOSE_JSON:-}${SHIM_COMPOSE:-} ]] || exit 1
  [[ $args == *" version "* ]] && { echo "2.30.0"; exit 0; }
  [[ $args == *" config "* && -n ${SHIM_COMPOSE_JSON:-} ]] && { cat "$SHIM_COMPOSE_JSON"; exit 0; }
  exit 1
fi
if [[ $args == *" volume ls "* ]]; then
  [[ -n ${SHIM_VOLUME_LS_FAIL:-} ]] && exit 1
  name=${args#*name=^}
  name=${name%%\$*}
  [[ " ${SHIM_VOLUMES:-} " == *" $name "* ]] && echo "$name"
  exit 0
fi
exit 1
SHIM
cat >"$tmproot/bin/uname" <<'SHIM'
#!/usr/bin/env bash
if [[ ${1:-} == -m ]]; then echo "${SHIM_ARCH:-x86_64}"; else exec /usr/bin/uname "$@"; fi
SHIM
cat >"$tmproot/bin/sshd" <<'SHIM'
#!/usr/bin/env bash
# Fake sshd over $FAKEROOT/etc/ssh/sshd_config.d/*.conf. -t fails when
# SHIM_SSHD_T_FAIL=1 and the hardening drop-in exists (a bad new config);
# -T fails when SHIM_SSHD_TT_FAIL=1, else prints the effective values: the
# first value of each option wins, Port lines add up and replace 22.
dir="$FAKEROOT/etc/ssh/sshd_config.d"
case ${1:-} in
  -t)
    [[ ${SHIM_SSHD_T_FAIL:-0} == 1 && -f $dir/00-hames-hardening.conf ]] && { echo "bad configuration option" >&2; exit 255; }
    exit 0
    ;;
  -T)
    [[ ${SHIM_SSHD_TT_FAIL:-0} == 1 ]] && { echo "/etc/ssh/sshd_config.d/x.conf line 1: Bad configuration option: Bogus" >&2; exit 255; }
    files=$(LC_ALL=C ls "$dir"/*.conf 2>/dev/null | LC_ALL=C sort)
    # shellcheck disable=SC2086
    cat $files /dev/null | awk '
      { k = tolower($1); v = $2 }
      k == "port" { ports = ports " " v; next }
      k != "" && k !~ /^#/ && !(k in seen) { seen[k] = tolower(v) }
      END {
        if (ports == "") ports = " 22"
        n = split(ports, P, " "); for (i = 1; i <= n; i++) print "port " P[i]
        d["passwordauthentication"] = "yes"; d["permitrootlogin"] = "prohibit-password"
        d["kbdinteractiveauthentication"] = "no"; d["pubkeyauthentication"] = "yes"
        for (k in d) print k " " ((k in seen) ? seen[k] : d[k])
        print "authorizedkeysfile .ssh/authorized_keys .ssh/authorized_keys2"
      }'
    ;;
esac
SHIM
cat >"$tmproot/bin/systemctl" <<'SHIM'
#!/usr/bin/env bash
echo "systemctl $*" >>"$CALLLOG"
case " $* " in
  *" daemon-reload "*)
    # Stand-in for Ubuntu's sshd-socket-generator: Port lines -> ListenStream.
    gen="$FAKEROOT/run/systemd/generator/ssh.socket.d"
    rm -rf "$gen"
    ports=$(cat "$FAKEROOT"/etc/ssh/sshd_config.d/*.conf 2>/dev/null | awk '$1 == "Port" { print $2 }')
    if [[ -n $ports && -z ${SHIM_NO_GENERATOR:-} ]]; then
      mkdir -p "$gen"
      { echo "[Socket]"; echo "ListenStream="; for p in $ports; do echo "ListenStream=0.0.0.0:$p"; echo "ListenStream=[::]:$p"; done; } >"$gen/addresses.conf"
    fi
    ;;
esac
exit 0
SHIM
cat >"$tmproot/bin/ss" <<'SHIM'
#!/usr/bin/env bash
# Listening TCP ports: what the drop-in's Port lines say sshd listens on (22
# when there are none), plus $SHIM_SS_EXTRA (something else holding a port).
ports=$(cat "$FAKEROOT"/etc/ssh/sshd_config.d/*.conf 2>/dev/null | awk '$1 == "Port" { print $2 }')
ports="${ports:-22} ${SHIM_SS_EXTRA:-}"
want=""
for a in "$@"; do [[ $a == *" = :"* ]] && want=${a##*:}; done
for p in $ports; do [[ -z $want || $want == "$p" ]] && echo "LISTEN 0 128 0.0.0.0:$p 0.0.0.0:*"; done
exit 0
SHIM
cat >"$tmproot/bin/ufw" <<'SHIM'
#!/usr/bin/env bash
# Fake ufw: rules in $FAKEROOT/ufw/added, active when $FAKEROOT/ufw/active
# exists. SHIM_UFW_DROP names rules that `allow` silently fails to record.
echo "ufw $*" >>"$CALLLOG"
st="$FAKEROOT/ufw"
mkdir -p "$st"
touch "$st/added"
case $1 in
  allow)
    [[ " ${SHIM_UFW_DROP:-} " == *" $2 "* ]] && exit 0
    grep -qx "ufw allow $2" "$st/added" || echo "ufw allow $2" >>"$st/added"
    ;;
  delete) grep -vx "ufw allow $3" "$st/added" >"$st/a.tmp" || true; mv "$st/a.tmp" "$st/added" ;;
  show) cat "$st/added" ;;
  status) if [[ -f $st/active ]]; then echo "Status: active"; else echo "Status: inactive"; fi ;;
  --force) [[ ${2:-} == enable ]] && touch "$st/active" ;;
esac
exit 0
SHIM
cat >"$tmproot/bin/getent" <<'SHIM'
#!/usr/bin/env bash
if [[ ${1:-} == passwd && -n ${FAKEHOME:-} ]]; then echo "$2:x:1000:1000::$FAKEHOME:/bin/bash"; exit 0; fi
exec /usr/bin/getent "$@"
SHIM
# apt never runs here: every package "is installed", and apt-get only logs.
printf '#!/usr/bin/env bash\nprintf "install ok installed"\n' >"$tmproot/bin/dpkg-query"
cat >"$tmproot/bin/apt-get" <<'SHIM'
#!/usr/bin/env bash
echo "apt-get $*" >>"${CALLLOG:-/dev/null}"
SHIM
printf '#!/usr/bin/env bash\nexit 0\n' >"$tmproot/bin/fail2ban-client"
chmod +x "$tmproot/bin/"*
# Only deployment probes are inert; fixture generation uses real Python.
export CLONE_PYTHON
CLONE_PYTHON=${CLONE_PYTHON:-$(command -v python3)}
cat >"$tmproot/bin/python3" <<'SHIM'
#!/usr/bin/env bash
if [[ ${SHIM_CLONES:-0} == 1 && ( $1 == *check-vps.py || $1 == *metadata-egress.py || $1 == *env-vm-guard.py ) ]]; then
  printf '%s|%s|python3 %s\n' "${COMPOSE_FILE:-}" "${COMPOSE_PROFILES:-}" "$*" >>"$CLONE_LOG"
  if [[ $1 == *metadata-egress.py ]]; then
    [[ $* == 'scripts/metadata-egress.py --docker-user-only --smoke' ]] || exit 2
    [[ ${SHIM_METADATA_FAIL:-0} == 0 ]] || exit 1
  fi
  if [[ $1 == *env-vm-guard.py ]]; then
    # The smoke runs the guard's read-only --check only; anything else is a bug.
    [[ $* == *' --check' ]] || exit 2
    # A guard refusal (the real one for a missing config) is non-zero and speaks
    # for itself, exactly as the installed guard would.
    [[ ${SHIM_GUARD_FAIL:-0} == 0 ]] || { echo 'FAIL guard config unreadable or not JSON' >&2; exit 1; }
  fi
  exit 0
fi
exec "$CLONE_PYTHON" "$@"
SHIM
chmod +x "$tmproot/bin/python3"
export PATH="$tmproot/bin:$PATH"

# lib DIR — a subshell prelude: the script's functions, pointed at DIR. The
# globals set at the end are read by those functions, not here.
# shellcheck disable=SC2034
lib() {
  export HAMES_APP_DIR="$1" HAMES_STATE_DIR="$1/state" HAMES_BOOTSTRAP_SOURCED=1
  # shellcheck source=bootstrap-vps.sh
  . "$SCRIPT"
  DRY_RUN=0 INTERACTIVE=0 KEYS_ESCROWED=0 LOCKOUT_CHANGED=0 NO_SEED=0 SSH_PORT=22 SSH_PORT_VERIFIED=0
  F2B_IGNORE="" REF="" KEYS_GENERATED=0
}

# Portable subset: the real boot decision and validator, inert Docker only.
# Linux CI runs this with the full suite; macOS lanes use --clones-only.
clone_tests() {
  local dir="$tmproot/clones" base='docker-compose.yaml:docker-compose.prod.yaml'
  local clones="$base:docker-compose.clones.yaml" out rc key file
  mkdir -p "$dir/release/app" "$dir/release/configs" "$dir/release/scripts" "$dir/dev/app" "$dir/dev/configs"
  cp "${CLONE_VALIDATOR_SCRIPT:-$ROOT/scripts/validate-clones.mjs}" "$dir/release/scripts/validate-clones.mjs"
  touch "$dir/release/scripts/check-vps.py" "$dir/release/scripts/metadata-egress.py" "$dir/release/scripts/env-vm-guard.py"
  for file in docker-compose.yaml docker-compose.prod.yaml docker-compose.clones.yaml docker-compose.dev-sandbox.yaml docker-compose.dev-sandbox-vm.yaml docker-compose.release-sandbox-vm.yaml configs/Caddyfile configs/Caddyfile.dev configs/mcp-config.yaml; do
    touch "$dir/release/$file"
  done
  # Synthetic environment VM client material, outside both checkouts: dev's in
  # tls/, release's in tls-release/ under its own CA (the validator refuses one
  # clone's identity on the other's VM).
  for tls in tls:dev tls-release:release; do
    mkdir -p "$dir/${tls%%:*}"
    (
      cd "$dir/${tls%%:*}" || exit 1
      openssl req -new -x509 -nodes -days 1 -subj "/CN=${tls#*:}-ca" -newkey rsa:2048 -keyout ca-key.pem \
        -addext basicConstraints=critical,CA:TRUE -out ca.pem &&
        openssl req -new -newkey rsa:2048 -nodes -subj "/CN=${tls#*:}-client" -keyout key.pem -out client.csr &&
        printf 'basicConstraints=critical,CA:FALSE\nextendedKeyUsage=clientAuth\n' >client.ext &&
        openssl x509 -req -days 1 -in client.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial -extfile client.ext -out cert.pem &&
        chmod 600 key.pem ca-key.pem
    ) >/dev/null 2>&1 || flunk 'clone fixture TLS material could not be generated'
  done
  echo 'synthetic firewall evidence record' >"$dir/firewall-evidence.txt"
  # #672 fixtures: the running Caddy's id, its `docker inspect` mount listing
  # and what `docker exec` reads back out of a mounted file (a fresh one).
  printf 'synthetic-caddy\n' >"$dir/caddy-id"
  printf 'bind %s/configs/Caddyfile /etc/caddy/Caddyfile\n' "$dir/release" >"$dir/caddy-mounts"
  # Fresh ("limit 10") and stale ("limit 20") served content are deliberately
  # the SAME LENGTH as the checkout's Caddyfile: a byte-count mutant must not
  # be able to stand in for the byte-for-byte cmp and read as fresh.
  printf 'limit 10\n' >"$dir/release/configs/Caddyfile"
  printf 'limit 10\n' >"$dir/caddy-served"
  # Release's record is read for structure: a guard smoke record whose
  # environments hold release's probes. The bad ones are each refused.
  printf '%s\n' '{"render_sha256": "synthetic", "environments": {"dev": [{"probe": "1"}], "release": [{"probe": "1"}]}}' >"$dir/release-evidence.json"
  printf '%s\n' '{"render_sha256": "synthetic", "environments": {"dev": [{"probe": "1"}]}}' >"$dir/dev-only-evidence.json"
  printf '%s\n' '{"environments": {"dev": [{"probe": "1"}], "release": []}}' >"$dir/release-unprobed-evidence.json"
  printf '%s\n' '{"environments": [{"release": [{"probe": "1"}]}]}' >"$dir/release-listed-evidence.json"
  printf '%s\n' '["release"]' >"$dir/release-array-evidence.json"
  : >"$dir/firewall-empty.txt"

  for file in release dev; do
    cat >"$dir/$file-runtime.env" <<ENV
AUTH_SESSION_SECRET=$file-synthetic-session-11111111111111111111111111111111
TOKEN_ENCRYPTION_KEY=$file-synthetic-token-22222222222222222222222222222222
DATA_ENCRYPTION_KEY=$file-synthetic-data-00000000000000000000000000000000
AZURE_TENANT_ID=synthetic-tenant
AZURE_CLIENT_ID=synthetic-client
AZURE_CLIENT_SECRET=synthetic-client-secret
ANTHROPIC_API_KEY=synthetic-api-key
VITE_ALLOWED_EMAILS=owner@example.invalid
ENV
    chmod 600 "$dir/$file-runtime.env"
  done
  git -C "$dir/dev" init -q
  git -C "$dir/dev" -c user.name=Fixture -c user.email=fixture@example.invalid -c core.hooksPath=/dev/null commit -qm fixture --allow-empty
  python3 - "$dir" <<'PY'
import json, pathlib, sys
p = pathlib.Path(sys.argv[1])
apps = {}
for clone, service in [('release', 'app'), ('dev', 'app-dev')]:
    apps[service] = dict(build={'context': str(p / clone / 'app')}, image='app:' + clone,
        networks={'app-network': None}, volumes=[dict(type='bind', source=str(p / clone / 'configs'), target='/configs', read_only=True)],
        environment=dict(VITE_DEV_BYPASS_AUTH='false', SANDBOX_ENVIRONMENT=clone, SANDBOX_CACHE_VOLUME='cache-' + clone,
            AUTH_REDIRECT_URI=f'https://{clone}.example.invalid/api/auth/callback',
            AUTH_POST_LOGOUT_REDIRECT_URI=f'https://{clone}.example.invalid/auth/signin',
            DATA_ENCRYPTION_KEY=clone + '-synthetic-data-' + '0'*32,
            AUTH_SESSION_SECRET=clone + '-synthetic-session-' + '1'*32,
            TOKEN_ENCRYPTION_KEY=clone + '-synthetic-token-' + '2'*32,
            DATABASE_URL=f'postgresql://{clone}_app:{clone}-synthetic@postgres:5432/app_{clone}'))
(p / 'good.json').write_text(json.dumps({'name': 'synthetic', 'x-clone-dev-docker-socket': False,
    'x-clone-release-sandbox': 'socket', 'x-clone-dev-sandbox': 'socket', 'services': apps}))
PY
  cat >"$dir/good.env" <<ENV
COMPOSE_FILE=$clones
DEV_CLONE_PATH=$dir/dev
DEV_REF=$(git -C "$dir/dev" rev-parse HEAD)
DEV_APP_DOMAIN=dev.example.invalid
ACME_EMAIL=ops@example.invalid
APP_DOMAIN=release.example.invalid
RELEASE_RUNTIME_ENV_FILE=$dir/release-runtime.env
DEV_RUNTIME_ENV_FILE=$dir/dev-runtime.env
RELEASE_DATABASE_URL=postgresql://release_app:release-synthetic@postgres:5432/app_release
DEV_DATABASE_URL=postgresql://dev_app:dev-synthetic@postgres:5432/app_dev
ACME_EMAIL=ops@example.invalid
ENV
  # All unrelated boot gates are inert. dc, compose_files, clone_preflight,
  # validator, command selection, and health-service selection are real.
  clone_boot() (
    lib "$dir/release"
    DRY_RUN=${SHIM_DRY_RUN:-0}
    export SHIM_CLONES=1 CLONE_LOG="$dir/calls" CLONE_ALIVE="$dir/app-dev-alive"
    export SHIM_COMPOSE_JSON="$dir/render.json"
    export CLONE_CADDY="$dir/caddy-id" CLONE_CADDY_MOUNTS="$dir/caddy-mounts" CLONE_CADDY_SERVED="$dir/caddy-served"
    : >"$CLONE_LOG"
    touch "$CLONE_ALIVE"
    [[ ${SHIM_NO_DEV:-0} == 0 ]] || rm "$CLONE_ALIVE"
    HOSTNAME_ARG=release.example.invalid ACME_EMAIL_ARG=ops@example.invalid
    assert_engine_supported() { :; }; assert_daemon_isolation() { :; }; assert_gateway_pinned() { :; }
    env_problems() { [[ ${SHIM_ENV_PROBLEM:-0} == 0 ]] || echo 'synthetic env problem'; }
    # #664's gate stub: $SHIM_RESERVED names the ONE value reserved_name
    # should refuse (default: none), so the .env-versus-argument distinction
    # stays testable.
    reserved_name() { [[ $1 == "${SHIM_RESERVED:-}" ]] && return 0 || return 1; }
    if [[ ${1:-boot} != owner ]]; then owner_missing() { :; }; fi
    escrow_recorded() { :; }; dns_points_here() { :; }; assert_dynamic_tools_off() { :; }
    rendered_exposure() { :; }; prepare_embedder() { echo PREPARE >>"$CLONE_LOG"; }
    wait_state() { echo "WAIT $*" >>"$CLONE_LOG"; }
    # shellcheck disable=SC2032 # smoke calls this function directly, never via sudo
    curl() {
      echo "HTTP $*" >>"$CLONE_LOG"
      case $* in *http://*) echo '301 https://release.example.invalid/';; *'/api/health') echo '{"status":"ok"}';; *) echo 401;; esac
    }
    dynamic_tools_state() { echo disabled; }
    sudo() {
      if [[ $1 == ss ]]; then echo "PROBE ss" >>"$CLONE_LOG"; return 0; fi
      command sudo "$@"
    }
    case ${1:-boot} in
      boot|owner) vps_check() { :; }; stage_boot ;;
      smoke)
        NO_SEED=1 PROBE_PRIVATE_HEALTH=${SHIM_HEALTH:-0}
        # main runs `set -euo pipefail`; SHIM_SET_E=1 reproduces that for the
        # smoke (the review's BLOCKING died silently under exactly this).
        [[ ${SHIM_SET_E:-0} == 0 ]] || set -e
        stage_smoke
        ;;
      dc) dc exec -T app true ;;
      images) stage_images ;;
      probe) vps_check --clones ;;
    esac
  )
  clone_reset() {
    cp "$dir/good.env" "$dir/release/.env"
    cp "$dir/good.json" "$dir/render.json"
  }
  clone_select() {
    printf 'COMPOSE_FILE=%s\n' "$1" >>"$dir/release/.env"
    if [[ $1 == *:docker-compose.dev-sandbox.yaml ]]; then
      python3 - "$dir/render.json" <<'PY'
import json, pathlib, sys
p=pathlib.Path(sys.argv[1]); c=json.loads(p.read_text())
c['x-clone-dev-docker-socket']=True
c['services']['app-dev']['volumes'].append(dict(type='bind',source='/var/run/docker.sock',target='/var/run/docker.sock',read_only=False))
p.write_text(json.dumps(c))
PY
    fi
    if [[ $1 == *:docker-compose.dev-sandbox-vm.yaml || $1 == *:docker-compose.dev-sandbox-vm.yaml:* ]]; then
      printf 'DEV_SANDBOX_FIREWALL_EVIDENCE=%s\n' "${2-$dir/firewall-evidence.txt}" >>"$dir/release/.env"
      python3 - "$dir/render.json" "$dir/tls" <<'PY'
import json, pathlib, sys
p=pathlib.Path(sys.argv[1]); c=json.loads(p.read_text()); dev=c['services']['app-dev']
c['x-clone-dev-sandbox']='per-env'
dev['environment'].update(SANDBOX_DOCKER_HOST='tcp://198.51.100.2:2376', **{'SANDBOX_DOCKER_TLS_'+k: '/run/sandbox-tls/'+v for k, v in (('CA', 'ca.pem'), ('CERT', 'cert.pem'), ('KEY', 'key.pem'))})
dev['volumes'] += [dict(type='bind', source=sys.argv[2]+'/'+f, target='/run/sandbox-tls/'+f, read_only=True, bind=dict(create_host_path=False)) for f in ('ca.pem', 'cert.pem', 'key.pem')]
dev['networks']['envapp-dev'] = dict(ipv4_address='192.0.2.66', gw_priority=1)
c['networks'] = {'envapp-dev': dict(name='envapp-dev', external=True)}
p.write_text(json.dumps(c))
PY
    fi
    if [[ $1 == *:docker-compose.release-sandbox-vm.yaml ]]; then
      printf 'RELEASE_SANDBOX_FIREWALL_EVIDENCE=%s\n' "${3-$dir/release-evidence.json}" >>"$dir/release/.env"
      python3 - "$dir/render.json" "$dir/tls-release" <<'PY'
import json, pathlib, sys
p=pathlib.Path(sys.argv[1]); c=json.loads(p.read_text()); app=c['services']['app']
c['x-clone-release-sandbox']='per-env'
app['environment'].update(SANDBOX_DOCKER_HOST='tcp://198.51.100.18:2376', **{'SANDBOX_DOCKER_TLS_'+k: '/run/sandbox-tls/'+v for k, v in (('CA', 'ca.pem'), ('CERT', 'cert.pem'), ('KEY', 'key.pem'))})
app['volumes'] += [dict(type='bind', source=sys.argv[2]+'/'+f, target='/run/sandbox-tls/'+f, read_only=True, bind=dict(create_host_path=False)) for f in ('ca.pem', 'cert.pem', 'key.pem')]
app['networks']['envapp-release'] = dict(ipv4_address='192.0.2.10', gw_priority=1)
c.setdefault('networks', {})['envapp-release'] = dict(name='envapp-release', external=True)
p.write_text(json.dumps(c))
PY
    fi
  }
  # An optional third argument is the refusal message the right gate prints,
  # for gates whose input a later gate would also refuse.
  clone_refused() {
    local label=$1 result status
    result=$(clone_boot "${2:-boot}" 2>&1); status=$?
    if ((status != 0)) && ! grep -Ev 'compose config --format json$' "$dir/calls" | grep -q . &&
      [[ -z ${3:-} || $result == *"$3"* ]]; then
      pass "clones refuses $label before changes"
    else flunk "clones accepted $label (rc=$status)" "$result"; fi
    [[ $result != *synthetic-secret* ]] || flunk "clones leaked renderer error"
  }
  clone_reset
  out=$(clone_boot 2>&1); rc=$?
  if ((rc == 0)) && grep -Fxq "$clones|app|compose up -d" "$dir/calls" &&
    grep -Fxq 'WAIT app-dev healthy 600' "$dir/calls" && [[ -f $dir/app-dev-alive ]] &&
    ! grep -q -- '--remove-orphans' "$dir/calls"; then
    pass "clones boot keeps app-dev in the same project and waits for its health"
  else flunk "clones boot shape (rc=$rc)" "$out"; fi
  clone_reset
  clone_select "$clones:docker-compose.dev-sandbox.yaml"
  out=$(clone_boot 2>&1); rc=$?
  if ((rc == 0)) && grep -Fxq "$clones:docker-compose.dev-sandbox.yaml|app|compose up -d" "$dir/calls"; then
    pass "clones retains the explicit owner socket overlay"
  else flunk "clones owner overlay (rc=$rc)" "$out"; fi
  clone_reset
  clone_select "$clones:docker-compose.dev-sandbox-vm.yaml"
  out=$(clone_boot 2>&1); rc=$?
  if ((rc == 0)) && grep -Fxq "$clones:docker-compose.dev-sandbox-vm.yaml|app|compose up -d" "$dir/calls"; then
    pass "clones retains the dev environment VM overlay"
  else flunk "clones dev VM overlay (rc=$rc)" "$out"; fi
  for shape in "$clones:docker-compose.dev-sandbox.yaml:docker-compose.dev-sandbox-vm.yaml" \
    "$clones:docker-compose.dev-sandbox-vm.yaml:docker-compose.dev-sandbox.yaml" "$base:docker-compose.dev-sandbox-vm.yaml"; do
    clone_reset
    printf 'COMPOSE_FILE=%s\n' "$shape" >>"$dir/release/.env"
    clone_refused 'a combined or clone-less dev sandbox overlay'
  done
  for evidence in '' "$dir/firewall-empty.txt" firewall-evidence.txt "$dir/absent.txt"; do
    clone_reset
    clone_select "$clones:docker-compose.dev-sandbox-vm.yaml" "$evidence"
    clone_refused "the dev VM overlay without its firewall evidence file (${evidence:-unset})"
  done
  # Release on its own VM (#648): one shape only, after dev's overlay.
  both="$clones:docker-compose.dev-sandbox-vm.yaml:docker-compose.release-sandbox-vm.yaml"
  clone_reset
  clone_select "$both"
  : >"$dir/sudo.log"
  out=$(SHIM_SUDO_LOG="$dir/sudo.log" clone_boot 2>&1); rc=$?
  if ((rc == 0)) && grep -Fxq "$both|app|compose up -d" "$dir/calls"; then
    pass "clones retains both environment VM overlays, release after dev"
  else flunk "clones both VM overlays (rc=$rc)" "$out"; fi
  # The guard smoke writes release's record as root, mode 0600: the structural
  # read must go through sudo, or every genuine record is refused on a host.
  if grep -F 'sudo python3 -I -c ' "$dir/sudo.log" | grep -Fq " $dir/release-evidence.json"; then
    pass "clones reads release's evidence record through sudo"
  else flunk "clones read release's evidence record without sudo" "$(cat "$dir/sudo.log")"; fi
  for shape in "$clones:docker-compose.release-sandbox-vm.yaml" \
    "$clones:docker-compose.release-sandbox-vm.yaml:docker-compose.dev-sandbox-vm.yaml" \
    "$clones:docker-compose.dev-sandbox.yaml:docker-compose.release-sandbox-vm.yaml" \
    "$both:docker-compose.release-sandbox-vm.yaml" "$base:docker-compose.release-sandbox-vm.yaml"; do
    clone_reset
    printf 'COMPOSE_FILE=%s\n' "$shape" >>"$dir/release/.env"
    printf 'DEV_SANDBOX_FIREWALL_EVIDENCE=%s\nRELEASE_SANDBOX_FIREWALL_EVIDENCE=%s\n' "$dir/firewall-evidence.txt" "$dir/release-evidence.json" >>"$dir/release/.env"
    clone_refused "release's VM overlay alone, first, beside the dev socket, twice or without clones ($shape)"
  done
  for evidence in '' "$dir/firewall-empty.txt" release-evidence.json "$dir/absent.txt"; do
    clone_reset
    clone_select "$both" "$dir/firewall-evidence.txt" "$evidence"
    # The structural read below would refuse these too: the message names the gate.
    clone_refused "the release VM overlay without its firewall evidence file (${evidence:-unset})" boot \
      'requires RELEASE_SANDBOX_FIREWALL_EVIDENCE: the recorded firewall evidence file'
  done
  # A non-empty file is not enough for release: dev's record, one written before
  # release joined the guard config, or anything not shaped like the record.
  for evidence in firewall-evidence.txt dev-only-evidence.json release-unprobed-evidence.json \
    release-listed-evidence.json release-array-evidence.json; do
    clone_reset
    clone_select "$both" "$dir/firewall-evidence.txt" "$dir/$evidence"
    clone_refused "a release evidence record that did not probe release ($evidence)"
  done
  # Dev's record is still required when release's overlay follows dev's.
  for evidence in '' "$dir/firewall-empty.txt"; do
    clone_reset
    clone_select "$both" "$evidence"
    clone_refused "both VM overlays without dev's firewall evidence file (${evidence:-unset})"
  done
  # A service of another profile is absent from the render the validator reads.
  for profile in '    profiles: ["debug"]' '    profiles:' '    profiles: [app, debug]'; do
    clone_reset
    printf '%s\n' "$profile" >"$dir/release/docker-compose.clones.yaml"
    clone_refused "a Compose profile other than app ($profile)"
  done
  clone_reset
  printf '%s\n' '    profiles: ["app"]' >"$dir/release/docker-compose.clones.yaml"
  out=$(clone_boot 2>&1); rc=$?
  : >"$dir/release/docker-compose.clones.yaml"
  if ((rc == 0)); then pass "clones accepts services of the app profile"; else flunk "clones app profile (rc=$rc)" "$out"; fi
  # Compare every box-changing command byte-for-byte, excluding only the two
  # exact read-only commands added by the coordinator-approved box-state guard.
  printf 'COMPOSE_FILE=%s\nACME_EMAIL=ops@example.invalid\nAPP_DOMAIN=release.example.invalid\n' "$base" >"$dir/release/.env"
  out=$(SHIM_NO_DEV=1 clone_boot 2>&1); rc=$?
  cat >"$dir/default-expected" <<ENV
PREPARE
$base|app|compose up -d --remove-orphans
WAIT postgres healthy 600
WAIT neo4j healthy 600
WAIT redis healthy 600
WAIT embedder healthy 600
WAIT app healthy 600
WAIT mcp-gateway running 120
WAIT doc-convert running 120
WAIT caddy running 120
ENV
  # #672 adds three read-only Caddy state probes to the transcript (its id,
  # its mount listing, what a mounted file serves); they are excluded here the
  # same way, and required.
  caddy_ps='||ps -aq --filter label=com.docker.compose.project=synthetic --filter label=com.docker.compose.service=caddy'
  caddy_inspect='||inspect -f {{range .Mounts}}{{printf "%s %s %s\n" .Type .Source .Destination}}{{end}} synthetic-caddy'
  caddy_exec='||exec synthetic-caddy cat /etc/caddy/Caddyfile'
  grep -Fxv -e "$base|app|compose config --format json" \
    -e '||ps -aq --filter label=com.docker.compose.project=synthetic --filter label=com.docker.compose.service=app-dev' \
    -e "$caddy_ps" -e "$caddy_inspect" -e "$caddy_exec" \
    "$dir/calls" >"$dir/default-changing"
  if ((rc == 0)) && cmp -s "$dir/default-expected" "$dir/default-changing" &&
    grep -Fxq '||ps -aq --filter label=com.docker.compose.project=synthetic --filter label=com.docker.compose.service=app-dev' "$dir/calls" &&
    grep -Fxq "$caddy_ps" "$dir/calls"; then
    pass "clones default boot box-changing transcript is byte-identical"
  else flunk "clones default command transcript changed (rc=$rc)" "$(cat "$dir/calls")"; fi
  out=$(clone_boot 2>&1); rc=$?
  if ((rc != 0)) && [[ -f $dir/app-dev-alive ]] && ! grep -q 'compose up ' "$dir/calls"; then
    pass 'clones refuses live app-dev under base:prod before orphan pruning'
  else flunk "clones pruned live app-dev under base:prod (rc=$rc)" "$out"; fi
  # #672: a running Caddy whose bind-mounted file no longer matches the
  # checkout's is recreated (only Caddy) during boot, after `up -d` and before
  # the health waits; a fresh one, a volume or directory mount, and a first
  # boot with no running Caddy are left alone. The smoke fails on the same
  # staleness instead of leaving it serving.
  clone_reset
  printf 'limit 20\n' >"$dir/caddy-served"
  out=$(clone_boot 2>&1); rc=$?
  recreate="$clones|app|compose up -d --no-deps --force-recreate caddy"
  if ((rc == 0)) && grep -Fxq "$recreate" "$dir/calls" &&
    (( $(grep -nFx "$clones|app|compose up -d" "$dir/calls" | cut -d: -f1) <
      $(grep -nFx "$recreate" "$dir/calls" | cut -d: -f1) )) &&
    (( $(grep -nFx "$recreate" "$dir/calls" | cut -d: -f1) <
      $(grep -nFx 'WAIT caddy running 120' "$dir/calls" | cut -d: -f1) )); then
    pass "clones boot recreates only a Caddy serving a changed Caddyfile, before the waits"
  else flunk "clones boot did not recreate the stale Caddy (rc=$rc)" "$out $(cat "$dir/calls")"; fi
  clone_reset
  printf 'limit 10\n' >"$dir/caddy-served"
  out=$(clone_boot 2>&1); rc=$?
  if ((rc == 0)) && ! grep -q -- '--force-recreate' "$dir/calls"; then
    pass "clones boot leaves a fresh Caddy alone"
  else flunk "clones boot recreated a fresh Caddy (rc=$rc)" "$out $(cat "$dir/calls")"; fi
  clone_reset
  # The volume and the directory mount sit next to the Caddyfile's own bind
  # mount (fail closed now needs one comparable regular file to be present).
  printf 'volume caddy_data /data\nbind %s/configs /configs\nbind %s/configs/Caddyfile /etc/caddy/Caddyfile\n' "$dir/release" "$dir/release" >"$dir/caddy-mounts"
  printf 'limit 10\n' >"$dir/caddy-served"
  out=$(clone_boot 2>&1); rc=$?
  if ((rc == 0)) && ! grep -q -- '--force-recreate' "$dir/calls"; then
    pass "clones boot compares only bind-mounted regular files"
  else flunk "clones boot compared a volume or directory mount (rc=$rc)" "$out $(cat "$dir/calls")"; fi
  printf 'bind %s/configs/Caddyfile /etc/caddy/Caddyfile\n' "$dir/release" >"$dir/caddy-mounts"
  mv "$dir/caddy-id" "$dir/held-caddy"
  out=$(clone_boot 2>&1); rc=$?
  mv "$dir/held-caddy" "$dir/caddy-id"
  if ((rc == 0)) && ! grep -q -- '--force-recreate' "$dir/calls"; then
    pass "clones first boot with no running Caddy compares nothing"
  else flunk "clones first boot compared a nonexistent Caddy (rc=$rc)" "$out $(cat "$dir/calls")"; fi
  printf 'limit 10\n' >"$dir/caddy-served"
  clone_reset
  printf 'limit 20\n' >"$dir/caddy-served"
  out=$(clone_boot smoke 2>&1); rc=$?
  if ((rc != 0)) && grep -q '1c the running Caddy serves a changed Caddyfile' <<<"$out"; then
    pass 'clones smoke fails on a Caddy serving a changed Caddyfile'
  else flunk 'clones smoke passed with a stale Caddyfile' "$out"; fi
  printf 'limit 10\n' >"$dir/caddy-served"
  out=$(clone_boot smoke 2>&1); rc=$?
  if ((rc == 0)) && grep -q "1c the running Caddy serves the checkout's Caddyfile" <<<"$out"; then
    pass "clones smoke reports a fresh Caddyfile"
  else flunk "clones smoke failed with a fresh Caddyfile (rc=$rc)" "$out"; fi
  # The review's BLOCKING, pinned as its reproduction: main runs the smoke
  # under `set -euo pipefail`, and with no running Caddy the stale comparison
  # must not end the run silently at 1c — the 1c WARN prints and the later
  # checks (the redirect check, at least) still run.
  clone_reset
  mv "$dir/caddy-id" "$dir/held-caddy"
  out=$(SHIM_SET_E=1 clone_boot smoke 2>&1); rc=$?
  mv "$dir/held-caddy" "$dir/caddy-id"
  if ((rc == 0)) && grep -q '1c no running Caddy container' <<<"$out" &&
    grep -q '1  http redirects to https' <<<"$out"; then
    pass 'clones smoke with no Caddy survives set -e and runs the later checks'
  else flunk 'clones smoke stopped silently under set -e with no Caddy' "$out"; fi
  # Fail closed when the running Caddy cannot be checked: inspect failing, or
  # no bind-mounted regular file at all (the Caddyfile mount is always there),
  # refuses boot and fails the smoke instead of reading as fresh.
  clone_reset
  : >"$dir/caddy-mounts"
  out=$(clone_boot 2>&1); rc=$?
  if ((rc != 0)) && grep -q "cannot compare the running Caddy's mounts" <<<"$out"; then
    pass 'clones boot refuses an empty Caddy mount listing instead of reading fresh'
  else flunk "clones boot treated an uncheckable Caddy as fresh (rc=$rc)" "$out"; fi
  printf 'bind %s/configs/Caddyfile /etc/caddy/Caddyfile\n' "$dir/release" >"$dir/caddy-mounts"
  clone_reset
  out=$(CLONE_CADDY_INSPECT_FAIL=1 clone_boot 2>&1); rc=$?
  if ((rc != 0)) && grep -q "cannot compare the running Caddy's mounts" <<<"$out"; then
    pass 'clones boot refuses a failed Caddy inspect instead of reading fresh'
  else flunk "clones boot ignored a failed Caddy inspect (rc=$rc)" "$out"; fi
  clone_reset
  out=$(CLONE_CADDY_INSPECT_FAIL=1 SHIM_SET_E=1 clone_boot smoke 2>&1); rc=$?
  if ((rc != 0)) && grep -q '1c could not inspect the running Caddy' <<<"$out" &&
    ! grep -q "1c the running Caddy serves the checkout's Caddyfile" <<<"$out"; then
    pass 'clones smoke fails on a Caddy it cannot inspect'
  else flunk "clones smoke passed with an uninspectable Caddy (rc=$rc)" "$out"; fi
  # The tests below expect the default (single-app) shape again.
  printf 'COMPOSE_FILE=%s\n' "$base" >"$dir/release/.env"
  out=$(SHIM_NO_DEV=1 SHIM_PS_FAIL=1 clone_boot 2>&1); rc=$?
  if ((rc != 0)) && ! grep -q 'compose up ' "$dir/calls"; then
    pass 'clones refuses inconclusive single-app box-state query'
  else flunk "clones ignored failed box-state query (rc=$rc)" "$out"; fi
  # #664: the boot gate checks the ACME_EMAIL Caddy actually reads — the .env
  # value, not this run's --acme-email argument — and stops for the owner when
  # the two differ.
  clone_reset
  python3 - "$dir/release/.env" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1]); p.write_text('\n'.join(s for s in p.read_text().splitlines() if not s.startswith('ACME_EMAIL=')) + '\nACME_EMAIL=owner@example.com\n')
PY
  out=$(SHIM_RESERVED='owner@example.com' clone_boot 2>&1); rc=$?
  if ((rc != 0)) && [[ $out == *"the ACME_EMAIL in .env is a reserved placeholder"* ]] &&
    [[ $out != *"--hostname is a reserved placeholder"* ]] && ! grep -q 'compose up ' "$dir/calls"; then
    pass 'clones boot refuses a reserved ACME_EMAIL in .env even with a real --acme-email'
  else flunk "clones boot accepted a reserved .env ACME_EMAIL (rc=$rc)" "$out"; fi
  clone_reset
  python3 - "$dir/release/.env" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1]); p.write_text('\n'.join(s for s in p.read_text().splitlines() if not s.startswith('ACME_EMAIL=')) + '\nACME_EMAIL=other@example.invalid\n')
PY
  out=$(clone_boot 2>&1); rc=$?
  if ((rc == 3)) && [[ $out == *"the ACME_EMAIL in .env differs from this run's --acme-email"* ]] && ! grep -q 'compose up ' "$dir/calls"; then
    pass "clones boot stops for the owner when .env ACME_EMAIL differs from --acme-email"
  else flunk "clones boot accepted a differing .env ACME_EMAIL (rc=$rc)" "$out"; fi
  clone_reset
  python3 - "$dir/release/.env" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1]); p.write_text('\n'.join(s for s in p.read_text().splitlines() if not s.startswith('ACME_EMAIL=')) + '\n')
PY
  out=$(clone_boot 2>&1); rc=$?
  if ((rc == 1)) && [[ $out == *"Clone preflight failed"* ]] && ! grep -q 'compose up ' "$dir/calls"; then
    pass 'clones boot refuses a Compose render without ACME_EMAIL'
  else flunk "clones boot accepted a render without ACME_EMAIL (rc=$rc)" "$out"; fi
  # #664 review: Compose's .env parser also reads `export ACME_EMAIL=...`
  # (and `ACME_EMAIL = ...`, a leading space; the last line wins) — the shim's
  # render mirrors that, so the gate must refuse the value COMPOSE renders,
  # not the canonical line env_get reads.
  clone_reset
  printf 'export ACME_EMAIL=owner@example.com\n' >>"$dir/release/.env"
  out=$(SHIM_RESERVED='owner@example.com' clone_boot 2>&1); rc=$?
  if ((rc != 0)) && [[ $out == *"the ACME_EMAIL in .env is a reserved placeholder"* ]] &&
    ! grep -q 'compose up ' "$dir/calls"; then
    pass 'clones boot refuses the ACME_EMAIL Compose renders (an export line wins over the canonical one)'
  else flunk "clones boot read .env text Compose does not render (rc=$rc)" "$out"; fi
  # The same three gates on APP_DOMAIN, which Caddy substitutes the same way.
  clone_reset
  python3 - "$dir/release/.env" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1]); p.write_text('\n'.join(s for s in p.read_text().splitlines() if not s.startswith('APP_DOMAIN=')) + '\nAPP_DOMAIN=owner@example.com\n')
PY
  out=$(SHIM_RESERVED='owner@example.com' clone_boot 2>&1); rc=$?
  if ((rc != 0)) && [[ $out == *"the APP_DOMAIN in .env is a reserved placeholder"* ]] &&
    [[ $out != *"the ACME_EMAIL in .env is a reserved placeholder"* ]] && ! grep -q 'compose up ' "$dir/calls"; then
    pass 'clones boot refuses a reserved APP_DOMAIN in .env even with a clean --hostname'
  else flunk "clones boot accepted a reserved .env APP_DOMAIN (rc=$rc)" "$out"; fi
  clone_reset
  python3 - "$dir/release/.env" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1]); p.write_text('\n'.join(s for s in p.read_text().splitlines() if not s.startswith('APP_DOMAIN=')) + '\nAPP_DOMAIN=other.example.invalid\n')
PY
  out=$(clone_boot 2>&1); rc=$?
  if ((rc == 3)) && [[ $out == *"the APP_DOMAIN in .env differs from this run's --hostname"* ]] && ! grep -q 'compose up ' "$dir/calls"; then
    pass "clones boot stops for the owner when .env APP_DOMAIN differs from --hostname"
  else flunk "clones boot accepted a differing .env APP_DOMAIN (rc=$rc)" "$out"; fi
  clone_reset
  python3 - "$dir/release/.env" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1]); p.write_text('\n'.join(s for s in p.read_text().splitlines() if not s.startswith('APP_DOMAIN=')) + '\n')
PY
  out=$(clone_boot 2>&1); rc=$?
  if ((rc == 1)) && [[ $out == *"Clone preflight failed"* ]] && ! grep -q 'compose up ' "$dir/calls"; then
    pass 'clones boot refuses a Compose render without APP_DOMAIN'
  else flunk "clones boot accepted a render without APP_DOMAIN (rc=$rc)" "$out"; fi
  # #664 review: the --hostname reserved gate this PR rewrote has its own pin,
  # distinguishable from the .env gates: the .env APP_DOMAIN is clean while the
  # ARGUMENT is the reserved one.
  clone_reset
  python3 - "$dir/release/.env" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1]); p.write_text('\n'.join(s for s in p.read_text().splitlines() if not s.startswith('APP_DOMAIN=')) + '\nAPP_DOMAIN=clean.example.invalid\n')
PY
  out=$(SHIM_RESERVED='release.example.invalid' clone_boot 2>&1); rc=$?
  if ((rc != 0)) && [[ $out == *"--hostname is a reserved placeholder"* ]] &&
    [[ $out != *"APP_DOMAIN"*"reserved placeholder"* ]] && ! grep -q 'compose up ' "$dir/calls"; then
    pass 'clones boot refuses a reserved --hostname even when the .env APP_DOMAIN is clean'
  else flunk "clones boot accepted a reserved --hostname (rc=$rc)" "$out"; fi
  for key in DEV_CLONE_PATH DEV_REF DEV_APP_DOMAIN RELEASE_RUNTIME_ENV_FILE DEV_RUNTIME_ENV_FILE RELEASE_DATABASE_URL DEV_DATABASE_URL; do
    clone_reset
    python3 - "$dir/release/.env" "$key" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1]); p.write_text('\n'.join(s for s in p.read_text().splitlines() if not s.startswith(sys.argv[2] + '=')) + '\n')
PY
    clone_refused "missing $key"
  done
  clone_reset
  python3 - "$dir/release/.env" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1]); p.write_text('\n'.join(s for s in p.read_text().splitlines() if not s.startswith('DEV_REF=')) + '\n')
PY
  out=$(SHIM_DRY_RUN=1 SHIM_ENV_PROBLEM=1 clone_boot 2>&1); rc=$?
  if ((rc == 1)) && [[ $out == *"WOULD REFUSE: .env is not ready"* ]] &&
    [[ $out == *"Clone configuration requires DEV_REF"* ]] && ! grep -q 'compose up ' "$dir/calls"; then
    pass 'clones dry run shows preflight refusal alongside .env problems'
  else flunk "clones dry run hid preflight refusal (rc=$rc)" "$out"; fi
  for file in docker-compose.clones.yaml scripts/validate-clones.mjs configs/Caddyfile.dev; do
    clone_reset
    mv "$dir/release/$file" "$dir/held"
    clone_refused "missing $file"
    mv "$dir/held" "$dir/release/$file"
  done
  for key in RELEASE_RUNTIME_ENV_FILE DEV_RUNTIME_ENV_FILE; do
    clone_reset
    printf '%s=/absent/synthetic.env\n' "$key" >>"$dir/release/.env"
    clone_refused "absent $key file"
  done
  clone_reset
  cp "$dir/release/scripts/validate-clones.mjs" "$dir/real-validator"
  printf "process.stdin.resume(); process.stdin.on('end',()=>process.exit(0));\n" >"$dir/release/scripts/validate-clones.mjs"
  SHIM_RENDER_FAIL=1 clone_refused 'failed render (even if a downstream validator accepts empty input)'
  clone_reset
  SHIM_RENDER_PARTIAL_FAIL=1 clone_refused 'a render Compose abandons after printing (the preflight pipefail)' boot 'Clone preflight failed'
  mv "$dir/real-validator" "$dir/release/scripts/validate-clones.mjs"
  for key in DATA_ENCRYPTION_KEY AUTH_SESSION_SECRET TOKEN_ENCRYPTION_KEY DATABASE_URL role database administrator; do
    clone_reset
    python3 - "$dir/render.json" "$key" <<'PY'
import json, pathlib, sys
p = pathlib.Path(sys.argv[1]); c = json.loads(p.read_text())
env = c['services']['app-dev']['environment']; key = sys.argv[2]
if key in ('role', 'database', 'administrator'):
    old, new = {'role': ('dev_app:', 'release_app:'), 'database': ('/app_dev', '/app_release'), 'administrator': ('dev_app:', 'postgres:')}[key]
    env['DATABASE_URL'] = env['DATABASE_URL'].replace(old, new)
else:
    env[key] = c['services']['app']['environment'][key]
p.write_text(json.dumps(c))
PY
    clone_refused "shared $key"
  done
  for shape in "$base" 'docker-compose.yaml:docker-compose.clones.yaml:docker-compose.prod.yaml'; do
    clone_reset
    printf 'COMPOSE_FILE=%s\n' "$shape" >>"$dir/release/.env"
    clone_refused 'partial or reordered overlay opt-in'
  done
  for key in DEV_CLONE_PATH DEV_REF DEV_APP_DOMAIN RELEASE_RUNTIME_ENV_FILE DEV_RUNTIME_ENV_FILE RELEASE_DATABASE_URL DEV_DATABASE_URL; do
    printf 'COMPOSE_FILE=%s\n' "$base" >"$dir/release/.env"
    grep "^$key=" "$dir/good.env" >>"$dir/release/.env"
    clone_refused "a lone $key under the single-app setting"
  done
  clone_reset
  printf 'RELEASE_RUNTIME_ENV_FILE=relative.env\n' >>"$dir/release/.env"
  clone_refused 'relative runtime env file'

  # The real shared wrappers: only Docker/Python/HTTP effects are inert.
  for operation in dc probe smoke images; do
    for shape in "$clones" "$clones:docker-compose.dev-sandbox.yaml" "$clones:docker-compose.dev-sandbox-vm.yaml" \
      "$clones:docker-compose.dev-sandbox-vm.yaml:docker-compose.release-sandbox-vm.yaml"; do
      clone_reset
      clone_select "$shape"
      [[ $operation != images ]] || continue # failure path below; image catalogue is out of scope
      out=$(clone_boot "$operation" 2>&1); rc=$?
      case $operation in
        dc) expected="$shape|app|compose exec -T app true" ;;
        probe) expected="$shape|app|python3 scripts/check-vps.py --clones" ;;
        smoke) expected="$shape|app|python3 scripts/check-vps.py --clones" ;;
      esac
      if ((rc == 0)) && grep -Fxq "$expected" "$dir/calls"; then
        pass "clones $operation preserves complete file list/profile ($shape)"
      else flunk "clones $operation lost selected environment (rc=$rc)" "$out"; fi
      if [[ $operation == smoke ]]; then
        if grep -Fxq "$shape|app|python3 scripts/metadata-egress.py --docker-user-only --smoke" "$dir/calls"; then
          pass "clones metadata smoke preserves selected environment ($shape)"
        else flunk "clones metadata smoke lost selected environment" "$(cat "$dir/calls")"; fi
      fi
    done
    for problem in incomplete malformed render validator; do
      clone_reset
      case $problem in
        incomplete) sed '/^DEV_DATABASE_URL=/d' "$dir/good.env" >"$dir/release/.env" ;;
        malformed) printf 'COMPOSE_FILE=%s\n' "$base:docker-compose.clones.yaml:docker-compose.prod.yaml" >>"$dir/release/.env" ;;
        validator) python3 - "$dir/render.json" <<'PY'
import json, pathlib, sys
p=pathlib.Path(sys.argv[1]); c=json.loads(p.read_text()); c['services']['app-dev']['environment']['SANDBOX_ENVIRONMENT']='release'; p.write_text(json.dumps(c))
PY
          ;;
      esac
      # Images may inspect daemon availability, but cannot build or pull.
      out=$(SHIM_RENDER_FAIL=$([[ $problem == render ]] && echo 1 || echo 0) SHIM_HEALTH=1 clone_boot "$operation" 2>&1); rc=$?
      if ((rc != 0)) && ! grep -Ev 'compose config --format json$|\|info$' "$dir/calls" | grep -q .; then
        pass "clones $operation refuses $problem before dispatch"
      else flunk "clones $operation dispatched after $problem (rc=$rc)" "$out $(cat "$dir/calls")"; fi
    done
  done
  clone_reset
  sed '/^DEV_DATABASE_URL=/d' "$dir/good.env" >"$dir/release/.env"
  clone_refused 'incomplete smoke inputs with private health disabled' smoke
  clone_reset
  out=$(SHIM_METADATA_FAIL=1 clone_boot smoke 2>&1); rc=$?
  if ((rc != 0)) && grep -q 'forwarded metadata policy/persistence/probe failed' <<<"$out"; then
    pass 'clones metadata smoke failure refuses admission'
  else flunk 'clones metadata smoke failure was ignored' "$out"; fi
  # Item 3 of docs/plan/env-vm-network.md §11: with the dev environment VM
  # overlay selected, the smoke runs the guard's read-only --check; without the
  # overlay it never runs, and a guard refusal (carrying the guard's own
  # message) fails the smoke instead of being swallowed.
  guard_call="python3 $dir/release/scripts/env-vm-guard.py --check"
  clone_reset
  clone_select "$clones:docker-compose.dev-sandbox-vm.yaml"
  out=$(clone_boot smoke 2>&1); rc=$?
  if ((rc == 0)) && grep -Fq "$guard_call" "$dir/calls"; then
    pass 'clones VM overlay smoke runs the guard check'
  else flunk "clones VM overlay smoke did not run the guard check (rc=$rc)" "$out"; fi
  clone_reset
  clone_select "$clones:docker-compose.dev-sandbox-vm.yaml:docker-compose.release-sandbox-vm.yaml"
  out=$(clone_boot smoke 2>&1); rc=$?
  if ((rc == 0)) && grep -Fq "$guard_call" "$dir/calls"; then
    pass 'clones both VM overlays smoke runs the guard check'
  else flunk "clones both VM overlays smoke did not run the guard check (rc=$rc)" "$out"; fi
  for shape in "$clones" "$clones:docker-compose.dev-sandbox.yaml"; do
    clone_reset
    clone_select "$shape"
    out=$(clone_boot smoke 2>&1); rc=$?
    if ((rc == 0)) && ! grep -Fq "$guard_call" "$dir/calls"; then
      pass 'clones smoke without the VM overlay runs no guard check'
    else flunk "clones smoke ran the guard check without the overlay ($shape) (rc=$rc)" "$out"; fi
  done
  clone_reset
  clone_select "$clones:docker-compose.dev-sandbox-vm.yaml"
  out=$(SHIM_GUARD_FAIL=1 clone_boot smoke 2>&1); rc=$?
  if ((rc != 0)) && grep -q 'unavailable: FAIL guard config unreadable' <<<"$out"; then
    pass 'clones a guard refusal fails the smoke with the guard message'
  else flunk "clones ignored a failing guard check (rc=$rc)" "$out"; fi
  clone_reset
  clone_select "$clones:docker-compose.dev-sandbox-vm.yaml"
  mv "$dir/release/scripts/env-vm-guard.py" "$dir/held-guard"
  out=$(clone_boot smoke 2>&1); rc=$?
  mv "$dir/held-guard" "$dir/release/scripts/env-vm-guard.py"
  if ((rc != 0)) && grep -q 'lacks scripts/env-vm-guard.py' <<<"$out"; then
    pass 'clones a missing guard installer refuses instead of silently passing'
  else flunk "clones accepted a missing guard installer (rc=$rc)" "$out"; fi
  printf 'COMPOSE_FILE=%s\nACME_EMAIL=ops@example.invalid\nAPP_DOMAIN=release.example.invalid\n' "$base" >"$dir/release/.env"
  out=$(SHIM_NO_DEV=1 clone_boot smoke 2>&1); rc=$?
  if ((rc == 0)) && grep -q '^HTTP ' "$dir/calls"; then pass 'clones default smoke still succeeds'; else flunk 'clones default smoke failed' "$out"; fi

  for shape in "$base" "$clones"; do
    for spelling in export spaced; do
      clone_reset
      python3 - "$dir/release/.env" "$shape" "$spelling" <<'PY'
import pathlib, sys
p=pathlib.Path(sys.argv[1]); lines=p.read_text().splitlines()
lines[0]='COMPOSE_FILE='+sys.argv[2]
p.write_text('\n'.join((('export '+s) if sys.argv[3]=='export' else s.replace('=', ' = ', 1)) if not s.startswith('COMPOSE_FILE=') else s for s in lines)+'\n')
PY
      clone_refused "$spelling clone inputs under $shape"
    done
    for spelling in 'export COMPOSE_FILE' 'COMPOSE_FILE '; do
      clone_reset
      printf '%s=%s\n' "$spelling" "$shape" >>"$dir/release/.env"
      clone_refused "ambiguous $spelling under $shape"
    done
  done
  clone_reset
  chmod 644 "$dir/dev-runtime.env"
  clone_refused '0644 runtime env'
  chmod 600 "$dir/dev-runtime.env"
  mkdir -m 700 "$dir/runtime-directory"
  clone_reset
  printf 'DEV_RUNTIME_ENV_FILE=%s/runtime-directory\n' "$dir" >>"$dir/release/.env"
  clone_refused 'directory in place of runtime env file'
  for checkout in release dev; do
    cp "$dir/dev-runtime.env" "$dir/$checkout/runtime.env"
    clone_reset
    printf 'DEV_RUNTIME_ENV_FILE=%s/%s/runtime.env\n' "$dir" "$checkout" >>"$dir/release/.env"
    clone_refused "runtime env inside $checkout checkout"
    rm "$dir/$checkout/runtime.env"
  done
  clone_reset
  printf 'DEV_CLONE_PATH=relative-dev\n' >>"$dir/release/.env"
  clone_refused 'relative dev checkout'
  clone_reset
  printf 'DEV_REF=%040d\n' 0 >>"$dir/release/.env"
  clone_refused 'unreviewed dev HEAD'
  clone_reset
  printf 'DEV_REF=short\n' >>"$dir/release/.env"
  clone_refused 'non-full dev SHA'
  clone_reset
  touch "$dir/dev/unreviewed"
  clone_refused 'dirty dev checkout'
  rm "$dir/dev/unreviewed"

  clone_reset
  out=$(clone_boot owner 2>&1); rc=$?
  if ((rc == 0)); then pass 'clones owner gate uses complete runtime values instead of unused root values'; else flunk 'clones owner gate ignored runtime values' "$out"; fi
  for file in release dev; do
    clone_reset
    cp "$dir/$file-runtime.env" "$dir/saved-owner"
    printf 'AZURE_CLIENT_SECRET=\n' >>"$dir/$file-runtime.env"
    clone_refused "missing $file runtime owner value" owner
    cp "$dir/saved-owner" "$dir/$file-runtime.env"
  done

  # The marker must cover all six runtime keys and ignore unused root keys.
  clone_reset
  out=$(
    lib "$dir/release"
    mkdir -p "$STATE_DIR"
    printf 'fixture %s\n' "$(keys_fingerprint)" >"$ESCROW_MARKER"
    escrow_recorded || exit 1
    printf 'DATA_ENCRYPTION_KEY=unused-root-key\n' >>"$ENV_FILE"
    escrow_recorded || exit 2
    for file in release dev; do
      cp "$dir/$file-runtime.env" "$dir/saved-runtime"
      for key in AUTH_SESSION_SECRET TOKEN_ENCRYPTION_KEY DATA_ENCRYPTION_KEY; do
        cp "$dir/saved-runtime" "$dir/$file-runtime.env"
        printf '%s=changed-runtime-key-00000000000000000000000000000000\n' "$key" >>"$dir/$file-runtime.env"
        if escrow_recorded; then exit 3; fi
      done
      cp "$dir/saved-runtime" "$dir/$file-runtime.env"
    done
    # Each owner's missing setting is read from that app's runtime file.
    for file in release dev; do
      printf 'AZURE_CLIENT_SECRET=\n' >>"$dir/$file-runtime.env"
      owner_missing "$dir/$file-runtime.env" | grep -qx AZURE_CLIENT_SECRET || exit 4
    done
  ); rc=$?
  if ((rc == 0)); then pass 'clones escrow covers each runtime key and runtime owner values'; else flunk "clones runtime escrow/owner gate failed (rc=$rc)" "$out"; fi
}
if [[ ${1:-} == --clone-mutations ]]; then
  python3 - "$SCRIPT" "$0" <<'PY'
import os, pathlib, subprocess, sys, tempfile
source, harness = map(pathlib.Path, sys.argv[1:])
original = source.read_text()
mutants = [
    ('overlay-not-applied', '(cd "$APP_DIR" && sudo env COMPOSE_FILE="$files" COMPOSE_PROFILES="$COMPOSE_PROFILE" docker compose "$@" 2>/dev/null)',
     '(cd "$APP_DIR" && sudo env COMPOSE_FILE="$COMPOSE_FILES" COMPOSE_PROFILES="$COMPOSE_PROFILE" docker compose "$@" 2>/dev/null)'),
    ('validator-skipped', 'node scripts/validate-clones.mjs >/dev/null', 'cat >/dev/null'),
    ('orphan-prune-clones', '    run dc up -d\n', '    run dc up -d --remove-orphans\n'),
    ('default-command-changed', '    run dc up -d --remove-orphans\n', '    run dc up -d\n'),
    ('single-app-live-dev-guard', '[[ -z $existing_dev ]] || { refuse', 'true || { refuse'),
    ('single-app-state-query-failure', '|| { refuse "cannot inspect app-dev before single-app orphan pruning"; return 1; }', '|| existing_dev=""'),
    ('half-config-falls-back', 'if [[ -n "$(env_get "$key")" ]]; then', 'if false; then'),
    ('required-inputs-skipped', 'for key in "${CLONE_INPUTS[@]}"; do\n    [[ -n', 'for key in; do\n    [[ -n'),
    ('missing-overlay-accepted', 'for path in "${parts[@]}" scripts/validate-clones.mjs configs/Caddyfile configs/Caddyfile.dev;',
     'for path in scripts/validate-clones.mjs configs/Caddyfile configs/Caddyfile.dev;'),
    ('render-failure-ignored', '(set -o pipefail; cd "$APP_DIR"', '(set +o pipefail; cd "$APP_DIR"'),
    ('dev-health-skipped', 'healthy_services+=(app-dev)', ':'),
    ('metadata-smoke-compose-selection', 'if (cd "$APP_DIR" && sudo env COMPOSE_FILE="$files" COMPOSE_PROFILES="$COMPOSE_PROFILE" \\\n    python3 scripts/metadata-egress.py', 'if (cd "$APP_DIR" && sudo env COMPOSE_FILE="$COMPOSE_FILES" COMPOSE_PROFILES="$COMPOSE_PROFILE" \\\n    python3 scripts/metadata-egress.py'),
    ('smoke-stage-preflight', '  clone_preflight "$files" || return 1\n  local fails=0', '  :\n  local fails=0'),
    ('dc-wrapper-preflight', 'if [[ ${1:-} != config ]]; then clone_preflight "$files" || return 1; fi', 'if [[ ${1:-} != config ]]; then :; fi'),
    ('vps-wrapper-preflight', '  clone_preflight "$files" || return 1\n  (cd "$APP_DIR"', '  :\n  (cd "$APP_DIR"'),
    ('vps-wrapper-compose-selection', 'COMPOSE_FILE="$files" COMPOSE_PROFILES="$COMPOSE_PROFILE" python3 scripts/check-vps.py', 'COMPOSE_FILE="$COMPOSE_FILES" COMPOSE_PROFILES="$COMPOSE_PROFILE" python3 scripts/check-vps.py'),
    ('boot-stage-preflight-R1',
     '    # silently by a later reader.\n    clone_preflight "$files" || return 1',
     '    # silently by a later reader.\n    :'),
    ('ambiguous-assignments', "  if grep -E '^[[:space:]]*(export", "  if false && grep -E '^[[:space:]]*(export"),
    ('runtime-file-R5', '[[ $path == /* && -r $path && -f $path ]]', 'true'),
    ('runtime-permissions', '(( (8#$mode & 077) != 0 ))', 'false'),
    ('runtime-location', '"$(realpath "$APP_DIR")"/*|"$dev_path"/*)', '/never-match-synthetic/*)'),
    ('runtime-escrow', 'if [[ $files != "$COMPOSE_FILES" ]]; then\n    (', 'if false; then\n    ('),
    ('runtime-owner-values', 'missing+=$(owner_missing "$file" | sed "s/^/$key: /")', 'missing+=""'),
    ('runtime-owner-file-parser', 'v=$(env_get "$key" "$file")', 'v=$(env_get "$key")'),
    ('dev-ref-head', '[[ $head == "$ref" && -z $dirty ]]', '[[ -z $dirty ]]'),
    ('dev-checkout-clean', '[[ $head == "$ref" && -z $dirty ]]', '[[ $head == "$ref" ]]'),
    ('dev-sandbox-overlay-allowlist', '|"$DEV_VM_COMPOSE_FILES"|"$BOTH_VM_COMPOSE_FILES") ;;', '|"$CLONE_COMPOSE_FILES:"*) ;;'),
    # #648 release VM: one shape, release after dev, each with its own evidence.
    ('release-vm-overlay-not-accepted', '|"$DEV_VM_COMPOSE_FILES"|"$BOTH_VM_COMPOSE_FILES") ;;', '|"$DEV_VM_COMPOSE_FILES") ;;'),
    ('release-vm-overlay-without-dev', 'readonly BOTH_VM_COMPOSE_FILES="$DEV_VM_COMPOSE_FILES:docker-compose.release-sandbox-vm.yaml"',
     'readonly BOTH_VM_COMPOSE_FILES="$CLONE_COMPOSE_FILES:docker-compose.release-sandbox-vm.yaml"'),
    ('release-vm-firewall-evidence', '    path=$(env_get RELEASE_SANDBOX_FIREWALL_EVIDENCE)\n    [[ $path == /* && -f $path && -s $path ]] ||',
     '    path=$(env_get RELEASE_SANDBOX_FIREWALL_EVIDENCE)\n    true ||'),
    ('release-vm-firewall-evidence-empty', '    path=$(env_get RELEASE_SANDBOX_FIREWALL_EVIDENCE)\n    [[ $path == /* && -f $path && -s $path ]]',
     '    path=$(env_get RELEASE_SANDBOX_FIREWALL_EVIDENCE)\n    [[ $path == /* && -f $path ]]'),
    ('release-vm-evidence-reads-dev-input', 'path=$(env_get RELEASE_SANDBOX_FIREWALL_EVIDENCE)', 'path=$(env_get DEV_SANDBOX_FIREWALL_EVIDENCE)'),
    # #777 security review: release's record must have probed release.
    ('release-evidence-read-unprivileged', "    sudo python3 -I -c 'import json, sys", "    python3 -I -c 'import json, sys"),
    ('release-evidence-structure-unread', "sys.exit(0 if isinstance(probes, list) and probes else 1)' \"$path\" 2>/dev/null ||",
     "sys.exit(0)' \"$path\" 2>/dev/null ||"),
    ('release-evidence-any-environment', 'probes = environments.get("release") if', 'probes = environments.get("dev") if'),
    ('release-evidence-unprobed-accepted', 'isinstance(probes, list) and probes else 1', 'isinstance(probes, list) else 1'),
    ('release-evidence-non-json-accepted', 'except (OSError, ValueError):\n    sys.exit(1)', 'except (OSError, ValueError):\n    sys.exit(0)'),
    ('dev-vm-evidence-by-suffix', '  if [[ $files == "$DEV_VM_COMPOSE_FILES" || $files == "$BOTH_VM_COMPOSE_FILES" ]]; then\n    path=$(env_get DEV_SANDBOX_FIREWALL_EVIDENCE)',
     '  if [[ $files == *:docker-compose.dev-sandbox-vm.yaml ]]; then\n    path=$(env_get DEV_SANDBOX_FIREWALL_EVIDENCE)'),
    ('vm-guard-check-dev-shape-only', '  guard_out=""\n  if [[ $files == "$DEV_VM_COMPOSE_FILES" || $files == "$BOTH_VM_COMPOSE_FILES" ]]; then',
     '  guard_out=""\n  if [[ $files == "$DEV_VM_COMPOSE_FILES" ]]; then'),
    ('dev-vm-firewall-evidence', '    path=$(env_get DEV_SANDBOX_FIREWALL_EVIDENCE)\n    [[ $path == /* && -f $path && -s $path ]] ||',
     '    path=$(env_get DEV_SANDBOX_FIREWALL_EVIDENCE)\n    true ||'),
    ('dev-vm-firewall-evidence-empty', '    path=$(env_get DEV_SANDBOX_FIREWALL_EVIDENCE)\n    [[ $path == /* && -f $path && -s $path ]]',
     '    path=$(env_get DEV_SANDBOX_FIREWALL_EVIDENCE)\n    [[ $path == /* && -f $path ]]'),
    # Item 3 (plan env-vm-network §11): with the VM overlay selected, the smoke
    # runs the guard's read-only --check; its refusal fails the smoke.
    ('vm-guard-check-skipped', '      guard_out=$(sudo python3 "$APP_DIR/scripts/env-vm-guard.py" --check 2>&1) && guard_rc=0 || guard_rc=$?', '      guard_rc=1'),
    ('vm-guard-check-unconditional', '  guard_out=""\n  if [[ $files == "$DEV_VM_COMPOSE_FILES" || $files == "$BOTH_VM_COMPOSE_FILES" ]]; then', '  guard_out=""\n  if [[ $files != "$COMPOSE_FILES" ]]; then'),
    ('vm-guard-exit-swallowed', '--check 2>&1) && guard_rc=0 || guard_rc=$?', '--check 2>&1 || true) && guard_rc=0 || guard_rc=$?'),
    ('vm-guard-refusal-uncounted', 'fails=$((fails + 1)) # the guard refused', ': # the guard refused'),
    ('vm-guard-message-withheld', 'failed or is unavailable: ${guard_out:-the pinned checkout lacks scripts/env-vm-guard.py}"', 'failed (its message withheld)"'),
    ('vm-guard-missing-installer-accepted', 'if [[ -f $APP_DIR/scripts/env-vm-guard.py ]]; then', 'if [[ -e $APP_DIR ]]; then'),
    ('clone-profiles-app-only', 'if [[ -n $profiles ]] &&', 'if false &&'),
    ('clone-profiles-allow-app', r'''profiles:[[:space:]]*\["app"\]''', r'''profiles:[[:space:]]*\["none"\]'''),
    # Behaviourally identical on small files, so only stage 2b's scan sees it.
    ('profiles-sigpipe-pipeline', '''profiles=$(grep -E '^[[:space:]]*profiles:' "$APP_DIR/$path" || true)
    if [[ -n $profiles ]] && grep -Evq '^[[:space:]]*profiles:[[:space:]]*\\["app"\\][[:space:]]*$' <<<"$profiles"; then''',
     '''if grep -E '^[[:space:]]*profiles:' "$APP_DIR/$path" | grep -Evq '^[[:space:]]*profiles:[[:space:]]*\\["app"\\][[:space:]]*$'; then''',
     'FAIL 2b SIGPIPE-prone pipeline'),
    # #672: the boot recreate of a Caddy serving a changed Caddyfile, and its
    # smoke counterpart.
    ('caddy-stale-check-skipped', '''    stale_files=$(caddy_stale_files "$caddy_id") || refuse "cannot compare the running Caddy\'s mounts with the checkout\'s (docker inspect failed, or no bind-mounted regular file)"''', '    stale_files=""'),
    ('boot-caddy-stale-refuse-dropped',
     'stale_files=$(caddy_stale_files "$caddy_id") || refuse "cannot compare',
     'stale_files=$(caddy_stale_files "$caddy_id") || : # refuse'),
    ('caddy-recreate-everything', 'run dc up -d --no-deps --force-recreate caddy', 'run dc up -d --no-deps --force-recreate'),
    ('caddy-always-stale', 'sudo docker exec "$id" cat "$tgt" 2>/dev/null | cmp -s - "$src" || printf', 'printf'),
    ('caddy-mounts-unfiltered', '[[ $mtype == bind && -f $src ]] || continue', ':'),
    ('smoke-caddy-stale-ignored', '  elif [[ -n $caddy_stale ]]; then', '  elif false; then'),
    ('smoke-caddy-inspect-fail-swallowed', '  elif ! caddy_stale=$(caddy_stale_files "$caddy_id"); then', '  elif caddy_stale=$(caddy_stale_files "$caddy_id"); then'),
    ('smoke-caddy-id-ignored',
     'caddy_id=$(caddy_container_id) || refuse "cannot resolve the running Caddy container for smoke check 1c (the Compose project lookup failed)"',
     'caddy_id=""'),
    # The review's BLOCKING reproduction, restored as a mutant: the stale
    # comparison runs unconditionally again, and under main's set -e the
    # no-Caddy smoke dies at `[[ -n $caddy_id ]] &&` before the later checks.
    ('smoke-no-caddy-set-e-unhandled', '  if [[ -z $caddy_id ]]; then',
     '  caddy_stale=$([[ -n $caddy_id ]] && caddy_stale_files "$caddy_id")\n  if [[ -z $caddy_id ]]; then'),
    # Restore the reviewed fall-through: inspect fails, FAIL is counted, then
    # the empty stale string reaches the contradictory fresh-Caddy ok line.
    ('smoke-caddy-inspect-fail-falls-through', '''  if [[ -z $caddy_id ]]; then
    # Nothing to compare against; Caddy's own liveness is check 2's business.
    warn "1c no running Caddy container, so its config was not compared"
  elif ! caddy_stale=$(caddy_stale_files "$caddy_id"); then
    fail "1c could not inspect the running Caddy's mounts, so its config was not compared"
    fails=$((fails + 1))
  elif [[ -n $caddy_stale ]]; then''', '''  caddy_stale=""
  if [[ -n $caddy_id ]]; then
    caddy_stale=$(caddy_stale_files "$caddy_id") || {
      fail "1c could not inspect the running Caddy's mounts, so its config was not compared"
      fails=$((fails + 1))
      caddy_stale=""
    }
  fi
  if [[ -z $caddy_id ]]; then
    # Nothing to compare against; Caddy's own liveness is check 2's business.
    warn "1c no running Caddy container, so its config was not compared"
  elif [[ -n $caddy_stale ]]; then'''),
    # The review's surviving byte-count mutant: killed only once fresh and
    # stale served content are the same length as the checkout's file.
    ('caddy-stale-by-size',
     'sudo docker exec "$id" cat "$tgt" 2>/dev/null | cmp -s - "$src" || printf \'%s -> %s\\n\' "$src" "$tgt"',
     '[[ $(sudo docker exec "$id" cat "$tgt" 2>/dev/null | wc -c) -eq $(wc -c <"$src") ]] || printf \'%s -> %s\\n\' "$src" "$tgt"'),
    # caddy_stale_files must fail closed: inspect's own status, and an empty
    # mount listing (the Caddyfile mount is always there).
    ('caddy-mount-inspect-fail-open',
     'mounts=$(sudo docker inspect -f \'{{range .Mounts}}{{printf "%s %s %s\\n" .Type .Source .Destination}}{{end}}\' "$id") || return 1',
     'mounts=$(sudo docker inspect -f \'{{range .Mounts}}{{printf "%s %s %s\\n" .Type .Source .Destination}}{{end}}\' "$id" 2>/dev/null) || return 0'),
    ('caddy-mounts-none-fail-open', '((found)) || return 1', '((found)) || return 0'),
    # #664: the boot gate reads the .env ACME_EMAIL Caddy actually uses.
    ('acme-gate-reads-argument', 'elif reserved_name "$env_acme"; then', 'elif reserved_name "$ACME_EMAIL_ARG"; then'),
    ('render-failure-refusal-off', '((render_ok)) || refuse "cannot render the Compose config, so the ACME_EMAIL/APP_DOMAIN Caddy gets are unreadable"', '((render_ok)) || :'),
    ('acme-mismatch-accepted', '[[ $env_acme == "$ACME_EMAIL_ARG" ]] || owner_stop', '[[ $env_acme == "$ACME_EMAIL_ARG" ]] || :'),
    # #664 review: the gates read what Compose RENDERS, not .env's own text —
    # env_get cannot see `export ACME_EMAIL=...` (nor spaces around `=`, nor a
    # leading space; the last line wins), which is exactly the review's
    # reproduction. The shim's render mirrors Compose's parser for these two
    # keys, so this mutant (read .env text instead) is killed by the
    # export-spelling pin.
    ('acme-render-reads-env-text', '''compose_caddy_env() {
  local key=$1 json
  json=$(dc config --format json) || return 1''',
     '''compose_caddy_env() {
  env_get "$1" || return 1
  return 0
}
compose_caddy_env_unused() {
  local key=$1 json
  json=$(dc config --format json) || return 1'''),
    # The --hostname reserved gate this PR rewrote (the review's surviving
    # mutant: `if false` survives everything but the pin below).
    ('hostname-reserved-gate-off', '''if reserved_name "$HOSTNAME_ARG"; then
    refuse "--hostname is a reserved placeholder''', '''if false; then
    refuse "--hostname is a reserved placeholder'''),
    ('appdomain-reserved-accepted', 'elif reserved_name "$env_domain"; then', 'elif false; then'),
    ('appdomain-mismatch-accepted', '[[ $env_domain == "$HOSTNAME_ARG" ]] || owner_stop', '[[ $env_domain == "$HOSTNAME_ARG" ]] || :'),
]
baseline = subprocess.run(['bash', str(harness), '--clones-only'], capture_output=True, text=True, timeout=90)
if baseline.returncode:
    sys.exit('Baseline failed: ' + baseline.stdout + baseline.stderr)
render_test = ['python3', str(source.parent / 'prepare-embedder.test.py'), '-k', 'test_boot_refuses_failed_compose_render_before_prepare_or_up']
baseline = subprocess.run(render_test, capture_output=True, text=True, timeout=10)
if baseline.returncode:
    sys.exit('Render-refusal baseline failed: ' + baseline.stdout + baseline.stderr)
with tempfile.TemporaryDirectory() as tmp:
    validator = source.parent / 'validate-clones.mjs'
    policy = validator.read_text()
    for name, old, new, *expected in mutants:
        if original.count(old) != 1:
            sys.exit('Mutation anchor must occur once: ' + name)
        changed = pathlib.Path(tmp) / 'bootstrap-vps.sh'
        changed.write_text(original.replace(old, new))
        env = {**os.environ, 'BOOTSTRAP_SCRIPT': str(changed)}
        command = render_test if name == 'render-failure-refusal-off' else ['bash', str(harness), '--clones-only']
        result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=90)
        signal = 'FAIL: test_boot_refuses_failed_compose_render_before_prepare_or_up' if name == 'render-failure-refusal-off' else (expected or ['FAIL clones'])[0]
        if not result.returncode or signal not in result.stdout + result.stderr:
            sys.exit('SURVIVED or invalid mutation: ' + name + '\n' + result.stdout + result.stderr)
        print('KILLED ' + name, flush=True)
    # New validator pins run the actual unit fixtures against a temporary
    # module, including the review's six previously ACCEPTED renders.
    for name, old, new in [
        ('sibling-value-scan', 'ownSecrets.some((secret) => String(value).includes(secret))', 'false'),
        ('administrator-value-scan', '!administrator ||', 'true ||'),
        ('equal-role-passwords', 'passwords[0] !== passwords[1]', 'true'),
        ('root-only-app-inputs', '!Object.keys(env).some', 'true || !Object.keys(env).some'),
        ('reserved-database', '!["postgres", "template0", "template1"].includes', 'true || !["postgres", "template0", "template1"].includes'),
        # #648: each clone's sandbox endpoint, its own environment VM over TLS.
        ('sandbox-mode-declared', 'modes.every((mode) => SANDBOX_MODES.includes(mode))', 'true'),
        ('host-reach', '!HOST_REACH.some((key) => [app[key]].flat().some(Boolean))', 'true'),
        ('host-reach-pid', '  "pid",\n', ''),
        ('host-reach-volumes-from', '  "volumes_from",\n', ''),
        ('vm-exact-mounts', 'volumes.length === 4 &&', ''),
        ('vm-read-only-mounts', 'volumes.every((v) => v.type === "bind" && v.read_only === true) &&', ''),
        ('vm-never-create-path', ' && v.bind?.create_host_path === false', ''),
        ('vm-tls-settings', '.join() === ["SANDBOX_DOCKER_HOST", ...Object.keys(TLS_FILES)].join() &&', '.join() !== "" &&'),
        ('vm-tls-targets', 'Object.entries(TLS_FILES).every(([key, target]) => env[key] === target)', 'true'),
        ('vm-ipv4', 'isIPv4(String(address)) &&', ''),
        ('vm-port-range', 'unicastIPv4(endpoint[1]) &&\n      Number(endpoint[2]) >= 1 &&\n      Number(endpoint[2]) <= 65535,', 'unicastIPv4(endpoint[1]),'),
        ('vm-address-class', '!(a === 0 || a === 127 || a >= 224 || (a === 169 && b === 254))', 'true'),
        ('vm-regular-file', 'check(stat.isFile(), "TLS mounts must be regular files");', ''),
        ('vm-outside-checkouts', '!roots.some((root) => path.startsWith(root + sep))', 'true'),
        ('vm-key-permissions', '(files.SANDBOX_DOCKER_TLS_KEY.stat.mode & 0o077) === 0', 'true'),
        ('vm-single-certificates', 'certificates(ca) === 1 &&\n      certificates(leaf) === 1 &&', ''),
        ('vm-no-key-in-certificates', '![ca, leaf].some((pem) => pem.includes("PRIVATE KEY-----"))', 'true'),
        ('vm-leaf-not-ca', '!certificate.ca &&', ''),
        ('vm-chain-own-ca', 'certificate.verify(authority.publicKey) &&', ''),
        ('vm-key-matches', 'certificate.checkPrivateKey(\n        createPrivateKey(files.SANDBOX_DOCKER_TLS_KEY.pem),\n      )', 'true'),
        ('vm-one-service', 'other === name ||', 'true ||'),
        ('vm-own-host', 'own.host !== other.host', 'true'),
        ('vm-cross-identity', '!own.certificate.verify(other.authority.publicKey) &&\n        !other.certificate.verify(own.authority.publicKey)', 'true'),
        ('socket-clone-no-vm-settings', '!Object.keys(envs[i]).some((key) => key.startsWith("SANDBOX_DOCKER_"))', 'true'),
        ('dev-socket-beside-vm', '!(devDockerSocket && modes[1] === "per-env")', 'true'),
        ('root-only-vm-inputs', '|(RELEASE|DEV)_SANDBOX_[A-Z_]+', ''),
        # #731 review round 1.
        ('vm-certificate-not-before', 'new Date(x.validFrom) <= now && ', ''),
        ('vm-certificate-not-after', ' && now <= new Date(x.validTo)', ''),
        ('vm-ca-dates', '[authority, certificate].every(', '[certificate].every('),
        ('vm-leaf-dates', '[authority, certificate].every(', '[authority].every('),
        ('vm-no-docker-client-env', 'Object.keys(env).every((key) => !key.startsWith("DOCKER_"))', 'true'),
        ('vm-endpoint-start-anchor', '/^tcp:', '/tcp:'),
        ('vm-endpoint-end-anchor', '{1,5})$/.exec', '{1,5})/.exec'),
        ('vm-ca-is-ca', 'authority.ca &&\n      ', ''),
        ('vm-container-id-join', 'String(service[key] ?? "").startsWith("container:") &&', 'false &&'),
        ('vm-container-other-app', 'service[key] !== `container:${apps[1 - i].container_name}`', 'true'),
        ('vm-tls-mount-elsewhere', 'vm.sources.some((file) => within(file, resolved(v.source)))', 'false'),
        ('vm-tls-directory-mount', 'within(file, resolved(v.source))', 'file === resolved(v.source)'),
        ('vm-tls-root-mount', 'directory === sep ? directory : directory + sep', 'directory + sep'),
        ('vm-missing-bind-source', 'return resolve(source); // A missing source cannot hold a TLS file.', 'throw new Error("missing");'),
        # #731 review round 3 (R1): Compose bind-mounts secret and config files
        # and local-driver volume devices too.
        ('host-reach-secrets', '  "secrets",\n', ''),
        ('host-reach-configs', '  "configs",\n', ''),
        ('host-mounts-secret-files', '["secrets", "configs"].flatMap', '["configs"].flatMap'),
        ('host-mounts-config-files', '["secrets", "configs"].flatMap', '["secrets"].flatMap'),
        ('host-mounts-volume-device', 'return device ? [{ source: device, target: v.target }] : [];', 'return [];'),
        ('socket-clone-host-mounts', '!hostMounts(config, app).some(', '!(app.volumes ?? []).filter((v) => v.type === "bind").some('),
        ('vm-one-service-host-mounts', 'hostMounts(config, service).some(', '(service.volumes ?? []).filter((v) => v.type === "bind").some('),
        # Dev link network (plan env-vm-network §2.3).
        ('vm-link-external', 'config.networks?.[link]?.external === true &&', ''),
        ('vm-link-name', 'config.networks[link].name === link &&', ''),
        ('vm-link-exact-networks', 'Object.keys(networks).sort().join() === ["app-network", link].join() &&', ''),
        ('vm-link-gw-priority', 'attachment?.gw_priority === 1 &&', ''),
        ('vm-link-address', 'unicastIPv4(attachment?.ipv4_address) &&', ''),
        ('vm-link-app-network-priority', '!((networks["app-network"]?.gw_priority ?? 0) >= 1)', 'true'),
        ('vm-link-sole-member', '(key) => named(key) === link,', '(key) => false,'),
        # #745 review: a member under another key, or app-network renamed to the link network.
        ('vm-link-member-by-key', 'const named = (key) => config.networks?.[key]?.name ?? key;', 'const named = (key) => key;'),
        ('vm-link-per-clone', 'linkNetwork(config, apps[i], ["release", "dev"][i])', 'linkNetwork(config, apps[i], "dev")'),
        ('root-only-link-inputs', '(RELEASE|DEV)_SANDBOX_[A-Z_]+)$/', '(RELEASE|DEV)_SANDBOX_DOCKER_[A-Z_]+)$/'),
    ]:
        if policy.count(old) != 1:
            sys.exit('Mutation anchor must occur once: ' + name)
        changed = pathlib.Path(tmp) / 'validate-clones.mjs'
        changed.write_text(policy.replace(old, new))
        result = subprocess.run(['corepack', 'pnpm', 'test:run', 'src/__tests__/lib/config/compose-clones.test.ts'],
            cwd=source.parent.parent / 'app', env={**os.environ, 'CI': '1', 'TEST_DATABASE_URL': 'postgresql://x:x@127.0.0.1:59999/x', 'CLONE_VALIDATOR_SCRIPT': str(changed)}, capture_output=True, text=True, timeout=90)
        if not result.returncode or 'AssertionError' not in result.stdout + result.stderr:
            sys.exit('SURVIVED or invalid mutation: ' + name + '\n' + result.stdout + result.stderr)
        print('KILLED ' + name, flush=True)
    for name, old in [
        ('separate-database-policy', 'decodeURIComponent(databases[0].pathname) !==\n      decodeURIComponent(databases[1].pathname)'),
        ('separate-role-policy', 'decodeURIComponent(databases[0].username) !==\n      decodeURIComponent(databases[1].username)'),
    ]:
        if policy.count(old) != 1:
            sys.exit('Mutation anchor must occur once: ' + name)
        changed = pathlib.Path(tmp) / 'validate-clones.mjs'
        changed.write_text(policy.replace(old, 'true'))
        env = {**os.environ, 'CLONE_VALIDATOR_SCRIPT': str(changed)}
        result = subprocess.run(['bash', str(harness), '--clones-only'], env=env, capture_output=True, text=True, timeout=90)
        if not result.returncode or 'FAIL clones' not in result.stdout:
            sys.exit('SURVIVED or invalid mutation: ' + name + '\n' + result.stdout + result.stderr)
        print('KILLED ' + name, flush=True)
PY
  exit $?
fi
clone_tests
# 2b. Never `producer | grep -q` under pipefail: grep -q exits at its first match,
# the producer dies of SIGPIPE and the pipeline reads as failed, i.e. a FOUND
# match is reported as absent. That shipped once here (the sshd -T check
# refused every box). Comments are exempt.
# One pipe, not the `||` of an or-list. A static scan needs no GNU tool, so it
# runs here, where --clones-only (the macOS lanes and the mutants) reaches it.
hits=$(grep -nE '(^|[^|])\|[[:space:]]*grep[[:space:]]+-[A-Za-z]*q' "$SCRIPT" | grep -vE '^[0-9]+:[[:space:]]*#' || true)
if [[ -z $hits ]]; then pass "2b no 'producer | grep -q' pipeline in the script"; else flunk "2b SIGPIPE-prone pipeline" "$hits"; fi
if [[ ${1:-} == --clones-only ]]; then
  ((failures == 0)) || exit 1
  echo 'all clone checks passed'
  exit 0
fi

# ---------------------------------------------------- 1. public_listeners
tcp_clean='LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*
LISTEN 0 4096 [::]:22 [::]:*
LISTEN 0 4096 *:443 *:*
LISTEN 0 4096 0.0.0.0:80 0.0.0.0:*
LISTEN 0 4096 127.0.0.1:5432 0.0.0.0:*
LISTEN 0 4096 127.0.0.1:7687 0.0.0.0:*
LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:*
LISTEN 0 4096 [::1]:3444 [::]:*'
out=$(
  lib "$tmproot/l1"
  public_listeners "22 80 443" <<<"$tcp_clean"
)
if [[ -z $out ]]; then pass "1 loopback data tier + 22/80/443 is clean"; else flunk "1 clean tcp flagged" "$out"; fi

for bad in '0.0.0.0:5432 0.0.0.0:*' '[::]:7687 [::]:*' '*:8811 *:*' '203.0.113.7:3444 0.0.0.0:*'; do
  out=$(
    lib "$tmproot/l1"
    public_listeners "22 80 443" <<<"$tcp_clean"$'\n'"LISTEN 0 4096 $bad"
  )
  if [[ $out == *"${bad%% *}"* ]]; then pass "1 flags a public listener: ${bad%% *}"; else flunk "1 missed ${bad%% *}" "$out"; fi
done

udp_clean='UNCONN 0 0 127.0.0.54:53 0.0.0.0:*
UNCONN 0 0 127.0.0.53%lo:53 0.0.0.0:*
UNCONN 0 0 203.0.113.7%ens3:68 0.0.0.0:*
UNCONN 0 0 [fe80::1%ens3]:546 [::]:*
UNCONN 0 0 127.0.0.1:323 0.0.0.0:*
UNCONN 0 0 [::1]:323 [::]:*
UNCONN 0 0 0.0.0.0:443 0.0.0.0:*'
out=$(
  lib "$tmproot/l1"
  public_listeners "443 68 546" <<<"$udp_clean"
)
if [[ -z $out ]]; then pass "1 udp: resolved, chrony, DHCP client and HTTP/3 are clean"; else flunk "1 clean udp flagged" "$out"; fi
out=$(
  lib "$tmproot/l1"
  public_listeners "443 68 546" <<<"$udp_clean"$'\nUNCONN 0 0 0.0.0.0:5353 0.0.0.0:*'
)
if [[ $out == *0.0.0.0:5353* ]]; then pass "1 udp: flags a public 5353"; else flunk "1 udp missed 5353" "$out"; fi

# --------------------------------------------- 2. gateway image pinning
digest=$(printf 'a%.0s' $(seq 1 64))
for img in "docker/mcp-gateway@sha256:$digest" "docker/mcp-gateway:v0.40.0@sha256:$digest"; do
  if (
    lib "$tmproot/p"
    image_pinned "$img"
  ); then pass "2 pinned: $img"; else flunk "2 not accepted as pinned: $img"; fi
done
for img in docker/mcp-gateway docker/mcp-gateway:latest docker/mcp-gateway:v0.40.0 \
  "docker/mcp-gateway@sha256:${digest:0:63}" "docker/mcp-gateway@sha256:${digest}0" ""; do
  if (
    lib "$tmproot/p"
    image_pinned "$img"
  ); then flunk "2 accepted as pinned: '$img'"; else pass "2 not pinned: '$img'"; fi
done

# Static read: the overlay's value wins over the base's.
mkdir -p "$tmproot/g"
cat >"$tmproot/g/docker-compose.yaml" <<'YAML'
services:
  neo4j:
    image: neo4j:5.26
  mcp-gateway:
    image: docker/mcp-gateway
    restart: unless-stopped
  app:
    image: hames-app:local
YAML
printf 'services:\n  mcp-gateway:\n    ports: ["127.0.0.1:8811:8811"]\n' >"$tmproot/g/docker-compose.prod.yaml"
got=$(
  lib "$tmproot/g"
  gateway_image
)
if [[ $got == docker/mcp-gateway ]]; then pass "2 static read finds the base image"; else flunk "2 static read: '$got'"; fi
printf 'services:\n  mcp-gateway:\n    image: "docker/mcp-gateway@sha256:%s"\n' "$digest" >"$tmproot/g/docker-compose.prod.yaml"
got=$(
  lib "$tmproot/g"
  gateway_image
)
if [[ $got == "docker/mcp-gateway@sha256:$digest" ]]; then pass "2 static read: the overlay wins, quotes stripped"; else flunk "2 overlay not preferred: '$got'"; fi
out=$(
  lib "$tmproot/g"
  printf 'services:\n  mcp-gateway:\n    image: docker/mcp-gateway:latest\n' >"$HAMES_APP_DIR/docker-compose.prod.yaml"
  assert_gateway_pinned 2>&1
)
rc=$?
if ((rc == 1)) && [[ $out == *"REFUSED"*"not digest-pinned"* ]]; then pass "2 assert_gateway_pinned refuses a tag, exit 1"; else flunk "2 tag not refused (rc=$rc)" "$out"; fi
# The parser must keep up with the REAL file layout (whatever the pin state).
got=$(
  lib "$ROOT"
  gateway_image
)
if [[ $got == docker/mcp-gateway* ]]; then pass "2 static read finds the gateway in the real compose files ($got)"; else flunk "2 real compose files: '$got'"; fi
# Since #421 the real files pin it, so the boot gate passes on this tree.
if (
  lib "$ROOT"
  image_pinned "$got"
); then pass "2 the real compose files' gateway passes the pin gate"; else flunk "2 the real gateway image is not pinned: '$got'"; fi

# The four allow-listed MCP servers each resolve to a digest-pinned catalog
# image, which the images stage pulls on the host.
for srv in context7 fetch neo4j-cypher web_search; do
  img=$(
    lib "$ROOT"
    catalog_image "$srv"
  )
  if (
    lib "$ROOT"
    image_pinned "$img"
  ); then pass "2d catalog image for $srv is pinned ($img)"; else flunk "2d catalog image for $srv: '$img'"; fi
done

# The gateway's management tools: only an explicit "disabled" passes, because
# the gateway's default when the key or the file is missing is ON (#422).
mkdir -p "$tmproot/dt/.git"
for case in 'disabled|{"features":{"dynamic-tools":"disabled"}}|0' \
  'enabled|{"features":{"dynamic-tools":"enabled"}}|1' \
  'no key|{"features":{}}|1' 'no features|{}|1' 'missing file||1' 'not json|{oops|1'; do
  IFS='|' read -r label json want <<<"$case"
  rm -f "$tmproot/dt/docker-config.json"
  [[ $label == "missing file" ]] || printf '%s\n' "$json" >"$tmproot/dt/docker-config.json"
  out=$(
    lib "$tmproot/dt"
    assert_dynamic_tools_off 2>&1
  )
  rc=$?
  if ((want == 0 ? rc == 0 : rc == 1)); then pass "2c dynamic-tools $label -> exit $rc"; else flunk "2c dynamic-tools $label (rc=$rc)" "$out"; fi
done

# 2b's static scan runs before the --clones-only exit, above.
out=$(
  set -o pipefail
  lib "$tmproot/m"
  matches 'needle' "$(seq 1 200000; echo needle)" && echo FOUND
)
if [[ $out == FOUND ]]; then pass "2b matches() finds a match at the end of a large input under pipefail"; else flunk "2b matches()" "$out"; fi

# ------------------------------------------------------------ 3. env stage
# A generator that fails must stop the run, not leave an empty value that the
# next run would then report as "kept".
mkdir -p "$tmproot/e0" "$tmproot/nossl"
cp "$ROOT/.env.production.example" "$tmproot/e0/.env.production.example"
printf '#!/bin/sh\nexit 1\n' >"$tmproot/nossl/openssl"
chmod +x "$tmproot/nossl/openssl"
out=$(
  PATH="$tmproot/nossl:$PATH"
  lib "$tmproot/e0"
  stage_env 2>&1
)
rc=$?
if ((rc == 1)) && [[ $out == *"could not generate POSTGRES_PASSWORD"* ]] &&
  grep -qx "POSTGRES_PASSWORD=''" "$tmproot/e0/.env"; then
  pass "3 a failed generator refuses (exit 1) and writes nothing"
else flunk "3 failed generator (rc=$rc)" "$out"; fi

mkdir -p "$tmproot/e"
cp "$ROOT/.env.production.example" "$tmproot/e/.env.production.example"
out1=$(
  lib "$tmproot/e"
  stage_env 2>&1
)
rc=$?
envf="$tmproot/e/.env"
if ((rc == 0)) && [[ -f $envf ]]; then pass "3 env stage creates .env"; else flunk "3 env stage rc=$rc" "$out1"; fi
mode=$(stat -c %a "$envf")
if [[ $mode == 600 ]]; then pass "3 .env is mode 600"; else flunk "3 .env mode is $mode"; fi
leaked=0
for k in POSTGRES_PASSWORD NEO4J_PASSWORD AUTH_SESSION_SECRET TOKEN_ENCRYPTION_KEY DATA_ENCRYPTION_KEY; do
  v=$(sed -n "s/^$k='\(.*\)'$/\1/p" "$envf")
  if [[ -z $v ]]; then flunk "3 $k was not generated"; fi
  [[ -n $v && $out1 == *"$v"* ]] && leaked=1
done
if ((leaked)); then flunk "3 a generated secret appears in the output"; else pass "3 no generated secret is printed"; fi
for k in POSTGRES_PASSWORD NEO4J_PASSWORD; do
  v=$(sed -n "s/^$k='\(.*\)'$/\1/p" "$envf")
  if [[ $v =~ ^[0-9a-f]{48}$ ]]; then pass "3 $k is URL-safe hex"; else flunk "3 $k shape: ${#v} chars"; fi
done
if [[ $out1 == *"ANTHROPIC_API_KEY"* && $out1 == *"VITE_ALLOWED_EMAILS"* && $out1 == *"ESCROW"* ]]; then
  pass "3 lists the owner's values and asks for the escrow"
else flunk "3 owner list or escrow prompt missing" "$out1"; fi
before=$(sha256sum "$envf")
out2=$(
  lib "$tmproot/e"
  stage_env 2>&1
)
if [[ "$(sha256sum "$envf")" == "$before" ]]; then pass "3 a re-run changes nothing"; else flunk "3 re-run rewrote .env"; fi
if [[ $out2 == *"kept existing DATA_ENCRYPTION_KEY"* ]]; then pass "3 a re-run keeps DATA_ENCRYPTION_KEY"; else flunk "3 re-run did not keep the key" "$out2"; fi
# An existing .env someone loosened is put back to 600, not left readable.
chmod 644 "$envf"
(
  lib "$tmproot/e"
  stage_env >/dev/null 2>&1
)
mode=$(stat -c %a "$envf")
if [[ $mode == 600 ]]; then pass "3 a loosened .env is put back to mode 600"; else flunk "3 a loosened .env stays $mode"; fi

# ------------------------------------------------------------ 4. env_set
mkdir -p "$tmproot/s"
printf "A='1'\n# B='commented'\n" >"$tmproot/s/.env"
(
  lib "$tmproot/s"
  # shellcheck disable=SC2016 # the $ and \t are the point: written literally
  env_set B 'p&q|r/s\t$x'
  env_set A 'two'
)
if grep -qxF "B='p&q|r/s\\t\$x'" "$tmproot/s/.env" && grep -qx "A='two'" "$tmproot/s/.env" &&
  [[ $(grep -c '^A=' "$tmproot/s/.env") == 1 ]]; then
  pass "4 env_set writes literally and replaces in place"
else flunk "4 env_set result" "$(cat "$tmproot/s/.env")"; fi
got=$(
  lib "$tmproot/s"
  env_get B
)
# shellcheck disable=SC2016 # literal comparison, as above
if [[ $got == 'p&q|r/s\t$x' ]]; then pass "4 env_get round-trips"; else flunk "4 env_get: '$got'"; fi
out=$(
  lib "$tmproot/s"
  env_set C "it's" 2>&1
)
rc=$?
if ((rc == 1)) && ! grep -q '^C=' "$tmproot/s/.env"; then pass "4 a single quote is refused, nothing written"; else flunk "4 quote accepted (rc=$rc)" "$out"; fi

# ------------------------------------------- 5. owner_missing / env_problems
good="$tmproot/c/.env"
mkdir -p "$tmproot/c"
cat >"$good" <<'ENV'
COMPOSE_FILE=docker-compose.yaml:docker-compose.prod.yaml
COMPOSE_PROFILES=app
APP_DOMAIN='staging.example.invalid'
POSTGRES_PASSWORD='00'
NEO4J_PASSWORD='00'
AZURE_TENANT_ID='t'
AZURE_CLIENT_ID='c'
AZURE_CLIENT_SECRET='s'
AUTH_SESSION_SECRET='a'
TOKEN_ENCRYPTION_KEY='b'
DATA_ENCRYPTION_KEY='d'
VITE_ALLOWED_EMAILS='a@contoso.com'
ANTHROPIC_API_KEY='k'
STASH_DIRECT_REDIS='1'
ACME_EMAIL='ops@contoso.com'
ENV
probs=$(
  lib "$tmproot/c"
  env_problems
  owner_missing
)
if [[ -z $probs ]]; then pass "5 a complete .env has no problems"; else flunk "5 complete .env flagged" "$probs"; fi
expect_problem() { # LABEL EDIT-COMMAND… — apply the edit to a copy, expect output
  local label=$1
  shift
  cp "$good" "$tmproot/c/.env.bak"
  "$@"
  local p
  p=$(
    lib "$tmproot/c"
    env_problems
    owner_missing
  )
  mv "$tmproot/c/.env.bak" "$good"
  if [[ -n $p ]]; then pass "5 flags: $label"; else flunk "5 not flagged: $label"; fi
}
# expect_problem_like LABEL PATTERN EDIT-COMMAND… — as expect_problem, but the output
# must carry a line matching PATTERN: a bare "something was flagged" is also true
# when the edit names a setting that does not exist and a different rule fires.
expect_problem_like() {
  local label=$1 pattern=$2
  shift 2
  cp "$good" "$tmproot/c/.env.bak"
  "$@"
  local p
  p=$(
    lib "$tmproot/c"
    env_problems
    owner_missing
  )
  mv "$tmproot/c/.env.bak" "$good"
  if grep -qE "$pattern" <<<"$p"; then pass "5 flags: $label"; else flunk "5 not flagged as /$pattern/: $label"; fi
}
expect_problem "placeholder allow-list" sed -i "s/^VITE_ALLOWED_EMAILS=.*/VITE_ALLOWED_EMAILS='*@contoso.com'/" "$good"
expect_problem "empty DATA_ENCRYPTION_KEY" sed -i "s/^DATA_ENCRYPTION_KEY=.*/DATA_ENCRYPTION_KEY=''/" "$good"
expect_problem "missing ANTHROPIC_API_KEY line" sed -i "/^ANTHROPIC_API_KEY=/d" "$good"
expect_problem "example.com left in" sed -i "s/^APP_DOMAIN=.*/APP_DOMAIN='preview.example.com'/" "$good"
expect_problem_like "two of five private-tier values" 'private tier: 2 of' bash -c "printf \"LARGE_LLM_BASE_URL='https://h/v1'\nLARGE_LLM_API_KEY='k'\n\" >>'$good'"
# A COMPLETE five-value set, so the partial-tier rule cannot fire and the /v1 rule is the only one left.
expect_problem_like "endpoint without /v1, tier otherwise complete" '^LARGE_LLM_BASE_URL must end in /v1$' bash -c "printf \"LARGE_LLM_BASE_URL='https://h'\nLARGE_LLM_API_KEY='k'\nSMALL_LLM_BASE_URL='https://s/v1'\nSMALL_LLM_DECISIONS_URL='https://s/v1/systemone'\nSMALL_LLM_API_KEY='k'\n\" >>'$good'"
# The 27B endpoint and its key are one deployment: a half-migrated pair is NOT five of five.
expect_problem_like "new large endpoint with an old key" 'private tier: 4 of' bash -c "printf \"LARGE_LLM_BASE_URL='https://h/v1'\nVERDA_INFERENCE_API_KEY='k'\nSMALL_LLM_BASE_URL='https://s/v1'\nSMALL_LLM_DECISIONS_URL='https://s/v1/systemone'\nSMALL_LLM_API_KEY='k'\n\" >>'$good'"
expect_problem_like "old large endpoint with a new key" 'private tier: 4 of' bash -c "printf \"VERDA_INFERENCE_ENDPOINT='https://h/v1'\nLARGE_LLM_API_KEY='k'\nSMALL_LLM_BASE_URL='https://s/v1'\nSMALL_LLM_DECISIONS_URL='https://s/v1/systemone'\nSMALL_LLM_API_KEY='k'\n\" >>'$good'"
expect_problem "VITE_DEV_BYPASS_AUTH present" bash -c "echo \"VITE_DEV_BYPASS_AUTH='false'\" >>'$good'"
expect_problem "STASH_DIRECT_REDIS unset" sed -i "/^STASH_DIRECT_REDIS=/d" "$good"
expect_problem "laptop compose file" sed -i "s/^COMPOSE_FILE=.*/COMPOSE_FILE=docker-compose.yaml/" "$good"
expect_problem "URL-unsafe POSTGRES_PASSWORD (@)" sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD='a@b'|" "$good"
expect_problem "URL-unsafe POSTGRES_PASSWORD (/)" sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD='a/b'|" "$good"

# ------------------------------------------------------------ 6. escrow
mkdir -p "$tmproot/x/state"
key="escrow-test-key-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
printf "AUTH_SESSION_SECRET='a'\nTOKEN_ENCRYPTION_KEY='b'\nDATA_ENCRYPTION_KEY='%s'\n" "$key" >"$tmproot/x/.env"
out=$(
  lib "$tmproot/x"
  escrow_recorded || echo NONE
  printf '%s %s\n' "now" "$(keys_fingerprint)" >"$ESCROW_MARKER"
  escrow_recorded && echo RECORDED
  sed -i "s/^DATA_ENCRYPTION_KEY=.*/DATA_ENCRYPTION_KEY='rotated'/" "$ENV_FILE"
  escrow_recorded || echo STALE
)
if [[ $out == *NONE*RECORDED*STALE* ]]; then pass "6 an attestation covers the current keys only"; else flunk "6 escrow" "$out"; fi
if grep -q "$key" "$tmproot/x/state/keys-escrowed"; then flunk "6 the marker contains a key"; else pass "6 the marker holds a hash, not a key"; fi

# --------------------------------------------- 7. authorized_keys_problem
mkdir -p "$tmproot/home/.ssh"
chmod 700 "$tmproot/home" "$tmproot/home/.ssh"
ak="$tmproot/home/.ssh/authorized_keys"
me=$(id -un)
akp() {
  lib "$tmproot/k"
  authorized_keys_problem "$ak" "$me"
}
: >"$ak"
if [[ -n "$(akp)" ]]; then pass "7 an empty authorized_keys is a problem"; else flunk "7 empty file accepted"; fi
echo "not a key" >"$ak"
if [[ -n "$(akp)" ]]; then pass "7 a file with no valid key is a problem"; else flunk "7 garbage accepted"; fi
ssh-keygen -q -t ed25519 -N '' -f "$tmproot/id" >/dev/null
cp "$tmproot/id.pub" "$ak"
chmod 600 "$ak"
got=$(akp)
if [[ -z $got ]]; then pass "7 one valid key, strict modes: no problem"; else flunk "7 valid key rejected" "$got"; fi
chmod 664 "$ak"
if [[ "$(akp)" == *writable* ]]; then pass "7 a group-writable file is a problem"; else flunk "7 group-writable accepted"; fi
chmod 600 "$ak"

# The checkpoint: a lockout-capable change stops the run (exit 3) with the
# new-login test; no change, no stop.
out=$(
  lib "$tmproot/k"
  LOCKOUT_CHANGED=1
  checkpoint_lockout
  echo "NOT STOPPED"
)
rc=$?
if ((rc == 3)) && [[ $out == *"NEW KEY LOGIN OK"* && $out != *"NOT STOPPED"* ]]; then
  pass "7 a lockout-capable change stops the run with the new-login test (exit 3)"
else flunk "7 checkpoint (rc=$rc)" "$out"; fi
out=$(
  lib "$tmproot/k"
  checkpoint_lockout
  echo "CONTINUED"
)
if [[ $out == CONTINUED ]]; then pass "7 no change, no checkpoint"; else flunk "7 checkpoint fired without a change" "$out"; fi

# --------------------------------------------- 7b. SSH port move, jail, edge
# portcase PORT VERIFIED — print: ports | closes_22? | Port lines | jail port
portcase() {
  lib "$tmproot/k"
  SSH_PORT=$1 SSH_PORT_VERIFIED=$2
  printf '%s|' "$(desired_ssh_ports)"
  if closes_22; then printf 'close22|'; else printf 'keep22|'; fi
  printf '%s|' "$(sshd_dropin_content | grep '^Port ' | tr '\n' ',')"
  f2b_jail_content | sed -n 's/^port *= *//p'
}
want() { # LABEL GOT EXPECTED
  if [[ $2 == "$3" ]]; then pass "$1"; else flunk "$1" "got:  $2"$'\n'"want: $3"; fi
}
want "7b default: 22 only, no Port line, jail on ssh" "$(portcase 22 0)" "22|keep22||ssh"
want "7b move, run A: 22 AND the new port everywhere" "$(portcase 50022 0)" "22 50022|keep22|Port 22,Port 50022,|22,50022"
want "7b move, run B: the new port only; 22 closes" "$(portcase 50022 1)" "50022|close22|Port 50022,|50022"
jail=$(
  lib "$tmproot/k"
  SSH_PORT=22 SSH_PORT_VERIFIED=0
  f2b_jail_content
)
for kv in "maxretry = 3" "findtime = 5m" "bantime  = 30m" "enabled  = true"; do
  if grep -qxF "$kv" <<<"$jail"; then pass "7b jail.local: $kv (the baseline value)"; else flunk "7b jail.local lacks '$kv'" "$jail"; fi
done
edge=$(
  lib "$tmproot/k"
  SSH_PORT=50022 SSH_PORT_VERIFIED=0
  edge_firewall_rules
)
if [[ $edge == *"0  Accept  TCP  state: established"* && $edge == *"destination port 22 "* &&
  $edge == *"destination port 50022"* && $edge == *"destination port 443"* &&
  "$(grep -E '^ +[0-9]+ ' <<<"$edge" | tail -n1)" == *"Deny    everything else"* ]]; then
  pass "7b edge rules: established first, both SSH ports during a move, deny last"
else flunk "7b edge rules" "$edge"; fi

# --------------------------------------------- 8. arguments and preflight
expect_exit() { # CODE LABEL ARGS…
  local want=$1 label=$2 rc
  shift 2
  out=$(bash "$SCRIPT" "$@" 2>&1)
  rc=$?
  if ((rc == want)); then pass "8 $label (exit $rc)"; else flunk "8 $label: exit $rc, want $want" "$out"; fi
}
expect_exit 2 "no arguments" --dry-run
expect_exit 2 "an IP is not a hostname" --hostname 203.0.113.7 --acme-email ops@example.invalid --dry-run
expect_exit 2 "a bare label is not a hostname" --hostname staging --acme-email ops@example.invalid --dry-run
expect_exit 2 "not an email" --hostname staging.example.invalid --acme-email nobody --dry-run
expect_exit 2 "unknown stage" --hostname staging.example.invalid --acme-email ops@example.invalid --only nope
expect_exit 2 "an SSH port outside the dynamic range" --hostname staging.example.invalid --acme-email ops@example.invalid --ssh-port 2222 --dry-run
expect_exit 2 "--ssh-port-verified without --ssh-port" --hostname staging.example.invalid --acme-email ops@example.invalid --ssh-port-verified --dry-run
out=$(SHIM_ARCH=aarch64 bash "$SCRIPT" --hostname staging.example.invalid --acme-email ops@example.invalid --only preflight 2>&1)
rc=$?
if ((rc == 1)) && [[ $out == *"REFUSED: architecture is aarch64"* ]]; then pass "8 aarch64 is refused (exit 1)"; else flunk "8 aarch64 (rc=$rc)" "$out"; fi
# A full dry run on a FRESH box (no checkout, no Docker) must reach the end.
# Under `set -e` a probe that fails inside `x=$(…)` ends the run with no
# message; that shipped once here (exit 2 in the images stage).
out=$(HAMES_APP_DIR="$tmproot/fresh" HAMES_STATE_DIR="$tmproot/fresh-state" \
  bash "$SCRIPT" --hostname staging.example.invalid --acme-email ops@example.invalid --dry-run 2>&1)
rc=$?
if ((rc == 0)) && [[ $out == *"Dry run complete: nothing was changed."* && ! -e $tmproot/fresh ]]; then
  pass "8 a fresh-box dry run reaches the end (exit 0) and creates nothing"
else flunk "8 fresh-box dry run (rc=$rc)" "$(tail -15 <<<"$out")"; fi
for n in staging.example.invalid ops@example.com x.test a.example b.localhost; do
  (
    lib "$tmproot/r"
    reserved_name "$n"
  ) && r=0 || r=1
  if ((r == 0)); then pass "8 reserved: $n"; else flunk "8 not reserved: $n"; fi
done
for n in staging.hames.contoso.com vps-1a2b3c4d.fabrikam.com; do
  (
    lib "$tmproot/r"
    reserved_name "$n"
  ) && r=0 || r=1
  if ((r == 0)); then flunk "8 wrongly reserved: $n"; else pass "8 not reserved: $n"; fi
done

# ------------------------------------------- 9. review round: S1, L1, C1, C2
# S1: --keys-escrowed on the run that GENERATES the keys records nothing.
mkdir -p "$tmproot/s1"
cp "$ROOT/.env.production.example" "$tmproot/s1/.env.production.example"
out=$(
  lib "$tmproot/s1"
  KEYS_ESCROWED=1
  stage_env 2>&1
  escrow_recorded && echo "BOOT WOULD PASS"
)
if [[ $out == *"--keys-escrowed IGNORED"* && $out != *"BOOT WOULD PASS"* && ! -e $tmproot/s1/state/keys-escrowed ]]; then
  pass "9 S1: --keys-escrowed on the generating run records nothing"
else flunk "9 S1: same-run escrow was recorded" "$out"; fi
out=$(
  lib "$tmproot/s1"
  KEYS_ESCROWED=1
  stage_env 2>&1
  escrow_recorded && echo "RECORDED"
)
if [[ $out == *RECORDED* && -e $tmproot/s1/state/keys-escrowed ]]; then
  pass "9 S1: --keys-escrowed on a later run records the escrow"
else flunk "9 S1: a later run's escrow was not recorded" "$out"; fi
out=$(
  lib "$tmproot/e0b"
  DRY_RUN=1 KEYS_ESCROWED=1 KEYS_GENERATED=1
  escrow_recorded && echo PASSES
)
if [[ $out != *PASSES* ]]; then pass "9 S1: a dry run does not pretend same-run keys are escrowed"; else flunk "9 S1: dry-run escrow"; fi

# L1: the jail never bans the operator's address.
jail_ignore() { # SSH_CONNECTION F2B_IGNORE
  (
    lib "$tmproot/k"
    SSH_CONNECTION=$1 F2B_IGNORE=$2
    unset SSH_CLIENT
    f2b_jail_content | sed -n 's/^ignoreip = //p'
  )
}
want "9 L1 ignoreip: this session's client address" "$(jail_ignore '198.51.100.4 51234 203.0.113.7 22' '')" "127.0.0.1/8 ::1 198.51.100.4"
want "9 L1 ignoreip: an IPv6 session" "$(jail_ignore '2001:db8::5 51234 2001:db8::1 22' '')" "127.0.0.1/8 ::1 2001:db8::5"
want "9 L1 ignoreip: --f2b-ignore wins" "$(jail_ignore '198.51.100.4 51234 203.0.113.7 22' '192.0.2.0/24,198.51.100.9')" "127.0.0.1/8 ::1 192.0.2.0/24 198.51.100.9"
want "9 L1 ignoreip: --f2b-ignore none" "$(jail_ignore '198.51.100.4 51234 203.0.113.7 22' none)" "127.0.0.1/8 ::1"
want "9 L1 ignoreip: no session, no flag" "$(jail_ignore '' '')" "127.0.0.1/8 ::1"
want "9 L1 ignoreip: a garbage SSH_CONNECTION is not written" "$(jail_ignore $'198.51.100.4\nX 1 2 3' '')" "127.0.0.1/8 ::1"
expect_exit 2 "--f2b-ignore rejects a non-address" --hostname staging.example.invalid --acme-email ops@example.invalid --f2b-ignore '1.2.3.4,evil' --dry-run

# C1: a real run that checks out the repo needs the reviewed commit's full SHA.
sha40=$(printf 'a%.0s' $(seq 1 40))
expect_exit 2 "C1: a real run without --ref" --hostname staging.example.invalid --acme-email ops@example.invalid --only checkout
expect_exit 2 "C1: a branch name is not a --ref" --hostname staging.example.invalid --acme-email ops@example.invalid --ref origin/main --dry-run
expect_exit 2 "C1: a short SHA is not a --ref" --hostname staging.example.invalid --acme-email ops@example.invalid --ref "${sha40:0:12}" --dry-run
out=$(HAMES_APP_DIR="$tmproot/c1" HAMES_STATE_DIR="$tmproot/c1s" bash "$SCRIPT" --hostname staging.example.invalid \
  --acme-email ops@example.invalid --ref "$sha40" --only checkout --dry-run 2>&1)
rc=$?
if ((rc == 0)) && [[ $out == *"at $sha40"* ]]; then pass "9 C1: a full SHA is accepted (exit 0)"; else flunk "9 C1: full SHA (rc=$rc)" "$out"; fi

# C2: exactly ONE primary key, and it is Docker's.
docker_pub='pub:-:4096:1:8D81803C0EBFCD88:1487788586:::-:::scESA::::::23::0:
fpr:::::::::9DC858229FC7DD38854AE2D88D81803C0EBFCD88:
uid:-::::1487792064::B5A08F01796E7F521861B449372D1FF271F2DD50::Docker Release (CE deb) <docker@docker.com>::::::::::0:
sub:-:4096:1:7EA0A9C3F273FCD8:1487788586::::::s::::::23:
fpr:::::::::D3306A018370199E527AE7317EA0A9C3F273FCD8:'
extra_pub='pub:-:255:22:0123456789ABCDEF:1700000000:::-:::scESC::::::23::0:
fpr:::::::::0000000000000000000000000000000000000000:'
c2() { # LABEL ok|bad COLONS
  local got
  got=$(
    lib "$tmproot/k"
    docker_key_problem "$3"
  )
  if [[ ($2 == ok && -z $got) || ($2 == bad && -n $got) ]]; then pass "9 C2: $1"; else flunk "9 C2: $1" "$got"; fi
}
c2 "Docker's key alone" ok "$docker_pub"
c2 "Docker's key plus an appended key" bad "$docker_pub"$'\n'"$extra_pub"
c2 "an appended key first" bad "$extra_pub"$'\n'"$docker_pub"
c2 "another key alone" bad "$extra_pub"
c2 "no key at all" bad ""

# ------------------------------- 10. the anti-lockout orchestration
# The ssh and firewall stages and main's checkpoint, run for real against a
# fake box: every assertion is about what was CALLED, and in which order.
ssh-keygen -q -t ed25519 -N '' -f "$tmproot/op" >/dev/null
box() { # NAME — a fresh fake box; exports FAKEROOT, FAKEHOME, CALLLOG
  local b="$tmproot/box-$1"
  rm -rf "$b"
  mkdir -p "$b/etc/ssh/sshd_config.d" "$b/etc/default" "$b/home/.ssh"
  chmod 755 "$b" "$b/home"
  chmod 700 "$b/home/.ssh"
  echo 'Include /etc/ssh/sshd_config.d/*.conf' >"$b/etc/ssh/sshd_config"
  echo 'PasswordAuthentication yes' >"$b/etc/ssh/sshd_config.d/50-cloud-init.conf"
  echo 'IPV6=yes' >"$b/etc/default/ufw"
  install -m 600 "$tmproot/op.pub" "$b/home/.ssh/authorized_keys"
  : >"$b/calls.log"
  export FAKEROOT="$b" FAKEHOME="$b/home" CALLLOG="$b/calls.log"
}
dropin() { echo "$FAKEROOT/etc/ssh/sshd_config.d/00-hames-hardening.conf"; }
stages() { # ARGS… — run the real script; sets $out and $rc
  out=$(HAMES_STATE_DIR="$FAKEROOT/state" bash "$SCRIPT" --hostname staging.example.invalid \
    --acme-email ops@example.invalid "$@" 2>&1)
  rc=$?
}
called() { grep -qF -- "$1" "$CALLLOG"; }
# before A B — the first call matching A comes before the first matching B
before() {
  local a b
  a=$(grep -nF -- "$1" "$CALLLOG" | head -n1 | cut -d: -f1)
  b=$(grep -nF -- "$2" "$CALLLOG" | head -n1 | cut -d: -f1)
  [[ -n $a && -n $b ]] && ((a < b))
}
not_reloaded() { ! grep -qE 'systemctl .*(reload|restart)' "$CALLLOG"; }
not_called() { ! grep -qF -- "$1" "$CALLLOG"; }
not_in_out() { ! grep -qF -- "$1" <<<"$out"; }
t() { # LABEL CONDITION… — pass if the command succeeds
  local label=$1
  shift
  if "$@"; then pass "10 $label"; else flunk "10 $label (rc=$rc)" "$(tail -6 <<<"$out")"$'\n'"calls: $(tr '\n' ';' <"$CALLLOG")"; fi
}

# R1 the key precondition: no usable key, nothing written, nothing reloaded.
box r1
: >"$FAKEHOME/.ssh/authorized_keys"
stages --only ssh
t "R1 no usable key: refused (exit 1)" test "$rc" -eq 1
t "R1 ... and no drop-in was written" test ! -e "$(dropin)"
t "R1 ... and sshd was not reloaded" not_reloaded

# R2 the sshd -t gate: a config sshd rejects is undone before any reload.
box r2
SHIM_SSHD_T_FAIL=1 stages --only ssh
t "R2 sshd -t fails: refused (exit 1)" test "$rc" -eq 1
t "R2 ... the new drop-in is removed" test ! -e "$(dropin)"
t "R2 ... and sshd was not reloaded" not_reloaded
box r2b
printf 'PasswordAuthentication no\n# the previous good one\n' >"$(dropin)"
SHIM_SSHD_T_FAIL=1 stages --only ssh --ssh-port 50022
t "R2 a previous drop-in is restored byte for byte" test "$(cat "$(dropin)")" = $'PasswordAuthentication no\n# the previous good one'

# R3 the effective-config readback: another file that wins is caught.
box r3
echo 'PasswordAuthentication yes' >"$FAKEROOT/etc/ssh/sshd_config.d/00-aaa-override.conf"
stages --only ssh
t "R3 an overriding file: refused (exit 1)" test "$rc" -eq 1
t "R3 ... naming the effective config" grep -q "effective config" <<<"$out"
t "R3 ... and sshd was not reloaded" not_reloaded

# R4 the readback before ufw enable: a rule that did not stick stops it.
box r4
SHIM_UFW_DROP=22/tcp stages --only firewall
t "R4 'allow 22/tcp' not recorded: refused (exit 1)" test "$rc" -eq 1
t "R4 ... and ufw was never enabled" not_called "ufw --force enable"
box r4b
stages --only firewall
t "R4 normal run: 22 allowed before ufw is enabled" before "ufw allow 22/tcp" "ufw --force enable"

# R5 the close-22 guard: 22 closes only once nothing listens on it.
box r5
printf 'Port 50022\n' >"$(dropin)"
mkdir -p "$FAKEROOT/ufw"
printf 'ufw allow 22/tcp\nufw allow 50022/tcp\n' >"$FAKEROOT/ufw/added"
touch "$FAKEROOT/ufw/active"
SHIM_SS_EXTRA=22 stages --only firewall --ssh-port 50022 --ssh-port-verified
t "R5 something on 22: refused (exit 1)" test "$rc" -eq 1
t "R5 ... and 22 was not deleted" not_called "ufw delete"
: >"$CALLLOG"
stages --only firewall --ssh-port 50022 --ssh-port-verified
t "R5 nothing on 22: 22 is deleted, then the checkpoint (exit 3)" test "$rc" -eq 3
t "R5 ... after the new port is allowed" before "ufw allow 50022/tcp" "ufw delete allow 22/tcp"

# R6 the checkpoint call site in main: nothing runs past a lockout change.
box r6
stages --only ssh,fail2ban
t "R6 ssh changed: exit 3 at the checkpoint" test "$rc" -eq 3
t "R6 ... fail2ban never ran" not_in_out "5/13 fail2ban"
box r6b
stages --only ssh,firewall,fail2ban
t "R6 ssh then firewall: the firewall still runs" grep -q "4/13 firewall" <<<"$out"
t "R6 ... one checkpoint, then exit 3" test "$rc-$(grep -c 'ANTI-LOCKOUT CHECKPOINT' <<<"$out")" = "3-1"
t "R6 ... fail2ban never ran" not_in_out "5/13 fail2ban"
stages --only ssh,firewall
t "R6 re-run with nothing to change: exit 0" test "$rc" -eq 0
t "R6 the ssh stage: sshd -t before the reload" before "/sshd -t" "systemctl try-reload-or-restart ssh.service"

# The port move, run A: the firewall opens P before the socket moves.
box mv
stages --only ssh --ssh-port 50022
t "move run A: exit 3 at the checkpoint" test "$rc" -eq 3
t "move run A: ufw allows 50022 before ssh.socket restarts" before "ufw allow 50022/tcp" "systemctl restart ssh.socket"
t "move run A: the drop-in listens on 22 AND 50022" test "$(grep '^Port' "$(dropin)" | tr '\n' ' ')" = "Port 22 Port 50022 "
SHIM_NO_GENERATOR=1 stages --only ssh --ssh-port 50111
t "move: no regenerated socket -> refused, previous drop-in kept" test "$rc-$(grep '^Port' "$(dropin)" | tr '\n' ' ')" = "1-Port 22 Port 50022 "

# L3: an unreadable CURRENT config is named as such, and nothing is written.
box l3
SHIM_SSHD_TT_FAIL=1 stages --only ssh
t "L3 sshd -T fails: refused with sshd's own error" grep -q "cannot read the CURRENT configuration.*Bad configuration option" <<<"$out"
t "L3 ... and no drop-in was written" test ! -e "$(dropin)"

# F2B the jail.local ownership guard: a jail.local this script did not write is
# an operator's own, refused and left byte for byte; one it wrote is its own,
# and a re-run proceeds over it rather than refusing every later run.
jail() { echo "$FAKEROOT/etc/fail2ban/jail.local"; }
box f2b
mkdir -p "$FAKEROOT/etc/fail2ban"
printf '[sshd]\nenabled = true\nmaxretry = 7\n# the operator'"'"'s own tuning\n' >"$(jail)"
before=$(sha256sum <"$(jail)")
stages --only fail2ban --no-prompt
t "F2B a jail.local it did not write: refused (exit 1)" test "$rc" -eq 1
t "F2B ... and left byte for byte" test "$(sha256sum <"$(jail)")" = "$before"
box f2b-own
stages --only fail2ban --no-prompt
t "F2B a first run writes its own jail.local (exit 0)" test "$rc-$(head -n1 "$(jail)")" = "0-# Managed by scripts/bootstrap-vps.sh, with the hardening baseline's [sshd]"
stages --only fail2ban --no-prompt
t "F2B a re-run over its own jail.local proceeds, file unchanged (exit 0)" grep -q "unchanged /etc/fail2ban/jail.local" <<<"$out"
t "F2B ... and exits 0" test "$rc" -eq 0
unset FAKEROOT FAKEHOME CALLLOG

# R7 the rendered-exposure gate, and its call in boot.
cat >"$tmproot/compose-clean.json" <<'JSON'
{"services": {
  "postgres": {"ports": [{"host_ip": "127.0.0.1", "published": "5432", "target": 5432}]},
  "mcp-gateway": {"image": "docker/mcp-gateway@sha256:abb58d13e267939e602118c0be88be31e2ebcea4c762980ff647ee2aeba92cde",
                  "command": ["--servers=neo4j-cypher,fetch,web_search,context7"],
                  "ports": [{"host_ip": "127.0.0.1", "published": "8811", "target": 8811}]},
  "caddy": {"ports": [{"published": "80", "target": 80}, {"published": "443", "target": 443}, {"published": "443", "target": 443, "protocol": "udp"}]}
}}
JSON
exposure() { # JSON-FILE — what rendered_exposure prints for it
  (
    mkdir -p "$tmproot/r7"
    lib "$tmproot/r7"
    SHIM_COMPOSE_JSON=$1 rendered_exposure
  )
}
variant() { python3 -c 'import json,sys; c=json.load(open(sys.argv[1])); exec(sys.argv[2]); json.dump(c, open(sys.argv[3], "w"))' "$tmproot/compose-clean.json" "$1" "$2"; }
want "10 R7 the clean render exposes nothing" "$(exposure "$tmproot/compose-clean.json")" ""
variant 'c["services"]["postgres"]["ports"][0]["host_ip"] = ""' "$tmproot/c-pg.json"
want "10 R7 postgres on 0.0.0.0 is flagged" "$(exposure "$tmproot/c-pg.json")" "postgres publishes 5432 on '0.0.0.0'"
variant 'c["services"]["mcp-gateway"]["command"] = ["--enable-all-servers"]' "$tmproot/c-gw.json"
want "10 R7 an un-allow-listed gateway is flagged" "$(exposure "$tmproot/c-gw.json")" "mcp-gateway is not allow-listed with --servers= (the overlay did not apply)"
variant 'c["services"]["caddy"]["ports"].append({"published": "8080", "target": 8080})' "$tmproot/c-caddy.json"
want "10 R7 an extra Caddy port is flagged" "$(exposure "$tmproot/c-caddy.json")" "caddy publishes 8080, not only 80/443"
mkdir -p "$tmproot/r7b/.git"
cp "$good" "$tmproot/r7b/.env"
printf '{"features":{"dynamic-tools":"disabled"}}\n' >"$tmproot/r7b/docker-config.json"
mkdir -p "$tmproot/r7b/configs"
: >"$tmproot/r7b/configs/mcp-config.yaml"
out=$(
  lib "$tmproot/r7b"
  DRY_RUN=1 HOSTNAME_ARG=staging.hames.contoso.com ACME_EMAIL_ARG=ops@contoso.com
  SHIM_COMPOSE_JSON="$tmproot/c-pg.json" stage_boot 2>&1
)
t "R7 boot refuses an exposed render" grep -q "WOULD REFUSE: the rendered compose config exposes more than Caddy: postgres" <<<"$out"

# R8 the volume guard: a volume that exists keeps the secret it was made with.
for vk in hames_pg16_glibc_data:POSTGRES_PASSWORD hames_pg16_glibc_data:DATA_ENCRYPTION_KEY hames_postgres_data:POSTGRES_PASSWORD hames_postgres_data:DATA_ENCRYPTION_KEY hames_neo4j_data:NEO4J_PASSWORD; do
  vol=${vk%%:*} key=${vk#*:}
  mkdir -p "$tmproot/r8"
  cp "$good" "$tmproot/r8/.env.production.example"
  sed "s/^$key=.*/$key=''/" "$good" >"$tmproot/r8/.env"
  out=$(
    lib "$tmproot/r8"
    SHIM_COMPOSE=1 SHIM_VOLUMES=$vol stage_env 2>&1
  )
  rc=$?
  if ((rc == 1)) && [[ $out == *"volume $vol exists but $key is empty"* ]] && grep -qx "$key=''" "$tmproot/r8/.env"; then
    pass "10 R8 $vol exists, $key empty: refused, nothing generated"
  else flunk "10 R8 $vol / $key (rc=$rc)" "$(tail -4 <<<"$out")"; fi
done
out=$(
  lib "$tmproot/r8"
  SHIM_COMPOSE=1 SHIM_VOLUME_LS_FAIL=1 stage_env 2>&1
)
rc=$?
if ((rc == 1)) && [[ $out == *"cannot list Docker volumes"* ]]; then pass "10 R8 an unreachable daemon fails closed"; else flunk "10 R8 daemon down (rc=$rc)" "$(tail -3 <<<"$out")"; fi

echo
if ((failures)); then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all checks passed"
