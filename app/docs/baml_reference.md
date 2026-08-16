# BAML Reference Guide

Quick reference for BAML templating features used in harness-patterns prompts.

## Types

### Primitives
- `bool`, `int`, `float`, `string`, `null`

### Composite Types
- `Type?` - Optional (may be null)
- `Type[]` - Array
- `Type1 | Type2` - Union (order matters)
- `map<string, Type>` - Key-value map

### Classes
```baml
class MyClass {
  field1 string
  field2 int?
  nested OtherClass
}
```

### Enums
```baml
enum Status {
  Pending @alias("pending") @description("Waiting for processing")
  Complete @alias("complete")
  Failed @skip  // Excluded from prompt
}
```

## Jinja Templating

### Variable Interpolation
```jinja
{{ variable }}
{{ user.name }}
{{ items|length }}
```

### Conditionals
```jinja
{% if condition %}
  content if true
{% elif other_condition %}
  content if other is true
{% else %}
  content if all false
{% endif %}
```

### For Loops
```jinja
{% for item in items %}
  {{ loop.index }}: {{ item.name }}
{% endfor %}
```

#### Loop Variables
| Variable | Description |
|----------|-------------|
| `loop.index` | Current iteration (1-indexed) |
| `loop.index0` | Current iteration (0-indexed) |
| `loop.first` | Boolean: is first iteration |
| `loop.last` | Boolean: is last iteration |
| `loop.length` | Total count of items |
| `loop.previtem` | Previous item (unavailable on first) |
| `loop.nextitem` | Next item (unavailable on last) |

### Filters

#### String Filters
```jinja
{{ text|upper }}        // UPPERCASE
{{ text|lower }}        // lowercase
{{ text|title }}        // Title Case
{{ text|trim }}         // Strip whitespace
{{ text|replace("old", "new") }}
```

#### Array Filters
```jinja
{{ items|length }}      // Count
{{ items|first }}       // First element
{{ items|last }}        // Last element
{{ items|join(", ") }}  // Join with separator
{{ items|sort }}        // Sort
{{ items|unique }}      // Deduplicate
{{ items|reverse }}     // Reverse order
{{ numbers|sum }}       // Sum numeric array
```

#### Utility Filters
```jinja
{{ value|default("fallback") }}  // Default if undefined
{{ price|round(2) }}             // Round to decimal places
{{ value|abs }}                  // Absolute value
```

#### BAML-Specific Filters
```jinja
{{ object|format(type="yaml") }}  // Serialize as YAML
{{ object|format(type="json") }}  // Serialize as JSON
{% if text|regex_match("\\d+") %} // Regex test
```

### Filter Chaining
```jinja
{{ name|trim|lower|title }}
```

## Roles

```jinja
{{ _.role("system") }}
System instructions here...

{{ _.role("user") }}
User message here...

{{ _.role("assistant") }}
Assistant response here...
```

### Dynamic Roles in Loops
```jinja
{% for m in messages %}
  {{ _.role(m.role) }}
  {{ m.content }}
{% endfor %}
```

## Output Format

Always include at end of prompt:
```jinja
{{ ctx.output_format }}
```

### Customization Options
```jinja
{{ ctx.output_format(prefix="Respond with JSON:\n") }}
{{ ctx.output_format(always_hoist_enums=true) }}
```

## Template Strings

Reusable prompt components:
```baml
template_string FormatTool(tool: ToolDescription) #"
  - {{ tool.name }}: {{ tool.description }}
"#

function MyFunction(tools: ToolDescription[]) -> string {
  prompt #"
    Available tools:
    {% for tool in tools %}
    {{ FormatTool(tool) }}
    {% endfor %}
  "#
}
```

## Function Structure

```baml
function FunctionName(
  param1: string,
  param2: int,
  optional_param: string?
) -> ReturnType {
  client ClientName
  prompt #"
    Your prompt here with {{ param1 }}

    {{ ctx.output_format }}
  "#
}
```
