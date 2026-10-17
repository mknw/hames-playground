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
import subprocess
import sys
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
from urllib.parse import urlsplit


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


def network():
    neo, relay = container("neo4j"), container("neo4j-relay")
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
    require(not any(c.get("Gateway") for c in net["IPAM"]["Config"]), "isolated network has a gateway")
    require(set(net["Containers"]) == {neo["Id"], relay["Id"]}, "unexpected internal network members")
    relay_nets = relay["NetworkSettings"]["Networks"]
    require(name in relay_nets and len(relay_nets) == 2, "relay network topology changed")
    bridge = net["Options"].get("com.docker.network.bridge.name", "br-" + net["Id"][:12])
    addresses = document("ip", "-j", "-4", "addr", "show", "dev", bridge)
    require(len(addresses) == 1 and not addresses[0]["addr_info"], "isolated bridge has a host IPv4 address")
    routes = checked("docker", "exec", neo["Id"], "cat", "/proc/net/route").splitlines()
    require(bool(routes) and routes[0].split()[:3] == ["Iface", "Destination", "Gateway"],
            "unreadable Neo4j routes")
    for row in routes[1:]:
        fields = row.split()
        require(len(fields) >= 3 and fields[1] != "00000000" and fields[2] == "00000000",
                "Neo4j has a default route or gateway")
    return neo, next(n for n in relay_nets if n != name)


TCP_CONTROL = """const s=require('node:net').connect(+process.argv[2],process.argv[1]);
s.setTimeout(3000);s.on('connect',()=>{s.destroy();process.exit(0)});
s.on('timeout',()=>{s.destroy();process.exit(1)});s.on('error',()=>process.exit(1));"""
TCP_NEGATIVE = 'timeout 3 bash -c \'exec 3<>/dev/tcp/$1/$2\' _ "$1" "$2"'
NETWORK_ERROR = re.compile(r"Connection refused|Network is unreachable|No route to host|timed out", re.I)


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
    # Use the installed cypher-shell but explicitly dial the relay, never the
    # container's localhost. The container-owned password stays in its env.
    result = checked("docker", "compose", "exec", "-T", "neo4j", "sh", "-c",
                     'NEO4J_PASSWORD="${NEO4J_AUTH#*/}" cypher-shell -a bolt://neo4j-relay:7687 '
                     '-u neo4j --format plain "RETURN 432 AS bootstrap_relay"')
    require(result.splitlines() == ["bootstrap_relay", "432"], "relay Cypher round trip failed")


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


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
        require(response.status == 200, "private health did not return 200")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group(required=True)
    for mode in ("daemon", "network", "egress", "relay", "private-health"):
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
    except Exception as error:
        # Only our fixed labels are safe to print. Library errors may carry
        # a URL, bearer value or Docker-inspect content.
        print("FAIL " + (str(error) if isinstance(error, Refused) else "probe unavailable or inconclusive"))
        return 1
    print("PASS requested deployment check")
    return 0


if __name__ == "__main__":
    sys.exit(main())
