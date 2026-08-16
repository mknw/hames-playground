/**
 * Tool-config constants and types — client-safe (no "use server").
 *
 * These live outside `config.server.ts` because the SolidStart server-action
 * transform rewrites every export from a `"use server"` module into an RPC
 * stub on the client. Non-function exports (constants, types) come through
 * as `undefined`-like proxies, which broke `MINIMAL_TOOLS.includes(...)` in
 * `ToolsPanel.tsx`. Putting pure data here keeps the import path stable
 * (`~/lib/tool-config` still re-exports everything) while letting the
 * client see real arrays.
 */

/** Execution mode determines which planning flow to use. Reserved for a
 *  future planner-switch UX; currently the mode Switch is disabled. */
export type ExecutionMode = "static" | "code";

/** Catalog mode determines which tools are available. Reserved; the
 *  toggle is disabled since the kg-agent gateway eagerly loads all servers. */
export type CatalogMode = "minimal" | "global";

/** Snapshot returned to the Tools panel by `getCodeModeAllowedTools`. */
export interface CodeModeToolsState {
  /** User's current per-conversation selection. Falls back to `defaults`
   *  when the conversation has no entry yet (e.g. first turn). */
  allowed: string[];
  /** Live list of every tool the gateway exposes. */
  available: string[];
  /** Meta-tools the actor always needs (`mcp-find`, `mcp-add`, `code-mode`,
   *  `mcp-exec`). UI should render them pre-checked and locked-on. */
  defaults: string[];
  /** Whether this conversation's agent actually composes a code-mode pattern
   *  (the only runtime consumer of the allowlist). When false, the Tools panel
   *  greys out — the selection would have no effect. Auto-detected from the
   *  agent's pattern graph; see `registry.server.ts` `agentUsesCodeMode`. */
  usesCodeMode: boolean;
}

/** Default "starter set" highlighted with a `Core` badge in the UI. */
export function getMinimalTools(): string[] {
  return [
    "read_neo4j_cypher",
    "write_neo4j_cypher",
    "get_neo4j_schema",
    "search",
    "fetch_content",
  ];
}

export const MINIMAL_TOOLS = getMinimalTools();

/** The four meta-tools the code-mode actor cannot function without. Mirrors
 *  CODE_MODE_TOOLS in `harness-client/examples/code-mode.server.ts` — keep
 *  in sync. */
export const CODE_MODE_DEFAULTS = ["mcp-find", "mcp-add", "code-mode", "mcp-exec"];

/** The "default code mode" preset — real gateway server names (the keys in
 *  configs/custom-catalog.yaml, NOT the client `inferServer` namespaces).
 *  When a conversation has no persisted selection, the actor is scoped to
 *  these servers' tools so it can reach Neo4j/web on turn 0 (the failure in
 *  .harness-logs/context-neo4j-vs-memory.json was the default being meta-tools
 *  only, leaving Neo4j invisible). The "Default code mode" Switch applies this
 *  set; everything else is selectable per-conversation in the Tools panel. */
export const CODE_MODE_PRESET_SERVERS = [
  "neo4j-cypher",
  "web_search",
  "fetch",
  "context7",
  "github",
];

/** One tool within a catalog server. */
export interface CatalogTool {
  name: string;
  description?: string;
}

/** A gateway MCP server as the code-mode factory addresses it. `key` is the
 *  REAL server name usable in `code-mode {servers:[key]}` (e.g. `neo4j-cypher`,
 *  `web_search`) — distinct from the client-side `inferServer` namespace. */
export interface CatalogServer {
  key: string;
  title: string;
  tools: CatalogTool[];
  /** Enabled in mcp-config.yaml AND reachable (cross-checked vs listTools). */
  enabled: boolean;
  /** Declares required secrets in the catalog — `mcp-add` will prompt for
   *  them even though the server may already be configured. The factory
   *  (`code-mode {servers}`) works regardless. */
  secretGated: boolean;
  secrets: string[];
}
