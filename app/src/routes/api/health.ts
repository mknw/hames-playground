/**
 * GET /api/health — liveness probe for the container healthcheck (#197).
 *
 * Deliberately a *liveness* check, not a readiness one: it answers "is this
 * process up and serving HTTP", and nothing else. It does not touch Postgres,
 * Neo4j, Redis or the MCP gateway on purpose — a dependency blip would then
 * mark the app unhealthy and (with `restart: unless-stopped`) restart a process
 * that is perfectly fine, turning one service's hiccup into an outage of ours.
 * Dependency state is what `docker compose ps` on those services already shows.
 *
 * Unauthenticated by design — the healthcheck runs before any session exists,
 * and the payload carries nothing an anonymous caller could not already learn
 * from the fact that the port answers.
 */

export function GET() {
  return new Response(
    JSON.stringify({
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}
