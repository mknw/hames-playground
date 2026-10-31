# Application configuration

Every environment variable and setting an operator can set, grouped by
concern. Derived from and verified against `app/.env.example`,
`app/src/lib/settings.ts`, `app/src/lib/cost-rates.server.ts`,
`packages/harness-baml/clients.server.ts` and
`app/src/lib/inference/tier.server.ts` — the files are the truth; this page
says what each thing DOES, what it defaults to, which providers it applies to,
and how the system fails when it is unset or wrong.

Generic values only. No instance values and no keys — this is a public repo
(ADR-0008); real values live in the git-ignored `app/.env` of a deployment.

## How to read this page

- **Defaults are in code, examples are in `app/.env.example`.** The example
  file is the operator-facing checklist; this page is the semantics.
- **Fail-closed is the house rule.** Where this page says _refuse_, the
  variable's absence or a bad value stops the boot or refuses the request —
  it never silently falls back to another provider, another endpoint, or a
  weaker posture. Where it says _fall back_, the fallback is itself the
  documented default, not a second provider.
- Several inference variables are read **per call**, not captured at boot, so
  an operator can change them without a rebuild. The ones that must be right
  at boot (tiers, keys, endpoints) are validated at module load instead.
- One-release renames: the legacy `VERDA_*` names
  (`VERDA_INFERENCE_ENDPOINT`, `VERDA_INFERENCE_API_KEY`, `VERDA_EUR_PER_HOUR`,
  `VERDA_SCALEDOWN_SECONDS`, `VERDA_WAKE_*`, `USE_VERDA_INFERENCE`) are
  accepted for `LARGE_LLM_*` / `USE_SELF_DEPLOYED_INFERENCE` and warn. The
  endpoint and its key migrate as ONE pair: once either canonical name is set,
  neither legacy name applies. `INFERENCE_TIERS=private` warns and reads as
  `self_deployed`.

---

## 1. Boot, database and secrets

