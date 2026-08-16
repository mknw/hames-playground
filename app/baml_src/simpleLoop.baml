// simpleLoop.baml - Default prompt for the simpleLoop pattern
// Task-agnostic: intent, tools, and turn history are injected at runtime.
// Decomposed into named template_strings (one per section) — edit the section,
// not the monolith. ToolCatalog is shared across controllers
// (prompt-sections.baml).
//
// Parameters:
//   turns               — tool calls/results from the CURRENT task (this invocation)
//   turns_previous_runs — compact references to results from PREVIOUS tasks/sessions
//                         (separate so the LLM can distinguish past context from current work)
//   multi_call_mode     — "parallel" | "sequential" | null; agent-static (from
//                         pattern config). Gates the LoopMultiCalls tier-1
//                         section advertising ControllerAction.additional_calls
//
// Prompt-caching layout (#122) — two stable tiers, then a chronological
// conversation:
//
//   system                      agent role text (static)
//   user  [CACHE tier-1]        CONTEXT · AVAILABLE TOOLS · MULTI-CALL · EXAMPLES
//                               agent-static: survives ACROSS runs/user-turns,
//                               so consecutive tasks of the same agent reuse it
//   user  [CACHE tier-2]        INTENT · INSTRUCTIONS · PREVIOUS RESULTS
//                               (expansion affordance + frozen summaries —
//                               run-static: fixed for one task run)
//   (assistant → user)*         one pair per turn, chronological. Append-only.
//                               Rolling CACHE markers on the last two result
//                               blocks: each iteration READS the prefix cached
//                               by the previous one and WRITES the extension.
//   user                        "Turn N. Decide." + output format (never cached)
//
// Breakpoint budget: 2 tiers + 2 rolling = 4 = Anthropic's maximum. Every
// marker is BOTH a read point and a write point (there is no store-vs-retrieve
// distinction), so the tier markers stay unconditional: their prefixes must be
// re-declared on every call to be re-readable, and to be rewritten after the
// 5-minute TTL lapses mid-run.
// cache_control only reaches providers that allowlist it via
// allowed_role_metadata (the Anthropic clients in clients.baml) — all other
// providers silently drop it, so the mixed chains see an unchanged prompt.
//
// STABILITY RULES:
//  - Nothing in tier-1 may depend on the run (the expandPreviousResult
//    affordance lives in tier-2 — its presence varies per run with the refs).
//  - Nothing in tier-1/tier-2 may depend on loop state (turn number, results,
//    expansions). See LoopPriorResults / LoopTurnLog for the details.

// --- Section: few-shot examples (cached tier-1; empty when unset) -----------
// Field labels deliberately match ControllerAction's field NAMES (reasoning /
// tool_name / tool_args) rather than inventing a third vocabulary (the earlier
// `Tool:` / `Args:` against the turn log's `Call:` / `Args:` against the schema's
// `tool_name` / `tool_args`). Kept as a labelled list rather than a JSON object:
// these live inside a user message and carry no status/is_final, so rendering
// them as objects would demonstrate an ACTION MISSING REQUIRED FIELDS — the very
// shape the turn log is careful not to model.
//
// `tojson` on the VALUES, not just matching labels: `tool_args` is a string whose
// CONTENT is JSON, so every quote inside it must be escaped. Rendered bare, a
// few-shot showed `tool_args: {"query":"MATCH ..."}` while the assistant turn log
// (below) showed `"tool_args": "{\"query\": \"MATCH ...\"}"` — two demonstrations
// of one field in two incompatible encodings. Observed live: an action that
// opened in the escaped form and closed in the bare one
// (`"{\"query\": \"MATCH ... LIMIT 20"}"` — three escapes, then a naked quote),
// which terminated the string early and failed BAML with status/is_final
// "missing" at 495 output tokens against a 32768 cap. The escaping is unavoidable
// while tool_args is typed `string` (BAML has no JSON type, and the tool set is
// only known at runtime); what IS avoidable is disagreeing about it.
template_string LoopFewShots(few_shots: FewShot[]?) #"
  {% if few_shots and few_shots|length > 0 %}

  ---
  EXAMPLES (illustrative — adapt to the actual request, do not copy verbatim):
  {% for ex in few_shots %}
  - User: {{ ex.user }}
    reasoning: {{ ex.reasoning | tojson }}
    tool_name: {{ ex.tool | tojson }}
    tool_args: {{ ex.args | tojson }}
  {% endfor %}
  {% endif %}
"#

