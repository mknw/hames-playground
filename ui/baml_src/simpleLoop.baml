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
//
// Prompt-caching layout (#122) — two stable tiers, then a chronological
// conversation:
//
//   system                      agent role text (static)
//   user  [CACHE tier-1]        CONTEXT · AVAILABLE TOOLS · EXAMPLES
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
template_string LoopFewShots(few_shots: FewShot[]?) #"
  {% if few_shots and few_shots|length > 0 %}

  ---
  EXAMPLES (illustrative — adapt to the actual request, do not copy verbatim):
  {% for ex in few_shots %}
  - User: {{ ex.user }}
    Reasoning: {{ ex.reasoning }}
    Tool: {{ ex.tool }}
    Args: {{ ex.args }}
  {% endfor %}
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
template_string LoopTurnLog(turns: LoopTurn[]) #"
  {% for turn in turns %}
  {{ _.role("assistant") }}
  Turn {{ turn.n }} action:
  {% if turn.reasoning %}
  Reasoning: {{ turn.reasoning }}
  {% endif %}
  {% if turn.tool_call %}
  Call: {{ turn.tool_call.tool }}
  Args: {{ turn.tool_call.args }}
  {% endif %}
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
  few_shots: FewShot[]?
) -> ControllerAction {
  client ControllerAnthropic
  prompt #"
    {{ _.role("system") }}
    You are an AI agent that accomplishes tasks by calling tools.
    Select one tool per turn. Use "Return" when you have enough information.

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
    {{ LoopFewShots(few_shots) }}

    {# ────────── CACHED TIER 2 · run-static: intent · instructions · prior results ────────── #}
    {{ _.role("user", cache_control={"type": "ephemeral"}) }}
    INTENT: {{ intent }}

    ---
    INSTRUCTIONS: {{ user_message }}
    {{ LoopPriorResults(turns_previous_runs) }}

    {# ────────── TURN HISTORY · append-only, rolling markers on last two results ────────── #}
    {{ LoopTurnLog(turns) }}

    {# ────────── VOLATILE TAIL · changes every turn, never cached ────────── #}
    {{ _.role("user") }}
    Turn {{ turns|length + 1 }}. Decide the next action.

    {{ ctx.output_format }}
  "#
}
