/**
 * The tools withheld from every agent, and the one predicate that asks.
 *
 * Its own module, with no imports, for two reasons: the catalog
 * (`mcp-client.server.ts`) and the loops (`patterns/simpleLoop.server.ts`,
 * `patterns/actorCritic.server.ts`) all read it, and tests that stub the MCP
 * client must not stub this along with it — a stubbed predicate would make
 * every loop's refusal untested.
 *
 * Placement is an open follow-up, due before the next release: the review of
 * #434 recommends moving the
 * NAMES into the host's catalog (`@hames-ai/connectors/mcp-catalog.ts`) and
 * registering them at boot, beside `registerToolNamespaces`, with this
 * mechanism staying in core.
 */

/** Why a tool is withheld from every agent, and the switch that keeps the
 *  gateway from serving it in the first place. The catalog's drop warning
 *  (`mcp-client.server.ts`) quotes both, once per withholding. */
export interface Withholding {
  /** The owner decision, as the clause after "because". */
  readonly because: string
  /** What an operator does so the gateway stops listing the tool. */
  readonly serverSide: string
}

/** Owner decision, 2026-10-03 (#403, #206): agents are READ-ONLY against Neo4j,
 *  the `general` agent included. The one writer is the memory hook (#419), and
 *  it writes through the app, not through an agent's tool list. The deployment
 *  ships `read_only: true` for `neo4j-cypher` in `configs/mcp-config.yaml`,
 *  under which the pinned `mcp-neo4j-cypher` 0.5.0 does not list the tool. */
const NEO4J_READ_ONLY: Withholding = {
  because: 'agents are read-only against Neo4j (#403)',
  serverSide:
    'To withhold the tool at the server as well, set `read_only: true` for `neo4j-cypher` in ' +
    'the config the gateway reads, and restart the gateway on it.',
}

/** Owner decision, 2026-10-03 (#412): running agents get no Postgres access.
 *  The `database-server` catalog server ran SQL against whatever
 *  `DATABASE_URL` the gateway handed it, which in this deployment was the
 *  app's own database: every user's conversations, sessions and stored tokens.
 *  It is gone from `configs/custom-catalog.yaml` and the gateway config, and
 *  the gateway no longer receives a Postgres credential. The app's own
 *  Postgres access is its repositories over the `pg` driver, never an agent's
 *  tool list. Names from the server's entry in the upstream Docker MCP catalog
 *  at the pinned image (`souhardyak/mcp-db-server`, `configs/catalog.yaml`),
 *  which lists `execute_sql` as well as the six the deployment's catalog
 *  named. */
const NO_POSTGRES: Withholding = {
  because: 'agents get no Postgres access (#412)',
  serverSide:
    'To stop the gateway serving them, remove `database-server` from the catalog it is ' +
    'started with (`--catalog`) and from its config, then recreate the gateway.',
}

/** Every withheld name, with the decision that withholds it. */
const WITHHOLDINGS: ReadonlyMap<string, Withholding> = new Map([
  ['write_neo4j_cypher', NEO4J_READ_ONLY],
  ['query_database', NO_POSTGRES],
  ['execute_sql', NO_POSTGRES],
  ['list_tables', NO_POSTGRES],
  ['describe_table', NO_POSTGRES],
  ['connect_to_database', NO_POSTGRES],
  ['get_connection_examples', NO_POSTGRES],
  ['get_current_database_info', NO_POSTGRES],
])

/**
 * Catalog-server tools no agent may hold, whatever the gateway lists and
 * whatever a loop's allowlist names: `write_neo4j_cypher` (#403) and the
 * `database-server` tools (#412). Each name's reason and server-side switch
 * are in {@link withholdingFor}.
 *
 * Enforced in two places, both through {@link isAgentWithheldTool}:
 *   - the CATALOG: `listTools` drops these names, so `Tools()`, every
 *     `tools.*` list, the planner's catalog and the controllers' catalog never
 *     carry them;
 *   - every LOOP's allowlist check (`simpleLoop`, `actorCritic`, singular and
 *     batched calls alike) refuses them, so a hand-written allowlist, a
 *     `dynamicToolAllowlist` or a `dynamicToolPattern` cannot hand one back.
 * Deliberately NOT `callTool`: this decides what an agent may call, not what
 * the app may, and the hook's write path is the app's.
 *
 * A list, not a single name, so another surface agents must not hold is one
 * entry here rather than a second mechanism.
 *
 * The deployment withholds every tool here at the gateway as well (each
 * entry's `serverSide`). This list is the second layer, the same shape as the
 * gateway management-tool list in `mcp-client.server.ts`: it holds when a
 * host's config or catalog says otherwise, or when a server bump changes what
 * it lists.
 */
export const AGENT_WITHHELD_TOOLS: ReadonlySet<string> = new Set(WITHHOLDINGS.keys())

/**
 * Why `name` is withheld, or `undefined` when it is not one of
 * {@link AGENT_WITHHELD_TOOLS}.
 *
 * Two prefixes must not hand a tool back, so both are seen through:
 *   - the gateway's `mcp__<server>__<tool>`, split as `inferServer` splits it;
 *   - a server's own namespace, `<namespace>-<tool>`: `mcp-neo4j-cypher`
 *     registers its tools that way when `NEO4J_NAMESPACE` is set, which is the
 *     shape a second, namespaced Neo4j server would arrive in.
 */
export function withholdingFor(name: string): Withholding | undefined {
  const at = name.lastIndexOf('__')
  const bare = at >= 0 ? name.slice(at + 2) : name
  const exact = WITHHOLDINGS.get(bare)
  if (exact) return exact
  for (const [withheld, why] of WITHHOLDINGS) {
    if (bare.endsWith(`-${withheld}`)) return why
  }
  return undefined
}

/**
 * Is `name` one of {@link AGENT_WITHHELD_TOOLS}? The one predicate the catalog
 * and every loop's allowlist check ask; it sees through the same two prefixes
 * as {@link withholdingFor}.
 */
export function isAgentWithheldTool(name: string): boolean {
  return withholdingFor(name) !== undefined
}
