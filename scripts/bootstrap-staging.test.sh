#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
#
# Pins the parts of scripts/bootstrap-staging.sh that decide whether a staging
# box is safe, WITHOUT a VPS, a Docker daemon or root: the script is sourced
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
#
# Linux only (GNU stat, as on the VPS and in CI).
# Run: scripts/bootstrap-staging.test.sh   (no arguments, exits 0 on green)

set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SCRIPT="$ROOT/scripts/bootstrap-staging.sh"

if [[ "$(uname -s)" != Linux ]]; then
  echo "bootstrap-staging.test.sh needs Linux (GNU stat); CI runs it on ubuntu-latest" >&2
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
mkdir -p "$tmproot/bin"
cat >"$tmproot/bin/sudo" <<'SHIM'
#!/usr/bin/env bash
# Runs the command as the caller: the test never needs root.
[[ ${1:-} == -n ]] && shift
exec "$@"
SHIM
cat >"$tmproot/bin/docker" <<'SHIM'
#!/usr/bin/env bash
# No daemon and no compose: `have_compose` is false, so the static paths run.
exit 1
SHIM
cat >"$tmproot/bin/uname" <<'SHIM'
#!/usr/bin/env bash
if [[ ${1:-} == -m ]]; then echo "${SHIM_ARCH:-x86_64}"; else exec /usr/bin/uname "$@"; fi
SHIM
chmod +x "$tmproot/bin/"*
export PATH="$tmproot/bin:$PATH"

# lib DIR — a subshell prelude: the script's functions, pointed at DIR. The
# globals set at the end are read by those functions, not here.
# shellcheck disable=SC2034
lib() {
  export HAMES_APP_DIR="$1" HAMES_STATE_DIR="$1/state" HAMES_BOOTSTRAP_SOURCED=1
  # shellcheck source=bootstrap-staging.sh
  . "$SCRIPT"
  DRY_RUN=0 INTERACTIVE=0 KEYS_ESCROWED=0 LOCKOUT_CHANGED=0 NO_SEED=0 SSH_PORT=22 SSH_PORT_VERIFIED=0
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
  if [[ $2 == "$3" ]]; then pass "7b $1"; else flunk "7b $1" "got:  $2"$'\n'"want: $3"; fi
}
want "default: 22 only, no Port line, jail on ssh" "$(portcase 22 0)" "22|keep22||ssh"
want "move, run A: 22 AND the new port everywhere" "$(portcase 50022 0)" "22 50022|keep22|Port 22,Port 50022,|22,50022"
want "move, run B: the new port only; 22 closes" "$(portcase 50022 1)" "50022|close22|Port 50022,|50022"
jail=$(
  lib "$tmproot/k"
  SSH_PORT=22 SSH_PORT_VERIFIED=0
  f2b_jail_content
)
for kv in "maxretry = 3" "findtime = 5m" "bantime  = 30m" "enabled  = true"; do
  if grep -qxF "$kv" <<<"$jail"; then pass "7b jail.local: $kv (the provider's value)"; else flunk "7b jail.local lacks '$kv'" "$jail"; fi
done
edge=$(
  lib "$tmproot/k"
  SSH_PORT=50022 SSH_PORT_VERIFIED=0
  edge_firewall_rules
)
if [[ $edge == *"0  Accept  TCP  state: established"* && $edge == *"destination port 22 "* &&
  $edge == *"destination port 50022"* && $edge == *"destination port 443"* && $edge == *"19 Deny"* ]]; then
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
expect_exit 2 "an SSH port outside the provider's range" --hostname staging.example.invalid --acme-email ops@example.invalid --ssh-port 2222 --dry-run
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
for n in staging.hames.contoso.com vps-1a2b3c4d.vps.ovh.net; do
  (
    lib "$tmproot/r"
    reserved_name "$n"
  ) && r=0 || r=1
  if ((r == 0)); then flunk "8 wrongly reserved: $n"; else pass "8 not reserved: $n"; fi
done

echo
if ((failures)); then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all checks passed"