| Variable               | What it does                                                                                                                                                                                                                            | Default                                                                              | Applies to               | Unset / wrong                                                                                                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`         | Postgres connection string.                                                                                                                                                                                                             | none                                                                                 | everything               | Boot fails; no fallback.                                                                                                                                                                           |
| `DATA_ENCRYPTION_KEY`  | Encrypts the content columns of every table in `ENCRYPTED_TABLES` at rest (`app/src/lib/db/crypto.server.ts`).                                                                                                                          | none — **required**, no fallback, deliberately not shared with the other two secrets | Postgres content columns | Booting with encrypted rows and no key is a hard failure; a missing key on a fresh schema fails on first write. **Back it up separately from the database** — it is not recoverable from the rows. |
| `AUTH_SESSION_SECRET`  | HMAC key signing auth cookies.                                                                                                                                                                                                          | none                                                                                 | auth                     | Boot/login fails.                                                                                                                                                                                  |
| `TOKEN_ENCRYPTION_KEY` | Encrypts the per-user Microsoft token cache at rest. Falls back to an HKDF value derived from `AUTH_SESSION_SECRET` when unset — set it explicitly in production so rotating the session secret does not invalidate every cached token. | derived from `AUTH_SESSION_SECRET`                                                   | Microsoft token cache    | Falls back (documented); a deployment that loses both secrets loses the cached tokens.                                                                                                             |

The three secrets rotate at wildly different costs, which is why
`DATA_ENCRYPTION_KEY` shares nothing with the other two.

## 2. Identity and access

| Variable                                                    | What it does                                                                                                                                                                                                                                                                                                   | Default               | Applies to                        | Unset / wrong                                                                                                                              |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | Entra ID (OIDC) application credentials for MSAL sign-in.                                                                                                                                                                                                                                                      | none                  | auth                              | Sign-in fails.                                                                                                                             |
| `AUTH_REDIRECT_URI`, `AUTH_POST_LOGOUT_REDIRECT_URI`        | OIDC redirect and post-logout URIs. Defaults target dev (port 3444); the redirect's origin is also the app's PUBLIC ORIGIN.                                                                                                                                                                                    | dev defaults          | auth                              | **Required in production** — unset there, the server refuses to boot.                                                                      |
| `AZURE_GRAPH_SCOPES`                                        | Escape hatch for the delegated Graph scopes requested at sign-in. May only TRIM the already-consented allowlist (`User.Read email Mail.Read Mail.Send Calendars.ReadWrite Files.Read.All Sites.Read.All`); all other scopes, including `Calendars.Read` and `.default`, are refused before token-cache access. | the consented seven   | Microsoft Graph tools (read-only) | An invalid or widening value refuses boot.                                                                                                 |
| `VITE_ALLOWED_EMAILS`                                       | Email allow-list for real auth (comma-separated; supports `*@domain.com`).                                                                                                                                                                                                                                     | none                  | auth                              | Unset refuses every identity (fail-closed allow-list).                                                                                     |
| `VITE_DEV_BYPASS_AUTH`                                      | DEV-only auth bypass. Requires both the dev build constant and this env var; a production build replaces the constant with `false`, so it cannot be switched on from a prod bundle. A prod build still carrying the var warns at module load.                                                                  | off                   | dev only                          | Ignored in production builds. All bypassed callers share one identity and one conversation namespace — a documented footgun, not a defect. |
| `GRAPH_TIMEZONE`                                            | IANA timezone Graph renders calendar times in.                                                                                                                                                                                                                                                                 | the server's own zone | Microsoft 365 tools               | Falls back.                                                                                                                                |
| `HOME_EMAIL_DOMAINS`                                        | This deployment's own email domains, comma-separated. A Microsoft 365 result from one of these domains reads as "internal".                                                                                                                                                                                    | none                  | Microsoft 365 tools               | Falls back (no internal classification).                                                                                                   |
| `GRAPH_DOCUMENT_HOSTS`                                      | This deployment's own SharePoint/OneDrive hosts, comma-separated exact hostnames. A Graph result's own `webUrl` on one of them is exempt from the `exfil-data-url` rule, and from no other rule; an entry must be a bare hostname, never a wildcard or pattern.                                                | none                  | Microsoft Graph tools             | Falls back (no link is exempt).                                                                                                            |

## 3. Inference tiers and client routing

The tier of a run decides which provider serves its model calls. It is a
per-conversation, per-run slot of the run frame; resolved by
`app/src/lib/inference/tier.server.ts` (conversation column → user's last-used
tier → default). `packages/harness-baml/tier.server.ts` registers
`effectiveTier()` into core, so routing and the boundary guards cannot name
different tiers.

| Variable                      | What it does                                                                                                                                                                                                                                                                                                                                                                                                                       | Default                                       | Applies to     | Unset / wrong                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------- |
| `INFERENCE_TIERS`             | Deployment-level tier restriction. `self_deployed` disables Anthropic for this deployment: stored Anthropic conversation tiers and user seeds resolve to private without rewriting history; new Anthropic selections are refused; explicit public run frames, public client overrides, and BAML calls missing their private override fail before request construction. The switch keeps Anthropic visible, disabled and explained. | unset — existing routing and key requirements | the whole app  | An unrecognised value is not a tier. All five private-tier values are required at boot when `self_deployed` is set. |
| `USE_SELF_DEPLOYED_INFERENCE` | The BOOT-TIME check that the private tier is configured. Not the tier of a run and not a restriction: a run that names no tier is on the private tier anyway when the host policy says so.                                                                                                                                                                                                                                         | unset (changes nothing)                       | boot           | With `=1`, a missing private-tier configuration fails boot.                                                         |
| `ANTHROPIC_API_KEY`           | The Anthropic tier's key.                                                                                                                                                                                                                                                                                                                                                                                                          | none                                          | Anthropic tier | Required unless `INFERENCE_TIERS=self_deployed`.                                                                    |

**The one tier rule (ruling E):** a frame tier is the Anthropic tier only when
it says exactly `'anthropic'`; an absent or empty tier takes the host policy's
default tier; a present but unrecognised one is the self-deployed tier on every
host — **refused when that tier is not reachable**, never rerouted to
Anthropic. A defaulted self-deployed tier that is not configured is refused on
every read (`assertPrivateTierConfigured`), never descaled.

## 4. The private 27B — endpoints, model id, and the route

The company's own Qwen deployment behind vLLM on Verda or Modal (confidential
compute), reached by any run on the self-deployed tier. Declared as
`LargeQwen` (thinking off) and `LargeQwenThink` (thinking on, parser-equipped
box) in `packages/harness-baml/baml_src/large-client.baml`.

| Variable             | What it does                                                                                                                                                                                                                                                                      | Default                         | Applies to                   | Unset / wrong                                                                                                                                                                                                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LARGE_LLM_BASE_URL` | The OpenAI-COMPATIBLE base — deployment root plus `/v1`, handed to `openai-generic` verbatim.                                                                                                                                                                                     | none                            | private tier, 27B roles      | Missing refuses the tier (boot when flagged); a value not ending in `/v1` refuses at boot — a bare root would 404 every call.                                                                                                                                                                               |
| `LARGE_LLM_API_KEY`  | Bearer key for the endpoint. Migrates as ONE pair with the base URL.                                                                                                                                                                                                              | none                            | private tier, 27B roles      | Missing refuses the tier.                                                                                                                                                                                                                                                                                   |
| `LARGE_LLM_MODEL`    | The model id on the wire. Default applied at boot in `inference-env.server.ts` (`DEFAULT_LARGE_LLM_MODEL`, `Qwen/Qwen3.8-27B-FP8`), so unset is byte-identical to the literal the declaration carried. An empty value is treated as unset (back to the default, never garbage).   | `Qwen/Qwen3.8-27B-FP8`          | all 27B clients, both routes | **Required (not defaulted) when `LARGE_LLM_ROUTE=openrouter`** — the default names the vLLM deployment's HF path, which OpenRouter refuses on every call; the boot assert refuses instead. On vLLM, any id the deployment does not serve is 400ed per call.                                                 |
| `LARGE_LLM_ROUTE`    | **The 27B route switch.** `openrouter` sends every role the tier map points at the 27B to the declared OpenRouter-route twins (`LargeQwenOR` / `LargeQwenThinkOR` — see §5); `modal` (or unset) keeps the GPU box. The switch is EXPLICIT — the base URL is never sniffed for it. | unset = `modal`, byte-identical | private tier, 27B roles      | Any other value **refuses** (`largeLlmRoute()`), never guesses: a typo'd route silently sending confidential traffic to the wrong kind of endpoint is the one failure this var must never have. On `openrouter` the wake poll and the box's infrastructure accounting are skipped (no box to wake or bill). |

