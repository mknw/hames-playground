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
SCRIPT="$ROOT/scripts/bootstrap-vps.sh"

if [[ "$(uname -s)" != Linux ]]; then
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
exec "$@"
SHIM
cat >"$tmproot/bin/docker" <<'SHIM'
#!/usr/bin/env bash
# No daemon. Unless a case sets SHIM_COMPOSE_JSON (a rendered config) or
# SHIM_COMPOSE=1, `have_compose` is false, so the static paths run.
args=" $* "
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

# The five allow-listed MCP servers each resolve to a digest-pinned catalog
# image, which the images stage pulls on the host.
for srv in context7 fetch memory neo4j-cypher web_search; do
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

# Never `producer | grep -q` under pipefail: grep -q exits at its first match,
# the producer dies of SIGPIPE and the pipeline reads as failed, i.e. a FOUND
# match is reported as absent. That shipped once here (the sshd -T check
# refused every box). Comments are exempt.
# One pipe, not the `||` of an or-list.
hits=$(grep -nE '(^|[^|])\|[[:space:]]*grep[[:space:]]+-[A-Za-z]*q' "$SCRIPT" | grep -vE '^[0-9]+:[[:space:]]*#' || true)
if [[ -z $hits ]]; then pass "2b no 'producer | grep -q' pipeline in the script"; else flunk "2b SIGPIPE-prone pipeline" "$hits"; fi
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
expect_problem "placeholder allow-list" sed -i "s/^VITE_ALLOWED_EMAILS=.*/VITE_ALLOWED_EMAILS='*@contoso.com'/" "$good"
expect_problem "empty DATA_ENCRYPTION_KEY" sed -i "s/^DATA_ENCRYPTION_KEY=.*/DATA_ENCRYPTION_KEY=''/" "$good"
expect_problem "missing ANTHROPIC_API_KEY line" sed -i "/^ANTHROPIC_API_KEY=/d" "$good"
expect_problem "example.com left in" sed -i "s/^APP_DOMAIN=.*/APP_DOMAIN='preview.example.com'/" "$good"
expect_problem "two of three private-tier values" bash -c "printf \"VERDA_INFERENCE_ENDPOINT='https://h/v1'\nVERDA_INFERENCE_API_KEY='k'\n\" >>'$good'"
expect_problem "endpoint without /v1" bash -c "printf \"VERDA_INFERENCE_ENDPOINT='https://h'\nVERDA_INFERENCE_API_KEY='k'\nSMALL_LLM_BASE_URL='https://s/v1'\n\" >>'$good'"
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
                  "command": ["--servers=neo4j-cypher,fetch,web_search,context7,memory"],
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
