# Harness patterns: design records

This page used to be the overview of the harness-patterns framework, written before
the framework moved into its own packages under [`packages/`](../../packages/) and
was published as the `@hames-ai/*` npm packages. Its overview, pattern catalog and
example now live with the packages:

| You want                                                       | Read                                                                               |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| What the framework is, how to install it, a first example      | [`packages/harness-patterns/README.md`](../../packages/harness-patterns/README.md) |
| The concepts: context, scopes, views, combinators, errors      | [`packages/harness-patterns/GUIDE.md`](../../packages/harness-patterns/GUIDE.md)   |
| Every pattern's signature and configuration                    | [`packages/harness-patterns/SPEC.md`](../../packages/harness-patterns/SPEC.md)     |
| The model adapters and prompts                                 | [`packages/harness-baml/README.md`](../../packages/harness-baml/README.md)         |
| The ready-made agents and how each is composed                 | [`packages/agents/README.md`](../../packages/agents/README.md)                     |
| Task walkthroughs: hosting a turn, guarding, sandboxes, models | [`docs/tutorials/`](../tutorials/README.md)                                        |

What this directory still holds is the record behind some of those designs, kept
because the package docs describe what the code does and not why it came out that
way:

| Page                                                                                 | What it records                                                                                                                                       |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`with-references.md`](./with-references.md)                                         | The design of `withReferences`, which attaches relevant results of earlier turns when a pattern starts, and where the shipped wrapper departs from it |
| [`withReferences-tutorial.md`](./withReferences-tutorial.md)                         | A two-turn walkthrough of that wrapper in the hames app, this repository's reference host                                                             |
| [`parallel.md`](./parallel.md)                                                       | What `parallel` does, and two options for it that were considered and not built                                                                       |
| [`prompt-caching.md`](./prompt-caching.md)                                           | One live run of the prompt-caching bench, and where the cache markers live now                                                                        |
| [`api.md`](./api.md), [`examples.md`](./examples.md), [`frontend.md`](./frontend.md) | Former reference pages, now short pointers to where their content moved                                                                               |

The three `hames_*.png` files beside these pages are the project logo. The root
README displays the two on a transparent background; the third, on a light
background, is referenced nowhere in the repository.
