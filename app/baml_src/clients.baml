// Learn more about clients at https://docs.boundaryml.com/docs/snippets/clients/overview
//
// Leaf clients only. The role chains every BAML function declares live in
// `anthropic-only.baml`; `local-client.baml` holds `LocalGLM`, which is in no
// chain and exists for manual wiring. Anthropic is the only provider — the
// mixed-provider chains (`RouterFallback` / `ControllerFallback` / …, spread
// across Groq, OpenRouter and OpenAI behind `USE_MIXED_CHAINS=1`) were removed
// 2026-08-24; see ADR-0001.

// Latest Anthropic Claude 4 models
client<llm> AnthropicOpus4 {
  provider anthropic
  options {
    model "claude-opus-4-1-20250805"
    api_key env.ANTHROPIC_API_KEY
    max_tokens 4096
  }
}

// Sonnet 5: adaptive thinking is ON by default (thinking spend counts against
// max_tokens), and the new tokenizer runs ~30% more tokens for the same text —
// so the output cap is deliberately generous. 4096 was proven inadequate for
// sandbox actors (a report-generation script truncated mid-tool_args →
// BamlValidationError; see baml-adapters truncation handling). Keep these caps
// in sync with CLIENT_MAX_OUTPUT_TOKENS in app/src/lib/settings.ts.
client<llm> AnthropicSonnet5 {
  provider anthropic
  options {
    model "claude-sonnet-5"
    api_key env.ANTHROPIC_API_KEY
    max_tokens 32768
    // #122: forward the cache_control breakpoints rendered by the controller
    // templates (simpleLoop.baml / actorCritic.baml). A provider without this
    // allowlist silently drops the metadata, so any future non-Anthropic leaf
    // has to declare it too or the same templates lose their cache markers.
    allowed_role_metadata ["cache_control"]
  }
}

client<llm> AnthropicSonnet46 {
  provider anthropic
  options {
    model "claude-sonnet-4-6"
    api_key env.ANTHROPIC_API_KEY
    max_tokens 16384
    // #122: see AnthropicSonnet5 — this is the ControllerAnthropic backstop.
    allowed_role_metadata ["cache_control"]
  }
}

// --- Thinking-disabled variants (#139) --------------------------------------
// These models run extended thinking BY DEFAULT — no request asks for it — and
// they do not expose the trace (empty `thinking` string plus a signature), so a
// caller pays for tokens it can neither read nor replay into `reasoning`.
//
// Measured over 12 captured controller prompts × 6 samples each (144 calls):
// disabling thinking took valid actions from 70/72 to 72/72 (with it on, the
// model sometimes ends its turn having produced ONLY thinking and no text — the
// failure #138 retries), cut median output tokens 438 → 249, and stopped the
// controller re-running a search it had just run while already holding the
// answer. Full data and the per-prompt output comparison: #139.
//
// Used ONLY by ControllerAnthropic (the simpleLoop tool loop). Everything else
// keeps thinking, deliberately: the actor, router, critic and compactExecution are
// unmeasured, and the actor in particular is the deepest loop we run.
//
// Identical to their twins otherwise — keep the options in sync, including
// `allowed_role_metadata` (#122 cache markers) and the caps / pricing entries in
// `settings.ts` keyed by these names.
client<llm> AnthropicSonnet5NoThink {
  provider anthropic
  options {
    model "claude-sonnet-5"
    api_key env.ANTHROPIC_API_KEY
    max_tokens 32768
    allowed_role_metadata ["cache_control"]
    thinking {
      type "disabled"
    }
  }
}

client<llm> AnthropicSonnet46NoThink {
  provider anthropic
  options {
    model "claude-sonnet-4-6"
    api_key env.ANTHROPIC_API_KEY
    max_tokens 16384
    allowed_role_metadata ["cache_control"]
    thinking {
      type "disabled"
    }
  }
}

client<llm> AnthropicHaiku45 {
  provider anthropic
  retry_policy Constant
  options {
    model "claude-haiku-4-5"
    api_key env.ANTHROPIC_API_KEY
    max_tokens 16384
  }
}

// Example Google AI client (uncomment to use)
// client<llm> CustomGemini {
//   provider google-ai
//   options {
//     model "gemini-2.5-pro"
//     api_key env.GOOGLE_API_KEY
//   }
// }

// Example AWS Bedrock client (uncomment to use)
// client<llm> CustomBedrock {
//   provider aws-bedrock
//   options {
//     model "anthropic.claude-sonnet-4-20250514-v1:0"
//     region "us-east-1"
//     // AWS credentials are auto-detected from env vars
//   }
// }

// Example Vertex AI client (uncomment to use)
// client<llm> CustomVertex {
//   provider vertex-ai
//   options {
//     model "gemini-2.5-pro"
//     location "us-central1"
//     // Uses Google Cloud Application Default Credentials
//   }
// }

// https://docs.boundaryml.com/docs/snippets/clients/retry
retry_policy Constant {
  max_retries 3
  strategy {
    type constant_delay
    delay_ms 200
  }
}

retry_policy Exponential {
  max_retries 2
  strategy {
    type exponential_backoff
    delay_ms 300
    multiplier 1.5
    max_delay_ms 2000
  }
}
