/**
 * MCP gateway health — Server Only (#276)
 *
 * One question, asked in two places: **is the gateway's tool surface there?**
 * `mcp-client.server.ts` answers it (it is the only module that talks to the
 * gateway), and the tool loops ask it before they run.
 *
 * ## The failure this exists for
 *
 * A gateway read degrades on purpose. `listTools()` logs and returns the
 * app-side tools; `getGraphSchema()` warns and returns `''`. Both are the right
 * call on their own — one dead transport must not take a turn down — but
 * together they produced something worse than an outage: a turn that answered
 * as if healthy. With the gateway refusing connections, `Tools()` yields a
 * ToolSet with no `neo4j` and no `web` key, every agent turns that into
 * `tools.neo4j ?? []`, and a `simpleLoop` runs with an empty tool list. It
 * cannot call anything, so it returns nothing, and the `compactExecution` at
 * the end of the chain composes a confident answer out of an empty execution.
 * The row is `done`. Nothing anywhere says a word about the gateway. The
 * app-path e2e suite measured exactly this and wrote it down (scenario 6's
 * header, "WHICH FAULT, AND WHY NOT THE GATEWAY") as the reason it injected a
 * different fault — a documented silent failure, which is why #276 is not a
 * theory.
 *
 * `[]` on its own is not the signal: the two sandbox agents pass `[]` to
 * `actorCritic` deliberately, because their tools come from the VM over
 * `docker exec` rather than from the gateway. The signal is an empty list
 * *while the gateway is known to be unreachable*, which is why this module
 * exists rather than a length check at each call site.
 *
 * ## What it is not
 *
 * It is not a monitor and it polls nothing. The state is a record of the last
 * gateway read this process performed, and only `listTools` writes it — a
 * failing `callTool` does not, deliberately: a tool that fails mid-loop is
 * ordinary (the controller sees the error and decides what to do, and the e2e
 * suite pins that a failing tool is not a failing conversation), while a tool
 * CATALOG that cannot be fetched means no tool can be chosen at all. Widening
 * the writer set to `callTool` would let one flaky call refuse the next loop's
 * tools; if that ever looks worth doing, it needs a failure count and a
 * decision about how many is enough, not a boolean.
 *
 * ## Recovery, and the honest limits of it
 *
 * In-process recovery lives in `listTools`: on failure it rebuilds the whole
 * connection pool and tries once more, so a stale keep-alive on any of the four
 * pooled connections cannot outlive one call (the per-lease reconnect only
 * heals the connection it was holding). Anything past that is the gateway's own
 * problem, and this app can do less about it than it looks:
 *
 *   - **`docker restart` is reachable but wrong from here.** The app does hold
 *     a docker socket in both shapes it runs in (the `docker` CLI on a dev
 *     host, `/var/run/docker.sock` mounted into the app container for the
 *     sandbox), so it COULD restart the gateway container. It should not do it
 *     from a turn: the gateway is shared by every user, so one degraded
 *     conversation would tear down every other conversation's in-flight tool
 *     calls; the socket is root-equivalent on the host and is mounted for the
 *     sandbox alone, so spending it on service lifecycle widens what a
 *     compromised app process can reach (SD-19); and the container has no
 *     `container_name` in `docker-compose.yaml`, so a hook would have to
 *     discover it through compose labels, which is a deployment coupling this
 *     module has no business holding.
 *   - **It is mostly redundant anyway.** The service is declared
 *     `restart: unless-stopped`, so Docker already restarts a gateway that
 *     exits. The case a restart hook would add is a gateway that is up and
 *     wedged — real, but rarer than the one Docker covers, and an owner call
 *     rather than an inference from this file.
 *   - **It is not always the app's container to restart.** `MCP_GATEWAY_URL`
 *     may name a gateway in another network or another host; there is nothing
 *     to restart there.
 *
 * So the app recovers its own connections, reports the outage to the person
 * waiting, and leaves the container to Docker and the operator.
 */

import { assertServerOnImport } from './assert.server'

assertServerOnImport()

/** What is known about an unreachable gateway. */
export interface GatewayDegradation {
  /** `Date.now()` of the first failed read in this degraded stretch. */
  since: number
  /** The last failure's message, verbatim — it names the cause (refused
   *  connection, bad URL, TLS) that a "tools unavailable" line cannot. */
  error: string
}

/**
 * Module-level, not on a `globalThis` symbol. The pool this shadows
 * (`mcp-client.server.ts`) is module-level too, so under an HMR reload both are
 * replaced together and the fresh state ("not known to be degraded") matches
 * the fresh pool ("no connections yet"). Parking one on a global and not the
 * other is what would desynchronise them.
 */
let degradation: GatewayDegradation | null = null

/** The gateway answered. Clears any recorded outage and logs the recovery
 *  once, so the log shows a stretch rather than a single line about failing. */
export function markGatewayReachable(): void {
  if (!degradation) return
  const seconds = Math.round((Date.now() - degradation.since) / 1000)
  console.log(`[mcp-health] gateway tool surface is back after ~${seconds}s`)
  degradation = null
}

/** The gateway could not be read. Keeps the FIRST failure's timestamp, so
 *  `since` measures the outage rather than the latest attempt. */
export function markGatewayUnreachable(error: string): void {
  degradation = { since: degradation?.since ?? Date.now(), error }
}

/** The current outage, or null when the last gateway read succeeded (or when
 *  this process has not made one yet — "not known to be degraded" is not the
 *  same as "known healthy", and no caller may read it as the latter). */
export function gatewayDegradation(): GatewayDegradation | null {
  return degradation
}

/** Test-only reset of the recorded state. */
export function __resetGatewayHealth(): void {
  degradation = null
}

/**
 * Why this pattern's tool list is empty, phrased for the person waiting — or
 * null when there is nothing wrong (the list is non-empty, or it is empty for
 * a reason that has nothing to do with the gateway).
 *
 * Both halves of the condition matter and neither is sufficient: an empty list
 * with a healthy gateway is a deliberately tool-less pattern, and a degraded
 * gateway with a non-empty list is a pattern whose tools came from somewhere
 * else (an app-side tool, a sandbox) and which can still do its job.
 */
export function toolSurfaceOutage(tools: string[]): { error: string; hint: string } | null {
  if (tools.length > 0) return null
  const outage = degradation
  if (!outage) return null
  const seconds = Math.round((Date.now() - outage.since) / 1000)
  return {
    error:
      'Tools unavailable: the MCP gateway could not be reached, so this step has no tools to ' +
      `call (unreachable for ~${seconds}s; last error: ${outage.error}).`,
    hint:
      'The gateway is down or misconfigured — check the mcp-gateway service and MCP_GATEWAY_URL. ' +
      'Retry once it answers; nothing about the question needs changing.',
  }
}
