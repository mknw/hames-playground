---
"@hames-ai/sandbox": minor
---

The environment VM entry point's `image` option gains a local-files source: the
config names the staged metadata tarball and disk image plus the pinned
fingerprint, and `reconcile` imports both files into the environment's own Incus
project over the project-restricted certificate, refusing — after deleting the
imported image and before creating any instance — unless Incus's computed
fingerprint equals the pin. The staged files are checked first (absolute, no
symlink in the path, regular, root-owned, not group/other-writable, bounded, and
outside any checkout). The HTTPS simplestreams source is unchanged in behaviour.
