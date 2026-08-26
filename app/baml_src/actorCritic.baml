// actorCritic.baml - Default prompts for the actorCritic pattern
// Two functions: Actor generates actions, Critic evaluates results.
// Task-agnostic: tools, attempts, and feedback are injected at runtime.
// The actor prompt is decomposed into named template_strings (one per
// section) — edit the section, not the monolith. ToolCatalog is shared
// across controllers (prompt-sections.baml).
//
// Prompt-caching layout (#122), settled by live A/B bench (~89% of input
// served from cache, ~64% input-cost reduction on a 4-call run):
//
//   system                 role text · AVAILABLE TOOLS · EXAMPLES (static;
//                          NO cache marker here — cross-run static-head
//                          reuse is a still-open decision, see STATE)
//   user                   USER INTENT · CONTEXT · USER REQUEST — the
//                          request block carries the CALL-1 cache marker
//   (assistant → result)*  one pair per attempt, append-only, ROLLING cache
//                          marker on the newest result
//   user                   feedback nudge · BUDGET · attempt counter ·
//                          output format — after the last marker, never cached
//
// Every marker is BOTH a read point and a write point; reads walk backward
// (automatic prefix checking) to the previous call's write. cache_control
// only reaches providers that allowlist it via allowed_role_metadata (the
// Anthropic clients) — all others silently drop it.

// ============================================================================
// Actor - Generates tool calls, improving from critic feedback
// ============================================================================

// --- Section: few-shot examples (blank-line entries, ----fenced) ------------
// Rendered as the SAME JSON object the attempt log below and `ctx.output_format`
// ask for. This prompt is where the brace-less-envelope failure was CAPTURED
// (`.harness-logs/baml-validation.json`, `sandbox-session-loop` attempt 3 of 6):
// the actor copied this section's old `key: value` shape line for line, invented
// a YAML `additional_calls:` list to go with it, and the loop died on a response
// whose every field was correct. Full account on LoopFewShots in simpleLoop.baml,
// including why "an object would demonstrate a MISSING REQUIRED FIELD" stopped
// being true once `status` (#144) and `is_final` (#159) became optional.
//
// Values rendered with `tojson` so the encoding of `tool_args` matches the
// attempt log below (which also uses `tojson`): it is a string whose content is
// JSON, so its inner quotes are escaped.
template_string ActorFewShots(few_shots: FewShot[]?) #"
  {% if few_shots and few_shots|length > 0 %}

  ---
  EXAMPLES (illustrative — adapt to the actual request, do not copy verbatim):
  {% for ex in few_shots %}

  - User: {{ ex.user }}
    {"reasoning": {{ ex.reasoning | tojson }}, "tool_name": {{ ex.tool | tojson }}, "tool_args": {{ ex.args | tojson }}, "is_final": false}
  {% endfor %}

  ---
  {% endif %}
"#

