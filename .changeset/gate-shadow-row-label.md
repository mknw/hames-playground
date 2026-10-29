---
"@hames-ai/harness-patterns": patch
---

A shadow guard gate's `decision_made` event gains `wouldRun`: what the gate WOULD have decided at its own configured threshold — run the screen or skip it (#784 item 10). The observability row for such an event reads `wouldRun` instead of the model's argmax `label`, which for a pTrue between the threshold and 0.5 read `false` while the gate would have run the screen.
