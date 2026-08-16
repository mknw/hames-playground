// code_mode.baml - Multi-tool JavaScript composition controller
// Handles complex operations that require combining multiple MCP tools
//
// Workflow:
// 1. CodeModeController generates JavaScript that calls MCP tools
// 2. Pattern executes the script
// 3. CodeModeCritic evaluates if the output answers the user's intent
// 4. If not sufficient, critic provides guidance for retry

// ============================================================================
// Functions
// ============================================================================

/// Controller that generates a JavaScript script to orchestrate MCP tool calls
/// Returns ControllerAction with tool_name="code-mode-executor"
function CodeModeController(
  user_message: string,
  intent: string,
  available_tools: string[],
  previous_attempts: ScriptExecutionEvent[]
) -> ControllerAction {
  client GroqWithFallback
  prompt #"
    You are a Code Mode Agent that writes JavaScript to orchestrate MCP tool calls.

    USER INTENT: {{ intent }}
    USER MESSAGE: {{ user_message }}

    AVAILABLE MCP TOOLS (callable as synchronous JavaScript functions):
    {% for tool in available_tools %}
    - {{ tool }}
    {% endfor %}

    {% if previous_attempts.length > 0 %}
    PREVIOUS ATTEMPTS (learn from these):
    {% for attempt in previous_attempts %}
    --- Attempt {{ loop.index }} ---
    Script: {{ attempt.script }}
    {% if attempt.error %}
    ERROR: {{ attempt.error }}
    {% else %}
    Output: {{ attempt.output }}
    {% endif %}
    {% endfor %}

    IMPORTANT: The previous output was not sufficient. Improve your approach based on
    the evaluation feedback provided in the last attempt's context.
    {% endif %}

    YOUR TASK:
    Write a JavaScript script that calls the available tools to answer the user's intent.

    JAVASCRIPT RULES:
    1. All tool functions are synchronous - no async/await needed
    2. Each tool returns a string result
    3. Your script MUST return a string (use JSON.stringify for objects/arrays)
    4. Keep scripts focused and efficient
    5. Handle potential errors with try/catch when appropriate
    6. Use conditionals (if/else) and loops (for/while) as needed

    EXAMPLE PATTERNS:

    // Simple query
    const result = read_neo4j_cypher({query: 'MATCH (n) RETURN n LIMIT 5'});
    return result;

    // Multiple tools with combination
    const schema = get_neo4j_schema();
    const data = read_neo4j_cypher({query: 'MATCH (n:Person) RETURN n.name'});
    return JSON.stringify({schema: JSON.parse(schema), people: JSON.parse(data)});

    // Conditional logic
    const searchResults = search({query: 'topic'});
    const parsed = JSON.parse(searchResults);
    if (parsed.results && parsed.results.length > 0) {
      const details = fetch_content({url: parsed.results[0].url});
      return details;
    }
    return searchResults;

    OUTPUT FORMAT:
    - tool_name: Always "code-mode-executor"
    - tool_args: JSON string containing the script: '{"script": "const x = 1;\\nreturn x;"}'
    - is_final: false (critic determines completion)

    CRITICAL JSON OUTPUT RULE:
    When outputting tool_args, you MUST escape ALL newlines as \\n within the JSON string.
    The script must be a SINGLE LINE in the JSON output with \\n for newlines.
    Example: '{"script": "const x = 1;\\nconst y = 2;\\nreturn x + y;"}'
    DO NOT use actual line breaks inside the JSON string value.

    {{ ctx.output_format }}
  "#
}

/// Critic that evaluates whether script output answers the user's intent
/// Returns CriticResult with evaluation and optional retry guidance
function CodeModeCritic(
  intent: string,
  previous_attempts: ScriptExecutionEvent[]
) -> CriticResult {
  client GroqWithFallback
  prompt #"
    You are evaluating whether MCP script execution results answer a user's intent.

    USER INTENT: {{ intent }}

    EXECUTION HISTORY:
    {% for attempt in previous_attempts %}
    --- Attempt {{ loop.index }} ---
    Script executed:
    ```javascript
    {{ attempt.script }}
    ```
    {% if attempt.error %}
    RESULT: ERROR
    {{ attempt.error }}
    {% else %}
    RESULT: SUCCESS
    {{ attempt.output }}
    {% endif %}
    {% endfor %}

    YOUR TASK:
    Evaluate if the MOST RECENT result adequately answers the user's intent.

    EVALUATION CRITERIA:
    1. Does the output contain the information the user asked for?
    2. Is the data complete enough to formulate a useful response?
    3. Did any errors occur that prevent answering the intent?

    IF SUFFICIENT (is_sufficient = true):
    - Provide a clear explanation of why the output answers the intent
    - Set suggested_approach to null

    IF NOT SUFFICIENT (is_sufficient = false):
    - Explain what's missing or went wrong
    - Provide specific guidance in suggested_approach for the next attempt
    - Consider: different queries, additional tools, error handling, data transformation

    NOTE: After 3 failed attempts, you should be more lenient in accepting partial results.
    Current attempt count: {{ previous_attempts.length }}

    {{ ctx.output_format }}
  "#
}

// ============================================================================
// Tests
// ============================================================================

test CodeModeController_Simple_Query {
  functions [CodeModeController]
  args {
    user_message "Show me what's in the graph"
    intent "Query the knowledge graph to see its contents"
    available_tools ["read_neo4j_cypher", "get_neo4j_schema"]
    previous_attempts []
  }
  @@assert( {{ this.tool_name == "code-mode-executor" }} )
  @@assert( {{ this.is_final == false }} )
}

test CodeModeController_With_Previous_Error {
  functions [CodeModeController]
  args {
    user_message "Count all nodes"
    intent "Get a count of nodes in the graph"
    available_tools ["read_neo4j_cypher"]
    previous_attempts [
      {
        script: "return read_neo4j_cypher({query: 'MATCH (n) RETURN count(n)'})",
        output: "",
        error: "Syntax error: unexpected token"
      }
    ]
  }
  @@assert( {{ this.tool_name == "code-mode-executor" }} )
}

test CodeModeCritic_Sufficient {
  functions [CodeModeCritic]
  args {
    intent "Count nodes in the graph"
    previous_attempts [
      {
        script: "return read_neo4j_cypher({query: 'MATCH (n) RETURN count(n) as total'})",
        output: "[{\"total\": 25}]",
        error: null
      }
    ]
  }
  @@assert( {{ this.is_sufficient == true }} )
}

test CodeModeCritic_Insufficient {
  functions [CodeModeCritic]
  args {
    intent "Find all Person nodes with their relationships"
    previous_attempts [
      {
        script: "return read_neo4j_cypher({query: 'MATCH (n) RETURN n LIMIT 1'})",
        output: "[{\"n\": {\"name\": \"Test\"}}]",
        error: null
      }
    ]
  }
  @@assert( {{ this.is_sufficient == false }} )
  @@assert( {{ this.suggested_approach != null }} )
}
