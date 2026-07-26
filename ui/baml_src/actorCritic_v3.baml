// actorCritic_v3.baml — DX refactor of ActorControllerV2 (#122): identical
// prompt, identical cache breakpoints, but decomposed into named
// template_strings so each section is readable and editable in isolation.
//
// CONTRACT: V3 must render BYTE-IDENTICAL requests to V2 — same blocks, same
// text, same cache_control placement. prompt-caching.test.ts asserts this
// ("V3 ≡ V2"); if you edit a section here, that test is the proof the cache
// behavior didn't silently change. Once V2/V3 equivalence has served its
// purpose, V2 can be deleted and V3's sections become the single source.
//
// Note: the BAML linter may warn about template_string usage (documented
// static-analysis limitation) — safe to ignore.

// --- Section: tool catalog (renders inside the cached system block) --------
template_string ActorToolCatalog(tools: ToolDescription[]) #"
  {% for tool in tools %}

  - {{ tool.name }}: {{ tool.description }}
    {% if tool.args_schema %}  Args: {{ tool.args_schema }} {% endif %}
  {% endfor %}
"#

// --- Section: few-shot examples (cached system block; empty when unset) ----
template_string ActorFewShotExamples(few_shots: FewShot[]?) #"
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

// --- Section: task frame — intent · context · request ----------------------
// Carries the FIRST-CALL rolling breakpoint: with no attempts yet, USER
// REQUEST is the last block that recurs verbatim in the next call's prefix.
template_string ActorTaskFrame(intent: string, context: string?, user_message: string, attempts: Attempt[]) #"
  {{ _.role("user") }}
  USER INTENT: {{ intent }}
  {% if context %}

  ---
  CONTEXT:
  {{ context }}
  {% endif %}

  {% if attempts|length == 0 %}
  {{ _.role("user", cache_control={"type": "ephemeral"}) }}
  {% else %}
  {{ _.role("user") }}
  {% endif %}
  USER REQUEST: {{ user_message }}
"#

// --- Section: attempt log — chronological assistant/user pairs -------------
// Carries the rolling breakpoint on the NEWEST result ({% if loop.last %}):
// the last block that recurs in the next call. Older results stay unmarked —
// automatic prefix checking walks back to the previous call's write.
template_string ActorAttemptLog(attempts: Attempt[]) #"
  {% for attempt in attempts %}
  {{ _.role("assistant") }}
  Attempt {{ attempt.n }} action:
      {% if attempt.action.reasoning %}
      Reasoning: {{ attempt.action.reasoning }}
      {% endif %}
  Tool: {{ attempt.action.tool_name }}
  Args: {{ attempt.action.tool_args }}
  {% if loop.last %}
  {{ _.role("user", cache_control={"type": "ephemeral"}) }}
  {% else %}
  {{ _.role("user") }}
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

// --- Section: closing — feedback nudge · budget · attempt counter ----------
// Volatile tail: changes every call, renders AFTER the last breakpoint and is
// never cached. ctx.output_format stays in the function prompt (kept out of
// template_strings deliberately).
template_string ActorClosing(attempts: Attempt[], attempt_n: int?, max_attempts: int?) #"
  {{ _.role("user") }}
  {% if attempts|length > 0 %}
  You MUST address the critic's feedback. Do not repeat failed approaches.
  {% endif %}

  {% if attempt_n is not none and max_attempts is not none %}
  BUDGET: Attempt {{ attempt_n }} of {{ max_attempts }}.
  {% if attempt_n >= max_attempts - 1 %}
  This is your final or near-final attempt. Call the tool most likely to
  produce a useful partial answer — the critic will decide whether to accept.
  Do NOT start a fresh tool chain that won't complete in time.
  {% endif %}
  {% endif %}

  You are on attempt {{ attempts|length + 1 }}. Respond with the next action.
"#

function ActorControllerV3(
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
    {{ _.role("system", cache_control={"type": "ephemeral"}) }}
    You are an AI agent that accomplishes tasks by calling tools.
    A critic evaluates your output. Learn from previous feedback.

    AVAILABLE TOOLS:
    {{ ActorToolCatalog(tools) }}
    The critic evaluates whether the data you've gathered is sufficient and
    decides when the task is complete — you don't need a "Return" tool. Focus
    on calling the right tool to make progress; the loop exits when the critic
    says so.
    {{ ActorFewShotExamples(few_shots) }}

    {{ ActorTaskFrame(intent, context, user_message, attempts) }}

    {{ ActorAttemptLog(attempts) }}

    {{ ActorClosing(attempts, attempt_n, max_attempts) }}

    {{ ctx.output_format }}
  "#
}
