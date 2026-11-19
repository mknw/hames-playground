---
"@hames-ai/harness-baml": patch
---

Label attempts with no output before passing them to ActorController or Critic, so a successful tool call without data cannot fail BAML's required result validation on the next attempt. Preserve execution errors and critic feedback.
