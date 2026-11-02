# URL interpretation seam for guard rules (Design)

> **Status: design, not built.** This is a docs-only design. It changes no application code, no
> rule corpus, no schema and no operator switch. Implementation follows only after this design
> converges and is reviewed. Every source claim below was re-opened in this worktree on the merge
> head `371f1f1d` (candidate A / #944); line numbers are that tree's.
>
> **Ruled ordering (owner, 2026-11-02):** this seam lands **before** the #901 link-verification
> implementation starts. That ordering is an input to this design, not a proposal to re-open. It
> means the seam's slices below are a prerequisite of #901's implementation, not a later cleanup.

## Placement

This design is its own `docs/plan/` file, following the precedent of
[`link-verification.md`](link-verification.md), rather than a new revision of
[`boundary-guards.md`](boundary-guards.md). It is a cross-cutting **implementation seam** for URL
reading in both the ingress sanitizer and the egress gate, not a new guard policy or a change to
the guards' owner rulings. Boundary-guards revisions are policy amendments with their own
ruling record; folding a shared URL parser into revision 6 — which is landing separately as the
injection-ingress-guard design (#941) — would mix a lexical/offset-mapping seam into an
ingress-classification revision and make both harder to review. This file therefore treats the
boundary-guards rulings as binding inputs and adds no new guard policy.

## Why one seam

The guard rules currently read URLs in five independent places across the ingress sanitizer and
the egress gate. Each repeats part of the same job — find an address, parse it, derive the
destination, compare it to something, and sometimes rewrite the source text — but with different
lexical rules and no shared offset contract:

| #   | Reader                                                 | What it does today                                                                                                                                                                                                                                                                | Source                                                                                    |
| --- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1   | `exfil-data-url` ingress rule                          | Finds an `http(s)` URL with a path or query carrying a 64+-character encoded run, then defangs the exact regex match. The trailing blob run is deliberately terminal and uncapped.                                                                                                | `packages/harness-patterns/injection-guard.ts:700-711`, `:565-576`                        |
| 2   | `isSourceLink` ingress exemption                       | Decides whether one whole string leaf is exactly one `https:` URL on one exact configured host, with no credentials, port, second URL or second scheme; if so, the leaf is exempt from `exfil-data-url` only.                                                                     | `packages/harness-patterns/injection-guard.ts:424-466`; applied at `:1076-1090`           |
| 3   | `addressesIn` egress reader                            | Finds every `http(s)` address in text verbatim, including an address nested after another scheme occurrence. The URL-tail pattern is terminal.                                                                                                                                    | `packages/harness-patterns/egress-gate.server.ts:293-307`                                 |
| 4   | `destinationHosts` egress reader                       | Parses those addresses, takes each `hostname`, and follows URLs nested in decoded query values to three levels so an open redirector names its destination too.                                                                                                                   | `packages/harness-patterns/egress-gate.server.ts:160`, `:329-348`                         |
| 5   | The gate's bare-end stripping and given-address corpus | Builds the set of addresses the controller was given, strips sentence-closing punctuation from the **given** side only, and compares a fetch leaf's whole value — after stripping only C0 controls and ASCII space from its ends — plus every address inside it against that set. | `packages/harness-patterns/patterns/withEgressGate.server.ts:425`, `:550-556`, `:896-902` |

The unused `carriesUrlQuery` is a sixth URL-reading function left from the retired
`loadedDecideDown` shape; it has no production or test caller at the source baseline
(`packages/harness-patterns/egress-gate.server.ts:351-356`). #901's link-verification
implementation would otherwise add another independent reader over chat-message links
([`link-verification.md`](link-verification.md)).

The seam exists to give all of these one interpretation contract: **where a URL begins and ends
in the original text, and where it resolves**, without making every consumer re-implement parsing,
nested-URL following, or offset accounting.

## The seam's contract

The seam is a pure, framework-neutral module in `packages/harness-patterns` — no server-only
imports — so the ingress sanitizer, the egress gate and #901's browser-side rendering can all
consume it. It has one output contract:

```ts
interface UrlSpan {
  /** Byte offsets in the EXACT input string passed to the seam. */
  start: number;
  end: number;
  /** The original spelling, never a canonical rewrite. */
  raw: string;
  /** `null` when the span is not a URL the platform parser accepts. */
  url: URL | null;
}

interface UrlDestination {
  href: string;
  hostname: string;
  port: string;
  /** 0 for a URL written directly in the input; > 0 for a nested URL. */
  level: number;
  /** The containing top-level span, when this destination came from a query value. */
  sourceSpan: UrlSpan | null;
}

interface UrlInterpretation {
  /** Every URL span the caller's lexical rule selected, in input order. */
  spans: readonly UrlSpan[];
  /** Resolvable outer and nested destinations, in appearance order, deduplicated. */
  destinations: readonly UrlDestination[];
}

function interpretUrlSpans(
  text: string,
  spans: readonly { start: number; end: number }[],
  options?: { readonly nestedLevels?: number },
): UrlInterpretation;
```

The two outputs are deliberately separated:

- **`spans` are for rewriting and exact comparison.** `start`/`end` address the input as passed
  to the seam, before any sanitizer rewrite or defanging. `raw` is the original spelling. A
  consumer never searches for `url.href` in the source text.
- **`destinations` are for decisions and display.** They carry the parsed `URL`'s canonical
  `href` and `hostname`/`port`, including URLs nested in decoded query values when the caller
  asks for nested following. They are never substituted back into content.

Span discovery remains each rule's own lexical decision where that lexical boundary is part of the
rule's identity. A prose URL and an argument URL intentionally end at different characters today;
preserving that behavior is a requirement below, not an accident. The seam owns what those spans
mean: URL parsing, destination extraction, nested-URL following and offset mapping. The egress
`argument` scanner may move behind the seam in the first slice because it has one production
grammar (`URL_AT`), but the ingress corpus regexes stay visible corpus rules until a separate,
measured lexical change is approved.

### Inputs and outputs per reader

| Reader                 | Span source handed to the seam                         | What it consumes                                                  | Behavior to preserve                                                                                                         |
| ---------------------- | ------------------------------------------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `addressesIn`          | The seam's egress argument scan                        | `spans[].raw`, verbatim                                           | Every scheme occurrence starts a candidate; nested ones included; no canonicalization before comparison.                     |
| `destinationHosts`     | `addressesIn`'s spans                                  | `destinations`, nested to 3 levels                                | Outer and nested `hostname`s in appearance order, deduplicated; a doubly encoded nested URL is followed.                     |
| Given-address corpus   | `addressesIn`'s spans                                  | `spans[].raw` plus the gate's bare-end/trailing-punctuation rules | Given-side punctuation stripping only; request-side value comparison after C0/space end stripping only.                      |
| `isSourceLink`         | The whole string leaf                                  | One `span` covering the entire value, and its `url`               | Exact whole-value URL, exact host equality, no credentials/port, no second URL or second scheme; failure means no exemption. |
| `exfil-data-url`       | The rule's own regex matches                           | Original spans through the offset map                             | Defang the original match, not its canonical form; stable rule id and finding shape.                                         |
| #901 link verification | Markdown/DOM-derived link spans from the chat renderer | `spans` and `destinations`                                        | One resolved address for display and the “Cancel and defang” rewrite.                                                        |

## What must not change

1. **The ordered corpus and stable rule ids.** `INJECTION_RULES` remains an ordered, frozen
   corpus (`packages/harness-patterns/injection-guard.ts:574-711`). `exfil-data-url` keeps its
   id, description, layer, action and finding shape. Markers and events continue to name the
   same ids.
2. **`disableRules` stays meaningful.** A caller may still disable `exfil-data-url` through
   `InjectionGuardOptions.disableRules`
   (`packages/harness-patterns/injection-guard.ts:418`; `resolveRules` at `:1136-1143`).
3. **`sentinel-escape` stays non-disableable.** `resolveRules` deliberately removes that id from
   the disabled set because every marker- and fence-integrity guarantee rests on it
   (`packages/harness-patterns/injection-guard.ts:1136-1143`). The seam must not create a second
   path that bypasses it.
4. **The existing failure direction of every reader.**
   - `exfil-data-url`: an address the URL parser cannot resolve is still matched and defanged by
     the lexical rule; a parse failure never creates an exemption.
   - `isSourceLink`: any lexical, parse, credentials/port, host, namespace, key or second-scheme
     failure means the leaf is scanned as before.
   - `addressesIn` and the given-address corpus: an unparseable or unusual candidate is still an
     address for verbatim comparison; a mismatch refuses (`fetch-address`).
   - `destinationHosts`: a parse failure contributes no destination, but contributes no
     authorization either; the request still goes through the gate's remaining checks.
   - A seam implementation error in a guard path must fail closed, not silently skip reading.
5. **Bounded work on attacker-sized text.** The ingress corpus's ReDoS discipline is unchanged:
   variable-length runs followed by anything are bounded, and only the documented terminal runs
   are uncapped (`packages/harness-patterns/injection-guard.ts:565-576`; pinned by
   `app/src/__tests__/lib/harness-patterns/injection-guard-redos.test.ts:437-461`). The egress
   side keeps its size and depth bounds: `readOutgoing` refuses a joined block over
   `EGRESS_MAX_BLOCK_CHARS` rather than truncating it
   (`packages/harness-patterns/egress-gate.server.ts:150`, `:286-287`), arguments deeper than 64
   are refused (`:163`, `:254`), and nested URLs are followed only three levels
   (`:160`, `:329-348`). The seam adds no unbounded quantifier, no regex built from input, no
   unbounded recursion, and no work that can grow faster than linearly in input length plus a
   bounded number of parsed URLs. It is covered by the same adversarial-input tests and static
   audit, extended to its own scanning code.
6. **Exact behavior during migration.** Each slice is behavior-preserving: the same findings,
   matches, replacements, hosts, refusals and event payloads for the existing fixtures. If a
   slice reveals that two readers disagree, it does not silently pick one answer; it records the
   disagreement for an owner decision.
7. **The existing egress step-1 and O21 ordering.** Candidate A's discriminated verdict and
   `readOutgoing`'s rule-as-data shape remain the gate seam
   (`packages/harness-patterns/egress-gate.server.ts:180-220`, `:286-287`;
   `packages/harness-patterns/patterns/withEgressGate.server.ts:886-902`). This design does not
   reopen the verdict shape.

## Risk statement

- **Canonicalization can create false exemptions.** A parsed `URL` changes spelling: case,
  percent escapes, default ports and empty paths can be normalized, and `hostname` is lower-cased
  and IDNA-encoded. If `isSourceLink` or the given-address comparison treated a canonical value as
  equivalent to a source spelling that current code refuses, content could smuggle a second URL,
  credentials, a port or a lookalike host through an exemption. The seam therefore never
  canonicalizes for matching; matching continues on the original spelling and the existing checks.
- **Synchronous CPU regressions.** The guards run inside a request path. A seam that parses every
  query value recursively, retries parse failures, builds regexes from untrusted text, or follows
  an unbounded nesting chain can turn a hostile tool result into synchronous CPU work. The bound
  above is enforced by extending the existing static quantifier audit and adversarial CPU grid to
  the seam, keeping nested following at three levels, and refusing rather than truncating where
  the gate already refuses.
- **Offset mapping before defanging.** `sanitizeText` applies rules in corpus order and rewrites
  the text as it goes; a finding's offset is the offset in the text at that rule's pass, not
  always the original leaf (`packages/harness-patterns/injection-guard.ts:995-1015`). If the seam
  is run once on the original leaf and later consumers use those offsets after earlier rules have
  removed or replaced characters, they can rewrite the wrong characters. The ingress migration
  therefore keeps an explicit offset map from the original leaf to the current rewritten string,
  and `exfil-data-url` consumes the mapped span. No consumer searches for a canonical URL in the
  current text to recover the location.
- **Canonical forms differ from original spellings.** `URL.href` is a display/decision value, not
  a source string. Defanging `url.href` would change the model-visible text, could add or remove
  characters, and could make the recorded finding no longer match the text it claims to
  neutralize. Rewrites use `raw` at the mapped source span; destinations are used only to decide
  or display.
- **Two lexical grammars are not accidentally unified.** Ingress prose and egress argument URLs
  end at different character sets today. Unifying them would change which bytes are flagged,
  exempted or refused. That is a behavior change requiring its own evidence, not a side effect of
  introducing the seam.

## Migration slices

Each slice is one PR with its own review loop and is behavior-preserving unless a row says an
owner decision is required. Every existing pin keeps passing or is rewritten to the same
observable contract; each new or rewritten pin names the source mutation that must turn it red,
and the implementing PR records that the mutation was run.

| Slice | Change                                                                                                                                                                                                                                                                                          | Pins and named mutations                                                                                                                                                                                                                                                                                                                                                                                                |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Add the pure seam module and migrate `addressesIn`/`urlsIn` in `egress-gate.server.ts` to it. Delete or explicitly deprecate the unused `carriesUrlQuery` only if the owner accepts a package-API cleanup; otherwise leave it untouched.                                                        | Keep `egress-gate.test.ts:453-478`, `:507-520`, `:651-681` green. New seam pins assert verbatim spans, every scheme occurrence, and no canonicalization; mutation: return `url.href` as `raw`, or stop at the first scheme so nested addresses disappear.                                                                                                                                                               |
| 2     | Migrate `destinationHosts` to the seam's destination output, preserving three-level nested following and the second percent-decode of query values.                                                                                                                                             | Keep `egress-gate.test.ts:1014-1030` green. Mutation: drop the `searchParams` recursion, the second `decodeLeaf`, or the exact-order deduplication; the destination list or state lines change.                                                                                                                                                                                                                         |
| 3     | Migrate the gate's given-address corpus and bare-end handling in `withEgressGate.server.ts` to seam spans, preserving the given-side `TRAILING_PUNCTUATION` strip and the request-side C0/space-only end strip.                                                                                 | Keep `egress-gate.test.ts:453-478`, `:507-520`, `:651-681`, `:683-697`, `:700-716`, and the step-1/O21 pins at `:2135-2166` green. Mutations: compare canonical hosts or paths instead of verbatim addresses, use `trim()` instead of C0/space stripping, or drop the `url`-key fallback; one refused shape reaches Decide.                                                                                             |
| 4     | Migrate `isSourceLink`'s URL parsing and host comparison to the seam while keeping its whole-value lexical checks and namespace/field binding.                                                                                                                                                  | Keep `app/src/__tests__/lib/harness-patterns/injection-guard.test.ts:821-895` green. Mutations: compare `hostname.endsWith(host)` or `value.includes(host)`, drop the credentials/port check, drop `SINGLE_HTTPS_URL`, drop the second-scheme check, or exempt every rule instead of only `exfil-data-url`.                                                                                                             |
| 5     | Migrate `exfil-data-url`'s rewrite path to the seam plus an explicit offset map. The corpus regex remains the rule's detector; the seam supplies the original span and the parser's destination. `sanitizeText` maintains the map across earlier rewrites, and defang wraps the original match. | Keep `app/src/__tests__/lib/harness-patterns/injection-guard.test.ts:199-226` and `:648-660` green, and `app/src/__tests__/lib/harness-patterns/injection-guard-redos.test.ts:437-461` green. Mutations: defang `url.href` instead of the regex match, use an unmapped original offset after an earlier rewrite, lower the `{64,}` floor, drop case-insensitive scheme matching, or make the terminal run non-terminal. |
| 6     | #901 readiness gate: link verification may start only after slices 1-5 merge. Its renderer supplies its own markdown/DOM link spans to the same seam and consumes `destinations` for display and `spans` for its defang action; it must not add a sixth local URL parser.                       | #901's design pins remain in [`link-verification.md`](link-verification.md). New integration pins belong to #901's implementation PR; a mutation that rewrites a canonical href instead of the selected source span must turn one red.                                                                                                                                                                                  |

The build order is **1, 2, 3, 4, 5, 6**. Slices 1-3 stay inside the egress side and are
independently revertible; slice 4 is the first ingress consumer; slice 5 is the highest-risk
because it touches sanitizer rewriting and offset mapping. No slice starts before the slice it
depends on has merged.

## Relationship to #901 and open guard work

- **#901 link verification** is a browser-facing design
  ([`link-verification.md`](link-verification.md)). It needs resolved addresses and a way to make
  one selected link inert. The seam gives it both without another parser. Browser acceptance of a
  link grants the agent no fetch permission, and the egress gate continues to judge agent-initiated
  requests separately.
- **#888** broadens link matching in the data-URL rule and changes both `exfil-data-url` and
  `isSourceLink`'s second-scheme check. It is not part of this behavior-preserving seam. It should
  not merge into the same slices: after the seam converges, its proposed spellings are evaluated as
  a separate lexical change against the seam's fixture corpus, with its own measurement of false
  positives and false negatives. If it merges first, slices 4-5 re-pin to its behavior; if it is
  superseded, its tests become seam candidates rather than requirements.
- **Boundary-guards rulings remain binding.** This design does not widen or narrow any guard
  mode, detector, refusal, prompt or tier rule. It only consolidates how URL-bearing text is
  interpreted and rewritten.

## Open questions for the owner

1. **#888 sequencing.** Recommendation: hold #888 until slices 1-5 merge, then evaluate its
   lexical change as a separate measured delta. Alternative: land #888 first and make slices 4-5
   migrate its broadened behavior. This is an ordering decision, not a re-argument of the proposed
   matching.
2. **`carriesUrlQuery`.** It has no caller at `371f1f1d`. Recommendation: delete it in slice 1
   with a patch changeset, because the seam otherwise leaves a dead second URL reader in the same
   module. Alternative: leave it untouched to avoid any public-package API change.
3. **Seam visibility.** Recommendation: expose the pure module through the package's existing
   wildcard export and document it as an internal, no-stability-promise helper; #901 needs it from
   the app. Alternative: keep it package-private and copy nothing, which would force #901 to
   depend on an unexported path.

## Verification boundary

This document only. No code, tests, evals or live calls are run for the design itself. The
implementation slices run the existing package and app unit suites, the ReDoS and
step-1/O21 pins named above, and typecheck/lint/format/build. Every security pin ships with its
named mutation and the implementing PR records the red result.