// --- Section: multi-call affordance (system block; empty when mode unset) ----
// Actor variant of LoopMultiCalls (simpleLoop.baml — see the rationale there).
// Differences: no Return/expandPreviousResult exclusion (neither exists for the
// actor), and is_final may legitimately accompany a batch (the critic still
// verifies before the loop exits). Mode is agent-static (pattern config), so
// the section sits in the static system head inside the call-1 marker's prefix.
//
// Each branch ends in ONE demonstrated action, and THIS prompt is where the
// missing demonstration was captured (#248 — the `sandbox-session-loop` attempt
// 3 in `.harness-logs/baml-validation.json`, a `sequential` sandbox agent). The
// actor wanted precisely the batch the sequential branch advertises — write a
// script, then run it, because escaping the script through `bash -lc` had just
// failed — and, with `additional_calls` described in prose but shown nowhere,
// INVENTED a YAML `additional_calls:` bullet list for it and rendered the whole
// envelope brace-less to match the few-shot form beside it. Complete, correct,
// 372 output tokens against a 32768 cap, so neither the empty-response nor the
// truncation retry matched, and the throw ended the loop with three attempts
// still in budget. The demonstration lives here rather than in `ActorFewShots`
// (per-agent examples that know nothing of the mode) or in an agent's few-shot
// config (which would show the batch shape to agents whose mode is 'off'): the
// section is already gated on `multi_call_mode`, so a demonstration inside it is
// mode-correct by construction. It byte-matches the envelope the attempt log and
// `ctx.output_format` ask for — one JSON object, `tool_args` a STRING whose
// content is JSON with inner quotes escaped, `additional_calls` entries of
// tool_name/tool_args only — because a demonstration that disagrees with the
// contract is this repo's most-paid-for defect class (#144 twice, #159, #248).
template_string ActorMultiCalls(multi_call_mode: string?) #"
  {% if multi_call_mode == "parallel" %}

  MULTIPLE CALLS PER TURN:
  You may execute several tool calls in one attempt: the first in
  tool_name/tool_args, the rest in additional_calls. All calls in an attempt
  run CONCURRENTLY, so they must be INDEPENDENT — no call may rely on another
  call's result or side effects. Prefer batching independent lookups over
  spending an attempt on each. At most 4 calls per attempt; keep each
  tool_args small. A failed call reports its error alongside the other results.
  Two independent lookups batched into one attempt — copy this SHAPE, not its
  content (tool_args stays a JSON string with its inner quotes escaped):
  {"reasoning": "The schema and the concept list do not depend on each other, so one attempt covers both.", "tool_name": "get_neo4j_schema", "tool_args": "{}", "additional_calls": [{"tool_name": "read_neo4j_cypher", "tool_args": "{\"query\": \"MATCH (c:Concept) RETURN c.name LIMIT 20\"}"}], "status": "Reading the schema and listing concepts", "is_final": false}
  {% elif multi_call_mode == "sequential" %}

  MULTIPLE CALLS PER TURN:
  You may execute several tool calls in one attempt: the first in
  tool_name/tool_args, the rest in additional_calls. Calls in an attempt run
  strictly IN ORDER: a later call sees the side effects (files written, state
  changed) of earlier calls, but you will NOT see any call's output until the
  whole attempt completes — never derive a later call's arguments from an
  earlier call's output. If a call fails, the rest of the batch is skipped.
  At most 4 calls per attempt; keep each tool_args small.
  A script written and then run in one attempt — copy this SHAPE, not its
  content (tool_args stays a JSON string with its inner quotes escaped):
  {"reasoning": "Escaping a long script through the shell is fragile, so write it to a file and run that file in the same attempt.", "tool_name": "sandbox_write", "tool_args": "{\"path\": \"/work/inspect.py\", \"content\": \"import openpyxl\\nprint('ok')\"}", "additional_calls": [{"tool_name": "sandbox_bash", "tool_args": "{\"command\": \"python3 /work/inspect.py\"}"}], "status": "Writing the script, then running it", "is_final": false}
  {% endif %}
"#

// --- Section: task frame — intent · context · request ------------------------
// Carries the FIRST-CALL cache marker on the USER REQUEST block: attempt_n is
// 1-based (the loop passes attempt + 1), so `== 1` fires exactly on call 1,
// when the request is the last block that recurs in the next call's prefix.
// (`== 0` is defensive: it can never fire under the current convention.)
// CONTEXT renders as a USER block. It was authored `system` for template-level
// semantics, on the reading that the wire coerces it anyway — true of Anthropic
// (which lifts only the LEADING system block into its top-level `system` field
// and rewrites the rest to `user`), false of an OpenAI-compatible server. vLLM
// rejects the whole request with `System message must be at the beginning.`, so
// a `system` marker here 400s every actor call that carries a context — and
// under `USE_VERDA_INFERENCE=1` that is every sandbox actor call. Rendering it
// `user` is byte-identical on the Anthropic wire (pinned by
// `prompt-role-order.test.ts`) and legal on both.
// An upstream planner's plan (#27) rides `context` here and stays cache-safe:
// unlike LoopController's tier 1, this marker's prefix is already RUN-scoped
// (it ends on USER REQUEST, and fires only on call 1), and the plan is fixed
// for the run — so every later attempt still re-reads it byte-identically.
// LoopController needed the plan split into its own `plan_context` parameter
// precisely because its tier-1 prefix is agent-static.
template_string ActorTaskFrame(intent: string, context: string?, user_message: string, attempt_n: int?) #"
  {{ _.role("user") }}
  USER INTENT: {{ intent }}
  {% if context %}

  ---
  {{ _.role("user") }}
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
// Result blocks use the USER role — the same as simpleLoop's LoopTurnLog, and
// for the same reason it never had this bug: a `system` marker AFTER an
// assistant turn is illegal on an OpenAI-compatible server (vLLM: `System
// message must be at the beginning.`), which 400d every actor RETRY on the
// self-hosted route while attempt 1 passed. Anthropic coerced them to `user`
// already, so this changes nothing there.
// Assistant entries render the recorded ControllerAction as JSON — the shape
// `ctx.output_format` asks for. Same reasoning as simpleLoop's LoopTurnLog (see
// the comment there): prior assistant messages are the model's own output, so a
// prose history demonstrates a vocabulary that contradicts the response contract
// and the demonstrations outnumber the instruction. Unlike simpleLoop, `is_final`
// comes from the DATA here: the critic verifies and can reject, so an attempt
// with is_final=true legitimately appears in history followed by another attempt.
// `| default(false)` because the field is optional since #159: the patterns
// normalise an omitted value to false before it is recorded, and this filter is
// the second line of defence — a bare `tojson` of an absent value would render
// `"is_final": null` into one of the model's OWN prior messages, demonstrating a
// third value for a boolean field.
template_string ActorAttemptLog(attempts: Attempt[], attempt_n: int?) #"
  {% for attempt in attempts %}
  {{ _.role("assistant") }}
  {"reasoning": {{ attempt.action.reasoning | default("") | tojson }}, "tool_name": {{ attempt.action.tool_name | tojson }}, "tool_args": {{ attempt.action.tool_args | tojson }}{% if attempt.action.additional_calls %}, "additional_calls": [{% for c in attempt.action.additional_calls %}{"tool_name": {{ c.tool_name | tojson }}, "tool_args": {{ c.tool_args | tojson }}}{% if not loop.last %}, {% endif %}{% endfor %}]{% endif %}, "status": {{ attempt.action.status | default("") | tojson }}, "is_final": {{ attempt.action.is_final | default(false) | tojson }}}
      {% if loop.index0 >= (attempt_n - 2) %}
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

