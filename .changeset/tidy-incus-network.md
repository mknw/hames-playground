---
'@hames-ai/sandbox': patch
---

Seed Incus VM networking by the validated device MAC before first boot, so predictable guest interface names receive DHCPv4. Refuse invalid MACs, failed seed writes and configuration drift; already-booted unseeded VMs require operator recreation.
