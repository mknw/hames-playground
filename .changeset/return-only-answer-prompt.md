---
"@hames-ai/harness-baml": patch
---

`LoopController`'s default (`returnStyle: 'summary'`) prompt now tells the controller to put the complete answer in `tool_args` when it called no tool in the task (#615). A Return-only turn has no tool result for the synthesizer to compose from, and #612 hands that Return text on as the answer; before, the prompt said the Return was "NOT the user-facing answer", so whether the text held the answer depended on the model. A turn that called a tool is unchanged (the Return stays a brief summary, #149); `returnStyle: 'answer'` is unchanged. The regenerated `baml_client` ships with it.
