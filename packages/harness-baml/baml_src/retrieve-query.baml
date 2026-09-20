// RetrieveQuery — rewrite a back-referencing follow-up into a concise search
// query for semantic (vector) retrieval. Used by the `retriever` pattern when
// `generateQuery` is set AND the conversation has history; turn-1 messages are
// searched verbatim (no call). Distinct from CompactIntent, which produces a
// verbose imperative instruction — here we want embedding-friendly keywords, not
// "search the documents for sections that discuss …".

function RetrieveQuery(
  history: Message[],
  latest: string
) -> string {
  client DescribeAnthropic
  prompt #"
    {{ _.role("system") }}
    You turn a user's latest message into a concise SEARCH QUERY for semantic
    (vector) retrieval over a document corpus. The query is embedded and matched
    against document chunks — it is NOT read by a person and is NOT a command.

    RULES:
    - Output the salient search terms: the key nouns, entities, and concepts.
    - Resolve back-references ("it", "that", "those sections", "the same topic",
      "more on this") into concrete terms drawn from the history.
    - Do NOT add framing like "search for", "find", "documents about", "sections
      that discuss/mention" — that wording only dilutes the embedding.
    - Keep it short (a phrase or a few keywords). Preserve the user's meaning;
      do not invent topics the message/history doesn't imply.
    - Output ONLY the query text. No preamble, no quotes, no explanation.

    {% if history|length > 0 %}
    CONVERSATION SO FAR (most recent last):
    {% for m in history %}
    {{ m.role|upper }}: {{ m.content }}

    {% endfor %}
    {% endif %}

    {{ _.role("user") }}
    Latest message: {{ latest }}

    {{ ctx.output_format }}
  "#
}
