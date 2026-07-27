// actorCritic_v4.baml — DX refactor of the PRODUCTION ActorController (#122):
// identical prompt, identical cache scheme (the V1 scheme: request marker on
// call 1 via the attempt_n gate, rolling marker on the newest result via
// loop.index0 >= attempt_n - 2; NO system-block marker), decomposed into
// named template_strings with commented sections.
//
// CONTRACT: ActorControllerV4 must render BYTE-IDENTICAL requests to
// ActorController — prompt-caching.test.ts asserts it. Once the equivalence
// has served its purpose, the production function body is replaced by this
// composition and the twin retires.
//
// Shared sections: ToolCatalog (prompt-sections.baml), ActorClosing
// (actorCritic_v3.baml — move it here when the V2/V3 bench arms retire).
// NOT shared with V3's sections: this scheme differs (roles, markers,
// separators), and byte-identity to production V1 wins over reuse.

// --- Section: few-shot examples (V1 shape: blank-line entries, trailing ---) -
template_string ActorV1FewShots(few_shots: FewShot[]?) #"
  {% if few_shots and few_shots|length > 0 %}

  ---
  EXAMPLES (illustrative — adapt to the actual request, do not copy verbatim):
  {% for ex in few_shots %}

  - User: {{ ex.user }}
    Reasoning: {{ ex.reasoning }}
    Tool: {{ ex.tool }}
    Args: {{ ex.args }}
  {% endfor %}

  ---
  {% endif %}
"#

// --- Section: task frame — intent · context · request ------------------------
// Carries the FIRST-CALL cache marker on the USER REQUEST block: attempt_n is
// 1-based (the loop passes attempt + 1), so `== 1` fires exactly on call 1,
// when the request is the last block that recurs in the next call's prefix.
// (`== 0` is defensive: it can never fire under the current convention.)
// CONTEXT is authored as a system role for template-level semantics — the
// Anthropic provider coerces mid-conversation system to `user` on the wire.
template_string ActorV1TaskFrame(intent: string, context: string?, user_message: string, attempt_n: int?) #"
  {{ _.role("user") }}
  USER INTENT: {{ intent }}
  {% if context %}

  ---
  {{ _.role("system") }}
  CONTEXT:
  {{ context }}
  {% endif %}

  ---
  {% if attempt_n == 0 or attempt_n == 1 %}
  {{ _.role("user", cache_control={"type": "ephemeral"}) }}
  {% else %}
  {{ _.role("user") }}
  {% endif %}
  USER REQUEST: {{ user_message }}

  ---
"#

// --- Section: attempt log — chronological assistant/system(→user) pairs ------
// ROLLING cache marker on the newest result: loop.index0 maxes at
// attempts|length - 1 == attempt_n - 2, so `>=` fires on the last entry only
// (strict `>` never fires — measured as 0% cache reads before the fix).
// Result blocks use the system role; the wire coerces them to `user`.
template_string ActorV1AttemptLog(attempts: Attempt[], attempt_n: int?) #"
  {% for attempt in attempts %}
  {{ _.role("assistant") }}
  Attempt {{ attempt.n }} action:
      {% if attempt.action.reasoning %}
      Reasoning: {{ attempt.action.reasoning }}
      {% endif %}
  Tool: {{ attempt.action.tool_name }}
  Args: {{ attempt.action.tool_args }}
      {% if loop.index0 >= (attempt_n - 2) %}
      {{ _.role("system", cache_control={"type": "ephemeral"}) }}
      {% else %}
      {{ _.role("system") }}
      {% endif %}
  Attempt {{ attempt.n }} result:
      {% if attempt.error %}
      ERROR: {{ attempt.error }}
      {% else %}
      Result: {{ attempt.result }}
      {% endif %}
      {% if attempt.feedback %}
      CRITIC FEEDBACK: {{ attempt.feedback }}
      {% endif %}
  {% endfor %}
"#

function ActorControllerV4(
  user_message: string,
  intent: string,
  tools: ToolDescription[],
  attempts: Attempt[],
  context: string?,
  few_shots: FewShot[]?,
  attempt_n: int?,
  max_attempts: int?
) -> ControllerAction {
  client ControllerAnthropic
  prompt #"
    {# ────────── SYSTEM · static requirements: role · tools · examples ────────── #}
    {{ _.role("system") }}
    You are an AI agent that accomplishes tasks by calling tools.
    A critic evaluates your output. Learn from previous feedback.

    AVAILABLE TOOLS:
    {{ ToolCatalog(tools) }}
    The critic evaluates whether the data you've gathered is sufficient and
    decides when the task is complete — you don't need a "Return" tool. Focus
    on calling the right tool to make progress; the loop exits when the critic
    says so.
    {{ ActorV1FewShots(few_shots) }}

    {# ────────── TASK FRAME · intent · context · request (call-1 cache marker) ────────── #}
    {{ ActorV1TaskFrame(intent, context, user_message, attempt_n) }}

    {# ────────── ATTEMPT LOG · append-only, rolling marker on newest result ────────── #}
    {{ ActorV1AttemptLog(attempts, attempt_n) }}

    {# ────────── VOLATILE TAIL · feedback nudge · budget · counter — never cached ────────── #}
    {{ ActorClosing(attempts, attempt_n, max_attempts) }}

    {{ ctx.output_format }}
  "#
}
