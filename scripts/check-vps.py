#!/usr/bin/env python3
"""Read-only checks of the EXISTING local deployment; never creates services.

Called by bootstrap-vps.sh via sudo in the pinned checkout, with its Compose
files/profile. No provider request occurs unless --private-health is explicit.
All diagnostics are labels only: never emit Docker inspect, env, URLs or errors
which may contain credentials. Unit tests inject the command and HTTP seams.
"""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import ssl
import subprocess
import sys
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
from urllib.parse import unquote, urlsplit


class Refused(Exception):
    pass


def require(condition, label):
    if not condition:
        raise Refused(label)


def command(*args):
    return subprocess.run(args, capture_output=True, text=True, timeout=20, check=False)


def checked(*args):
    result = command(*args)
    require(result.returncode == 0, "command unavailable or failed (inconclusive)")
    return result.stdout.strip()


def document(*args):
    return json.loads(checked(*args))


def container(service):
    ids = checked("docker", "compose", "ps", "-q", service).splitlines()
    require(len(ids) == 1 and bool(ids[0]), "expected one running " + service)
    return document("docker", "inspect", ids[0])[0]


def daemon():
    path = Path("/etc/docker/daemon.json")
    config = json.loads(path.read_text()) if path.exists() else {}
    require(isinstance(config, dict), "daemon.json must be a JSON object")
    for key in ("iptables", "ip6tables"):
        require(key not in config or config[key] is True, key + " must remain enabled")
    for key in ("allow-direct-routing", "ip-forward-no-drop"):
        require(key not in config or config[key] is False, key + " must remain disabled")
    # This deployment's Engine >=28 baseline uses the iptables backend.
    require(config.get("firewall-backend", "iptables") == "iptables", "unverified firewall backend")
    bridge = config.get("default-network-opts", {}).get("bridge", {})
    for family in ("ipv4", "ipv6"):
        require(bridge.get("com.docker.network.bridge.gateway_mode_" + family, "nat") == "nat",
                "default bridge gateway mode must remain nat")
    require(not bridge.get("com.docker.network.bridge.trusted_host_interfaces"),
            "default bridge direct routing must remain disabled")
    pids = checked("pidof", "dockerd").split()
    require(len(pids) == 1 and pids[0].isdigit(), "running Docker daemon is inconclusive")
    args = Path("/proc/" + pids[0] + "/cmdline").read_bytes().decode().rstrip("\0").split("\0")
    require(bool(args[0]), "unreadable Docker daemon command line")
    for i, arg in enumerate(args[1:], 1):
        flag = arg.split("=", 1)[0]
        require(flag not in {"--iptables", "--ip6tables", "--allow-direct-routing", "--ip-forward-no-drop",
                             "--firewall-backend", "--default-network-opt"},
                "unverified Docker daemon command-line isolation override")
        if flag == "--config-file":
            value = arg.split("=", 1)[1] if "=" in arg else args[i + 1] if i + 1 < len(args) else ""
            require(value == "/etc/docker/daemon.json", "non-default Docker daemon configuration file")


