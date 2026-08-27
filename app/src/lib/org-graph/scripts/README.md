# Org-graph scripts

Live-tenant, live-database entry points for the organisational graph. They
complement the hermetic vitest suites under `app/src/__tests__/lib/org-graph/`
and `.../lib/privacy/org-roster.test.ts` — those mock `fetch` and the Neo4j
driver, so they never touch the tenant. These scripts talk to the real thing.

There is no UI and no `'use server'` RPC for any of this on purpose: a function
that wipes a graph or reads the whole directory must not be browser-reachable.
See the header of `../schema.server.ts`.

## Prerequisites

- Neo4j up: `docker compose up -d` from the repo root.
- `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` in `app/.env`,
  with the **`User.Read.All` application permission** admin-consented on the app
  registration. Client credentials, not a delegated sign-in — the roster is the
  whole tenant, so there is no user whose delegated view would be right.
- For `enrich-sharepoint-edges.ts` only: `ORG_GRAPH_OWNER_EMAIL` in `.env`, the
  email of an account that has signed into this app at least once (via
  `/auth/signin`, so a Graph token cache exists for it) with `Sites.Read.All`
  and `Files.Read.All` consented. This is the **opposite** credential shape
  from the other three scripts — a delegated per-user token, not client
  credentials — see that script's own header for why.

Run from `app/`. The `--env-file=.env` flag is how these pick up `.env` without
a `dotenv` import (same convention as `../../sandbox/scripts/`).

## The scripts

| File                         | Touches       | Destructive                                                          |
| ---------------------------- | ------------- | -------------------------------------------------------------------- |
| `setup-org-graph.ts`         | Neo4j schema  | only with `--wipe`                                                   |
| `ingest-roster.ts`           | Graph → Neo4j | no (upsert)                                                          |
| `enrich-org-edges.ts`        | Neo4j only    | no (idempotent — clears/re-derives its own inferred structure only)  |
| `enrich-sharepoint-edges.ts` | Graph → Neo4j | no (idempotent — clears/re-derives only its own `COLLABORATES_WITH`) |

`enrich-org-edges.ts` needs no Graph credential and no `AZURE_*` env — it reads
and writes the local graph only, deriving `MEMBER_OF` groupings and `Resource`
reclassification from the roster `ingest-roster.ts` already wrote. Run it after
that, any time; see `docs/org-graph.md` §8.

`enrich-sharepoint-edges.ts` also needs the roster written first (it matches
Graph identities against `Member.entraId`/`Member.mail`), but its Graph
credential is the **owner's own delegated sign-in**, not the app-only
client-credentials grant the other Graph-touching script uses — see
`docs/org-graph.md` §9.

```sh
# idempotent: creates missing constraints, deletes nothing
pnpm dlx tsx --env-file=.env src/lib/org-graph/scripts/setup-org-graph.ts

# the ONE-SHOT migration — prompts for the confirmation phrase
pnpm dlx tsx --env-file=.env src/lib/org-graph/scripts/setup-org-graph.ts --wipe

pnpm dlx tsx --env-file=.env src/lib/org-graph/scripts/ingest-roster.ts

pnpm dlx tsx --env-file=.env src/lib/org-graph/scripts/enrich-org-edges.ts

pnpm dlx tsx --env-file=.env src/lib/org-graph/scripts/enrich-sharepoint-edges.ts
```

**Ordering note:** `enrich-org-edges.ts` clears **every** relationship
carrying `inferred: true`, of any type, by design (its own header explains
why). Running it after `enrich-sharepoint-edges.ts` therefore also clears that
script's `COLLABORATES_WITH` edges — re-run `enrich-sharepoint-edges.ts`
afterwards if you need both kinds of inferred structure present at once. This
is pre-existing behaviour of the older script, not something introduced here.

A third, `smoke-pseudonymise.ts`, is run the same way but lives elsewhere:

```sh
pnpm dlx tsx --env-file=.env src/__tests__/lib/privacy/smoke-pseudonymise.ts
```

It is the one script that composes `lib/privacy/*`, and
`src/__tests__/lib/privacy/egress-wiring.test.ts` asserts that nothing outside
`src/__tests__/` does — that tripwire is a deliberate stop sign in front of the
open questions in `docs/plan/graph-pseudonymisation.md`, and hand-run
verification is not the production hook it is watching for. So the script sits
next to the tripwire rather than here; its own header carries the reasoning.
Everything below applies to it unchanged.

`--wipe` was authorised once, for the migration to an organisational-only graph.
The wipe lives behind a required confirmation **argument** (not a flag, not an
env var) so it can never become a side effect of ordinary setup — re-read
`wipeAndApplyOrgGraphSchema` before reaching for it again.

## Output is redacted

Every script prints counts, property names and reason codes only. Where an
identity has to be shown at all — `smoke-pseudonymise.ts` has to prove a
_specific_ real name was replaced — it goes through `mask()` in `_redact.ts`,
which replaces every alphanumeric run with a **fixed-width** `···`, so neither
the initial nor the length of a name survives into a pasted transcript.
Assertions run on the unmasked strings in memory. That is output hygiene, not a
security control: it keeps a transcript pasteable, and the thing that makes it
pasteable is that nothing in it identifies anybody.

One thing it does **not** cover: `ingest-roster.ts`'s error path prints
`err.message`, and a Graph error carries the request path — which on the
memberships loop contains a member's Entra object id. Still no display name and
no address, but an opaque directory identifier is not nothing, so that path
masks the id out before printing (see `maskGraphIds` in `_redact.ts`).

## What "passing" looks like

- `setup-org-graph.ts`: all ontology constraints present, no leftovers. Without
  `--wipe`, pre-ontology data is reported as drift and **left alone** — that is
  the guarantee, not a failure.
- `ingest-roster.ts`: `written + rejected rows == fetched`, constraints
  complete, non-conformance `none`. A non-zero `incomplete` tally is expected —
  it is the ontology's soft tier reporting how much of the directory the tenant
  has filled in (`docs/org-graph.md`).
- `smoke-pseudonymise.ts`: `all assertions passed`. Case 1 is _meant_ to show a
  leak — it reproduces the payload-only limitation against real data, which is
  the baseline case 2 improves on.
- `enrich-org-edges.ts`: non-conformance `none` afterwards, same as the ingest.
  `0` everywhere in the report body is not a failure by itself — it means the
  roster has nothing the current bases can see yet (see `docs/org-graph.md`
  §1 on how sparse `department` is on the live tenant).
- `enrich-sharepoint-edges.ts`: non-conformance `none` afterwards. `0` pairs
  written is not a failure — it means the owner's own SharePoint visibility
  showed no cross-member folder activity in this run. A `GraphAuthRequiredError`
  means exactly one thing: the `ORG_GRAPH_OWNER_EMAIL` account's sign-in has
  expired or was never completed — sign in again at `/auth/signin` and re-run.
