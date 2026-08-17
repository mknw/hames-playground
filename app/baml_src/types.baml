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
  /// Calls 2..N of a multi-call turn, mirroring ControllerAction.additional_calls
  /// so the assistant turn log can replay the model's exact output shape.
  /// The combined per-call results land in tool_result as an index-keyed map
  /// (the expandPreviousResult multi-ref precedent). Optional: sessions and
  /// turns recorded before this field exists still parse.
  additional_calls ToolCallRequest[]? @description("Extra tool calls executed in the same turn (multi-call turns only)")
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

/// One extra tool call inside a multi-call turn (ControllerAction.additional_calls).
/// Field names deliberately match ControllerAction's singular fields — one
/// vocabulary, demonstrated everywhere (see the few-shot encoding lesson in
/// simpleLoop.baml: disagreeing demonstrations are defects).
class ToolCallRequest {
  tool_name string @description("Tool to call")
  tool_args string @description("Valid JSON object string with this call's arguments — same contract as the top-level tool_args")
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
  tool_args string @description("Valid JSON object string with the tool's arguments, e.g. {\"query\": \"search term\"}. Keys and string values MUST be double-quoted. For Return, use plain prose (not JSON), as your instructions describe.")
  // OPTIONAL and self-gating: one ControllerAction class serves every agent,
  // so this field is visible in ctx.output_format even for agents whose
  // instructions never mention multiple calls. The description tells the model
  // to leave it alone unless the prompt advertises the affordance; the runtime
  // tolerates un-advertised batches by executing them serially.
  additional_calls ToolCallRequest[]? @description("More tool calls to execute in the SAME turn, after tool_name/tool_args. Only use this when your instructions describe multiple calls per turn — they also say whether calls run concurrently or in order. Omit it otherwise, and always omit it when tool_name is 'Return' or 'expandPreviousResult'.")
  // OPTIONAL because it is decorative: nothing reads it for control flow. The
  // loop stores it only to render into the next prompt (simpleLoop.server.ts),
  // and both UI consumers already guard for absence (ObservabilityPanel's
  // `<Show when>`, useChainProgress's `?.status ? … : null`).
  //
  // Required, it cost a finished answer. The turn log can only ever demonstrate
  // NON-final actions — the loop breaks before pushing a final one — so every
  // example the model sees pairs `status` with a tool call it is about to make
  // ("Searching for files related to TraceFrom project..."). On the terminal
  // Return turn there is no call and no progress to report, so the field has no
  // natural filler: observed live as a structurally perfect action (valid JSON,
  // 33 correctly-placed escapes, a 900-char composed answer) that simply omitted
  // `status` and failed with missing=1, discarding the answer. A required field
  // the system treats as optional punishes the model for being right.
  status string? @description("Short user-facing status message describing what you are doing. Omit it on the final Return turn if nothing is in progress.")
  // OPTIONAL with a documented default of FALSE — absent means "not final" —
  // and normalised to `false` by both loop patterns (`normalizeControllerAction`
  // in harness-patterns/controller-action.ts) before anything reads it, so no
  // consumer ever sees `undefined`.
  //
  // Third instance of one failure class (#159; #144 fixed the other two —
  // few-shot `tool_args` encoding, then `status`). Observed live: a turn-0
  // action with valid JSON, a real tool, correct args and 135 output tokens
  // against a 32768 cap — so neither truncation nor an empty completion, and
  // neither retry trigger matched — that simply omitted `is_final` and failed
  // with missing=1. The turn was discarded and the user got an apology.
  //
  // The omission is structural, not a one-off: the field is only ever
  // DEMONSTRATED as false. `LoopTurnLog` renders a literal `false` (the loop
  // breaks before pushing a final action) and few-shots carry no action fields
  // at all, so a turn-0 call with empty `turns` and no few-shots — exactly the
  // failing shape — has `ctx.output_format` as its only description of the
  // field. A field whose sole demonstrated value is the default is the field a
  // model drops.
  //
  // False is the safe default in both patterns, so absence can never end a loop
  // early or claim finality: simpleLoop exits on `is_final || tool_name ===
  // 'Return'` (the tool name is an independent terminal signal), and actorCritic
  // tests `is_final === true` merely to TRIGGER the critic, which owns exit —
  // at worst an omission costs one more actor turn before the cadence gate.
  //
  // The description is PATTERN-NEUTRAL and defers to the prompt for what
  // "complete" means, for the same reason `additional_calls` above defers: one
  // ControllerAction class serves both loop patterns, so this text renders into
  // `ctx.output_format` for BOTH — and what ends the turn differs between them.
  // simpleLoop finishes with `tool_name: 'Return'` (simpleLoop.baml states it in
  // the system spine); the actorCritic actor has no `Return` — it is rejected by
  // the allowlist — and sets `is_final` merely to summon the critic, which owns
  // the exit (actorCritic.baml states that). Naming `Return` here would tell the
  // actor its only critic trigger requires a tool it is forbidden to call.
  is_final bool? @description("Set to true on the turn where you consider the task complete, as your instructions define completion. On every other turn set it to false or omit it — an absent value is read as false and the loop continues.")
}

/// Critic evaluation result
class CriticResult {
  is_sufficient bool @description("True if output adequately satisfies the intent")
  explanation string @description("Why sufficient, or what is missing")
  suggested_approach string? @description("Guidance for next attempt if not sufficient")
}

/// Strategic plan produced by the `planner` pattern BEFORE any tool runs.
/// The planner never executes a tool — it only describes the approach, which
/// downstream loop patterns receive as their trailing `planContext` argument
/// (harness-patterns/patterns/planner.server.ts → `formatPlanContext`).
/// `LoopController` takes it as its own `plan_context` parameter (tier 2);
/// `ActorController` merges it into `context`, which is cache-safe there.
class PlanResult {
  /// Field name deliberately matches ControllerAction.reasoning — one
  /// vocabulary for "why this course of action", wherever it is produced.
  reasoning string @description("Why this approach was chosen")
  plan string @description("Numbered, executable plan in natural language")
  n_steps int @description("Number of discrete steps in the plan")
}

/// Routing decision
class RoutingResult {
  intent string @description("Self-contained statement of what the user wants now, with back-references resolved from the history — never a bare 'try again' / 'the second one'")
  needs_tool bool @description("Whether a tool call is required")
  route string? @description("Selected route name, null if no tool needed")
  response string? @description("Brief status message when routing, or conversational reply when no tool needed")
}
