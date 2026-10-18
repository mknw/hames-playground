---
"@hames-ai/sandbox": patch
---

Seed Incus VM networking with a static address matched by MAC before first boot, using the validated guest address, bridge prefix and default gateway without DHCP or nameservers. Refuse invalid MACs, failed seed writes and configuration drift; already-booted unseeded VMs require operator recreation.
