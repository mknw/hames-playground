// controller.baml - Shared types for all controller functions
//
// All controller functions return ControllerAction for consistent pattern integration.
// This enables patterns (simpleLoop, actorCritic) to work with any controller.

// ============================================================================
// Core Action Type
// ============================================================================

/// Standardized action returned by all controller functions
/// Patterns use this to execute tools and determine when to exit loops
class ControllerAction {
  reasoning string @description("Step-by-step thought process (Chain of Thought)")
  tool_name string @description("Actual tool name to call (e.g., 'read_neo4j_cypher', 'search') or 'Return' to exit loop")
  tool_args string @description("JSON string with tool arguments, or empty '{}' if tool_name is 'Return'")
  status string @description("User-facing status message shown during execution")
  is_final bool @description("True when loop should exit (typically when tool_name is 'Return')")
}

// ============================================================================
// Code Mode Types
// ============================================================================

/// Output from a single script execution attempt (used by CodeModeController/Critic)
class ScriptExecutionEvent {
  script string @description("The JavaScript code that was executed")
  output string @description("The output/result from running the script")
  error string? @description("Error message if script failed, null if successful")
}

/// Critic evaluation result
class CriticResult {
  is_sufficient bool @description("True if the output adequately answers the user's intent")
  explanation string @description("Why the result is sufficient, OR what's missing and how to improve")
  suggested_approach string? @description("If not sufficient: guidance for next attempt. null if sufficient")
}