def network():
    neo, relay = container("neo4j"), container("neo4j-relay")
    require(neo["HostConfig"]["Privileged"] is False and
            not {"NET_ADMIN", "NET_RAW"}.intersection(neo["HostConfig"].get("CapAdd") or []),
            "Neo4j has unsafe network privileges")
    nets = neo["NetworkSettings"]["Networks"]
    require(len(nets) == 1, "Neo4j must join only neo4j-internal")
    name, attachment = next(iter(nets.items()))
    net = document("docker", "network", "inspect", attachment["NetworkID"])[0]
    labels = net.get("Labels", {})
    require(labels.get("com.docker.compose.network") == "neo4j-internal" and
            labels.get("com.docker.compose.project") == neo["Config"]["Labels"]["com.docker.compose.project"],
            "unexpected Neo4j network owner")
    require(net["Driver"] == "bridge" and net["Scope"] == "local" and net["Internal"] is True
            and net["EnableIPv6"] is False, "Neo4j network must be internal IPv4 bridge")
    require(net["Options"].get("com.docker.network.bridge.gateway_mode_ipv4") == "isolated",
            "Neo4j bridge must use isolated gateway mode")
    require(set(net["Options"]) <= {"com.docker.network.bridge.gateway_mode_ipv4", "com.docker.network.bridge.name"},
            "unverified Neo4j bridge options")
    require(not any(c.get("Gateway") for c in net["IPAM"]["Config"]), "isolated network has a gateway")
    require(set(net["Containers"]) == {neo["Id"], relay["Id"]}, "unexpected internal network members")
    relay_nets = relay["NetworkSettings"]["Networks"]
    require(name in relay_nets and len(relay_nets) == 2, "relay network topology changed")
    app_net = next(n for n in relay_nets if n != name)
    app_labels = document("docker", "network", "inspect", relay_nets[app_net]["NetworkID"])[0].get("Labels", {})
    require(app_labels.get("com.docker.compose.network") == "app-network" and
            app_labels.get("com.docker.compose.project") == labels["com.docker.compose.project"],
            "unexpected relay app network owner")
    bridge = net["Options"].get("com.docker.network.bridge.name", "br-" + net["Id"][:12])
    addresses = document("ip", "-j", "-4", "addr", "show", "dev", bridge)
    require(not any(a.get("family") == "inet" for i in addresses for a in i.get("addr_info", [])),
            "isolated bridge has a host IPv4 address")
    routes = checked("docker", "exec", neo["Id"], "cat", "/proc/net/route").splitlines()
    require(bool(routes) and routes[0].split()[:3] == ["Iface", "Destination", "Gateway"],
            "unreadable Neo4j routes")
    for row in routes[1:]:
        fields = row.split()
        require(len(fields) >= 3 and fields[1] != "00000000" and fields[2] == "00000000",
                "Neo4j has a default route or gateway")
    return neo, app_net


TCP_CONTROL = """const s=require('node:net').connect(+process.argv[2],process.argv[1]);
s.setTimeout(3000);s.on('connect',()=>{s.destroy();process.exit(0)});
s.on('timeout',()=>{s.destroy();process.exit(1)});s.on('error',()=>process.exit(1));"""
BOLT_CONTROL = """const s=require('node:net').connect(+process.argv[2],process.argv[1]);
let reply=Buffer.alloc(0);s.setTimeout(3000);
s.on('connect',()=>s.write(Buffer.from('6060b01700000404000000040000000000000000','hex')));
s.on('data',chunk=>{reply=Buffer.concat([reply,chunk]);if(reply.length>=4){
s.destroy();process.exit(reply.length===4&&reply.readUInt32BE(0)!==0?0:1)}});
s.on('end',()=>process.exit(1));s.on('error',()=>process.exit(1));
s.on('timeout',()=>{s.destroy();process.exit(1)});"""
TCP_NEGATIVE = 'timeout 3 bash -c \'exec 3<>/dev/tcp/$1/$2\' _ "$1" "$2"'
NETWORK_ERROR = re.compile(r"Network is unreachable|No route to host|timed out", re.I)


def blocked_tcp(neo, app, address, port):
    # Same literal address and port from both namespaces; a dead destination
    # cannot manufacture evidence of isolation.
    ipaddress.IPv4Address(address)
    checked("docker", "exec", app["Id"], "node", "-e", TCP_CONTROL, address, str(port))
    result = command("docker", "exec", neo["Id"], "bash", "-c", TCP_NEGATIVE, "_", address, str(port))
    require(result.returncode != 0, "EGRESS OPEN: forbidden TCP connection succeeded")
    require(result.returncode == 124 or (result.returncode == 1 and NETWORK_ERROR.search(result.stderr)),
            "inconclusive Neo4j TCP probe")


