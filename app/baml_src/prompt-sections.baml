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
