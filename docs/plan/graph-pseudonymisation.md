# Pseudonymising Graph tool results — the roster is already in the payload

**Status:** core built and tested (this PR), **wired to nothing**. The open
questions the first version of this document posed were resolved on 2026-08-16
after two research passes (a blast-radius map of every reader/writer of
`conversations.context`, and a placeholder-fidelity study) and three design
rounds — see [Architecture](#architecture-converged-2026-08-16). Wiring follows
as its own work, package name **`anonymize`** (working name).

Code: `ui/src/lib/privacy/graph-roster.ts`, `ui/src/lib/privacy/pseudonymise.ts`.
Tests: `ui/src/__tests__/lib/privacy/` (59 cases). No production module imports
either file, and no dependency was added.

---

## The insight

The problem plan item 3 states is that `conversations.context` now holds
Outlook bodies, calendar entries and SharePoint file content verbatim, and that
all of it is sent to a US processor. Encrypting it protects the database but not
the transfer; excluding it removes the feature. The third option is to send the
content but not the people — which normally means named-entity recognition, and
NER is exactly what you do not want here: a model or a model-sized dependency,
non-deterministic, unauditable, per-call latency, and trained mostly on English
while this mailbox is Dutch, French and English, often in one thread.

None of that is necessary, because **Microsoft Graph already tells you who is in
a payload**. Every person arrives in a structured, labelled field:
`from.emailAddress`, `toRecipients[]`, `ccRecipients[]`, `replyTo[]`, `sender`,
`organizer`, `attendees[].emailAddress`, `createdBy.user`,
`lastModifiedBy.user`, `shared.sharedBy.user`, `mentions[].mentioned.user`,
`scoredEmailAddresses[]`. The free-text fields — `subject`, `bodyPreview`,
`body.content`, a file `name` — are the _only_ place identity is unlabelled, and
the people they name are, overwhelmingly, the same people the labelled fields
just declared. So: **harvest the labelled fields into a payload-scoped roster,
then do exact-match substitution of those known strings over the free text.**
Finding people becomes a schema walk, not an inference.

What that buys is not a slightly cheaper NER. It is a different class of
mechanism: deterministic (same payload, same output, forever), auditable (the
table _is_ the audit record — every replacement can be shown to a DPO with the
field it came from), language-independent (Dutch genitives and French prose are
just strings), zero-latency and zero-dependency, and **reversible**, so the user
can be shown real names in the final answer while the model only ever saw
`PERSON_1`. A regulator's question — "what personal data left the EU in this
conversation?" — gets a literal answer instead of a confidence interval.

## What the core does

Two pure modules, no I/O, no `.server.ts` suffix because there is nothing
server-only in them.

**`graph-roster.ts` — `extractRoster(payload)`.** Recursive descent over any
JSON value, returning `{ name, address, nameVariants, roles }[]`, deduplicated
by address case-insensitively. Detection is **structural, not a whitelist of
top-level keys**, so a tool projection written next month is covered without
touching this file: an object is an identity if its `address` is email-shaped,
or it carries a `displayName` next to an email-ish sibling, or it sits under an
`emailAddress` / `user` key. On top of that, the app's own compact projections
flatten a person to a single string (`from: 'Jan Van Damme'`,
`organizer`, `shared_by`, `with[]`), so those key names are read as identities
at any depth. `roles` records the field each identity was found under, which is
what makes the output explainable.

It also reads one _negative_ label: an `attendees[]` entry marked
`type: 'resource'` is a meeting room, not a person, so "Vergaderzaal Brussel"
stays in clear text. A room is not personal data and pseudonymising it would
cost the model a fact for nothing. The same principle as the rest of the design
— believe Graph's labels.

**`pseudonymise.ts` — `buildTable` / `apply` / `reverse`.** `buildTable` turns
the roster into placeholders: `PERSON_1` for the primary name,
`PERSON_1_EMAIL`, `PERSON_1_NAME2` for a second spelling, `PERSON_1_GIVEN` /
`PERSON_1_FAMILY` for the parts of a name (the family name keeps its particles:
"Van Damme", not "Damme"), `PERSON_1_LOCAL` for a name-like local part
(`michael.accetto`), and `PERSON_1_SLUG` for the underscored form Microsoft puts
in personal-site URLs (`michael_accetto_dtsc_be`).

`apply` deep-clones the payload and rewrites every string — structured fields
and free text alike — in **one left-to-right pass over a single alternation
regex**, needles sorted longest-first. That ordering is what makes overlapping
identities safe: at any position "Jan Van Damme" beats "Jan", and
"jan.vandamme@dtsc.be" beats both. A single pass also means the output can never
be re-matched by a later needle.

Three hazards were worth solving explicitly, and each has tests:

| Hazard        | What breaks naively                                                              | What is done                                                                                                                                                                     |
| ------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Substrings    | replacing "Michael" corrupts "Michaelson"                                        | Unicode boundary lookarounds on every needle                                                                                                                                     |
| Unicode names | JS `\b` fires _inside_ "José" and "Müller", so `\bJosé\b` matches within "Josée" | `(?<![\p{L}\p{N}_])` / `(?![\p{L}\p{N}_])` under the `u` flag                                                                                                                    |
| HTML bodies   | `body.content` is usually HTML; a blind replace can rewrite a tag                | markup and text are separated first: text nodes and _quoted attribute values_ are rewritten (so `href="mailto:…"` and `title="…"` are caught), tag and attribute names never are |

Derived name parts get a stricter fence that also refuses to match beside a
hyphen, so the "Jan" of "Jan Van Damme" cannot take the head off an unrelated
"Jan-Pieter".

`reverse(text, table)` maps placeholders back for display, longest-first so
`PERSON_1` never eats the head of `PERSON_1_EMAIL` or `PERSON_10`. Because each
surface form owns its own placeholder, `reverse(apply(x))` reproduces the
original payload byte-for-byte — asserted over nine fixtures, including the HTML
body. The one exception is letter case: matching is case-insensitive on purpose
(a subject line shouting a surname must still be caught), so an occurrence whose
case differed from the roster's comes back in the roster's case.

## Known limitations

These are properties of the design, not defects to be scheduled. Each is a
passing test, so a future change that "fixes" one has to say so out loud.

1. **A person named only in free text is not replaced** — _by the core alone._
   The architecture below narrows this sharply: the org-graph roster lets the
   dictionary pass catch known people in prose, and user-approved extraction
   (#162) grows coverage over time. What remains unreplaced is a person known to
   neither Graph fields nor the org graph — the honest residual to put in front
   of a DPO, and an empirical count the fidelity bench will start measuring.
2. **Inflected forms are missed by the exact pass.** Dutch glues the genitive on
   — "Michaels planning" — and word boundaries are exactly what protect
   "Michaelson". The _reverse_ side compensates with a lenient second pass (see
   below); the _apply_ side deliberately does not.
3. **The app's own projections cost the roster information.** `shapeMessages`
   flattens a sender to `name ?? address` — _one_ of the two. This is why the
   roster is harvested **before** projection (see hook points): it settled the
   where-to-hook question with evidence rather than taste.
4. **A first name shared by two people is attributed to the first of them.**
   Both are still replaced; they are conflated onto one placeholder rather than
   being split at random. Conflation is the safe direction to fail in.

---

## Architecture (converged 2026-08-16)

The single most consequential decision is a **split the first draft had fused**:

- **The roster** — _who exists_ — is cumulative and canonical, and lives in the
  **Neo4j org graph** (below).
- **The placeholder table** — _what `PERSON_n` means in this conversation_ — is
  **per-conversation, append-only, AES-256-GCM encrypted** (the `user_tokens`
  pattern), keyed by conversation id, deleted with the conversation. Each entry
  references the canonical graph node `iri`, so identity is stable across
  conversations at the node level while numbering stays conversation-stable —
  which is what keeps prompt prefixes cacheable and prevents the one _silent_
  failure mode (the model misattributing `PERSON_2`'s fact to `PERSON_1` when
  numbering shifts mid-conversation).

This resolves old open questions 3 and 5 simultaneously: erasure rides the
existing delete-conversation path, and the model gets stable references without
a cross-conversation directory ever existing in placeholder space.

### Trust boundary

```
                       ┌──────────────────── trust boundary ────────────────────┐
 Graph API ──raw JSON──► graphFetch ─► roster harvest ─► shape*() projections   │
                       │                    │                                   │
                       │                    ▼                                   │
                       │  runAppTool: apply(result)  ◄─── per-conversation      │
                       │             reverse(args)        table (encrypted)     │
                       │                    │                    ▲              │
                       │                    ▼                    │              │
                       │   harness: events, prompts, LLM calls — placeholders   │
                       │   only; NOTHING inside the harness can reverse         │
                       └──────┬──────────────────────────┬──────────────────────┘
                              ▼                          ▼
                   presentation boundary          persistence: Postgres
                   (reverse for the owner)        context = placeholders
```

### Hook points (evidence-settled)

- **Roster harvest at `graphFetch`'s return** (`ui/src/lib/auth/graph-token.server.ts`)
  — the last point where identities are still structured, before the `shape*()`
  projections flatten `name ?? address` (limitation 3).
- **Apply/reverse at `runAppTool`** (`ui/src/lib/app-tools/registry.server.ts`)
  — the single dispatcher for all app tools, both directions. Results are
  pseudonymised on exit; **args are reversed on entry**, which covers the three
  person-valued filter args that exist today (`author` reaches Graph's KQL and
  would silently zero-hit on a placeholder) and every future write tool for
  free. The `ref:` expansion path (prior results injected into args) flows
  through the same point.
- Hooking **early** is load-bearing, not just clean: every event can carry a
  second verbatim copy of its content in `llmCall.rawInput` (the literal
  provider request body, persisted in the same row and rendered in the
  observability panel). Transport-level hooking means both copies are born
  pseudonymised; a regression test should pin that `rawInput` never contains
  roster clear text.
- **Neo4j writes are inside the boundary**: args to graph-writing tools are
  reversed at the same choke point, so the knowledge graph stores real
  identities (it _is_ the roster) and never accumulates `PERSON_n` nodes.
- **Sandbox transport: excluded by design.** Sandbox workloads will rely on
  local models or a specifically trusted provider; not in scope.

### Placeholder format and fidelity (evidence-settled)

Bare **`PERSON_1` / `PERSON_1_EMAIL`** is the emitted form — measured against
this codebase, it is the only candidate simultaneously inert in the chat's
markdown pipeline (`[PERSON_1]: …` at line start is _silently deleted_ as a
link-reference definition), in `repairJson` (`{{…}}` throws; bracket values
corrupt sibling keys), and in the BAML prompt templates.

Fidelity through LLM paraphrase is handled on three fronts:

1. **Prompt guidance**, injected through the existing per-call `context`
   mechanism (`contextPrefix` on the controller adapters; precedent:
   `TRUNCATION_RETRY_GUIDANCE`). `Synthesize` needs a small signature addition
   (`context: string?`). Guidance is **always-on per agent** so the cached
   tier-1 prompt prefix stays stable. `ResultDescribe` gets the same line — its
   summaries persist and re-enter cached controller prompts, making it an
   otherwise-unguarded rewrite stage.
2. **Two-stage reverse**: the exact pass keeps its byte-exact roundtrip
   guarantee; a lenient second pass recovers case changes, `PERSON\_1`,
   space/hyphen separators and the Dutch genitive `PERSON_1s`, resolving **only
   ids the table minted**.
3. **A detector, not just a reverser**: after reversal, residual
   `PERSON`-shaped tokens and in-table-range ids that never appeared in the
   input raise a `warning` event — converting silent loss into a metric.

A fidelity bench (NL/FR/EN × guidance on/off, built on the prompt-cache-bench
harness and this PR's fixtures) measures survival rates; results land in
`docs/plan/pseudonym-fidelity-bench.md`.

### Reversal: a render-time lens, never a mutation

Stored events keep placeholders forever. Reversal happens only at the
**presentation boundary**, for the authenticated owner: the SSE per-event frame,
the SSE `done` payload (which ships the full context), and `loadConversation`
on history load. It is _not_ a method reachable from pattern code — the router
re-feeds stored assistant messages into prompts on later turns, so reversing
into storage would silently reinject clear text into the model. The
observability panel's context-export keeps placeholders.

### User input

The user's own message is the largest fidelity hole — "wat stuurde Jan mij?"
hands the model the clear name next to `PERSON_1`. Fix: the same dictionary
pass runs over `user_message`, backed by the org-graph roster, with one
disambiguation rule — **unambiguous surface forms (full name, email) always
match; an ambiguous bare first name matches only if exactly one candidate is
already in this conversation's table.** A missed name is the documented
limitation; a wrong match would be misattribution, the silent failure — so the
rule fails toward missing.

### The org graph (the roster's home)

Modeled with the TBox/ABox conventions of
[`docs/ONTOLOGY_CONVENTIONS.md`](../ONTOLOGY_CONVENTIONS.md) — org classes
(`org:Person`, `org:OrgUnit`, `org:Role`, `org:Meeting`, `org:Document`,
`org:ExternalContact`) become the production TBox. Three feeds, by trust:

1. **Directory sync** — MS Graph `/users` (names, mail, jobTitle, department,
   `manager`): authoritative, 100 % internal coverage from day one.
   _Pending `User.Read.All` admin consent._
2. **`graphFetch` harvests** — every payload roster MERGEs on
   `lower(address)`; this is where external contacts accrete. Deterministic,
   no LLM.
3. **Conversation-hypothesis extraction** —
   [#162](https://github.com/mknw/harness-playground/issues/162): LLM-proposed
   `:Hypothesis` nodes, **user-approved before any ABox write**, optionally
   validated by the #73 ontology-validator loop. Phase 2.

**Interaction-derived edges (communication-frequency graphs) are deferred**
pending the employee-information steps in the privacy plan. The org graph gets
its own ROPA entry with retention tied to the employment/business relationship,
and Neo4j hardening precedes feed 2 in production.

### Retriever and the Data Stash

Stash documents stay clear text at rest (7-day TTL; ingest-time conversion and
embedding operate on real text for retrieval quality). Pseudonymisation wraps
the retriever at its two ends:

- the retriever's rewritten **query is reversed before search**, so embeddings
  and full-text search match the real names stored in chunks;
- **retrieved chunks are pseudonymised** before entering prompts, via the
  org-roster dictionary (chunk prose has no labelled fields, so this is
  precisely what the cumulative roster enables).

Constraint: **the embedding provider must sit inside the trust boundary when
`anonymize` is active** — the local model or an in-tenancy Azure deployment;
a remote embedding provider combined with query-reversal must hard-fail.

### Packaging

`anonymize` ships as a sibling library next to `sandbox` (working location
`ui/src/lib/anonymize/`): **harness-patterns exports a transport-agnostic
middleware interface** (apply-on-result, reverse-on-args, pluggable roster
source and table store); the app registers the Graph policy on the app-tools
transport. The pure core in `ui/src/lib/privacy/` folds into the package. This
keeps the OSS split clean: the library ships the mechanism, the private
deployment ships the policy.

## Remaining open items

- `User.Read.All` admin consent (feed 1 wires when granted; feed 2 is not
  blocked).
- Fidelity-bench numbers (bench PR pending) — decides how much weight the
  lenient reverse and guidance each carry.
- Final package name (`anonymize` is the working default).
- Misattribution rate has no mechanical detector; the bench samples it by
  reading. It remains the residual risk to restate wherever this ships.

## Related

- [`docs/data-privacy/plan.md`](../data-privacy/plan.md) — the findings this
  serves, especially "The part that changes the risk profile" and plan item 3.
- [#162](https://github.com/mknw/harness-playground/issues/162) — org-graph
  hypothesis extraction with user approval (feed 3).
- [`docs/ONTOLOGY_CONVENTIONS.md`](../ONTOLOGY_CONVENTIONS.md) and #17 / #73 —
  the TBox/ABox contract and validator loop the org graph reuses.
- [`docs/MICROSOFT_GRAPH.md`](../MICROSOFT_GRAPH.md) — the nine tools whose
  results are the material here.
- [`docs/graph-api-notes.md`](../graph-api-notes.md) — what Graph actually
  returns, which is where the identity-field shapes came from.
- `ui/src/lib/app-tools/graph.server.ts` — the projections the controller sees,
  and the source of limitation 3.
