// planner.baml - Tool composition planning for code_mode
// Plans which tools to use, can reuse coded tools from repository or create new compositions
//
// This is used when executionMode === 'code' (not 'static')
// Static mode uses namespace-specific planners (PlanNeo4jOperation, PlanWebSearch)

// ============================================================================
// Data Models
// ============================================================================

/// Reference to a coded tool stored in Neo4j repository
class CodedToolReference {
  name string @description("Tool name/identifier")
  description string @description("What this tool does")
}

/// Plan output - decides whether to reuse existing tool or create new script
class ToolCompositionPlan {
  reasoning string @description("Step-by-step thought process (Chain of Thought)")

  use_existing_tool bool @description("True to reuse a coded tool from repository")
  existing_tool_name string? @description("Name of existing tool to use (required if use_existing_tool=true)")

  new_script string? @description("JavaScript code to execute (required if use_existing_tool=false)")
  tool_name_to_save string? @description("Suggested name for saving this tool to repository")
  tool_description string? @description("Description for the saved tool")
  should_save bool @description("Whether this composition should be saved for future reuse")

  status_message string @description("User-facing status message shown during execution")
}

// ============================================================================
// Functions
// ============================================================================

/// Plan which tools to use - can reuse coded tools from repository or create new compositions
function PlanToolComposition(
  user_message: string,
  intent: string,
  available_tools: string[],
  coded_tools: CodedToolReference[],
  previous_attempts: ScriptExecutionEvent[]
) -> ToolCompositionPlan {
  client GroqWithFallback
  prompt #"
    You are a Tool Composition Planner that orchestrates MCP tools.

    Your job is to either:
    1. Reuse an existing CODED TOOL from the repository (if one matches the intent)
    2. Write new JavaScript that calls MCP tools (for novel operations)

    USER INTENT: {{ intent }}
    USER MESSAGE: {{ user_message }}

    AVAILABLE MCP TOOLS (callable as JavaScript functions):
    {% for tool in available_tools %}
    - {{ tool }}
    {% endfor %}

    CODED TOOLS (reusable from repository):
    {% if coded_tools.length > 0 %}
    These tools were previously created and saved for reuse:
    {% for tool in coded_tools %}
    - {{ tool.name }}: {{ tool.description }}
    {% endfor %}
    {% else %}
    No coded tools available yet. You'll be creating the first ones!
    {% endif %}

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

    IMPORTANT: The previous attempt was not sufficient. Improve your approach.
    {% endif %}

    DECISION PROCESS:

    1. CHECK CODED TOOLS FIRST
       - Does any coded tool match this intent?
       - If yes: set use_existing_tool=true, provide existing_tool_name

    2. IF NO MATCH, CREATE NEW SCRIPT
       - Write JavaScript using available MCP tools
       - Set use_existing_tool=false, provide new_script

    3. DECIDE ON PERSISTENCE
       - Is this script reusable? (combines tools, common pattern, general utility)
       - If yes: set should_save=true, suggest tool_name_to_save and tool_description
       - If it's a one-off specific query: should_save=false

    JAVASCRIPT RULES (for new_script):
    1. All tool functions are synchronous - no async/await needed
    2. Each tool returns a string result
    3. Your script MUST return a string (use JSON.stringify for objects/arrays)
    4. Keep scripts focused and efficient
    5. Handle potential errors with try/catch when appropriate

    CRITICAL JSON OUTPUT RULE:
    When outputting the new_script field, you MUST escape ALL newlines as \n within the JSON string.
    The script must be a SINGLE LINE in the JSON output with \n for newlines.
    Example: "const x = 1;\nconst y = 2;\nreturn x + y;"
    DO NOT use actual line breaks inside the JSON string value.

    NAMING CONVENTIONS (for tool_name_to_save):
    - Use snake_case: get_user_relationships, find_tech_stack, search_and_summarize
    - Be descriptive but concise
    - Prefix with action verb: get_, find_, search_, count_, create_, update_

    {{ ctx.output_format }}
  "#
}

// ============================================================================
// Tests
// ============================================================================

test PlanToolComposition_NoExistingTools {
  functions [PlanToolComposition]
  args {
    user_message "Show me what's in the graph"
    intent "Query the knowledge graph to see its contents"
    available_tools ["read_neo4j_cypher", "get_neo4j_schema", "search", "fetch_content"]
    coded_tools []
    previous_attempts []
  }
  @@assert( {{ this.use_existing_tool == false }} )
  @@assert( {{ this.new_script != null }} )
  @@assert( {{ this.reasoning.length > 0 }} )
}

test PlanToolComposition_WithMatchingTool {
  functions [PlanToolComposition]
  args {
    user_message "Show me the graph schema"
    intent "Get the structure/schema of the knowledge graph"
    available_tools ["read_neo4j_cypher", "get_neo4j_schema"]
    coded_tools [
      { name: "get_graph_overview", description: "Fetches schema and sample nodes from the graph" },
      { name: "count_all_nodes", description: "Counts all nodes in the graph by label" }
    ]
    previous_attempts []
  }
  @@assert( {{ this.use_existing_tool == true }} )
  @@assert( {{ this.existing_tool_name == "get_graph_overview" }} )
}

test PlanToolComposition_ShouldSaveReusable {
  functions [PlanToolComposition]
  args {
    user_message "Find all technologies and their relationships"
    intent "Query for technology nodes and how they connect"
    available_tools ["read_neo4j_cypher", "get_neo4j_schema"]
    coded_tools []
    previous_attempts []
  }
  @@assert( {{ this.use_existing_tool == false }} )
  @@assert( {{ this.should_save == true }} )
  @@assert( {{ this.tool_name_to_save != null }} )
}

test PlanToolComposition_OneOffQuery {
  functions [PlanToolComposition]
  args {
    user_message "How many nodes have the exact name 'React 19.2.1'?"
    intent "Count nodes with a very specific name value"
    available_tools ["read_neo4j_cypher"]
    coded_tools []
    previous_attempts []
  }
  @@assert( {{ this.use_existing_tool == false }} )
  // One-off specific queries shouldn't be saved
  @@assert( {{ this.should_save == false }} )
}

test PlanToolComposition_WithPreviousError {
  functions [PlanToolComposition]
  args {
    user_message "Search for Neo4j tutorials"
    intent "Find web content about Neo4j tutorials"
    available_tools ["search", "fetch_content"]
    coded_tools []
    previous_attempts [
      {
        script: "return search({query: 'Neo4j tutorials'})",
        output: "",
        error: "search is not defined"
      }
    ]
  }
  @@assert( {{ this.use_existing_tool == false }} )
  @@assert( {{ this.new_script != null }} )
  // Should learn from error and try different approach
}
