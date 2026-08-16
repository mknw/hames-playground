// response.baml - Response generation and validation
// Creates user-friendly responses from tool results

// ============================================================================
// Functions
// ============================================================================

// Create final user-friendly response from tool execution results
// Called after tool loop completes (Return selected or max turns reached)
function CreateToolResponse(
  tool_events: string,
  user_message: string,
  intent: string
) -> string {
  client GroqWithFallback
  prompt #"
    Create a user-friendly response based on tool execution results.

    USER'S ORIGINAL MESSAGE: {{ user_message }}
    DETECTED INTENT: {{ intent }}

    TOOL EXECUTION RESULTS:
    {{ tool_events }}

    YOUR TASK:
    Synthesize the tool results into a helpful, conversational response.

    GUIDELINES:
    - Be concise but informative
    - Highlight key findings and insights
    - If results are empty, explain why and suggest alternatives
    - For graph data, summarize patterns and relationships
    - For web search, extract key information
    - Suggest relevant follow-up questions when appropriate

    Do NOT just dump raw data. Help the user understand what they found.
  "#
}

// Validates a proposed write operation before execution
// Provides a safety check for data modifications
function ValidateWriteOperation(
  cypher_query: string,
  user_intent: string,
  current_graph_state: string
) -> string {
  client CustomSonnet4
  prompt #"
    A user wants to modify the graph database. Please validate this operation.

    User's intent: {{ user_intent }}

    Proposed Cypher query:
    ```cypher
    {{ cypher_query }}
    ```

    Current relevant graph state:
    {{ current_graph_state }}

    Your task:
    1. Verify the query is syntactically correct
    2. Check if it will do what the user intends
    3. Identify any potential issues or unintended consequences
    4. Provide a clear explanation of what will happen

    Respond with a clear explanation that helps the user understand:
    - What nodes/relationships will be created, modified, or deleted
    - Any potential side effects
    - Whether you recommend proceeding

    Be specific and clear about the impacts.
  "#
}
