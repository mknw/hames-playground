# Do `PERSON_1` placeholders survive an LLM paraphrase? — measured

**Status:** measured, 2026-08-15. This answers **open question 4** of
[`graph-pseudonymisation.md`](graph-pseudonymisation.md), which asked whether
`reverse` can rely on the model echoing its placeholders verbatim, and flagged
that "the failure mode should be measured before this is user-facing".

**Answer: yes, and by a wider margin than the question assumed.** Over 96 live
`Synthesize` calls in Dutch, French and English, the model echoed **1826
placeholder occurrences and mangled none of them** — no case changes, no
Markdown-escaped underscores, no inflected or invented ids. The lenient reverse
pass this bench was built to size turned out to have nothing to recover.

Code: `ui/src/lib/privacy/pseudonym-metrics.ts` (pure, 27 offline unit tests),
`ui/src/__tests__/bench/pseudonym-fidelity-bench.test.ts` (env-gated live run).
The run writes its raw report and all 96 answers to
`ui/.harness-logs/` (gitignored, so the numbers below are the committed record).
**Nothing in `baml_src/` was changed** — see [Method](#method).

---

## Headline

| | |
|---|---|
| Calls | 96 completed, 0 failed, 0 truncated (planned 96, hard ceiling 120) |
| Spend | **$0.9212** of the $4 budget |
| Placeholder *ids* presented | 888 (148 per cell × 6 cells) |
| Survived **verbatim** | 645 (72.6%) |
| Survived **only leniently** (mangled but resolvable) | **0** (0.0%) |
| **Residue** (`PERSON`-shaped token neither pass resolves) | **0** |
| **Hallucinated** out-of-range `PERSON_n` | **0** |
| Dropped (absent from the answer in any form) | 243 (27.4%) |
| Placeholder *occurrences* echoed verbatim | **1826** |

The only non-zero failure column is `dropped`, and
[it is not a fidelity failure](#the-27-that-was-dropped-is-not-a-fidelity-failure):
it is a summariser omitting redundant forms, concentrated on `_EMAIL` and
`_GIVEN`. The identity-bearing bare `PERSON_n` survived **96.3%** of its
presentations, and **every single one of the 11 exceptions was the mailbox owner
themselves**, whom the model addressed as "you" / "vous" / "jij".

## Method

**Corpus.** The 11 Graph fixtures in `ui/src/__tests__/lib/privacy/fixtures.ts`
recombined into 8 multi-turn transcripts (mail + calendar + files + chat mixes;
raw Graph resources and the app's compact projections both). Each transcript
gets **one roster and one table across all its turns** — the conversation-scoped
reading of open question 5, because a payload-scoped table renumbers the same
person per turn and makes a cross-turn echo unscoreable. 4–15 distinct
placeholders per transcript.

**Pipeline per transcript.** `extractRoster` over the whole payload set →
`buildTable` → `apply` to each payload → wrap as `LoopTurn[]` → `b.request.Synthesize`
→ raw POST to the Anthropic API (key from `ui/.env`, `usage` read from the
response rather than through a Collector). This is the plumbing of
`prompt-cache-bench.test.ts`, reused deliberately.

**Arms.** Language forced from the user message (`Antwoord in het Nederlands.` /
`Répondez en français.` / `Answer in English.`) × guidance off/on. The guidance
is injected through `Synthesize`'s `intent` argument, **not** by editing
`baml_src/synthesizer.baml`: the question is whether guidance is worth wiring,
and changing the production prompt in order to measure that would beg it.
Verbatim text of the on-arm:

> Some names appear as opaque tokens like PERSON_1 or PERSON_1_EMAIL. Copy these
> tokens exactly as written: never translate, inflect, pluralise, merge, or
> expand them, and never write such a token that does not appear in the input.

**Samples.** 2 per (transcript × language × guidance) cell at the API's default
temperature = 96 calls. Model is whatever `SynthesizerAnthropic` leads with
(claude-sonnet-5), `max_tokens` clamped to 3000 — a truncated answer would read
as a dropped placeholder, so `stop_reason` is tracked and reported (0 of 96 hit
the cap).

**Scoring** is `pseudonym-metrics.ts`, unit-tested offline so the live run
measures the model and not the instrument. Three passes consume the answer in
order, so each `PERSON`-shaped token is counted exactly once:

| Outcome | Meaning | Does `reverse` recover it today? |
|---|---|---|
| **exact** | back byte-for-byte | yes |
| **recoverable** | mangled within the lenient family below | no — this is what a wider `reverse` would win |
| **residue** | `PERSON`-shaped, neither pass resolves it | no; the user would see it raw |
| **dropped** | an input placeholder absent in any form | nothing to recover |
| **hallucinated** | a `PERSON_n` whose `n` was never minted | no — and reversing it would name the *wrong person* |

The **lenient family** is case changes, Markdown-escaped underscores
(`PERSON\_1`), separator swaps (`PERSON 1`, `PERSON-1`), and a glued Dutch
genitive (`PERSON_1s`). It resolves **only ids the table actually minted**, so
`PERSON_9` in a three-person table is scored as a hallucination rather than as a
near-miss.

> One clarification the unit tests forced: the apostrophe genitive `PERSON_1's`
> is scored **exact**, not recoverable. `reverse` fences on `[A-Za-z0-9_]` and an
> apostrophe is none of those, so that spelling already round-trips today. 25 of
> the 96 answers used it. Only the *glued* `s` would have been a real mangle.

## Results

### Per language × guidance

Percentages are over placeholder *ids* summed across the cell's 16 samples (an
id present in two samples counts twice). `residue` and `hallucinated` are
occurrence counts — they have no natural denominator.

| lang | guidance | ids in | exact | recoverable | dropped | residue | hallucinated |
|---|---|---|---|---|---|---|---|
| NL | off | 148 | 103 (69.6%) | 0 | 45 (30.4%) | 0 | 0 |
| NL | on  | 148 | 110 (74.3%) | 0 | 38 (25.7%) | 0 | 0 |
| FR | off | 148 | 99 (66.9%)  | 0 | 49 (33.1%) | 0 | 0 |
| FR | on  | 148 | 122 (82.4%) | 0 | 26 (17.6%) | 0 | 0 |
| EN | off | 148 | 95 (64.2%)  | 0 | 53 (35.8%) | 0 | 0 |
| EN | on  | 148 | 116 (78.4%) | 0 | 32 (21.6%) | 0 | 0 |

The `recoverable` / `residue` / `hallucinated` columns are zero in every cell.
That is the finding; the rest of this document is about the one column that
moves.

### The guidance delta

| lang | exact, off → on | residue | hallucinated |
|---|---|---|---|
| NL | 69.6% → **74.3%** (+4.7pp) | 0 → 0 | 0 → 0 |
| FR | 66.9% → **82.4%** (+15.5pp) | 0 → 0 | 0 → 0 |
| EN | 64.2% → **78.4%** (+14.2pp) | 0 → 0 | 0 → 0 |

Guidance cannot have improved *fidelity*, because fidelity was already perfect
in both arms. What it improved is **coverage** — how many of the available
placeholders the answer bothers to mention. And that is not a length artifact:
guided answers are marginally **shorter** (mean 1341 vs 1367 characters) while
carrying more placeholders (density 14.38 vs 13.30 per 1000 characters, mean
19.7 vs 18.4 occurrences per answer). Dutch benefits least, which is consistent
with Dutch already being the language the fixture bodies are written in.

### The 27% that was "dropped" is not a fidelity failure

Splitting drops by placeholder kind reframes the whole number:

| placeholder kind | presented | dropped | drop rate |
|---|---|---|---|
| `PERSON_n` (bare) | 300 | 11 | **3.7%** |
| `PERSON_n_FAMILY` | 84 | 3 | 3.6% |
| `PERSON_n_SLUG` | 24 | 0 | 0.0% |
| `PERSON_n_NAME2` | 36 | 6 | 16.7% |
| `PERSON_n_EMAIL` | 228 | 112 | 49.1% |
| `PERSON_n_GIVEN` | 180 | 92 | 51.1% |
| `PERSON_n_NAME3` | 36 | 19 | 52.8% |

A summariser that has already written `PERSON_1` does not also need to print
`PERSON_1_EMAIL`, `PERSON_1_GIVEN` and `PERSON_1_NAME3` — those are the *same
person* in four encodings, and omitting three of them is the behaviour you want.
The drop rate is a property of the table minting several forms per person, not
of the model losing people.

Restricted to the identity-bearing bare placeholder:

| lang | guidance | bare ids | survived verbatim | dropped |
|---|---|---|---|---|
| NL | off | 50 | 48 (96.0%) | 2 |
| NL | on  | 50 | 48 (96.0%) | 2 |
| FR | off | 50 | 47 (94.0%) | 3 |
| FR | on  | 50 | **49 (98.0%)** | 1 |
| EN | off | 50 | 48 (96.0%) | 2 |
| EN | on  | 50 | **49 (98.0%)** | 1 |

**All 11 of those drops are the mailbox owner.** Nine are `PERSON_1` in
`me-mail-chat` and one is `PERSON_1` in `projection-mixed` — both transcripts
open with `graph_me`, so the user is person 1. The eleventh is `PERSON_2` in
`event-files`, where the owner is an attendee rather than the organiser. In
every case the model wrote "you" / "vous" / "jij" instead of naming them — which
is correct behaviour, and arguably better than the alternative. **No third party
was dropped, in any language, in either arm, in 96 answers.**

## What the answers actually looked like

Verbatim excerpts from the saved run. Fixture surnames are redacted to their
placeholder form where they appear un-substituted; every `PERSON_*` token below
is exactly as the model wrote it.

**1 — Dutch, inside Markdown bold.** 77 of 96 answers wrapped a placeholder in
`**…**`, the single most likely place for a model to escape the underscore as
`PERSON\_1`. It never did, in any of them:

> …ferte PERSON_1_FAMILY — feedback gevraagd"** (11 aug 2026, ongelezen, met bijlage)
> - Van: **PERSON_1** (PERSON_1_EMAIL)
> - Aan: **PERSON_2**, **PERSON_3**
> - Cc: **PERSON_4**

**2 — French, mixed bold and inline.** Suffixed ids survive the same treatment:

> …**réponse** directement à son adresse (PERSON_1_EMAIL).
> - 👉 **Action requise :** répondre à **PERSON_1**.
> **2. « Devis — relance »**
> - **De :** PERSON_5 (PERSON_5_EMAIL)

**3 — Dutch, possessive.** The inflection the plan doc's limitation 2 warns
about on the *input* side does occur on the output side — with an apostrophe,
which `reverse` already handles:

> …doorgestuurd naar PERSON_3. PERSON_3 kijkt ernaar voor vrijdag, en PERSON_1
> wacht op jouw (PERSON_2's) antwoord.

**4 — English, reformatted into a Markdown table.** A structural rewrite of the
input, and the ids still come through intact:

> | Person | Role |
> |---|---|
> | PERSON_1 | Sender of thread 1, awaiting your reply |
> | PERSON_2 | You — recipient in both threads |

**5 — Dutch, placeholder inside a URL path.** The model reproduced a
SharePoint personal-site slug it could not possibly have parsed as a name:

> - **Link:** https://dtsc-my.sharepoint.com/personal/PERSON_3_SLUG/Documents/Offertes/Offerte%20Van%20⟨FAMILY⟩%202026.docx

That last excerpt also carries an **incidental finding about `apply`, not about
the model**: the `_SLUG` form (`jan_vandamme_dtsc_be`) is substituted, but the
**percent-encoded** copy of the same surname in the URL *path*
(`Offerte%20Van%20…%202026.docx`) is not — `%20` breaks the literal, so the
needle never matches. The un-encoded `name` field of the same driveItem *is*
substituted correctly. This is a sixth case for the "known limitations" list in
[`graph-pseudonymisation.md`](graph-pseudonymisation.md#known-limitations) and is
independent of everything measured here; it was noticed while building the
corpus, and no fix is proposed in this PR.

## Recommendation

**1. Is the lenient reverse family sufficient? It is unnecessary — do not ship
it.** 0 of 888 presentations needed it, and 0 produced residue or a hallucinated
id. Widening `reverse` would add a heuristic (and the `PERSON_1s` / `PERSON_15`
ambiguity that comes with it) to solve a problem this model does not have.
**Keep `pseudonym-metrics.ts` instead**: it is the regression instrument, it
costs nothing offline, and it is what tells you if a model swap changes this
answer. Re-run the bench when the synthesizer client changes — that is the
trigger, not a calendar.

**2. Is prompt guidance worth wiring? Yes, but not for the reason it was
proposed.** It does not protect fidelity — nothing was mangled without it. What
it buys is +4.7 to +15.5pp coverage of derived placeholders at ~45 tokens of
system prompt and no measurable increase in answer length. Two caveats before
wiring it:

- The benefit lands on `_EMAIL` / `_GIVEN` mention rates, a metric this bench
  did not set out to optimise. Whether "the answer names more email placeholders"
  is *good* depends on the product, and it is not obviously good — those are
  reversed to real addresses in front of the user.
- Guidance only makes sense at the **prompt/synthesizer seam** (option 3 of open
  question 1). If the hook lands at the app-tools transport or the event store,
  the synthesizer prompt is the wrong place to put it and this recommendation
  does not apply.

So: wire it *if and when* the prompt seam is chosen, as a one-paragraph addition
to `synthesizer.baml`. It is not a prerequisite for `reverse` to work.

**3. Open question 4 can be closed** for the Anthropic synthesizer chain. It
should not be closed in general — see below.

## Threats to validity

Stated plainly, because the result is clean enough to be over-read.

1. **One model.** Only `claude-sonnet-5`, the lead of `SynthesizerAnthropic`.
   The Haiku 4.5 backstop is unmeasured, and so is the entire mixed-provider
   `SynthesizerFallback` chain (`OpenRouterGemma4 → GroqQwen3_32b → OpenAIGPT5`)
   used under `USE_MIXED_CHAINS=1`. Gemma leads that chain and is a far smaller
   model; **do not assume this result transfers to it.** If mixed chains are ever
   the production default, this bench must be re-run against them before open
   question 4 is closed there.
2. **One prompt shape.** `Synthesize` only. A controller that has to *compose a
   tool argument* from a placeholder — the reversal problem open question 1
   raises for the prompt seam — is a different and harder test that this bench
   does not attempt.
3. **Fictional fixtures.** 11 payloads, invented names on `dtsc.be` /
   `partner.example`. Real mailboxes have more people per payload, more name
   collisions, and quoted reply chains; a larger roster means larger `n`, and
   `PERSON_11` vs `PERSON_1` is a confusion class that never arose here because
   no transcript exceeded 5 people.
4. **`dropped` is a soft metric.** There is no ground truth for how many people
   a good three-paragraph summary should name, so drop rates are only comparable
   *between arms of this bench*, not against an absolute standard.
5. **2 samples per cell** at default temperature. Enough to establish that
   mangling is rare; not enough to put a confidence interval on a 4pp coverage
   difference. The zero columns are the robust part of this result.

## Reproducing

```bash
cd ui && PSEUDO_BENCH=1 pnpm vitest run src/__tests__/bench/pseudonym-fidelity-bench.test.ts
```

Requires `ANTHROPIC_API_KEY` in the environment or `ui/.env`. The run is guarded:
it refuses to start if the plan exceeds **120 calls** and aborts mid-run if spend
passes **$4**. Output goes to stdout and to
`ui/.harness-logs/pseudonym-bench-latest.md`, with every answer saved alongside in
`.samples.json` so a surprising number can be audited without paying for a
re-run. The metrics module has its own offline suite
(`ui/src/__tests__/lib/privacy/pseudonym-metrics.test.ts`) that runs in
`pnpm test:run` with no network.

## Related

- [`plan/graph-pseudonymisation.md`](graph-pseudonymisation.md) — the core this
  measures, its known limitations, and open questions 1–3 and 5, which this
  bench does **not** answer.
- [`data-privacy/plan.md`](../data-privacy/plan.md) — plan item 3, the reason
  any of this exists.
- [`harness-patterns/prompt-caching.md`](../harness-patterns/prompt-caching.md) —
  the bench-results precedent this document follows, and the source of the API
  plumbing.
