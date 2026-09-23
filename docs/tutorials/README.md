# Tutorials

## What this is

Step-by-step pages for developers building their own application on the
`@hames-ai` packages. Each page takes one task — running an agent's turn from
your own code, guarding an agent against untrusted tool output, running
agent-written code in a container, calling a model you host yourself — and
walks it from start to finish. Every TypeScript snippet on these pages is
compiled against the real packages by this repository's test suite, so a
snippet that stops matching the code fails a test instead of going stale.

Three words the pages lean on: your _host_ is your own application, the code
that imports these packages; a _run frame_ is the bundle of settings one run of
an agent carries from start to finish (for example its budgets, which models it
uses, and who is listening for live events), opened once per run and read by
every step inside it; and
a _pattern_ is one composable step of an agent, such as a tool loop or a
router. Every other term is in the [glossary](../../GLOSSARY.md).

## Which package do you need?

Five packages that work together. The first is the foundation; add the others
for what they do.

| If you want to…                                                                                            | Use                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| build an agent out of composable pieces — tool loops, routers, planners                                    | [`@hames-ai/harness-patterns`](https://github.com/mknw/hames-playground/tree/main/packages/harness-patterns#readme) |
| get typed model calls with the prompts already written, on Anthropic or your own model provider            | [`@hames-ai/harness-baml`](https://github.com/mknw/hames-playground/tree/main/packages/harness-baml#readme)         |
| use a ready-made agent                                                                                     | [`@hames-ai/agents`](https://github.com/mknw/hames-playground/tree/main/packages/agents#readme)                     |
| use Microsoft 365 or the Neo4j graph database from an agent, or sort an MCP server's tools into namespaces | [`@hames-ai/connectors`](https://github.com/mknw/hames-playground/tree/main/packages/connectors#readme)             |
| run agent-written code in a container                                                                      | [`@hames-ai/sandbox`](https://github.com/mknw/hames-playground/tree/main/packages/sandbox#readme)                   |

## See it running

The [hames app](https://github.com/mknw/hames-playground) is the reference
host for all five packages: a self-hosted agent workspace whose agents are
built from them, with every step of every run visible in its UI. Its
[Quickstart](https://github.com/mknw/hames-playground#quickstart) runs it
locally with Docker and pnpm.

## Install

Five packages, and only the first is mandatory. Each companion declares
`@hames-ai/harness-patterns` as a **peer**, so you add it yourself — the core package keeps
per-run state in Node's `AsyncLocalStorage`, and two installed copies of it would keep two
separate copies of that state that never see each other.

| Package                      | Bring it in when                                                               |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `@hames-ai/harness-patterns` | always — patterns, event views, the injection guard, tool calling over MCP     |
| `@hames-ai/harness-baml`     | you want the shipped prompts and model adapters                                |
| `@hames-ai/agents`           | you want the six ready-made agent definitions                                  |
| `@hames-ai/sandbox`          | you want to run code in a container                                            |
| `@hames-ai/connectors`       | you want the MCP tool-namespace map, a Neo4j client or the Microsoft 365 tools |

```bash
pnpm add @hames-ai/harness-patterns
pnpm add @hames-ai/harness-baml @hames-ai/agents @hames-ai/sandbox @hames-ai/connectors
```

`@hames-ai/connectors` is the one easy to skip and then need two pages later: `mcpNamespace`
lives there (the registration the injection guard's refusal tells you to make), and so does
`configureNeo4j`.

**You need a TypeScript bundler.** These packages ship TypeScript source — every code
target in `exports` is a `.ts` file and there is no `dist/`. Vite, esbuild, tsx and Bun run
them as-is; a plain `node dist/index.js` does not. Anything that calls a model through
`@hames-ai/harness-baml` needs `ANTHROPIC_API_KEY` set.

## Pages

| Page                                                                | You will build                                                                                                                                                |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Hosting the harness](./hosting-the-harness.md)                     | Running a turn from your own application: the run frame a turn opens, the five settings it holds, what breaks when you skip it, and one complete host to copy |
| [Wiring a host](./wiring-a-host.md)                                 | Your startup code: what to register once at boot, the one `AgentDeps` object every agent shares, and adding icons when you register agents                    |
| [Guarding an agent](./guarding-an-agent.md)                         | A loop over a hostile tool, wrapped in the injection guard — and the exact event a caught injection produces                                                  |
| [Running code in a sandbox](./running-code-in-a-sandbox.md)         | A sandboxed pattern: network access profiles, how long a container is kept, and picking a specialised image per turn                                          |
| [Attaching a sandbox workspace](./attaching-a-sandbox-workspace.md) | Keeping `/work` files between sessions — plugging in a workspace store, `syncWorkspace`, and keeping each user's files separate                               |
| [Bring your own provider or model](./own-provider-or-model.md)      | The shipped agents calling a model you supply — a different provider or a self-hosted endpoint — without touching prompts                                     |

### Examples directory

Every complete page above also ships its code as one file, under
[`examples/`](./examples/README.md) — that page's fences assembled into a single runnable
`.ts` you can copy or clone instead of reassembling it from the prose. The pages stay the
explanation; the files are the thing you run. [Wiring a host](./wiring-a-host.md) has no
example file, because it is still a stub: there is nothing to assemble yet.

## Suggested order

If you are starting cold, begin with hosting-the-harness, because it gets a turn running
before any theory; read [GUIDE.md](../../packages/harness-patterns/GUIDE.md) second, for the
model behind what you just ran. Everything else hangs off hosting-the-harness:

```text
hosting-the-harness                   →  a turn runs
        │
        ├──▶ guarding-an-agent            (before any untrusted tool result reaches a model)
        ├──▶ own-provider-or-model        (before any call leaves for someone else's API)
        └──▶ running-code-in-a-sandbox    (before any agent-authored code runs)
                    │
                    ▼
             attaching-a-sandbox-workspace

wiring-a-host                         →  your startup code (STUB — see the page)
```

## How these pages relate to the other docs

Three kinds of document, three different jobs:

| Document                                                                                                                                                                                                                                                                  | Answers                                     | Read it                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | --------------------------------- |
| **Tutorials** (here)                                                                                                                                                                                                                                                      | "how do I use X in my app?"                 | start to finish, once per task    |
| **[GUIDE.md](../../packages/harness-patterns/GUIDE.md)**                                                                                                                                                                                                                  | "how does the framework think?"             | second, after your first tutorial |
| **Package READMEs** ([patterns](../../packages/harness-patterns/README.md) · [baml](../../packages/harness-baml/README.md) · [agents](../../packages/agents/README.md) · [sandbox](../../packages/sandbox/README.md) · [connectors](../../packages/connectors/README.md)) | "what can I import, and what do I pass in?" | when you need a signature         |

The developer guide carries the composition model, how to write your own pattern, how tool
calls are routed to your own tool servers, and the error surface — the concepts every page
here assumes.
[SPEC.md](../../packages/harness-patterns/SPEC.md) is the per-pattern reference underneath
both. A tutorial never restates a signature the README owns; it links to it.

## Conventions

- **Every TypeScript snippet is compiled against the real packages** by
  `app/src/__tests__/docs/tutorials-docs-pins.test.ts`, which extracts each fence and type-checks
  it against the live source. A snippet that drifts from the shipped surface fails CI rather
  than rotting quietly. Snippets that need infrastructure a test cannot reach (a container
  engine, an MCP gateway, a document store) stand their host values up with `declare const`
  — the wiring is still checked; only the I/O is not performed.
- **Output blocks are real.** Every event payload, error message and log line quoted in
  these pages was captured from a run, not paraphrased.
- The model contract is **your own provider or model, the same prompts**: you supply clients by
  role, the prompts and output schemas stay the ones the package declares, and no accessor
  to the generated BAML client ships.

## Related

- [`docs/INDEX.md`](../INDEX.md) — every document in this repository.
- [`GLOSSARY.md`](../../GLOSSARY.md) — definitions of _pattern_, _controller_, _actor_,
  _critic_, _harness_, _EventView_, _tool namespace_, _sandbox flavour_ and the rest.
- [`docs/adr/`](../adr/README.md) — the design decisions behind these pages.
