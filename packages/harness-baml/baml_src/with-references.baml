// ReferenceSelector — chooses which prior tool_result events to attach to a
// pattern's ingress, given the user's intent and recent dialogue.
// Used by the `withReferences` meta-pattern wrapper.

class ReferenceCandidate {
  ref_id string @description("Event ID for this candidate")
  tool string @description("Tool that produced the result")
  summary string @description("Brief summary of what the result contains")
  tool_args string? @description("Arguments the tool was called with, if known")
  ts_offset_s int @description("Seconds before now")
}

class ReferenceSelection {
  ref_id string @description("Event ID of the selected candidate")
  reason string @description("One short sentence on why this is relevant")
}

class ReferenceSelectorResult {
  reasoning string @description("Why these were chosen / why none were chosen")
  selected ReferenceSelection[] @description("Ranked, most-relevant first; empty when nothing applies")
}

function ReferenceSelector(
  intent: string,
  recent_messages: Message[],
  candidates: ReferenceCandidate[]
) -> ReferenceSelectorResult {
  client DescribeAnthropic
  prompt #"
    {{ _.role("system") }}
    Select prior tool results that are relevant to the user's current intent.

    RULES:
    - Rank candidates by relevance, but include any that are plausibly useful.
    - Return zero candidates only if **all** items are completely unrelated to the intent and recent dialogue.
    - Prefer recent items over older ones when relevance is similar.
    - Reasons should be one short sentence each.

    {{ _.role("user") }}
    INTENT: {{ intent }}

    RECENT DIALOGUE:
    {% for m in recent_messages %}
    - {{ m.role }}: {{ m.content }}
    {% endfor %}

    CANDIDATES:
    {% for c in candidates %}
    - id: {{ c.ref_id }}
      tool: {{ c.tool }}
      summary: {{ c.summary }}
      {% if c.tool_args %}args: {{ c.tool_args }}{% endif %}
      ts_offset: {{ c.ts_offset_s }}s ago
    {% endfor %}

    {{ ctx.output_format }}
  "#
}
