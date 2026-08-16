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
