// types.baml - Shared types for all harness patterns
// These are task-agnostic: tools, events, and context are passed as variables.

// ============================================================================
// Tool Types
// ============================================================================

/// Description of an available tool, passed to patterns at runtime
class ToolDescription {
  name string @description("Tool identifier")
  description string @description("What the tool does")
  args_schema string? @description("JSON schema of accepted arguments")
}

// ============================================================================
// Event Types (mirror harness EventType)
// ============================================================================

/// A single turn in a loop-based pattern
class LoopTurn {
  n int @description("Turn number, 0-indexed")
  reasoning string? @description("Agent reasoning for this turn")
  /// The turn's own user-facing status. Recorded so the assistant turn log can
  /// replay a COMPLETE ControllerAction — a history entry missing required
  /// fields would demonstrate exactly the malformed shape we want to prevent.
  /// Optional because sessions serialized before this field exists still parse.
  status string? @description("Short user-facing status message from this turn's action")
  tool_call ToolCall? @description("Tool invocation if any")
  tool_result ToolResult? @description("Tool execution result if any")
  expansions ExpandedRef[]? @description("Refs resolved into tool_args this turn via ref:<id>")
}

/// A ref:<id> argument that was expanded inline during a turn
class ExpandedRef {
  ref_id string @description("Event ID that was expanded")
  content string @description("Expanded content as it was inlined into tool_args (may be truncated)")
}

/// Tool call event
class ToolCall {
  tool string @description("Tool name that was called")
  args string @description("JSON-encoded arguments")
}

/// Tool execution result
class ToolResult {
  tool string @description("Tool name")
  result string @description("Serialized result")
  success bool @description("Whether execution succeeded")
  error string? @description("Error message if failed")
}

/// A previous attempt for actor-critic retry loop
class Attempt {
  n int @description("Attempt number, 1-indexed")
  action ControllerAction @description("Action that was taken")
  result string @description("Execution output")
  error string? @description("Error if execution failed")
  feedback string? @description("Critic feedback if not sufficient")
}

// ============================================================================
// Cross-Turn Data References
// ============================================================================

/// A compact reference to a tool result from a previous task/turn.
/// The LLM can pass ref:<ref_id> as a tool argument value to retrieve full data.
class PriorResult {
  ref_id string @description("Event ID — pass as ref:<ref_id> in tool arguments to expand full data")
  tool string @description("Tool that produced this result")
  summary string @description("Brief summary or preview of the result")
  expanded_in_turn int? @description("Turn (in current loop) where this ref was first inlined; absent if never expanded")
}

// ============================================================================
// Few-Shot Examples
// ============================================================================

/// A canonical example of how the agent should pick a tool for a given user request.
/// Few-shots are domain-specific — pass at config time on a per-route basis (e.g., a
/// neo4j route ships graph-query examples; a web route ships search-formulation examples).
class FewShot {
  user string @description("Example user request")
  reasoning string @description("Reasoning the agent followed before choosing the tool")
  tool string @description("Tool name selected")
  args string @description("JSON-encoded tool arguments matching the tool's schema")
}

// ============================================================================
// Routing Types
// ============================================================================

/// A named route option for the router pattern
class RouteOption {
  name string @description("Route identifier")
  description string @description("When this route should be selected")
}

/// Conversation message for history context
class Message {
  role string @description("'user' or 'assistant'")
  content string @description("Message text")
}

// ============================================================================
// Return Types (match pattern scopes)
// ============================================================================

/// Action decision returned by loop and actor controllers
class ControllerAction {
  reasoning string @description("Step-by-step thought process")
  tool_name string @description("Tool to call, or 'Return' to exit loop")
  tool_args string @description("Valid JSON object string with the tool's arguments, e.g. {\"query\": \"search term\"}. Keys and string values MUST be double-quoted. For Return, use the final answer as a plain string.")
  status string @description("Short user-facing status message")
  is_final bool @description("True when the loop should terminate")
}

/// Critic evaluation result
class CriticResult {
  is_sufficient bool @description("True if output adequately satisfies the intent")
  explanation string @description("Why sufficient, or what is missing")
  suggested_approach string? @description("Guidance for next attempt if not sufficient")
}

/// Routing decision
class RoutingResult {
  intent string @description("Detected user intention")
  needs_tool bool @description("Whether a tool call is required")
  route string? @description("Selected route name, null if no tool needed")
  response string? @description("Brief status message when routing, or conversational reply when no tool needed")
}
