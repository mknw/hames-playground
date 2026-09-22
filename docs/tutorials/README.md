# Tutorials

Task-shaped pages for developers building **on** the `@hames` packages: pick the one that
names what you are trying to do, follow it start to finish, have it working in ten
minutes.

## What these are, and what they are not

Three kinds of document, three different jobs:

| Document                                                                                                                                                                                                                                                                  | Answers                                      | Read it                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------- |
| **Tutorials** (here)                                                                                                                                                                                                                                                      | "how do I use X in my app?"                  | start to finish, once per task  |
| **[GUIDE.md](../../packages/harness-patterns/GUIDE.md)**                                                                                                                                                                                                                  | "how does the framework think?"              | once, before the first tutorial |
| **Package READMEs** ([patterns](../../packages/harness-patterns/README.md) · [baml](../../packages/harness-baml/README.md) · [agents](../../packages/agents/README.md) · [sandbox](../../packages/sandbox/README.md) · [connectors](../../packages/connectors/README.md)) | "what is the surface, and what is injected?" | when you need a signature       |

The developer guide carries the composition model, how to write your own pattern, the
tool-transport seam and the error surface — the concepts every page here assumes.
[SPEC.md](../../packages/harness-patterns/SPEC.md) is the per-pattern reference underneath
both. A tutorial never restates a signature the README owns; it links to it.

## The pages

| Page                                                                            | You will build                                                                                                            |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| [Hosting the harness in your own app](./hosting-the-harness-in-your-own-app.md) | A working agent inside your own process — no model, no gateway — then each stand-in swapped for the real thing            |
| [Wiring a host](./wiring-a-host.md)                                             | The composition root: boot-time seams, the one `AgentDeps` bag, and the registration overlay                              |
| [Guarding an agent](./guarding-an-agent.md)                                     | A loop over a hostile tool, wrapped in the injection guard — and the exact event a caught injection produces              |
| [Running code in a sandbox](./running-code-in-a-sandbox.md)                     | A sandboxed pattern: egress profiles, attachment lifetimes, and per-turn flavour selection                                |
| [Attaching a sandbox workspace](./attaching-a-sandbox-workspace.md)             | The durable `/work` seam — a workspace store, `syncWorkspace`, and the tenant boundary                                    |
| [Bring your own provider or model](./own-provider-or-model.md)                  | The shipped agents calling a model you supply — a different provider or a self-hosted endpoint — without touching prompts |

## Suggested order

If you are starting cold, the first two pages are the spine:

```text
hosting-the-harness-in-your-own-app   →  it runs
        │
        ▼
wiring-a-host                         →  it runs on YOUR catalog, store and policy
        │
        ├──▶ guarding-an-agent            (before any untrusted tool result reaches a model)
        ├──▶ own-provider-or-model        (before any call leaves for someone else's API)
        └──▶ running-code-in-a-sandbox    (before any agent-authored code runs)
                    │
                    ▼
             attaching-a-sandbox-workspace
```

## Conventions

- **Every TypeScript snippet is compiled against the real packages** by
  `app/src/__tests__/docs/tutorials-docs-pins.test.ts`, which extracts each fence and type-checks
  it against the live source. A snippet that drifts from the shipped surface fails CI rather
  than rotting quietly. Snippets that need infrastructure a test cannot reach (a container
  engine, an MCP gateway, a document store) stand their host values up with `declare const`
  — the wiring is still checked; only the I/O is not performed.
- **Output blocks are real.** Every event payload, error message and log line quoted in
  these pages was captured from a run, not paraphrased.
- The V1 model contract is **own provider or model, same prompts**: you supply clients by
  role, the prompts and output schemas stay the ones the package declares, and no accessor
  to the generated BAML client ships.

## Related

- [`docs/INDEX.md`](../INDEX.md) — every document in this repository.
- [`GLOSSARY.md`](../../GLOSSARY.md) — the house vocabulary: _pattern_, _controller_,
  _actor_, _critic_, _harness_, _EventView_, _tool namespace_, _sandbox flavour_.
- [`docs/adr/`](../adr/README.md) — the decisions these pages describe the consequences of.
