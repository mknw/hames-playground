---
"@hames-ai/harness-baml": patch
---

`createActorControllerAdapter` keeps `ActorController` on the non-thinking private client when the `controller` pattern is reasoning-configured (`PRIVATE_REASONING_ROLES`). The actor shares the `controller` role but has no reasoning twin, so it used to be sent on the thinking leaf and refused after the call, failing every actorCritic attempt. Routing with the setting unset is unchanged.
