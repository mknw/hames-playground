// Learn more about clients at https://docs.boundaryml.com/docs/snippets/clients/overview

// Groq — Fast routing & classification (1000 t/s, cheapest, 32K ctx)
client<llm> GroqFast {
  provider openai-generic
  retry_policy Exponential
  options {
    base_url "https://api.groq.com/openai/v1"
    api_key env.GROQ_API_KEY
    model "openai/gpt-oss-20b"
    max_tokens 2048
  }
}

// Groq — Strong reasoning for controllers (131K ctx, GPT-OSS 120B)
client<llm> GroqGPT120B {
  provider openai-generic
  retry_policy Exponential
  options {
    base_url "https://api.groq.com/openai/v1"
    api_key env.GROQ_API_KEY
    model "openai/gpt-oss-120b"
    max_tokens 4096
  }
}

// OpenRouter — MiniMax (NVIDIA, strong structured-output reasoning, 131K ctx)
client<llm> OpenRouterMiniMax2_5 {
  provider openai-generic
  retry_policy Exponential
  options {
    base_url "https://openrouter.ai/api/v1"
    api_key env.OPENROUTER_API_KEY
    model "minimax/minimax-m2.5:free"
    max_tokens 4096
  }
}

// OpenRouter — Nemotron Super (NVIDIA, strong structured-output reasoning, 131K ctx)
client<llm> OpenRouterNemotron120B {
  provider openai-generic
  retry_policy Exponential
  options {
    base_url "https://openrouter.ai/api/v1"
    api_key env.OPENROUTER_API_KEY
    model "nvidia/nemotron-3-super-120b-a12b:free"
    max_tokens 4096
  }
}


client<llm> OpenRouterNemotron3Nano30B {
  provider openai-generic
  retry_policy Exponential
  options {
    base_url "https://openrouter.ai/api/v1"
    api_key env.OPENROUTER_API_KEY
    model "nvidia/nemotron-3-nano-30b-a3b:free"
    max_tokens 4096
  }
}

// OpenRouter — Gemma 4 27B (Google, fast synthesis, 128K ctx)
client<llm> OpenRouterGemma4 {
  provider openai-generic
  retry_policy Exponential
  options {
    base_url "https://openrouter.ai/api/v1"
    api_key env.OPENROUTER_API_KEY
    model "google/gemma-4-31b-it:free"
    max_tokens 4096
  }
}

// Groq — Evaluation & critique (Qwen3 32B, 400 t/s, 32K ctx)
client<llm> GroqQwen3_32b {
  provider openai-generic
  retry_policy Exponential
  options {
    base_url "https://api.groq.com/openai/v1"
    api_key env.GROQ_API_KEY
    model "qwen/qwen3-32b"
    max_tokens 2048
  }
}

// Using the new OpenAI Responses API for enhanced formatting
client<llm> OpenAIGPT5 {
  provider openai-responses
  options {
    model "gpt-5"
    api_key env.OPENAI_API_KEY
  }
}

client<llm> OpenAIGPT5Mini {
  provider openai-responses
  retry_policy Exponential
  options {
    model "gpt-5-mini"
    api_key env.OPENAI_API_KEY
  }
}

// Fastest, most cost-efficient OpenAI model
client<llm> OpenAIGPT5Nano {
  provider openai-responses
  retry_policy Exponential
  options {
    model "gpt-5-nano"
    api_key env.OPENAI_API_KEY
  }
}

// Openai with chat completion
client<llm> OpenAIGPT5Chat {
  provider openai
  options {
    model "gpt-5"
    api_key env.OPENAI_API_KEY
  }
}

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
    // templates (simpleLoop.baml / actorCritic.baml). Providers without this
    // allowlist silently drop the metadata, so the same templates stay safe
    // on the Groq/OpenRouter/OpenAI chains.
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
// keeps thinking, deliberately: the actor, router, critic and synthesizer are
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

// Example Azure OpenAI client (uncomment to use)
// client<llm> CustomAzure {
//   provider azure-openai
//   options {
//     model "gpt-5"
//     api_key env.AZURE_OPENAI_API_KEY
//     base_url "https://MY_RESOURCE_NAME.openai.azure.com/openai/deployments/MY_DEPLOYMENT_ID"
//     api_version "2024-10-01-preview"
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


// https://docs.boundaryml.com/docs/snippets/clients/round-robin
client<llm> CustomFast {
  provider round-robin
  options {
    // This will alternate between the two clients
    strategy [OpenAIGPT5Mini, AnthropicHaiku45]
  }
}

// Per-use-case fallback clients (Groq-only; LocalGLM available in local-client.baml)
client<llm> RouterFallback {
  provider fallback
  options {
    // Classification only — fast 20B model sufficient, 120B as backstop
    strategy [OpenRouterGemma4, GroqFast, GroqGPT120B, AnthropicSonnet46]
  }
}

client<llm> ControllerFallback {
  provider fallback
  options {
    // 1. GroqGPT120B — gpt-oss-120b, fastest; 2. OpenRouterNemotron120B — when Groq fails structured output
    // on large context; 3. OpenAIGPT5Chat — reliable OpenAI fallback
    strategy [OpenRouterNemotron120B, OpenRouterMiniMax2_5, GroqGPT120B, OpenAIGPT5, AnthropicSonnet46]
  }
}

client<llm> CriticFallback {
  provider fallback
  options {
    // Qwen3-32B purpose-built for evaluation; GroqGPT120B as backstop
    strategy [GroqQwen3_32b, GroqGPT120B, OpenRouterMiniMax2_5, AnthropicSonnet46]
  }
}

client<llm> SynthesizerFallback {
  provider fallback
  options {
    // 1. OpenRouterGemma4 — fast prose synthesis; 2. GroqQwen3_32b (Qwen3-32B); 3. OpenAIGPT5Mini
    strategy [OpenRouterGemma4, GroqQwen3_32b, OpenAIGPT5, AnthropicSonnet46]
  }
}

// Lightweight summarization — fast 20B model is sufficient alone
client<llm> DescribeFallback {
  provider fallback
  options {
    strategy [GroqFast, OpenRouterGemma4, OpenAIGPT5, AnthropicHaiku45]
  }
}

// https://docs.boundaryml.com/docs/snippets/clients/fallback
// client<llm> OpenaiFallback {
//   provider fallback
//   options {
//     // This will try the clients in order until one succeeds
//     strategy [OpenAIGPT5Mini, OpenAIGPT5]
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
