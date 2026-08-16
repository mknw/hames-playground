// planner.baml — upfront strategic decomposition for the `planner` pattern (#27).
//
// Used by `harness-patterns/patterns/planner.server.ts`, one call per chain
// invocation, BEFORE any tool runs:
//
//   chain(planner(tools.all), simpleLoop(tools.all), synthesizer({ mode: 'thread' }))
//
// Why it exists: a simpleLoop controller re-derives its high-level approach on
// EVERY turn, and with a diverse tool surface (neo4j + database + web +
// context7) that re-derivation is both the expensive part of the prompt and
// the part most prone to greedy, locally-coherent choices ("search the web
// again" when turn 1 already pulled the docs). The planner pays for that
// reasoning once and hands the result downstream.
//
// The planner NEVER calls a tool. It only reads the catalog — which is why the
// output is `PlanResult` (prose) and not `ControllerAction` (a tool call): the
// two must not be confusable, since the tool catalog it sees is the very same
// one the executor gets.
//
// Prompt-caching layout mirrors LoopController's tier-1 (#122): the
// agent-static CONTEXT + AVAILABLE TOOLS block carries the cache marker, so
// consecutive planning calls for the same agent reuse the tool catalog.

function Planner(
  user_message: string,
  intent: string,
  tools: ToolDescription[],
  context: string?
) -> PlanResult {
  client PlannerAnthropic
  prompt #"
    {{ _.role("system") }}
    You are a strategic planner for a tool-using agent. Given the user's intent
    and the tools available, produce a concise plan describing how to
    accomplish the task.

    You do NOT invoke tools — you only describe the approach. A separate
    executor will follow your plan, one tool call per step, and it can adapt if
    reality differs from what you assumed.

    RULES:
    - Be specific: name the actual tools to use, and the order to use them in.
    - Prefer REUSING a result across steps over re-fetching it. Say explicitly
      when a later step consumes an earlier step's output.
    - Only plan steps the listed tools can actually perform. If the task needs
      no tools at all, say so in one step.
    - Keep it short — the executor reads this on every turn. Aim for 2-6 steps,
      one line each, and never more than a short paragraph of reasoning.
    - Do not answer the user's question yourself, and do not invent findings.
      The plan describes work still to be done.
    - `n_steps` MUST equal the number of steps you actually wrote.

    {# ────────── CACHED TIER 1 · agent-static: context · tools ────────── #}
    {{ _.role("user", cache_control={"type": "ephemeral"}) }}
    {% if context %}
    CONTEXT:
    {{ context }}

    ---
    {% endif %}
    AVAILABLE TOOLS:
    {{ ToolCatalog(tools) }}

    {{ _.role("user") }}
    INTENT: {{ intent }}

    ---
    REQUEST: {{ user_message }}

    {{ ctx.output_format }}
  "#
}
