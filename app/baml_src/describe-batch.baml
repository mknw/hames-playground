// ResultDescribeBatch — the batched twin of ResultDescribe (#83 Part E).
//
// `compactBulkData` used to spend one describe-tier round-trip per oversized
// tool result: a 6-result turn meant 6 calls, 6 system prompts and 6 latencies.
// This folds a batch into ONE call and returns one summary per item.
//
// The per-item `id` is what makes the split-back reliable: the model echoes it
// on each summary and the caller maps by id, never by list position or by
// splitting a delimited string. An id the model drops or answers blank simply
// falls back to a single-item ResultDescribe call for THAT item, so a partial
// answer costs one extra call instead of the whole batch.
//
// Batch size is bounded by the caller (MAX_BATCH_ITEMS in
// harness-patterns/compactBulkData.server.ts) so N × ~200 output tokens stays
// well under the client's output cap — a truncated response would drop the
// tail items' summaries, which is exactly what the per-item fallback repairs.

class DescribeTarget {
  // Caller-assigned label, unique within the batch. Echo it verbatim.
  id string
  tool string
  tool_args string
  reasoning string
  result string
}

class DescribeItemSummary {
  // The `id` of the DescribeTarget this summary is for.
  id string
  summary string
}

class DescribeBatchResult {
  summaries DescribeItemSummary[]
}

function ResultDescribeBatch(items: DescribeTarget[]) -> DescribeBatchResult {
  client DescribeAnthropic
  prompt #"
    {{ _.role("system") }}
    You are a concise data summarizer. You will receive several INDEPENDENT tool
    calls. Summarize each one separately: what that call found or produced, in
    2-3 short sentences (max 200 tokens each). Focus on the data returned, not
    the mechanics of the call.

    RULES:
    - Return exactly one summary per item — no more, no fewer.
    - Set each summary's `id` field to its item's `id`, copied verbatim. Never
      write the id inside the `summary` text — the summary is read on its own,
      by both a model and a human, and a leading "id=3:" is noise there.
    - Never merge, compare or cross-reference items. They are unrelated calls
      that happen to share a request.
    - Summarize only what an item's own result contains. If a result is empty or
      an error, say so plainly for that item.

    {{ _.role("user") }}
    {% for item in items %}
    --- ITEM id={{ item.id }} ---
    Tool: {{ item.tool }}
    Arguments: {{ item.tool_args }}
    {% if item.reasoning %}
    Agent reasoning: {{ item.reasoning }}
    {% endif %}
    Result (may be truncated):
    {{ item.result }}

    {% endfor %}
    {{ ctx.output_format }}
  "#
}