**Provider posture (SD-12):** every routing chain uses one provider; the private
tier sends no call to a public AI provider except through the explicit
OpenRouter route above, which is a processor/transfer decision recorded with
`provider { zdr: true }` on the wire. Pointing the tier at a new endpoint is an
env edit; making a new provider reachable is a decision, not a config change.

## 5. Per-pattern reasoning (provider-independent)

| Variable                  | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Default                                                                        | Applies to                       | Unset / wrong                                                                                                                                                                                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PRIVATE_REASONING_ROLES` | Comma-separated list of HARNESS PATTERN names whose model calls run with model-side thinking ON while the active tier is self_deployed. One setting governs the Modal/Verda box AND the OpenRouter route — **the setting never names a provider or client**; the client seam owns the wire translation. Known vocabulary: `controller, actor, critic, synthesizer, router, planner, describe, screen`. Today twins exist for `controller` (`ControllerThinking`), `critic` (`CriticThinking`) and `planner` (`PlannerThinking`). | unset = no pattern thinks; routing byte-identical to the pre-reasoning posture | private tier, the named patterns | A named pattern **with no twin** (e.g. `actor`) REFUSES at module load ("reasoning enabled for pattern X but no reasoning twin exists") — fail-closed, never a silent no-op. An unknown token refuses at module load. An unrecognised value never degrades to "off quietly". |

**Wire representation — the native reasoning field is primary.** The twin
clients are TRANSLATIONS of one provider-neutral setting at the client seam:

- **OpenRouter route** (`LargeQwenThinkOR`): carries OpenAI's native
  `reasoning { enabled: true }`, which OpenRouter honours for
  `qwen/qwen3.8-27b` (probed live): the trace rides the response's separate
  reasoning field and `content` holds only the answer envelope. The
  `chat_template_kwargs { enable_thinking }` form is **accepted but NOT
  honoured** on OpenRouter, so the OR clients carry it nowhere.
- **vLLM route** (`LargeQwenThink`): carries the `chat_template_kwargs`
  kwarg, because that is what the deployed vLLM demonstrably honours.
  **Native reasoning-object acceptance on vLLM is UNVERIFIED** — the probes
  hit OpenRouter only — so the kwarg translation stays in effect on that route
  until verified. **The live check is owner-gated; it is not a standing call.**

The thinking-leaf discipline (G19 Q7) is unchanged on both routes: an inline
think-close in `content` is REFUSED loudly, the trace is taken from the
separate field only, and the reasoning twins get ONE corrective retry on the
non-thinking twin of the SAME route.

## 6. The private small box — summarizer and decisions

`SmallQwen` (the 4B summarizer, the `describe` role) and `PrivateSystemOne`
(the systemone decision transport on the private tier).

| Variable                  | What it does                                                                                                                                                                     | Default  | Applies to                         | Unset / wrong                                                                                                                                                                                                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SMALL_LLM_BASE_URL`      | The 4B summarizer's OpenAI-compatible `/v1` base. No in-code default — `app/.env.example` carries the localhost values.                                                          | none     | private tier `describe`            | **Required by the private tier** since 2026-08-26: a tier with no small box is REFUSED, not descaled onto the 27B (named owner decision).                                                                                                                                   |
| `SMALL_LLM_API_KEY`       | Bearer key, shared with the decisions endpoint. Local llama-servers ignore it; systemone authenticates it.                                                                       | none     | private tier `describe` + `decide` | Required by the private tier.                                                                                                                                                                                                                                               |
| `SMALL_LLM_DECISIONS_URL` | The FULL decisions endpoint URL, ending in `/v1/systemone`.                                                                                                                      | none     | private tier `decide`              | Missing refuses the whole tier (and fails boot when flagged). A URL naming a public systemone provider (`api.typesafe.ai`, `openrouter.ai`) is refused before any request. A wrong path refuses. **Never falls through to the Anthropic tier's endpoint, and the reverse.** |
| `SMALL_LLM_WAKE_*`        | `SMALL_LLM_WAKE_TIMEOUT_MS` (720000), `_ATTEMPT_TIMEOUT_MS` (10000), `_POLL_INTERVAL_MS` (5000), `SMALL_LLM_SCALEDOWN_SECONDS` (300): the small box's wake poll and idle window. | see left | private tier `describe`            | Tuning only; mis values degrade latency estimates, not correctness. The remote 4B must also serve `GET <base without /v1>/health` — an endpoint without it refuses every private-tier turn.                                                                                 |

