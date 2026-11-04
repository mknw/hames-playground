// prompt-sections.baml — template_string sections shared across controller
// prompts (#122 DX pass). One definition, every consumer renders identical
// bytes — which is what keeps tool catalogs cache-stable AND consistently
// formatted everywhere.
//
// WHITESPACE RULE (learned the hard way — see prompt-caching.test.ts
// "tool catalog separation"): a template line that ENDS in a statement tag
// ({% endif %}) loses its trailing newline when rendered, which is how tool
// entries used to run together ("…Args: {…}- next_tool"). Keep {% if %} /
// {% endif %} on their own lines inside content sections.

// --- Tool catalog -----------------------------------------------------------
// Renders each tool as a blank-line-separated entry:
//
//   - name: description
//     Args: {…}            (only when the tool declares a schema)
//
// The section ends after the last entry's final line; the caller supplies the
// blank line before the next section.
template_string ToolCatalog(tools: ToolDescription[]) #"
  {% for tool in tools %}

  - {{ tool.name }}: {{ tool.description }}
  {% if tool.args_schema %}
    Args: {{ tool.args_schema }}
  {% endif %}
  {% endfor %}
"#

// --- Current time (per turn) -------------------------------------------------
// The turn's clock block (`formatTimeBlock` in harness-patterns' `clock.ts`:
// weekday, ISO date, local time, UTC offset, zone name), or nothing. Callers
// render it ONLY inside per-turn user-role content AFTER their last cache
// marker: it changes every turn, so inside a cached prefix it would turn every
// cache read into a write (#122), and it is never a system block, because a
// system block after a message breaks the system-at-front rule
// (`prompt-role-order.test.ts`). A null one renders nothing.
template_string CurrentTime(current_time: string?) #"
  {% if current_time %}
  {{ current_time }}
  {% endif %}
"#
