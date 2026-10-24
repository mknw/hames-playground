---
"@hames-ai/harness-playground": patch
---

**The environment VM guard's smoke attributes its trace evidence by the guard's own traversal, not by trace id.**

nft assigns a new trace id per hook traversal (captured live on nft 1.1.6, `scripts/env-vm-guard-nft116-trace.txt`), so a refused probe's SYN is one prerouting id with no guard-table verdict and a separate forward id carrying the `drop`. Grouping by trace id read every packet twice — once with no verdict at all — and the smoke refused every refusal ("not every packet was traced to its own rule's drop") with the counter having moved by exactly the dropped packets; probe 8c's attribution carried the same assumption. The evidence is now the ids that reached the guard's table, each a clean drop on the probe's ingress, with the counter's change measured against those. The test fake emits per-hook ids like the real nft; the reverted mutation turns the smoke corpus red (214/214 killed).