The Anthropic tier's decision transport is separate: `JEV_DECISIONS_URL` (a
parsed https-or-loopback endpoint) + `JEV_DECISIONS_API_KEY`. **Each tier
refuses its own missing decision configuration without falling through to the
other tier's endpoint.**

## 7. Pricing

Four bases, one currency (EUR), decided by the client the call ACTUALLY
selected — never by the tier the run intended.

| Variable                     | What it does                                                                                                                              | Default                                                                        | Applies to                      | Unset / wrong                                                                                  |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------- | ---------------------------------------------------------------------------------------------- |
| `EUR_PER_USD`                | Static USD→EUR multiplier (`0.86`), set by hand. Deliberately NOT a live FX lookup: two page loads of one conversation must not disagree. | `DEFAULT_EUR_PER_USD`                                                          | every USD figure                | A non-positive or garbage value warns and falls back to the default — never renders as "free". |
| `LARGE_LLM_EUR_PER_HOUR`     | EUR/hour the 27B box is awake (time-priced clients).                                                                                      | `4.59898` (Modal H100, 4 cores, 64 GiB, broad `eu` compute)                    | `LargeQwen`, `LargeQwenThink`   | Non-positive warns and falls back. Set for a different host, shape or compute region.          |
| `SMALL_LLM_EUR_PER_HOUR`     | EUR/hour the small L4 box is awake.                                                                                                       | `1.07418` (L4, 2 cores, 24 GiB, broad `eu` compute)                            | `SmallQwen`, `PrivateSystemOne` | Same rule.                                                                                     |
| `SMALL_LLM_EUR_PER_HOUR_A10` | EUR/hour when the small box serves on A10.                                                                                                | `1.37088`, derived from the L4 rate using the full A10/L4 container cost ratio | `SmallQwen`, `PrivateSystemOne` | Explicit override wins; otherwise an L4 override moves this derived default proportionally.    |

