// neo4j.baml - Neo4j graph database controller
// Handles Cypher queries for reading and writing graph data

// ============================================================================
// Functions
// ============================================================================

/// Controller that decides which Neo4j tool to call next
/// Returns standardized ControllerAction for pattern integration
function Neo4jController(
  user_message: string,
  intent: string,
  previous_results: string,
  n_turn: int,
  schema: string?
) -> ControllerAction {
  client GroqWithFallback
  prompt #"
    You are a Neo4j Knowledge Graph Agent. The user wants to: {{ intent }}

    Turn {{ n_turn }}/5. You must complete within 5 turns.

    USER MESSAGE: {{ user_message }}

    {% if schema %}
    GRAPH SCHEMA:
    {{ schema }}
    {% endif %}

    PREVIOUS RESULTS (from earlier turns):
    {{ previous_results }}

    YOUR TASK:
    1. Think step by step about what Cypher query will answer the user's intent
    2. Generate a valid Cypher query with LIMIT clauses for safety

    AVAILABLE TOOLS:
    - read_neo4j_cypher: For MATCH queries that read data
    - write_neo4j_cypher: For CREATE/DELETE/SET/MERGE queries (requires user approval)
    - get_neo4j_schema: To refresh schema info (rarely needed)
    - Return: When you have enough info to answer - stops the loop

    OUTPUT FORMAT:
    - tool_name: The exact tool name string (e.g., "read_neo4j_cypher") or "Return"
    - tool_args: JSON string with query, e.g., '{"query": "MATCH (n) RETURN n LIMIT 10"}'
      Use '{}' if tool_name is "Return"
    - is_final: Set to true ONLY when tool_name is "Return"

    Choose Return if previous_results contains sufficient information.

    {{ ctx.output_format }}
  "#
}

// ============================================================================
// Tests
// ============================================================================

test Neo4jController_Read_Simple {
  functions [Neo4jController]
  args {
    user_message "Show me all Person nodes"
    intent "Query graph for Person nodes"
    previous_results "[]"
    n_turn 1
    schema "Node Labels:\n- Person (properties: name, age)\n\nRelationships:\n- (Person)-[KNOWS]->(Person)"
  }
  @@assert( {{ this.tool_name == "read_neo4j_cypher" }} )
  @@assert( {{ this.is_final == false }} )
}

test Neo4jController_Schema_Request {
  functions [Neo4jController]
  args {
    user_message "What types of nodes exist?"
    intent "Get schema information"
    previous_results "[]"
    n_turn 1
    schema null
  }
  @@assert( {{ this.tool_name == "get_neo4j_schema" or this.tool_name == "read_neo4j_cypher" }} )
}

test Neo4jController_Return_With_Results {
  functions [Neo4jController]
  args {
    user_message "Show me all Person nodes"
    intent "Query graph for Person nodes"
    previous_results "[{\"status_code\": 200, \"data\": [{\"n\": {\"name\": \"Alice\", \"age\": 30}}, {\"n\": {\"name\": \"Bob\", \"age\": 25}}]}]"
    n_turn 2
    schema "Node Labels:\n- Person (properties: name, age)"
  }
  @@assert( {{ this.tool_name == "Return" }} )
  @@assert( {{ this.is_final == true }} )
}

test Neo4jController_Write_Create {
  functions [Neo4jController]
  args {
    user_message "Create a new Person named Charlie"
    intent "Create a new node in the graph"
    previous_results "[]"
    n_turn 1
    schema "Node Labels:\n- Person (properties: name, age)"
  }
  @@assert( {{ this.tool_name == "write_neo4j_cypher" }} )
  @@assert( {{ this.is_final == false }} )
}
