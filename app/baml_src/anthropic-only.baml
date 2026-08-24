// The role chains every BAML function declares. Anthropic is the only
// provider: the mixed-provider chains this file used to be an opt-out FROM
// (RouterFallback / ControllerFallback / … across Groq, OpenRouter and OpenAI,
// gated on `USE_MIXED_CHAINS=1`) were removed 2026-08-24 — their combined rate
// limits made dev iteration on actorCritic / multi-turn scenarios too noisy to
// debug against, and one provider is also one processor to paper. See ADR-0001.
//
// Leaf clients: `clients.baml`. Role → chain map: `harness-patterns/clients.server.ts`.

client<llm> RouterAnthropic {
  provider fallback
  options {
    strategy [AnthropicHaiku45, AnthropicSonnet5]
  }
}

client<llm> ControllerAnthropic {
  provider fallback
  options {
    // Sonnet 5 leads — near-Opus structured-output/agentic quality at Sonnet
    // cost. Backstop is Sonnet 4.6, NOT Haiku: a rate-limit fallback on the
    // controller must stay Sonnet-tier (Haiku's weaker structured output was
    // implicated in tool-loop parse failures).
    //
    // Thinking DISABLED (#139): measured on captured controller prompts, the
    // tool loop decides better without it — 72/72 valid actions vs 70/72, 43%
    // fewer output tokens, and it stops re-querying when it already holds the
    // answer. The trace is never exposed to us, so nothing is lost from
    // `reasoning`. See AnthropicSonnet5NoThink in clients.baml.
    strategy [AnthropicSonnet5NoThink, AnthropicSonnet46NoThink]
  }
}

client<llm> ActorAnthropic {
  provider fallback
  options {
    // The actor keeps thinking ON. Same models as ControllerAnthropic, and it
    // used to share that client — split so the measured simpleLoop change does
    // not silently apply here. The #139 corpus contained ZERO ActorController
    // prompts and nothing deeper than 2 turns; the sandbox actor is the deepest,
    // most multi-step loop we run and the place thinking is most likely to earn
    // its cost. Do not flip this without its own measurement.
    strategy [AnthropicSonnet5, AnthropicSonnet46]
  }
}

client<llm> PlannerAnthropic {
  provider fallback
  options {
    // Thinking left ON, like the actor and unlike ControllerAnthropic. The
    // #139 measurement that disabled thinking covers the simpleLoop CONTROLLER
    // — a per-turn "pick the next tool" decision where the model already holds
    // the answer half the time. The planner is the opposite call: ONE
    // strategic decomposition per chain, made before any tool has run, where
    // the reasoning budget is the whole point. Do not flip this without its
    // own measurement (that corpus contained no Planner prompts).
    strategy [AnthropicSonnet5, AnthropicSonnet46]
  }
}

client<llm> CriticAnthropic {
  provider fallback
  options {
    // Haiku 4.5 leads — critic is short evaluative judgment, doesn't need
    // Sonnet-tier reasoning. Sonnet 5 as backstop.
    strategy [AnthropicHaiku45, AnthropicSonnet5]
  }
}

client<llm> SynthesizerAnthropic {
  provider fallback
  options {
    strategy [AnthropicSonnet5, AnthropicHaiku45]
  }
}

client<llm> DescribeAnthropic {
  provider fallback
  options {
    strategy [AnthropicHaiku45]
  }
}
