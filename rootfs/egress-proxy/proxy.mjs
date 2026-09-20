#!/usr/bin/env node
/**
 * egress-proxy — allowlist CONNECT proxy for the sandbox egress profiles (#116).
 *
 * Runs INSIDE a gateway container (the same kg-sandbox image the sandboxes
 * use — it only needs Node), on the sandbox-facing internal-only docker
 * network. The sandboxes of a proxied profile (`pypi`, `github-trusted`) sit
 * on that same network with `HTTPS_PROXY`/`HTTP_PROXY` pointed at this
 * process, and the network itself has no external route — so a client that
 * ignores the proxy vars has no path out at all. That topology is what makes
 * the allowlist below ENFORCED rather than advisory (see
 * app/src/lib/sandbox/egress-policy.ts).
 *
 * Surface:
 *   - HTTPS CONNECT tunneling, filtered by destination host against the
 *     allowlist. No TLS interception (no certs, no plaintext): the tunnel is
 *     opaque bytes end-to-end.
 *   - Plain-HTTP proxy requests are DENIED (405) — uv/pip/git/curl all speak
 *     HTTPS, and supporting absolute-URI forwarding would widen the surface
 *     for nothing. Fail closed.
 *   - Every request — allowed and denied — is written to stdout as one JSON
 *     audit line, so `docker logs kg-sandbox-egress-<profile>-<sandbox-id>-gw`
 *     is the outbound audit trail. The gateway is PER BOOT (multi-user
 *     isolation, docs/plan/sandbox.md → channel 2): one audit trail names
 *     exactly one sandbox's outbound traffic.
 *
 * Host matching: exact, or a subdomain of an entry (`githubusercontent.com`
 * admits `objects.githubusercontent.com`). Case-insensitive; trailing dots
 * and IPv6 brackets are normalized away first.
 *
 * Zero dependencies (node:http + node:net), mirroring mcp-shell.
 *
 * CLI:  node egress-proxy/proxy.mjs --port 3128 --host pypi.org --host files.pythonhosted.org
 */

import http from "node:http";
import net from "node:net";
import { pathToFileURL } from "node:url";

/** True when `hostname` is allowed by `allowlist` (exact or dot-suffix match). */
export function hostAllowed(hostname, allowlist) {
  if (typeof hostname !== "string" || hostname.length === 0) return false;
  const host = hostname
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.$/, "");
  return allowlist.some((entry) => {
    const e = String(entry).toLowerCase();
    return host === e || host.endsWith("." + e);
  });
}

/** Parse `--port N` (once) and `--host H` (repeatable) CLI args. */
export function parseArgs(argv) {
  const hosts = [];
  let port = 3128;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port") {
      port = Number(argv[i + 1]) || port;
      i++;
    } else if (argv[i] === "--host") {
      const host = String(argv[i + 1] ?? "").trim();
      if (host) hosts.push(host);
      i++;
    }
  }
  return { hosts, port };
}

/**
 * Build the proxy server. `onAudit` receives one record per request (both
 * verdicts); the CLI wires it to stdout, tests wire it to an array.
 */
export function createProxyServer(
  allowlist,
  { onAudit = (_record) => {} } = {},
) {
  const server = http.createServer((req, res) => {
    // Plain-HTTP proxying (absolute-URI GET/POST) is denied by design.
    onAudit({
      kind: "http",
      method: req.method,
      host: req.headers.host ?? "",
      allowed: false,
    });
    res.writeHead(405, { "content-type": "text/plain" });
    res.end(
      "egress-proxy: only HTTPS CONNECT is permitted; plain-HTTP egress is denied\n",
    );
  });

  server.on("connect", (req, clientSocket, head) => {
    const target = req.url ?? "";
    const colon = target.lastIndexOf(":");
    const host = colon === -1 ? target : target.slice(0, colon);
    const port = colon === -1 ? 443 : Number(target.slice(colon + 1)) || 443;
    const allowed = hostAllowed(host, allowlist);
    onAudit({ kind: "CONNECT", host, port, allowed });
    if (!allowed) {
      clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = net.connect(port, host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    const fail = () => {
      clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      upstream.destroy();
    };
    upstream.on("error", fail);
    clientSocket.on("error", () => upstream.destroy());
  });

  return server;
}

// CLI entry — only when run directly (not when imported by the test suite).
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { hosts, port } = parseArgs(process.argv.slice(2));
  if (hosts.length === 0) {
    console.error(
      "egress-proxy: no --host entries — refusing to start with an empty allowlist",
    );
    process.exit(64);
  }
  const server = createProxyServer(hosts, {
    onAudit: (record) => console.log(JSON.stringify(record)),
  });
  server.listen(port, "0.0.0.0", () => {
    console.log(JSON.stringify({ kind: "listening", port, allowlist: hosts }));
  });
}
