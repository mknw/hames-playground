// actorCritic.baml - Default prompts for the actorCritic pattern
// Two functions: Actor generates actions, Critic evaluates results.
// Task-agnostic: tools, attempts, and feedback are injected at runtime.

// ============================================================================
// Actor - Generates tool calls, improving from critic feedback
// ============================================================================
//
// Prompt-caching layout (#122) — same two-tier + chronological-pairs scheme as
// LoopController; full rationale in simpleLoop.baml. Differences here:
//  - CONTEXT sits in tier-2, not tier-1: the actor's context may come from a
//    per-invocation contextProvider (e.g. code-mode's ENABLED SERVERS catalog)
//    and can legitimately change mid-run — tier-2 placement limits such a
//    change to busting tier-2, keeping the tools/examples cache alive.
//  - The per-attempt BUDGET block renders in the volatile tail (it changes
//    every attempt, so it must never sit in a cached region).
//  - stable_hash is the adapter-computed mutation canary rendered in tier-2;
//    constant across the attempts of one run unless an input actually changed
//    (e.g. a mid-run tool registration — a deliberate, visible cache bust).

function ActorController(
  user_message: string,
  intent: string,
  tools: ToolDescription[],
  attempts: Attempt[],
  context: string?,
  few_shots: FewShot[]?,
  attempt_n: int?,
  max_attempts: int?,
) -> ControllerAction {
  client ControllerAnthropic
  prompt #"
    {{ _.role("system") }}
    You are an AI agent that accomplishes tasks by calling tools.
    A critic evaluates your output. Learn from previous feedback.

    AVAILABLE TOOLS:
    {% for tool in tools %}

    - {{ tool.name }}: {{ tool.description }}
      {% if tool.args_schema %}  Args: {{ tool.args_schema }} {% endif %}
    {% endfor %}

    The critic evaluates whether the data you've gathered is sufficient and
    decides when the task is complete — you don't need a "Return" tool. Focus
    on calling the right tool to make progress; the loop exits when the critic
    says so.
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

    {{ ctx.output_format }}
  "#
}

// ============================================================================
// Critic - Evaluates whether the actor's output satisfies the intent
// ============================================================================

function Critic(
  intent: string,
  attempts: Attempt[]
) -> CriticResult {
  client CriticAnthropic
  prompt #"
    {{ _.role("system") }}
    You evaluate whether task execution results satisfy the user's intent.
    Be precise about what is missing. Be lenient with partial results after multiple attempts.

    USER INTENT: {{ intent }}

    EXECUTION HISTORY:
    {% for attempt in attempts %}
    --- Attempt {{ attempt.n }} ---
    Action: {{ attempt.action.tool_name }}({{ attempt.action.tool_args }})
    Reasoning: {{ attempt.action.reasoning }}
    {% if attempt.error %}RESULT: ERROR — {{ attempt.error }}
    {% else %}RESULT: {{ attempt.result }}
    {% endif %}
    {% endfor %}

    {{ _.role("user") }}
    Evaluate the MOST RECENT result against the intent.

    CRITERIA:
    1. Does the output contain the needed information?
    2. Is the data complete enough to form a response?
    3. Did errors prevent answering the intent?
    4. PROVENANCE: if a result carries a `_source` field (e.g.
       {"server": ..., "tool": ...}), check it came from the source the intent
       asks for. When the intent names a specific store ("the neo4j db", "the
       memory graph", a particular API) and `_source.server` is a DIFFERENT
       store, the result is NOT sufficient — the answer came from the wrong
       place. Steer the actor to scope to the correct server rather than
       accepting it. (No `_source` field? Skip this check.)
    5. TRUTHFULNESS over completeness: a truthful empty or negative result that
       faithfully answers the intent IS sufficient. If the correct source
       genuinely holds no matching data, accept that — do NOT loop demanding
       results that don't exist; that only pressures the actor into fabricating.
       An honest "nothing found" beats an invented answer.

    On a DEGENERATE result (wrong store, a blocked/bot-detected fetch, or output
    that looks invented), steer the actor toward a valid alternative source via
    suggested_approach — don't reject sound work, and don't accept fabrication.

    Don't be a pedantic QA gate: minor formatting or stylistic gaps are not
    grounds for another loop when the substantive information is present.

    IF SUFFICIENT: set is_sufficient=true, explain why. Leave suggested_approach null.
    IF NOT SUFFICIENT: set is_sufficient=false, explain what is missing, provide specific guidance.

    {% if attempts|length >= 3 %}
    NOTE: {{ attempts|length }} attempts have been made. Accept partial results if they provide meaningful information.
    {% endif %}

    {{ ctx.output_format }}
  "#
}
