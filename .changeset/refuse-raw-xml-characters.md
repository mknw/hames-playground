---
'@hames-ai/harness-patterns': patch
---

Refuse raw characters outside XML 1.0's Char production, including lone surrogates, in the shared XML tokenizer. XML parsing, scanning and ZIP validation now reject malformed parts before document disarming can treat them as clean.
