// web_search.baml - Web search and URL fetch controller
// Handles internet searches and content fetching

// ============================================================================
// Functions
// ============================================================================

/// Controller that decides which web tool to call next
/// Returns standardized ControllerAction for pattern integration
function WebSearchController(
  user_message: string,
  intent: string,
  previous_results: string,
  n_turn: int
) -> ControllerAction {
  client GroqWithFallback
  prompt #"
    You are a Web Search Agent. The user wants to: {{ intent }}

    Turn {{ n_turn }}/5. You must complete within 5 turns.

    USER MESSAGE: {{ user_message }}

    PREVIOUS RESULTS (from earlier turns):
    {{ previous_results }}

    YOUR TASK:
    1. Determine the optimal search query to answer the user's intent
    2. Consider refining based on previous results
    3. If Search results lack detail, use fetch to get content from specific URLs
    4. End the loop by selecting "Return" as tool_name when you have sufficient information

    AVAILABLE TOOLS:
    - search: Web search with a query string
    - fetch: Get content from a specific URL found in search results
    - Return: When you have enough info to answer - stops the loop

    OUTPUT FORMAT:
    - tool_name: The exact tool name string (e.g., "search", "fetch") or "Return"
    - tool_args: JSON string with payload:
      - For search: '{"query": "your search query"}'
      - For fetch: '{"url": "https://example.com/page"}'
      - For Return: '{}'
    - is_final: Set to true ONLY when tool_name is "Return"

    Choose Return if previous_results contains sufficient information.

    {{ ctx.output_format }}
  "#
}

// ============================================================================
// Tests
// ============================================================================

test WebSearchController_Search_Simple {
  functions [WebSearchController]
  args {
    user_message "Search for React 19 features"
    intent "Find information about React 19"
    previous_results "[]"
    n_turn 1
  }
  @@assert( {{ this.tool_name == "search" }} )
  @@assert( {{ this.is_final == false }} )
}

test WebSearchController_Search_Documentation {
  functions [WebSearchController]
  args {
    user_message "Find the official TypeScript documentation"
    intent "Locate TypeScript docs"
    previous_results "[]"
    n_turn 1
  }
  @@assert( {{ this.tool_name == "search" or this.tool_name == "fetch" }} )
}

test WebSearchController_Fetch_URL {
  functions [WebSearchController]
  args {
    user_message "Get the content from https://example.com/docs"
    intent "Fetch specific URL content"
    previous_results "[]"
    n_turn 1
  }
  @@assert( {{ this.tool_name == "fetch" }} )
  @@assert( {{ this.is_final == false }} )
}

test WebSearchController_Return_With_Results {
  functions [WebSearchController]
  args {
    user_message "What are the new features in React 19?"
    intent "Learn about React 19 features"
    previous_results "[{\"status_code\": 200, \"data\": {\"results\": [{\"title\": \"React 19 Release\", \"snippet\": \"React 19 introduces new concurrent features...\"}]}}]"
    n_turn 2
  }
  @@assert( {{ this.tool_name == "Return" }} )
  @@assert( {{ this.is_final == true }} )
}
