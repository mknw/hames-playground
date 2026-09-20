// router.baml - Default prompt for the router pattern
// Routes user messages to the appropriate handler/chain.
// Task-agnostic: routes and history are injected at runtime.

function Router(
  message: string,
  routes: RouteOption[],
  history: Message[]
) -> RoutingResult {
  client RouterAnthropic
  prompt #"
    {{ _.role("system") }}
    Analyze the user message and determine routing.

    AVAILABLE ROUTES:
    {% for route in routes %}
    - {{ route.name }}: {{ route.description }}
    {% endfor %}

    ROUTING RULES:
    - Set needs_tool=true if the message requires calling a tool or route
    - Set route to the matching route name (null if no tool needed)
    - Set needs_tool=false ONLY for greetings, thanks, help requests, or simple clarifications
    - Any question about data, graphs, databases, stored information, or domain-specific lookups MUST route to the appropriate tool (needs_tool=true)
    - If needs_tool=true, set response to a SHORT status like "Looking into that..." — do NOT attempt to answer the question yourself
    - If needs_tool=false, provide a direct conversational reply
    - NEVER generate a substantive answer when routing to a tool — the tool will provide the real answer

    INTENT FORMULATION:
    Downstream patterns receive `intent` and NOTHING ELSE from this conversation —
    they cannot see the history below. An intent that only makes sense next to the
    previous turns is useless to them.
    - `intent` MUST be a self-contained statement of what the user wants right now.
    - If the latest message is a back-reference to earlier context — "try again",
      "do it", "more of those", "the second one", "now in TypeScript", "and also Y" —
      expand it using the conversation history so it stands alone.
      Example:
        HISTORY: USER: "search the web for SolidJS resources"
                 ASSISTANT: "<rate-limit error, no results>"
        MESSAGE: "try again"
        intent:  "search the web for SolidJS resources (retry of the previous turn)"
    - Resolve pronouns and ordinals ("it", "that one", "the second") into the
      concrete nouns they refer to in the history.
    - If the latest message is already self-contained, intent may mirror it.
    - NEVER set intent to a bare back-reference phrase on its own.
    - Preserve the user's actual request: expand references, but do not answer it,
      add steps, or widen the scope.

    {% if history|length > 0 %}
    CONVERSATION HISTORY (most recent last):
    {% for m in history %}
    {{ m.role|upper }}: {{ m.content }}

    {% endfor %}
    {% endif %}

    {{ _.role("user") }}
    {{ message }}

    {{ ctx.output_format }}
  "#
}
