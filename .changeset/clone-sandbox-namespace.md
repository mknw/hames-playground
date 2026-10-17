---
"@hames-ai/sandbox": patch
---

Scope sandbox, egress proxy and network labels and startup cleanup by SANDBOX_ENVIRONMENT so one app clone cannot reap another clone's resources. Production backends require an explicit environment namespace.
