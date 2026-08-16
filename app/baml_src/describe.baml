// ResultDescribe — lightweight tool result summarizer
// Uses a small/fast model (DescribeFallback) to keep token cost low.
// Called non-blocking after the response has been provided to the user.

function ResultDescribe(
  tool: string,
  tool_args: string,
  reasoning: string,
  result: string
) -> string {
  client DescribeAnthropic
  prompt #"
    {{ _.role("system") }}
    You are a concise data summarizer. Summarize what the following tool call
    found or produced, in 2-3 short sentences (max 200 tokens).
    Focus on the data returned, not the mechanics of the call.

    {{ _.role("user") }}
    Tool: {{ tool }}
    Arguments: {{ tool_args }}
    {% if reasoning %}
    Agent reasoning: {{ reasoning }}
    {% endif %}
    Result (may be truncated):
    {{ result }}

    {{ ctx.output_format }}
  "#
}
