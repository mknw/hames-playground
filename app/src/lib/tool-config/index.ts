/**
 * Tool Configuration Module
 *
 * Per-conversation tool allowlist for the code-mode agent, plus the Neo4j-
 * backed CodedTool repository.
 */

// Server-only RPC functions (each rewritten to a fetch by SolidStart)
export {
  getCodeModeAllowedTools,
  setCodeModeAllowedTools,
  getAvailableTools,
} from "./config.server";

// Server-only: real-server-name catalog (factory scoping) + master-catalog
// search preview. getPresetTools/serverForTool are also imported server-side
// by the code-mode agent.
export {
  getServerCatalog,
  getPresetTools,
  serverForTool,
  searchMasterCatalog,
} from "./server-catalog.server";

// Pure data + types — must come from a non-"use server" module so the
// client sees real arrays and not RPC stubs (see ToolsPanel hallucination
// log on this branch's PR thread).
export {
  getMinimalTools,
  MINIMAL_TOOLS,
  CODE_MODE_DEFAULTS,
  CODE_MODE_PRESET_SERVERS,
  type ExecutionMode,
  type CatalogMode,
  type CodeModeToolsState,
  type CatalogServer,
  type CatalogTool,
} from "./constants";

// Repository exports
export {
  fetchCodedTools,
  fetchCodedToolsForPlanner,
  saveCodedToolServer,
  deleteCodedToolServer,
  type CodedTool,
  type CodedToolReference,
  type SaveCodedToolInput,
} from "./repository.server";
