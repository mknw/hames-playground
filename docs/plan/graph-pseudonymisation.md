# Pseudonymising Graph tool results — the roster is already in the payload

**Status:** core built and tested, **wired to nothing**. This is a proof that
option three exists for [item 3 of the data-protection
plan](../data-privacy/plan.md#plan) ("encrypt or exclude Graph-derived
`tool_result` content"), plus the questions that have to be answered before any
of it is switched on. Those questions are deliberately left open — see
[Open questions](#open-questions).

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
`body.content`, a file `name` — are the *only* place identity is unlabelled, and
the people they name are, overwhelmingly, the same people the labelled fields
just declared. So: **harvest the labelled fields into a payload-scoped roster,
then do exact-match substitution of those known strings over the free text.**
Finding people becomes a schema walk, not an inference.

What that buys is not a slightly cheaper NER. It is a different class of
mechanism: deterministic (same payload, same output, forever), auditable (the
table *is* the audit record — every replacement can be shown to a DPO with the
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

It also reads one *negative* label: an `attendees[]` entry marked
`type: 'resource'` is a meeting room, not a person, so "Vergaderzaal Brussel"
stays in clear text. A room is not personal data and pseudonymising it would
cost the model a fact for nothing. The same principle as the rest of the design
— believe Graph's labels.

**`pseudonymise.ts` — `buildTable` / `apply` / `reverse`.** `buildTable` turns
the roster into per-payload placeholders: `PERSON_1` for the primary name,
`PERSON_1_EMAIL`, `PERSON_1_NAME2` for a second spelling, `PERSON_1_GIVEN` /
`PERSON_1_FAMILY` for the parts of a name (the family name keeps its particles:
"Van Damme", not "Damme"), `PERSON_1_LOCAL` for a name-like local part
(`michael.accetto`), and `PERSON_1_SLUG` for the underscored form Microsoft puts
in personal-site URLs (`michael_accetto_dtsc_be`). Numbering is positional and
therefore payload-scoped: the same person is a different number in the next tool
result, so the placeholders cannot be joined across a conversation into a
directory.

`apply` deep-clones the payload and rewrites every string — structured fields
and free text alike — in **one left-to-right pass over a single alternation
regex**, needles sorted longest-first. That ordering is what makes overlapping
identities safe: at any position "Jan Van Damme" beats "Jan", and
"jan.vandamme@dtsc.be" beats both. A single pass also means the output can never
be re-matched by a later needle.

Three hazards were worth solving explicitly, and each has tests:

| Hazard | What breaks naively | What is done |
|---|---|---|
| Substrings | replacing "Michael" corrupts "Michaelson" | Unicode boundary lookarounds on every needle |
| Unicode names | JS `\b` fires *inside* "José" and "Müller", so `\bJosé\b` matches within "Josée" | `(?<![\p{L}\p{N}_])` / `(?![\p{L}\p{N}_])` under the `u` flag |
| HTML bodies | `body.content` is usually HTML; a blind replace can rewrite a tag | markup and text are separated first: text nodes and *quoted attribute values* are rewritten (so `href="mailto:…"` and `title="…"` are caught), tag and attribute names never are |

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

1. **A person named only in free text is not replaced.** If a body says "ik sprak
   met Karel Peeters" and Karel is in no labelled field of that payload, Karel
   survives into the prompt. This is the direct cost of using Graph's labels
   instead of NER, and it is the limitation to put in front of a DPO — the
   mechanism reduces exposure sharply and provably, but it does not eliminate it.
   How much residual risk that leaves is an empirical question nobody here has
   measured yet: it wants a count over real payloads, not an opinion.
2. **Inflected forms are missed.** Dutch glues the genitive on — "Michaels
   planning" — and word boundaries are exactly what protect "Michaelson", so the
   two cannot both be had with this mechanism. A suffix allowance (`'s`, `s`) is
   possible and was not taken, because it trades a hard guarantee for a heuristic.
3. **The app's own projections cost the roster information.** `shapeMessages`
   flattens a sender to `name ?? address` — *one* of the two. When a message's
   sender arrives as an address, that payload's roster never learns their display
   name, and their name in the body text is not replaced. This is not a defect in
   the core; it is an argument about where to hook (below), and it is the single
   most useful thing the tests turned up.
4. **A first name shared by two people is attributed to the first of them.** Both
   are still replaced; they are conflated onto one placeholder rather than being
   split at random. Conflation is the safe direction to fail in.

## Open questions

Per the "probe before scaffolding" rule in `CLAUDE.md`, these are **not decided
here**. Each changes the shape of the implementation, and picking one silently
inside this PR would lock in a default the reader would have redirected.

**1. Where does this hook?** Three candidate seams, with real trade-offs:

- *The app-tools transport* (`runAppTool` / `callTool`), before the projection
  functions run. Earliest point, and it is the only place where the full Graph
  payload is still present — which limitation 3 says matters, because the
  projections have already discarded half of each identity by the time the
  result is shaped. But it puts privacy logic in the tool dispatch path for
  every namespace, not just `graph`.
- *The event store*, when a `tool_result` is written to `conversations.context`.
  Narrowest change, and it is precisely the store plan item 3 names. But the
  model has already seen the clear text by then, so it protects the database and
  not the transfer — which is the larger of the two exposures.
- *The prompt/synthesizer boundary*, pseudonymising on the way into the LLM and
  reversing on the way out. Protects the transfer, but every pattern that reads
  `view.serialize()` has to be in on it, and any tool argument the model composes
  from a placeholder (a search `author`, a filter `person`) has to be reversed
  before it reaches Graph — an issue none of the other seams have.

**2. Does `conversations.context` store pseudonymised or clear text?** If
pseudonymised, the stored history is genuinely reduced-risk and rehydration for
display needs the table; if clear, the table is only a transfer control. This
decision interacts with retention (plan item 2) and with erasure (finding 3):
pseudonymised-at-rest changes what "delete everything about me" has to reach.

**3. Where does the table live — and for how long?** The table is *itself
personal data*: it maps `PERSON_1` to a named employee. Persisting it beside the
conversation recreates the exposure the pseudonymisation removed, unless it is
encrypted (the `user_tokens` AES-256-GCM pattern is right there) or given a much
shorter TTL than the conversation. Not persisting it makes historical
conversations permanently unreadable — arguably a feature, arguably a support
problem. Note that a per-payload table also means one conversation accumulates
many tables.

**4. Do placeholders survive an LLM paraphrase?** `reverse` assumes the model
echoes `PERSON_1` verbatim. Real models sometimes write "Person 1", "the first
person", or translate it. A mangled placeholder does not corrupt data — it just
fails to reverse, and the user sees `PERSON_1` — but the failure mode should be
measured before this is user-facing, and it is a prompt question as much as a
code one. `reverse` already resolves a bare `PERSON_n` for a person known only
by address, which is one small step in that direction.

**5. Is a stable per-user pseudonym ever wanted?** Payload-scoped numbering is
the privacy-maximal choice, and it means the model cannot tell that the `PERSON_2`
of one tool result is the `PERSON_1` of the next — which will hurt on
multi-tool turns ("who did Jan share this with?"). A conversation-scoped table
would fix the reasoning and weaken the guarantee. This is the trade-off most
likely to be felt in the product.

## Related

- [`docs/data-privacy/plan.md`](../data-privacy/plan.md) — the findings this
  serves, especially "The part that changes the risk profile" and plan item 3.
- [`docs/MICROSOFT_GRAPH.md`](../MICROSOFT_GRAPH.md) — the nine tools whose
  results are the material here.
- [`docs/graph-api-notes.md`](../graph-api-notes.md) — what Graph actually
  returns, which is where the identity-field shapes came from.
- `ui/src/lib/app-tools/graph.server.ts` — the projections the controller sees,
  and the source of limitation 3.