// --- Section: multi-call affordance (cached tier-1; empty when mode unset) ---
// Advertises ControllerAction.additional_calls per execution mode. The mode is
// agent-static (pattern config, resolved once per adapter call chain), so this
// section is tier-1-safe: it cannot vary within a run. When the mode is null
// ('off' — no affordance) the section renders empty and the prompt is
// byte-identical to the pre-feature layout.
// The Return/expandPreviousResult exclusion lives here (not only in the field
// description) because both are loop-control actions the executor handles as
// singular turns — a batch containing them gets per-call errors at runtime.
template_string LoopMultiCalls(multi_call_mode: string?) #"
  {% if multi_call_mode == "parallel" %}

  MULTIPLE CALLS PER TURN:
  You may execute several tool calls in one turn: the first in
  tool_name/tool_args, the rest in additional_calls. All calls in a turn run
  CONCURRENTLY, so they must be INDEPENDENT — no call may rely on another
  call's result or side effects. Prefer batching independent lookups over
  spending a turn on each. At most 4 calls per turn; keep each tool_args
  small. A failed call reports its error alongside the other results.
  Never use additional_calls on a "Return" or "expandPreviousResult" turn.
  {% elif multi_call_mode == "sequential" %}

  MULTIPLE CALLS PER TURN:
  You may execute several tool calls in one turn: the first in
  tool_name/tool_args, the rest in additional_calls. Calls in a turn run
  strictly IN ORDER: a later call sees the side effects (files written,
  state changed) of earlier calls, but you will NOT see any call's output
  until the whole turn completes — never derive a later call's arguments
  from an earlier call's output. If a call fails, the rest of the batch is
  skipped. At most 4 calls per turn; keep each tool_args small.
  Never use additional_calls on a "Return" or "expandPreviousResult" turn.
  {% endif %}
"#

// --- Section: prior-run results (cached tier-2) ------------------------------
// Frozen summaries + the expandPreviousResult affordance. STABILITY RULE:
// renders plain summaries only — never per-turn annotations, which would
// mutate the cached prefix mid-loop (expanded content arrives in the turn
// history instead, append-only).
template_string LoopPriorResults(turns_previous_runs: PriorResult[]?) #"
  {% if turns_previous_runs and turns_previous_runs|length > 0 %}

  ---
  RESULTS FROM PREVIOUS TASKS:
  The data below was retrieved in earlier tasks. To bring one into your
  working context, call the extra tool `expandPreviousResult`:
      tool_args: "ref:<ref_id>"           (single)
               | "ref:<id_1>,<id_2>,..."  (multiple — expanded together)
  Expanded content appears in your turn history below — reuse it, do not
  re-expand a ref you already expanded.

  {% for r in turns_previous_runs %}
  - [ref:{{ r.ref_id }}] {{ r.tool }}: {{ r.summary }}
  {% endfor %}
  {% endif %}
"#

// --- Section: turn log — chronological assistant/user pairs ------------------
// Append-only history with ROLLING cache markers on the last two result
// blocks: each iteration READS the prefix cached by the previous one and
// WRITES the extension. Expanded ref content renders inside the turn that
// expanded it — as late as possible, so everything before stays a valid
// cache prefix.
// Each assistant entry is rendered as a COMPLETE ControllerAction object — the
// same shape `ctx.output_format` asks for. This is load-bearing, not cosmetic:
// an assistant turn is one of the model's OWN prior messages, and continuing the
// form of its previous messages is a stronger prior than a trailing instruction.
// Rendering history as prose (`Reasoning:` / `Call:` / `Args:`) put N
// demonstrations of one vocabulary against one request for another, and the
// demonstrations win — observed live as a complete, correct action emitted in
// prose, failing BAML parsing with all five required fields "missing" (output
// 412 tokens against a 32768 cap, so not truncation). The demonstration count
// grows with turn depth, so deep loops were the most exposed. Rendered this way
// the same copying instinct produces a valid action.
//
// `is_final` is a literal `false`: the loop breaks on a final action BEFORE
// pushing a turn (`simpleLoop.server.ts` — `if (action.is_final || tool_name ===
// 'Return') break`), so every turn that reaches this log is non-final by
// construction. `tojson` does the quoting, so tool_args (itself JSON, full of
// quotes) can't break out of its string.
template_string LoopTurnLog(turns: LoopTurn[]) #"
  {% for turn in turns %}
  {{ _.role("assistant") }}
  {"reasoning": {{ turn.reasoning | default("") | tojson }}, "tool_name": {{ (turn.tool_call.tool if turn.tool_call else "") | tojson }}, "tool_args": {{ (turn.tool_call.args if turn.tool_call else "") | tojson }}{% if turn.additional_calls %}, "additional_calls": [{% for c in turn.additional_calls %}{"tool_name": {{ c.tool_name | tojson }}, "tool_args": {{ c.tool_args | tojson }}}{% if not loop.last %}, {% endif %}{% endfor %}]{% endif %}, "status": {{ turn.status | default("") | tojson }}, "is_final": false}
  {% if loop.index0 >= turns|length - 2 %}
  {{ _.role("user", cache_control={"type": "ephemeral"}) }}
  {% else %}
  {{ _.role("user") }}
  {% endif %}
  Turn {{ turn.n }} result:
  {% if turn.tool_result %}
  {% if turn.tool_result.success %}
  Result: {{ turn.tool_result.result }}
  {% else %}
  ERROR: {{ turn.tool_result.error }}

  If the error appears transient (timeout, connection), consider retrying with same or modified arguments.
  If the error indicates invalid arguments, fix them and retry.
  If the tool cannot help with this task, try an alternative approach or use Return to explain what went wrong.
  {% endif %}
  {% endif %}
  {% if turn.expansions and turn.expansions|length > 0 %}
  Expanded refs (now in your context — do not re-expand):
  {% for e in turn.expansions %}
  - [ref:{{ e.ref_id }}] → {{ e.content }}
  {% endfor %}
  {% endif %}
  {% endfor %}