def egress(ssh_port):
    neo, app_net = network()
    app = container("app")
    checked("docker", "exec", neo["Id"], "bash", "-c", "command -v bash timeout getent >/dev/null")
    # Prove that the negative probe's interpreter/timeout/TCP mechanism works.
    checked("docker", "exec", neo["Id"], "bash", "-c", TCP_NEGATIVE, "_", "127.0.0.1", "7687")
    # Prove embedded DNS works before either absent-name result is accepted.
    checked("docker", "exec", neo["Id"], "getent", "hosts", "neo4j-relay")
    targets = [("1.1.1.1", 443)]  # public TCP, no HTTP or model payload
    for service, port in (("mcp-gateway", 8811), ("redis", 6379), ("postgres", 5432)):
        peer = container(service)
        targets.append((peer["NetworkSettings"]["Networks"][app_net]["IPAddress"], port))
    defaults = document("ip", "-j", "-4", "route", "show", "default")
    require(bool(defaults), "missing host primary route")
    for device in (defaults[0]["dev"], "docker0"):
        interfaces = document("ip", "-j", "-4", "addr", "show", "dev", device)
        addresses = [a["local"] for i in interfaces for a in i["addr_info"] if a["family"] == "inet"]
        require(bool(addresses), "missing host IPv4 target")
        targets.extend((a, ssh_port) for a in addresses)
    alias = command("docker", "exec", neo["Id"], "getent", "ahostsv4", "host.docker.internal")
    require(alias.returncode in (0, 2), "inconclusive host alias lookup")
    if alias.returncode == 0:
        require(bool(alias.stdout.strip()), "empty host alias result")
        targets.extend((line.split()[0], ssh_port) for line in alias.stdout.splitlines())
    for address, port in sorted(set(targets)):
        blocked_tcp(neo, app, address, port)
    checked("docker", "exec", app["Id"], "node", "-e",
            "require('node:dns').lookup('example.com',e=>process.exit(e?1:0))")
    dns = command("docker", "exec", neo["Id"], "getent", "hosts", "example.com")
    require(dns.returncode == 2 and not dns.stdout.strip(), "external DNS open or inconclusive")


def relay():
    app = container("app")
    checked("docker", "exec", app["Id"], "node", "-e", BOLT_CONTROL, "neo4j-relay", "7687")
    # Use the installed cypher-shell but explicitly dial the relay, never the
    # container's localhost. The container-owned password stays in its env.
    result = checked("docker", "compose", "exec", "-T", "neo4j", "sh", "-c",
                     'NEO4J_PASSWORD="${NEO4J_AUTH#*/}" cypher-shell -a bolt://neo4j-relay:7687 '
                     '-u neo4j --access-mode read --format plain "RETURN 432 AS bootstrap_relay"')
    require(result.splitlines() == ["bootstrap_relay", "432"], "relay Cypher round trip failed")


EMBEDDINGS = """(async()=>{
const response=await fetch('http://embedder:8090/v1/embeddings',{
method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
headers:{'Content-Type':'application/json'},
body:JSON.stringify({input:['bootstrap embedder smoke'],model:'Qwen3-Embedding-0.6B'})});
if(response.status!==200)process.exit(1);
const body=await response.json();const vector=body.data?.[0]?.embedding;
if(body.data?.length!==1||!Array.isArray(vector)||vector.length!==1024||
!vector.every(x=>typeof x==='number'&&Number.isFinite(x)))process.exit(1);
})().catch(()=>process.exit(1));"""


def embeddings():
    # The embedder has no published port. Use the installed app's Node from
    # its network namespace; never read a configurable provider URL or key.
    checked("docker", "compose", "exec", "-T", "app", "node", "-e", EMBEDDINGS)


CLONE_DATABASE = """(async()=>{
const {Client}=require('node:module').createRequire('/app/.output/server/index.mjs')('pg');
const url=new URL(process.env.DATABASE_URL);
const other=JSON.parse(process.env.CLONE_OTHER_DATABASES);
if(!Array.isArray(other)||other.length!==2||other.some(name=>typeof name!=='string'||!name))throw Error();
const client=new Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000});
try{await client.connect();
const {rows}=await client.query(`SELECT current_user AS role, current_database() AS database,
NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls) AS limited,
NOT EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname=current_user) AS no_membership,
NOT has_database_privilege(current_user, $1, 'CONNECT') AND
NOT has_database_privilege(current_user, $2, 'CONNECT') AS isolated
FROM pg_roles WHERE rolname = current_user`,other);
if(rows.length!==1||rows[0].role!==decodeURIComponent(url.username)||
rows[0].database!==decodeURIComponent(url.pathname.slice(1))||!rows[0].limited||!rows[0].no_membership||!rows[0].isolated)process.exitCode=1;
}finally{await client.end();}
})().catch(()=>{process.exitCode=1;});"""