// --- Section: closing — feedback nudge · budget · attempt counter ------------
// Volatile tail: changes every call, renders AFTER the last cache marker and
// is never cached. ctx.output_format stays in the function prompt (kept out
// of template_strings deliberately).
template_string ActorClosing(attempts: Attempt[], attempt_n: int?, max_attempts: int?) #"
  {{ _.role("user") }}
  {% if attempts | selectattr("feedback") | list | length > 0 %}
  You MUST address the CRITIC FEEDBACK above. Do not repeat failed approaches.
  {% elif attempts|length > 0 %}
  Do not repeat failed approaches.
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

function ActorController(
  user_message: string,
  intent: string,
  tools: ToolDescription[],
  attempts: Attempt[],
  context: string?,
  few_shots: FewShot[]?,
  attempt_n: int?,
  max_attempts: int?,
  multi_call_mode: string?
) -> ControllerAction {
  // ActorAnthropic, not ControllerAnthropic: same models, but thinking stays ON
  // here. #139 disabled it for the simpleLoop controller on measured evidence
  // that did not cover this pattern at all.
  client ActorAnthropic
  prompt #"
    {# ────────── SYSTEM · static requirements: role · tools · examples ────────── #}
    {{ _.role("system") }}
    You are an AI agent that accomplishes tasks by calling tools.
    A critic evaluates your output. Learn from previous feedback.

    AVAILABLE TOOLS:
    {{ ToolCatalog(tools) }}
    A critic decides when the task is complete and when the loop exits — you
    don't need a "Return" tool. Focus on calling the right tool to make progress.

    When you believe the task is fully complete — every requested deliverable
    actually produced, not merely planned — set is_final=true. The critic then
    VERIFIES before the loop exits, so is_final is a signal, not a guarantee.
    While you still have work to do, keep is_final=false and call the next tool.
    In particular, a script you have only WRITTEN is not done: keep is_final=false
    and run it (and confirm its output) before you set is_final=true.
    {{ ActorMultiCalls(multi_call_mode) }}
    {{ ActorFewShots(few_shots) }}

    {# ────────── TASK FRAME · intent · context · request (call-1 cache marker) ────────── #}
    {{ ActorTaskFrame(intent, context, user_message, attempt_n) }}

    {# ────────── ATTEMPT LOG · append-only, rolling marker on newest result ────────── #}
    {{ ActorAttemptLog(attempts, attempt_n) }}

    {# ────────── VOLATILE TAIL · feedback nudge · budget · counter — never cached ────────── #}
    {{ ActorClosing(attempts, attempt_n, max_attempts) }}

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
    {% if attempt.action.additional_calls %}
    {% for c in attempt.action.additional_calls %}
    Also called (same attempt): {{ c.tool_name }}({{ c.tool_args }})
    {% endfor %}
    {% endif %}
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