The Modal defaults come from the dated GPU, CPU, memory and compute-region table
in `app/src/lib/modal-pricing.ts`: `(GPU USD/h + cores × CPU USD/core/s × 3600 +
GiB × memory USD/GiB/s × 3600) × compute-region multiplier × EUR_PER_USD`.
The full A10/L4 ratio includes CPU and memory; the GPU-only ratio 1.375 does not
price a complete box. Both boxes are configured for broad `eu` compute (1.15×)
as of 2026-10-30; the 27B routing region remains `eu-west` and does not set
the compute price. Narrow `eu-west` compute costs 1.75×. Paid verification of
the 27B live compute placement remains an owner decision. If a deployment
changes its region or allocation, set the corresponding hourly override.
Sources read 2026-10-30: [Modal pricing](https://modal.com/pricing) and
[Modal region selection](https://modal.com/docs/guide/region-selection).

The bases (pinned disjoint by `pricing-eur.test.ts`):

- **Token** (Anthropic chains): vendor list price in USD from `CLIENT_PRICING`
  (`app/src/lib/settings.ts`), converted once at `EUR_PER_USD`.
- **Provider** (`PROVIDER_COST_CLIENTS`: `JevDecide`, plus the OpenRouter-route
  twins `LargeQwenOR` / `LargeQwenThinkOR`): the provider-reported `usage.cost`
  (USD), converted once. A response with no cost is UNKNOWN, never free.
- **Time** (`TIME_PRICED_CLIENTS`): `LargeQwen` / `LargeQwenThink` at
  `LARGE_LLM_EUR_PER_HOUR`, and `SmallQwen` / `PrivateSystemOne` at
  `SMALL_LLM_EUR_PER_HOUR` — measured call duration × the box's hourly rate;
  tokens free. A time bill with no duration reads as unknown, not free.
- **Local** (`LOCAL_PRICED_CLIENTS`: `LocalGLM`): exact €0.00 — no marginal bill.

Rendered figures for time-priced steps are FLOORS, labelled `≥` ("compute
time"): they exclude the cold start and the scale-down window.

## 8. Output caps, truncation recovery, context windows

| Setting                    | What it does                                                                                              | Where                     | Failure mode                                                                                                                                                                                                                                                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLIENT_MAX_OUTPUT_TOKENS` | Per-leaf `max_tokens` mirror of `baml_src/*.baml`; drives cap-hit detection and the ONE corrective retry. | `app/src/lib/settings.ts` | A missing entry silently blinds truncation detection for that client (SA-C2); `client-output-caps.test.ts` enforces the mirror. Current 27B values (all four leaves): 4096, provisional/unmeasured — G19 Q5's separately authorised eval sets the final pair, and the cap moves with its coupled 180s timeout together or not at all. |
| `MODEL_CONTEXT_WINDOWS`    | Per-client context window; `resolveClientForRole` trims against the SERVER's real ceiling.                | `app/src/lib/settings.ts` | Unknown client falls back to 16K (over-trims, never overflows). 27B leaves: 131072, from vLLM's `--max-model-len`; the OR twins carry the same provisional value pending the eval.                                                                                                                                                    |

## 9. Wake, warm and scale-to-zero

| Variable                            | What it does                                                                                                      | Default                       | Applies to          | Unset / wrong                                                                                                                                                                    |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LARGE_LLM_WAKE_TIMEOUT_MS`         | Overall bound of the 27B wake poll.                                                                               | `600000`                      | private tier turns  | A value below the measured cold-start tail (~360s) reliably fails the first turn of every session.                                                                               |
| `LARGE_LLM_WAKE_ATTEMPT_TIMEOUT_MS` | Per-attempt bound of the poll.                                                                                    | `30000`                       | private tier turns  | Must stay well clear of a warm call's p95 (9.9s) so a warm box never retries.                                                                                                    |
| `LARGE_LLM_WAKE_POLL_INTERVAL_MS`   | Interval between wake attempts.                                                                                   | `5000`                        | private tier turns  | Tuning.                                                                                                                                                                          |
| `LARGE_LLM_SCALEDOWN_SECONDS`       | The box's idle window, AS CONFIGURED — the cold-start estimate's coldness gate reads this.                        | `300` (matching the live box) | cold-start estimate | A value lower than the deployment's own understates coldness; the estimate's plausibility floor (36.5s, its own literal) is what keeps a wrong value from poisoning the history. |
| `MEMORY_WAKE_*`                     | The memory summarizer's wake subscription (`MEMORY_WAKE_TIMEOUT_MS`, `_ATTEMPT_TIMEOUT_MS`, `_POLL_INTERVAL_MS`). | see `.env.example`            | memory writes       | Tuning.                                                                                                                                                                          |

Both boxes wake in parallel before any harness work; concurrent turns share
one poll per box. A wake failure ends the turn VISIBLY (an error frame naming
the box, and nothing was sent to any other provider) — it never falls back to
Anthropic. On the OpenRouter route the large poll is skipped: there is no box
to wake.

## 10. Embedder

| Variable                   | What it does                                                                                                                                                                                 | Default                           | Applies to       | Unset / wrong                                                      |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ---------------- | ------------------------------------------------------------------ |
| `EMBEDDINGS_PROVIDER`      | The embedding provider. `local` is the Data Stash embedder; anything else must be declared trusted in code — `openrouter` is refused at boot, so query text cannot leave the box through it. | `local`                           | stash embeddings | An untrusted value refuses boot.                                   |
| `EMBEDDINGS_LOCAL_URL`     | The 0.6B embedder's OpenAI-compatible `/v1` base.                                                                                                                                            | localhost value in `.env.example` | stash embeddings | Falls back to the configured default; a wrong host fails per call. |
| `EMBEDDINGS_LOCAL_API_KEY` | Bearer key; optional (a local llama-server ignores it).                                                                                                                                      | empty                             | stash embeddings | Optional.                                                          |
| `EMBEDDINGS_LOCAL_MODEL`   | The embedding model. Changing the MODEL (not the host) invalidates the vector index.                                                                                                         | see `.env.example`                | stash embeddings | See `docs/DATA_STASH.md`.                                          |

## 11. Boundary guards (operator switches)

Four `GUARD_*` variables let an operator weaken a guard WITHOUT a code change,
and three set the guards' numbers (#844); a weaker value logs at boot what it
loosened (`app/src/lib/inference/guard-config.server.ts`). An unrecognised or
out-of-range value refuses boot and never echoes the value; unset keeps the
default.

| Variable                                 | Values                       | Default                                                  | Failure mode                                                                             |
| ---------------------------------------- | ---------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `GUARD_SCREEN`                           | `off, shadow, gated, always` | `gated` on the self-deployed tier, `always` on Anthropic | An unrecognised value refuses boot. Weakening logs at boot.                              |
| `GUARD_SCREEN_ANTHROPIC`                 | `off, always`                | `always`                                                 | Same.                                                                                    |
| `GUARD_EGRESS`                           | `filter, roster`             | `filter`                                                 | Same.                                                                                    |
| `GUARD_PSEUDONYMISE`                     | `on, off`                    | `on`                                                     | `off` refuses nothing but logs that names are no longer substituted (SD-8/SD-9 posture). |
| `GUARD_GATE_THRESHOLD`                   | a number from 0 to 1         | `0.15` (τi; obeyed only by a `gated` screen)             | Out of range refuses boot. Above the default logs that more content skips the screen.    |
| `GUARD_EGRESS_THRESHOLD`                 | a number from 0 to 1         | `0.3` (τe, both tiers)                                   | Out of range refuses boot. Above the default logs that more requests go out unasked.     |
| `GUARD_EGRESS_MAX_RETRIES_POST_TRIPWIRE` | a whole number, 0 or greater | `0` (the first refusal closes the route)                 | Out of range refuses boot. Above 0 logs that a refused request can be asked again.       |

## 12. Data services and documents

| Variable                                                                          | What it does                                                                                                                                         | Default                     | Applies to         | Unset / wrong                                                                  |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------ | ------------------------------------------------------------------------------ |
| `NEO4J_BOLT_URL`, `NEO4J_HTTP_URL`                                                | Neo4j connections. In the compose topology Neo4j sits on an isolated internal bridge; the host app uses localhost through the published relay ports. | see `.env.example`          | graph              | Connection failures surface per call, never silently degrade to another store. |
| `REDIS_HOST_DIRECT`, `REDIS_PORT`, `REDIS_PWD`, `REDIS_SSL`, `STASH_DIRECT_REDIS` | The app-side Redis transport for the document stash (7-day expiry).                                                                                  | see `.env.example`          | stash              | See `docs/DATA_STASH.md`.                                                      |
| `STASH_CONVERT_DOCS`, `DOC_CONVERT_URL`, `DOC_CONVERT_TIMEOUT_MS`                 | Document conversion service for ingestion.                                                                                                           | see `.env.example`          | file ingestion     | Conversion failure is recorded, never silent.                                  |
| `MCP_GATEWAY_URL`                                                                 | The Docker MCP gateway (port 8811) the agents' tools connect to server-side.                                                                         | `http://127.0.0.1:8811/mcp` | agent tool surface | An unreachable gateway degrades per the gateway-health seam and is recorded.   |

## 13. Sandbox execution

| Variable                                                                                                                                                                | What it does                                                                                                                                                                                    | Default            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `SANDBOX_ENVIRONMENT`, `SANDBOX_DOCKER_HOST`, `SANDBOX_DOCKER_TLS_*`                                                                                                    | Which Docker the code-execution boxes run on. **Production backends require an explicit environment namespace.**                                                                                | see `.env.example` |
| `SANDBOX_EGRESS_*` (`_PROXY_PORT`, `_GITHUB_ALLOWLIST`, `_PYPI_ALLOWLIST`, `SANDBOX_ENABLE_OPEN_EGRESS`)                                                                | The egress profile plumbing. **One profile is enforced; the rest are vocabulary** — see SD-20 in `docs/agents/sensitive-domain-brief.md`.                                                       | strict by default  |
| `SANDBOX_BASH_ALLOW`, `SANDBOX_BASH_DENY`, `SANDBOX_PIDS_LIMIT`, `SANDBOX_SECCOMP_PROFILE`, `SANDBOX_APPARMOR_PROFILE`, `SANDBOX_CACHE_VOLUME`, `SANDBOX_WORK_TMPFS_MB` | Flavour and containment knobs. Capability drops, read-only root, non-root user and a syscall profile are on the DEFERRED list, not the backend — do not describe this area as hardened (SD-19). | see `.env.example` |

## 14. Browser-visible (`VITE_*`) and evaluation

| Variable                                      | What it does                                                                                                                                                                   | Failure mode                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `VITE_ALLOWED_EMAILS`, `VITE_DEV_BYPASS_AUTH` | See §2.                                                                                                                                                                        | See §2.                                                          |
| `HAMES_TEST_ALLOW_LOCAL_DB`                   | Names the ONE absolute checkout path allowed to point the test suites at a local Postgres. A copy of it (another worktree's `.env`, an inherited export) opts nothing else in. | Wrong path refuses the suite with instructions; CI runs DB-less. |
| `TEST_DATABASE_URL`                           | Private throwaway Postgres for test runs (worktrees, lanes, agents).                                                                                                           | Unset + no allowance refuses; see `docs/testing/pyramid.md`.     |

## 15. Eval-only posture

The live general-next eval is gated twice: `EVAL_GENERAL_GO` must equal the
coordinator-merged go phrase, and `assertLivePreconditions`
(`app/src/lib/eval-support/live-preconditions.ts`) validates an env-file
SNAPSHOT before any model runtime is imported — remote HTTPS endpoints with
the right paths, keys present, and (since the route switch) `LARGE_LLM_MODEL`
required when `LARGE_LLM_ROUTE=openrouter`. Hermetic modes run
`poisonPublicProviders`, which replaces every public-provider credential with
a value the boot refuses — so no test can reach a public provider by accident,
and no live OpenRouter call happens in the test suites.
