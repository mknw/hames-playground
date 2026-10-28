---
"@hames-ai/harness-patterns": minor
"@hames-ai/harness-baml": patch
"@hames-ai/agents": minor
---

Tell the Decide step about the turn's recalled memories. `decisionLoop` takes an optional `quoteMemories: () => boolean`, called once per run before iteration 1. With it, the state gains a block after the documents block and before "This turn so far" for the memories `withMemory` recalled this turn (`data.memories`): their text, quoted as data, when the host answers `true`; a count only (`N relevant memories (not shown)`) for any other answer. Without `quoteMemories`, or when nothing was recalled, the state is byte-identical to before. Core never reads a tier: the host decides which runs may see the text.

- The quote: each memory is cut to 280 code points before anything else runs, NFKC-normalised, has separators and control characters replaced and invisible and format characters removed, and becomes one `> `-prefixed line between `---BEGIN MEMORIES <nonce>---` and `---END MEMORIES <nonce>---`. The 16-hex nonce is drawn once per run from the platform's cryptographic source and never occurs in the quoted text. At most 5 memories and 2,000 characters, then a `(+K relevant memories not quoted)` line.
- A run that quotes memories records its decisions with the call redacted (usage, cost and client kept; the state and the request body dropped), so memory text never reaches the persisted conversation through a `decision_made` or `error` event; an error message keeps only its text before the first `': '` and the new `WITHHELD_ERROR_DETAIL` marker. New `DecideOptions.redact` does this for any caller.
- A `quoteMemories` that throws, or a quote that cannot be fenced, gives the count and one `warning` (new `WarningTask` `'decision_memories'`). `routerMemory: 'replies-only'` keeps memory out of the decision entirely. Route children still never receive memories.
- `DecisionLoopStateInput.memories` hands the resolved value to a `state` override, with the text only on a run the host lets quote it. New exports: `renderMemoriesBlock`, `DECISION_MEMORIES_HEADING`, `DECISION_MEMORIES_MAX`, `DECISION_MEMORY_CODE_POINTS`, `DECISION_MEMORIES_MAX_CHARS` and the `DecisionMemories` type. A document name containing the memories heading is withheld, like the state's other headers.
- `@hames-ai/agents`: `AgentDeps.quoteMemoriesToDecider` (optional); `general-next` passes it to its loop.
- `@hames-ai/harness-baml`: `Synthesize`'s memory block gains one exception: when the user asks what is remembered or noted about them, the answer comes from that block and says it is remembered from earlier conversations.
