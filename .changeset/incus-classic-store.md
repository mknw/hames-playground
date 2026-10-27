---
"@hames-ai/sandbox": patch
---

Incus environment VMs now boot Docker on the classic `overlay2` image store (`storage-driver: overlay2`, `features.containerd-snapshotter: false` in the guest's `daemon.json`), the store the offline VM image preloads. Docker 29's default containerd store would have started with none of the preloaded sandbox images.