SANDBOX_ENDPOINT = ("SANDBOX_DOCKER_HOST", "SANDBOX_DOCKER_TLS_CA", "SANDBOX_DOCKER_TLS_CERT", "SANDBOX_DOCKER_TLS_KEY")
SANDBOX_TLS = ("/run/sandbox-tls/ca.pem", "/run/sandbox-tls/cert.pem", "/run/sandbox-tls/key.pem")


def clones():
    # Config/inspect stay in memory. The TCP login uses the running app's own
    # DATABASE_URL; neither credentials nor SQL results reach stdout or argv.
    config = document("docker", "compose", "config", "--format", "json")
    projects = set()
    for service, namespace in (("app", "release"), ("app-dev", "dev")):
        desired = config["services"][service]["environment"]
        app = container(service)
        actual = dict(value.split("=", 1) for value in app["Config"]["Env"])
        require(app["State"]["Running"] is True and app["State"]["Health"]["Status"] == "healthy",
                "clone app not healthy")
        projects.add(app["Config"]["Labels"]["com.docker.compose.project"])
        for key in ("DATABASE_URL", "SANDBOX_ENVIRONMENT", "SANDBOX_CACHE_VOLUME", "DATA_ENCRYPTION_KEY",
                    "AUTH_SESSION_SECRET", "TOKEN_ENCRYPTION_KEY", "AUTH_REDIRECT_URI", "VITE_DEV_BYPASS_AUTH"):
            require(bool(desired.get(key)) and actual.get(key) == desired[key], "clone runtime differs from validated configuration")
        require(actual["SANDBOX_ENVIRONMENT"] == namespace and not actual.get("POSTGRES_PASSWORD"),
                "clone namespace or administrator credential mismatch")
        for key in SANDBOX_ENDPOINT:
            require(actual.get(key) == desired.get(key), "clone sandbox endpoint differs from validated configuration")
        targets = ("/configs", "/var/run/docker.sock", *SANDBOX_TLS)
        expected_mounts = sorted((v["target"], v["source"], v["type"], not v.get("read_only", False))
                                 for v in config["services"][service].get("volumes", []) if v["target"] in targets)
        actual_mounts = sorted((v["Destination"], v["Source"], v["Type"], v["RW"])
                               for v in app["Mounts"] if v["Destination"] in targets)
        require(actual_mounts == expected_mounts, "clone mounts differ from validated configuration")
        if config.get("x-clone-" + namespace + "-sandbox") == "per-env":
            # The validator pinned a VM clone's render to exactly these mounts;
            # refuse any a recreate outside Compose added, a socket included.
            require(sorted(v["Destination"] for v in app["Mounts"]) ==
                    sorted(v["target"] for v in config["services"][service].get("volumes", [])),
                    "VM clone mounts differ from validated configuration")
            # Its one allowed source to the VM (docs/plan/env-vm-network.md §2.3):
            # the operator's link network, with this app as its sole member.
            link = "envapp-" + namespace
            address = config["services"][service]["networks"][link]["ipv4_address"]
            link_net = document("docker", "network", "inspect", link)[0]
            subnets = [c["Subnet"] for c in link_net["IPAM"]["Config"] if ipaddress.ip_network(c["Subnet"]).version == 4]
            members = link_net["Containers"] or {}
            require(link_net["Options"].get("com.docker.network.bridge.name") == link and
                    link_net["Driver"] == "bridge" and link_net["Internal"] is False and
                    len(subnets) == 1 and ipaddress.ip_address(address) in ipaddress.ip_network(subnets[0]) and
                    list(members) == [app["Id"]] and members[app["Id"]]["IPv4Address"].split("/")[0] == address,
                    "VM clone link network differs from validated configuration")
        if namespace == "dev":
            require(config.get("x-clone-dev-docker-socket") is True or
                    not any(v[0] == "/var/run/docker.sock" for v in actual_mounts), "dev socket requires owner opt-in")
        sibling = "app-dev" if service == "app" else "app"
        other = unquote(urlsplit(config["services"][sibling]["environment"]["DATABASE_URL"]).path.lstrip("/"))
        checked("docker", "exec", "-e", "CLONE_OTHER_DATABASES=" + json.dumps([other, "postgres"]), app["Id"], "node", "-e", CLONE_DATABASE)
    require(len(projects) == 1, "clones must share one compose project")


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def private_health_http_status(status):
    if type(status) is not int or not 100 <= status <= 599:
        return "private health unavailable or inconclusive"
    return "private health HTTP " + str(status) + (" (auth)" if status in (401, 403) else "")


