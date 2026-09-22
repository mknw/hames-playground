# Tutorials

Task-shaped pages for developers building **on** the `@hames-ai` packages: pick the one that
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

| Page                                                                | You will build                                                                                                                                    |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Hosting the harness](./hosting-the-harness.md)                     | Running a turn from your own application: the run frame a turn opens, its five slots, what breaks when you skip it, and one complete host to copy |
| [Wiring a host](./wiring-a-host.md)                                 | The composition root: boot-time seams, the one `AgentDeps` bag, and the registration overlay                                                      |
| [Guarding an agent](./guarding-an-agent.md)                         | A loop over a hostile tool, wrapped in the injection guard — and the exact event a caught injection produces                                      |
| [Running code in a sandbox](./running-code-in-a-sandbox.md)         | A sandboxed pattern: egress profiles, attachment lifetimes, and per-turn flavour selection                                                        |
| [Attaching a sandbox workspace](./attaching-a-sandbox-workspace.md) | The durable `/work` seam — a workspace store, `syncWorkspace`, and the tenant boundary                                                            |
| [Bring your own provider or model](./own-provider-or-model.md)      | The shipped agents calling a model you supply — a different provider or a self-hosted endpoint — without touching prompts                         |

### The examples directory

Every complete page above also ships its code as one file, under
[`examples/`](./examples/README.md) — that page's fences assembled into a single runnable
`.ts` you can copy or clone instead of reassembling it from the prose. The pages stay the
explanation; the files are the thing you run. [Wiring a host](./wiring-a-host.md) has no
example file, because it is still a stub: there is nothing to assemble yet.

## Install

Five packages, and only the first is mandatory. Each companion declares
`@hames-ai/harness-patterns` as a **peer**, so you add it yourself — the companions hold
module-level `AsyncLocalStorage` scopes, and two resolved copies of the core package would
be two scopes that never see each other.

| Package                   | Bring it in when                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------- |
| `@hames-ai/harness-patterns` | always — patterns, event views, the guard, the tool transport                          |
| `@hames-ai/harness-baml`     | you want the shipped prompts and model adapters                                        |
| `@hames-ai/agents`           | you want the six ready-made agent definitions                                          |
| `@hames-ai/sandbox`          | you want to run code in a container                                                    |
| `@hames-ai/connectors`       | you want this deployment's MCP catalog, the Neo4j non-agentic layer or the Graph tools |

```bash
pnpm add @hames-ai/harness-patterns
pnpm add @hames-ai/harness-baml @hames-ai/agents @hames-ai/sandbox @hames-ai/connectors
```

`@hames-ai/connectors` is the one easy to skip and then need two pages later: `mcpNamespace`
lives there (the registration the injection guard's refusal tells you to make), and so does
`configureNeo4j`.

**You must be a TS-bundler consumer.** These packages ship TypeScript source — `main` and
every code target in `exports` is a `.ts` file (`./package.json` is the one non-code entry),
there is no `dist/`, and `pnpm pack` is the whole publish pipeline. Vite, vinxi, esbuild, tsx
and Bun run them as-is; a plain `node dist/index.js` consumer is not supported, deliberately.

## Suggested order

If you are starting cold, the first two pages are the spine:

```text
hosting-the-harness                   →  a turn runs
        │
        ├──▶ guarding-an-agent            (before any untrusted tool result reaches a model)
        ├──▶ own-provider-or-model        (before any call leaves for someone else's API)
        └──▶ running-code-in-a-sandbox    (before any agent-authored code runs)
                    │
                    ▼
             attaching-a-sandbox-workspace

wiring-a-host                         →  the composition root (STUB — see the page)
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
