// GenerateConversationTitle — ultra-short conversation titles for the sidebar.
// Reuses the DescribeFallback client chain (Groq → Gemma → OpenAI → Haiku)
// — same lightweight chain used by the background tool-result summarizer
// since both are "tiny async post-process" jobs with identical cost shapes.
//
// Invoked as the body of a minimal one-pattern harness agent
// (lib/harness-client/examples/title-generator.server.ts) on the first
// turn of a conversation, and on-demand via the sidebar's regenerate
// button. Output is sanitized client-side (quote stripping, length cap)
// so the prompt rules are best-effort, not load-bearing.

function GenerateConversationTitle(user_message: string) -> string {
  client DescribeAnthropic
  prompt #"
    {{ _.role("system") }}
    Generate a 3-to-5-word title summarizing what this conversation is
    about, based on the user's first message. Title case. No quotes. No
    trailing punctuation. No emojis. Return only the title text — no
    preamble, no explanation.

    {{ _.role("user") }}
    First message:
    {{ user_message }}

    {{ ctx.output_format }}
  "#
}
