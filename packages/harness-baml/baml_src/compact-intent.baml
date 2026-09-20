// CompactIntent — rewrite a user's latest message into a self-contained brief.
//
// Used by the `compactIntent` chain primitive (harness-patterns) upstream of a
// router-less actor. Chain-based agents (e.g. Sandbox · Session) have no router
// to resolve bare back-references ("try again", "I can't find the file", "now
// in TypeScript") into a standalone instruction, so the downstream actor — which
// only sees `scope.data.intent` plus the current turn — would otherwise act blind.
//
// Uses the lightweight DescribeAnthropic client (same cheap chain as the
// background summarizer / title generator) — one call per chain invocation.

function CompactIntent(
  history: Message[],
  latest: string
) -> string {
  client DescribeAnthropic
  prompt #"
    {{ _.role("system") }}
    You rewrite a user's latest message into a single self-contained instruction
    for a downstream agent that CANNOT see the conversation history.

    RULES:
    - Resolve every back-reference ("it", "that file", "the script", "try again",
      "now in TypeScript") into concrete nouns drawn from the history.
    - Preserve the user's actual request exactly. Do NOT answer it, add steps,
      or widen the scope.
    - If the latest message is already self-contained, return it essentially
      unchanged.
    - Output ONE imperative instruction. No preamble, no explanation, no quotes.

    {% if history|length > 0 %}
    CONVERSATION SO FAR (most recent last):
    {% for m in history %}
    {{ m.role|upper }}: {{ m.content }}

    {% endfor %}
    {% endif %}

    {{ _.role("user") }}
    Latest message: {{ latest }}

    {{ ctx.output_format }}
  "#
}
