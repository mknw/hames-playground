---
"@hames-ai/agents": minor
---

HELD (#507 default flip): `general` no longer opts into memory, which moves to
`general-next`; in the picker `general-next` replaces `general`, which stays
registered but unlisted so stored `general` conversations keep opening on it.
A new chat opens on `general-next` (`DEFAULT_AGENT_ID`) instead of `search`.
