---
'@hames-ai/connectors': patch
---

Request the already-consented Calendars.ReadWrite scope for calendar reads so
sign-in and delegated token minting do not require a new Calendars.Read consent.
No Microsoft Graph write tool is added.
