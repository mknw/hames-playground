---
"@hames-ai/harness-baml": patch
---

The Jev decide transport (#418 O1–O4): on an OpenRouter endpoint the request carries `provider: { zdr: true, data_collection: 'deny' }` and refuses to send if that cannot be applied; it reads its own key, `JEV_DECISIONS_API_KEY`, never `OPENROUTER_API_KEY`; `JEV_DECISIONS_URL` must parse to `https:` or a loopback host, and is refused before the key is read.