"#

function LoopController(
  user_message: string,
  intent: string,
  tools: ToolDescription[],
  turns: LoopTurn[],
  context: string?,
  turns_previous_runs: PriorResult[]?,
  few_shots: FewShot[]?,
  multi_call_mode: string?,
  // Plan from an upstream `planner`, issue #27. A SEPARATE parameter, never
  // folded into `context`: `context` is agent-static — graph schema, enabled
  // servers — and renders inside the tier-1 cache marker, while the plan is
  // written per QUESTION. Prepending it to `context` made the tier-1 prefix
  // vary per run, turning every cache read on the tool catalog into a cache
  // write, issue #122. It renders in tier 2 instead, beside the intent it
  // belongs with.
  plan_context: string?
) -> ControllerAction {
  client ControllerAnthropic
  prompt #"
    {# The terminal action is described HERE because the turn log can never show
       one: the loop breaks before pushing a final action, so `is_final` renders
       as a literal false and every demonstration the model gets is a non-final
       turn paired with a tool call. That left the one shape that ENDS the loop —
       and carries the answer — undemonstrated. Static text, so it costs nothing
       per turn and stays inside the cached prefix. #}
    {{ _.role("system") }}
    You are an AI agent that accomplishes tasks by calling tools.
    Select one tool per turn. Use "Return" when you have enough information.

    To finish, set tool_name to "Return", put the complete answer in tool_args as
    plain prose (not JSON), and set is_final to true. That turn makes no tool
    call, so there is no progress to report and `status` may be omitted.

    {# ────────── CACHED TIER 1 · agent-static: context · tools · examples ────────── #}
    {{ _.role("user", cache_control={"type": "ephemeral"}) }}
    {% if context %}
    CONTEXT:
    {{ context }}

    ---
    {% endif %}
    AVAILABLE TOOLS:
    {{ ToolCatalog(tools) }}
    - Return: Signal task completion (tool_args = final answer or summary)
    {{ LoopMultiCalls(multi_call_mode) }}
    {{ LoopFewShots(few_shots) }}

    {# ────────── CACHED TIER 2 · run-static: plan · intent · instructions · prior results ────────── #}
    {{ _.role("user", cache_control={"type": "ephemeral"}) }}
    {% if plan_context %}
    {{ plan_context }}

    ---
    {% endif %}
    INTENT: {{ intent }}

    ---
    INSTRUCTIONS: {{ user_message }}
    {{ LoopPriorResults(turns_previous_runs) }}

    {# ────────── TURN HISTORY · append-only, rolling markers on last two results ────────── #}
    {{ LoopTurnLog(turns) }}

    {# ────────── VOLATILE TAIL · changes every turn, never cached ────────── #}
    {{ _.role("user") }}
    {# 0-indexed to match the turn log and the `n` the next turn is recorded
       under: with one completed turn the log ends at "Turn 0 result" and this
       asks for turn 1. The previous `+ 1` skipped a number, inviting the model
       to infer a turn it had never seen. #}
    Turn {{ turns|length }}. Decide the next action.

    {{ ctx.output_format }}
  "#
}
