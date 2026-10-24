---
"@hames-ai/sandbox": patch
---

**The local-files image import names the disk part `rootfs.img`, so the imported image is a virtual-machine image.**

Incus types the imported image by the multipart field name of the disk part (`cmd/incusd/images.go`): `rootfs.img` is a virtual-machine image, plain `rootfs` a container one. #743 named the part `rootfs`, so a pinned local-files import landed as a container image that passed its fingerprint pin and then refused every VM create with "Asked for a VM but image is of type container" — found live in the environment-VM window (2026-10-24) at the first real reconcile on the W8 host. The test's fake Incus mirrors the server it fakes: a disk part with the wrong name is a 400, so the reverted mutation turns the suite red.
