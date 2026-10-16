---
"@hames-ai/agents": minor
---

HELD (#507 default flip): `general` no longer opts into memory, which moves to
`general-next`; the app registers `general-next` in `general`'s picker slot and
resolves stored `general` ids to it. A new chat opens on `general-next`
(`DEFAULT_AGENT_ID`) instead of `search`.
