/**
 * App-side tools barrel — Server Only.
 *
 * Importing this module registers every built-in app tool as a side effect,
 * then re-exports the registry accessors. `mcp-client.server.ts` and
 * `tools.server.ts` import from here (never from `registry.server.ts`
 * directly) so tool registration can't be skipped by import order.
 *
 * Add new app-side tool modules to the side-effect import list below —
 * e.g. Pattern B (#109) per-user vault tools.
 */
import "./graph.server";

export {
  hasAppTool,
  runAppTool,
  appToolDescriptions,
  appToolNamespace,
  registerAppTool,
  type AppToolDefinition,
  type AppToolContext,
} from "./registry.server";
