// compact-execution.baml - Default prompt for the compactExecution pattern
// Turns tool execution results into a user-friendly response.
// Task-agnostic: event history is injected at runtime.

function Synthesize(
  user_message: string,
  intent: string,
  turns: LoopTurn[],
  has_error: bool,
  error_message: string?
) -> string {
  client SynthesizerAnthropic
  prompt #"
    {{ _.role("system") }}
    Create a user-friendly response from tool execution results.

    USER MESSAGE: {{ user_message }}
    INTENT: {{ intent }}

    {% if has_error %}
    --- ERROR OCCURRED ---
    {{ error_message }}

    Acknowledge the error honestly and explain what went wrong in user-friendly terms.
    If partial results were obtained, summarize them.
    Suggest what the user could try differently.
    {% endif %}

    TOOL EXECUTION:
    {% for turn in turns %}
    {% if turn.tool_result %}
    --- Turn {{ turn.n }} ---
    Tool: {{ turn.tool_result.tool }}
    {% if turn.additional_calls %}
    (multi-call turn: {{ turn.additional_calls|length + 1 }} tools ran together — the result below is a map keyed by call index, each entry naming its tool)
    {% endif %}
    {% if turn.tool_result.success %}Result: {{ turn.tool_result.result }}
    {% else %}Error: {{ turn.tool_result.error }}
    {% endif %}
    {% endif %}
    {% endfor %}

    {{ _.role("user") }}
    Synthesize the above into a helpful response.

    FIDELITY — do not fabricate:
    - Cite ONLY links/URLs that appear verbatim in the TOOL EXECUTION results
      above. Never invent, guess, or substitute a URL — do NOT replace a blocked
      or missing page with a "related" link the results don't contain (e.g. a
      docs homepage or a schema.org link). If a result carries no URL for an
      item, say so plainly; don't supply one.
    - If a result includes a URL but the page could not be fetched (a 403 /
      Forbidden / "could not fetch" / error appears in place of the content),
      STILL show that original URL and note it couldn't be fetched. Do not drop
      it and do not swap in a different link.
    - Every name, number, and fact in your response must trace to the results
      above. When the data is missing, empty, or negative, report that honestly
      rather than filling the gap.

    GUIDELINES:
    - Be concise but informative
    - Highlight key findings and relationships
    - If errors occurred, explain what went wrong clearly and suggest alternatives
    - For structured data, summarize patterns rather than dumping raw output
    - When you draw on content retrieved from an uploaded document, name its
      source file (the result's `source`, e.g. "According to INDEX.md, …") so the
      reader can open the citation
    - Suggest follow-up questions when relevant
  "#
}