def private_health_failure(error):
    # Never format a library exception: it may include the URL or bearer.
    if isinstance(error, Refused):
        return str(error)
    if isinstance(error, HTTPError):
        return private_health_http_status(error.code)
    reason = error.reason if isinstance(error, URLError) else error
    if isinstance(reason, socket.gaierror):
        return "private health DNS error"
    if isinstance(reason, TimeoutError):
        return "private health timeout"
    if isinstance(reason, ssl.SSLError):
        return "private health TLS error"
    if isinstance(reason, ConnectionRefusedError):
        return "private health connection refused"
    if isinstance(error, URLError) or isinstance(reason, OSError):
        return "private health transport error"
    return "private health unavailable or inconclusive"


def private_health():
    # Off by default in both CLIs. A GET can itself cause a scale-from-zero;
    # this explicit operation is one read, never a completion or retry loop.
    base = os.environ.get("SMALL_LLM_BASE_URL", "")
    key = os.environ.get("SMALL_LLM_API_KEY", "")
    parsed = urlsplit(base)
    try:
        loopback = ipaddress.ip_address(parsed.hostname or "").is_loopback
    except ValueError:
        loopback = parsed.hostname == "localhost"
    parsed.port  # Validate the port before opening a request.
    require((parsed.scheme == "https" or (parsed.scheme == "http" and loopback)) and parsed.hostname and not parsed.username and not parsed.password
            and not parsed.query and not parsed.fragment and parsed.path.endswith("/v1")
            and not any(c.isspace() for c in base), "invalid SMALL_LLM_BASE_URL for health probe")
    require(bool(key) and not any(ord(c) < 32 or ord(c) == 127 for c in key), "missing or invalid small-model key")
    request = Request(base[:-3] + "/health", headers={"Authorization": "Bearer " + key}, method="GET")
    # Ignore proxy env and refuse redirects, so the bearer has one destination.
    with build_opener(NoRedirect(), ProxyHandler({})).open(request, timeout=10) as response:
        require(response.status == 200, private_health_http_status(response.status))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group(required=True)
    for mode in ("daemon", "network", "egress", "relay", "private-health", "embeddings", "clones"):
        modes.add_argument("--" + mode, action="store_true")
    parser.add_argument("--ssh-port", type=int, default=22)
    args = parser.parse_args()
    try:
        require(1 <= args.ssh_port <= 65535, "invalid SSH probe port")
        if args.daemon:
            daemon()
        elif args.network:
            network()
        elif args.egress:
            egress(args.ssh_port)
        elif args.relay:
            relay()
        elif args.private_health:
            private_health()
        elif args.embeddings:
            embeddings()
        elif args.clones:
            clones()
    except Exception as error:
        # Only our fixed labels are safe to print. Library errors may carry
        # a URL, bearer value or Docker-inspect content.
        label = private_health_failure(error) if args.private_health else (
            str(error) if isinstance(error, Refused) else "probe unavailable or inconclusive")
        print("FAIL " + label)
        return 1
    print("PASS requested deployment check")
    return 0


if __name__ == "__main__":
    sys.exit(main())
