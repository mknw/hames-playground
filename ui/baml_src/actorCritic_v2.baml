// actorCritic_v2.baml — BENCHMARK ARM for #122 prompt caching. Not wired into
// production: the adapters keep calling `ActorController` (actorCritic.baml).
// This variant exists to be measured against it by the cache bench
// (src/__tests__/bench/prompt-cache-bench.test.ts) on identical inputs.
//
// Design: the incremental-conversation pattern (Anthropic cookbook, prompt
// caching Example 3), transliterated to the actor loop. Exactly TWO
// breakpoints per call, on specific content blocks:
//
//   1. The system block (role text · AVAILABLE TOOLS · EXAMPLES) — the
//      static head, byte-identical for every call of every run of this agent.
//   2. The last block that will RECUR verbatim in the next call's prefix:
//      - call 1 (no attempts yet): the USER REQUEST block
//      - call 2+: the newest attempt-result block ({% if loop.last %})
//      The cookbook marks "the last user message"; in a chat that message
//      recurs as history next turn. Our literal last message (attempt counter,
//      BUDGET, output format) is regenerated every call and never recurs — a
//      breakpoint there would write a prefix no future call can match. Hence
//      "last persistent block", not "last block".
//
// Call N+1 re-reads call N's write through prefix matching: its breakpoint
// sits a couple of blocks past call N's, and the automatic prefix check finds
// the longest cached prefix behind it.
//
// Roles: past actions are assistant turns; results/feedback are user turns —
// on the wire messages[] only has user/assistant (a mid-conversation
// "system" role would be coerced to user anyway), and user-role tool results
// are the pattern the models are trained on.

function ActorControllerV2(
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
    {% endif %}

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
