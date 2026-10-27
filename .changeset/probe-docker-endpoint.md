---
"@hames-ai/sandbox": minor
---

Add `probeDockerEndpoint` to the operator-only `./incus-environment.server` subpath. It makes one mutual-TLS `GET /_ping` with exactly the four `SANDBOX_DOCKER_*` settings an app receives, and returns a `DockerProbe`. When ready, the result carries the client certificate's expiry. When not, it carries one of `unreachable`, `refused`, `not-ready` or `untrusted-server`; only `untrusted-server`, any server-certificate verification failure, is final. Each probe opens a fresh connection and is bounded by `timeoutMs` (10 s by default). Plaintext, an unverified server and any answer other than `200 OK` are never ready.
