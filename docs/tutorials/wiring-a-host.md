# Wiring a host

> **STUB — the worked example follows.** The composition root is being rewritten
> ([#374](https://github.com/mknw/hames-playground/issues/374) candidate 2): the app's
> boot-time wiring collapses into **one `configureHarness`-style call taking suppliers**,
> with the deployment's tool surface passed as a single value. A full worked example
> written against today's shape would be wrong within the week, and a tutorial that is
> wrong is worse than a tutorial that is missing. This page names the seam now and gains
> its example when that PR lands.

**Audience:** someone past "a turn runs" and building the composition root — the one place
that decides what the packages are allowed to reach.

---

## The seam, which is not changing

The packages own protocols; the **host owns identity, storage, catalogs, policy and
presentation**. Nothing crosses that line by import — it crosses by **supply**. That
division is the stable part; only its call shape is in flux.

What a host supplies, and why none of it can live in a package:

| Supplied                        | Why it is the host's                                                  |
| ------------------------------- | --------------------------------------------------------------------- |
| the tool→namespace catalog      | it is _this deployment's_ map; a default would hide a moved catalog   |
| tool transports                 | what your process can actually run                                    |
| storage (documents, workspaces) | your database, your retention, your content classification            |
| tenant identity                 | resolved server-side from your auth, never accepted as input          |
| inference routing               | tier policy is app policy; the package never imports a host's clients |
| presentation                    | icons, accents — the agent definitions carry none                     |

## Three rules that outlive the rewrite

These are properties of _when_ and _what_, not of the call shape, so they hold either way.

1. **Explicit-config-only seams are set before any request, not lazily.** Several package
   seams refuse rather than degrade — an unset one is a named error at first use, never a
   silent no-op. That is precisely why they belong at boot: the one place that runs before
   any request is the one place that can guarantee they are set. See
   [attaching a sandbox workspace §2](./attaching-a-sandbox-workspace.md#2-supply-the-store)
   for the worked version of one of them, including both of its refusals.

2. **Register the tool→namespace catalog _and_ pass it to every `Tools()` call.** The
   registration is the default the **injection guard** consults; the explicit `namespaces`
   argument is what **grouping** consults. Setting both from one map is what makes a missing
   catalog loud instead of silent — the guard refuses a namespace it cannot verify, which is
   [exactly what you see](./guarding-an-agent.md#4-the-three-refusals) when the registration
   is missing.

3. **Tenant identity is a resolver, not a literal.** A host builds its patterns once and
   caches the chain for a conversation's life; the authenticated user is only in scope for
   one turn. A literal read at wrap time freezes whichever tenant was in scope during the
   build onto every later turn — silently, on the one field isolation is scoped by. The full
   rule, with the code, is
   [attaching a sandbox workspace §5](./attaching-a-sandbox-workspace.md#5-the-tenant-seam).

## What is deliberately not here yet

The worked example — which file calls what, in which order, at this repo's own composition
root. It is held rather than guessed, because #374 candidate 2 changes exactly that. Until
it lands:

- For **inference routing**, [bring your own provider or model](./own-provider-or-model.md)
  is complete and unaffected — it documents the role map and the plug, not the boot call.
- For **containment**, [running code in a sandbox](./running-code-in-a-sandbox.md) and
  [attaching a sandbox workspace](./attaching-a-sandbox-workspace.md) carry the supplier
  shapes their own features need.
- For **the run itself**, [hosting the harness](./hosting-the-harness.md) covers the run
  frame and a complete minimal host.

## Where to go next

- [`@hames-ai/agents` README](../../packages/agents/README.md) — the injected / imported /
  overlaid table, which is the seam this page will illustrate.
- [`@hames-ai/connectors` README](../../packages/connectors/README.md) — the other
  explicit-config-only seam and its injected suppliers.
- [`@hames-ai/harness-patterns` GUIDE](../../packages/harness-patterns/GUIDE.md) — the
  composition model underneath all of it.
