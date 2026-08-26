# Data protection: findings and plan

**Status:** technical audit complete, verified against `main` on 2026-08-15. No
compliance artefact exists yet — this document is the input to producing them.

**What this is and isn't.** Everything under "Where the data is" and "Findings"
is fact, established by reading the code and querying the live database, and can
be re-verified. Everything under "Legal reading" is a non-lawyer's mapping of
those facts onto the obligations they plausibly engage, and needs DTSC's counsel
or DPO to confirm. The value here is that the factual groundwork is the first
thing either of them will ask for.

---

## Scope and roles

DTSC is the **controller**; the data subjects are DTSC employees using the
assistant. Anthropic is the **processor** (it is now the only LLM provider —
the Groq / OpenRouter / OpenAI chains and their `USE_MIXED_CHAINS` switch were
removed 2026-08-24; see finding 1). The app is internal-only and reached through Entra
SSO, so every record is tied to a named employee — there is no anonymous use and
no pseudonymisation anywhere in the stack.

---

## Where the data is

Measured on the live dev database, 2026-08-15.

| Store                     | Contents                                                                                                       | Encrypted at rest          | Retention                           | Rows now |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------- | ----------------------------------- | -------- |
| Postgres `conversations`  | `context` JSONB — the **full event stream**: `user_message`, `assistant_message`, `tool_call`, `tool_result`   | `title` + `context`        | **none**                            | 28       |
| Postgres `users`          | Entra `oid`, email, display name, tenant id, first/last login                                                  | `email` + `display_name`   | none                                | 1        |
| Postgres `auth_sessions`  | oid, email, display name, 8h expiry                                                                            | `email` + `display_name`   | lazy, per-id + hourly sweep         | 22       |
| Postgres `routines`       | agent id, trigger kind/config, the input prompt, label (#131)                                                  | `input` + `label`          | none                                | —        |
| Postgres `user_tokens`    | MSAL cache, **AES-256-GCM encrypted**, fails closed                                                            | `token_cache`              | deleted on logout                   | 1        |
| Postgres `session_claims` | session id -> owner id, for the pre-persistence window                                                         | nothing (holds no content) | `expires_at`, mirrors the stash TTL | —        |
| Redis Data Stash          | uploaded and Microsoft 365-ingested documents, chunks, embeddings                                              | **no**                     | **7 days** (`DEFAULT_TTL_SECONDS`)  | —        |
| Neo4j                     | **the staff directory**: per `Member` — `entraId`, `displayName`, `mail`, `department`, `jobTitle`, `syncedAt` | **no**                     | **none**                            | 49       |

The Postgres column encryption is AES-256-GCM under `DATA_ENCRYPTION_KEY`
(`app/src/lib/db/crypto.server.ts`), applied in the repository modules on write
and read; identifiers, the lifted enums and the timestamps stay plaintext so
owner scoping, indexes and list ordering still happen in SQL. It closes the
"conversation content sits in plaintext" half of finding 4 and the second half
of plan item 3. It does **not** cover Redis or Neo4j, and it is not a substitute
for retention (finding 2) or erasure (finding 3): encrypted-and-kept-forever is
still kept forever.

Conversation data spans 2026-07-27 → 2026-08-15. Nothing has ever been deleted
by a retention process, because none exists.

The Neo4j row is dated differently from the rest of the table and reads across
from a different measurement: until the org-graph roster ingest shipped, that
store held disposable `Concept`/`Class` sketches and "graph content / none /
—" was an accurate way to leave it. It now holds one node per enabled member of
the tenant. The 49 is the count that ingest reported on 2026-08-25 against the
compose Neo4j, not a fresh reading of the live one; the row's shape is from
`NODE_LABELS` in `app/src/lib/org-graph/ontology.ts`, which is authoritative and
does not go stale. The other three labels the ontology declares — `Team`,
`Resource`, `Knowledge` — are empty, and `Team` is empty because the app
registration lacks the tenant permission rather than because nothing writes it.

Two things follow, and neither is decided: the retention column says `none` for
the same reason the `conversations` row does, and this store now contains
personal data that arrived from an **automated upsert** rather than from
anything a user typed, so a departed colleague's node persists until an ingest
counts it stale and a human acts on the count. That interaction is the open
decision (b) on PR #264.

The encryption column sharpens it. Since the Postgres columns went to
AES-256-GCM at rest, Neo4j is the **only** store that holds a name, an address,
a department and a job title per member of staff in plaintext, with no erasure
path. The only other `**no**` above it is the document stash, which expires in
seven days and holds what a user chose to upload.

### The part that changes the risk profile

`tool_result` events are stored **verbatim** inside `conversations.context`.
Since #133 and #136 shipped per-user Microsoft Graph access, a tool result can
contain **Outlook message bodies, calendar entries, and SharePoint / OneDrive
file contents**.

So `conversations` is no longer a table of chat logs. It is an indefinitely
retained, plaintext, partial mirror of employees' mailboxes and document
libraries, keyed directly to their Entra `oid`. That change happened in a
fortnight of ordinary feature work and was never re-assessed — which is the
single most important finding in this document.

---

## Findings

### 1. Third-country transfers and processor agreements — the largest exposure

Every conversation, including the embedded mail and file content described
above, is sent to **Anthropic's API** — and, since 2026-08-24, to no other LLM
provider. MCP tool servers (web fetch/search, GitHub, Context7) receive whatever
is passed to them.

Each is a processor under **Art. 28** (needs a data processing agreement) and,
being US-based, a **Chapter V transfer** (needs EU–US Data Privacy Framework
certification or Standard Contractual Clauses, plus a transfer impact
assessment). Which DPAs DTSC holds, and each vendor's current DPF status, must
be checked — this cannot be determined from the codebase.

Two things follow that _are_ in our control:

- **Anthropic-only is a compliance asset**: one processor to paper rather than
  four. It is no longer a default that a switch could undo — the mixed-provider
  chains and the `USE_MIXED_CHAINS` env flag were deleted outright on
  2026-08-24, so there is no configuration that sends a prompt to Groq,
  OpenRouter or OpenAI. Re-introducing one is an Art. 28 / Chapter V decision,
  not a config change.
- Whether **zero-retention / no-training-on-inputs** terms apply to the account
  materially changes the risk picture, and is a contract setting rather than a
  code one.

**Update (2026-08-25, widened 2026-08-26) — a self-hosted route now exists,
and it now covers every conversational role.** A verda tier decision — the
`USE_VERDA_INFERENCE=1` deployment default or a per-user header switch —
re-points controller / actor / critic / synthesizer / router / planner /
describe at the company's own Qwen deployment on a Verda (DataCrunch) GPU
(`baml_src/verda-client.baml`). Read against the paragraph above: no
configuration still sends a prompt to Groq, OpenRouter or OpenAI, and the new
route moves prompts _off_ a third-country processor rather than onto one, so it
cuts the exposure this finding is about rather than widening it. Three caveats
belong in the same breath, because each is the kind of thing this doc exists to
stop being assumed:

- The flag is **not** a "no prompt leaves the building" switch, though it is
  much closer to one than this doc first recorded. The open owner decision named
  here — whether `router`, `describe` and `planner` should follow — was **made
  on 2026-08-26, and they did**: `describe` is the role handed `tool_result`
  content verbatim, i.e. exactly the mail and file bodies "The part that changes
  the risk profile" is about, and leaving it on Anthropic while calling the tier
  confidential was the wrong way round. `router` went with it (it sees the raw
  user message) and `planner` with them.
  What remains on Anthropic in both tier positions is **`screen`** — the opt-in
  prompt-injection classifier — and it is not a leftover: a screen is only worth
  running on a model that cannot be talked out of reporting by the content it
  reviews and that copies matched spans verbatim, and the self-hosted model is
  unmeasured on both (SA-M5). The residual exposure is therefore narrow and
  specific: for an agent with the screen enabled, up to 20 000 characters of
  **fetched third-party content** per guarded tool result reach Anthropic
  whatever tier the chat is on. No agent enables it today. Moving it is a
  distinct owner decision and wants a measurement first, not a map edit; the
  role map in `clients.server.ts` is where it would be made.
- The **infrastructure** is company-controlled, which is a claim about hosting,
  not a completed Art. 28 / Chapter V analysis: DataCrunch is still a hosting
  provider with its own contract, location and sub-processors, and this doc has
  not looked at any of them.
- The client asks for **no prompt caching** (no `allowed_role_metadata`, so the
  templates' `cache_control` breakpoints are dropped) — nothing in a request
  asks anything to retain a prompt. The deployment's own vLLM prefix cache is a
  server flag outside this repo and is not covered by that statement.

### 2. No storage limitation (Art. 5(1)(e))

`conversations` has no TTL and no deletion policy, while Data Stash documents
expire after 7 days — an odd asymmetry, since conversations now hold richer
personal data than the stash does.

**Evidence (as audited 2026-08-15):** of 22 `auth_sessions` rows, **21 were
already past `expires_at` and still present**, because
`deleteExpiredSessions()` in `app/src/lib/auth/session-store.server.ts` was
called from nowhere and expiry was enforced lazily per-id on access only. That
half has since been fixed: `startSessionSweepTimer()` is armed from
`ensureSchema()` in the same module, on an hourly self-unref'ing interval with
an immediate first sweep. `conversations` still has no expiry at all, which is
what the finding is now about.

### 3. Erasure is incomplete (Art. 17)

`deleteConversation` / `deleteConversations` correctly scope by `user_id`. But:

- Data Stash keys are `stash:doc:{sessionId}:{docId}` — scoped by **session, not
  user** — so "delete everything about me" has no implementation path.
- Neo4j content is not covered at all — and since the roster ingest that is no
  longer an abstract gap: the graph holds a name, an address, a department and a
  job title per member of staff, written by a scheduled-shaped job with no
  deletion path of any kind. Erasing a colleague from this system today means
  hand-written Cypher.
- There is no export path for a subject access request (Art. 15).

### 4. Security (Art. 32) — mixed, with real strengths

Genuinely good, and worth crediting: opaque server-side sessions, PKCE S256,
signed handshake with state/nonce, single-tenant authority, an email allow-list
enforced before session mint, timing-safe HMAC comparison, parameterized SQL,
AES-256-GCM on the per-user token store, and cross-user Graph isolation that is
mutation-tested.

Against that:

- ~~**Conversation content sits in plaintext**, including the Graph-derived
  material above.~~ Addressed: `conversations.title` / `conversations.context`,
  the `users` and `auth_sessions` profile columns and the `routines` prompt are
  AES-256-GCM encrypted under `DATA_ENCRYPTION_KEY`, so a dump yields
  ciphertext. Redis and Neo4j are unchanged.
- The committed compose publishes Postgres, Redis and Neo4j on `0.0.0.0` with
  password `password`. Fine on a laptop, unacceptable on a VM — which is why
  `docs/deployment/azure-vm.md` overrides it. That override is now load-bearing.
- **No Postgres backups exist.** This is an Art. 32(1)(c) obligation ("ability
  to restore availability and access to personal data in a timely manner"), not
  merely ops hygiene.
- A **key-escrow trap**, now larger: `user_tokens` is encrypted with
  `TOKEN_ENCRYPTION_KEY`, which HKDF-derives from `AUTH_SESSION_SECRET` when
  unset, and conversation content is encrypted with `DATA_ENCRYPTION_KEY`, which
  has no fallback at all. If those live only in the VM's systemd
  `EnvironmentFile` and the VM is what was lost, the restored database cannot be
  decrypted — and for `DATA_ENCRYPTION_KEY` that means the conversations
  themselves, not just a re-obtainable token cache. The keys must be backed up
  **separately from the data**. This is the cost side of the encryption above and
  it is not optional.
- `auth_sessions.token_cache` — the legacy plaintext column from #119 — still
  exists in the schema. It is no longer written and currently holds **0 non-null
  rows**, so the exposure is remediated in data; dropping the column is
  outstanding schema cleanup.

### 5. Missing paperwork

- **Art. 30 record of processing activities** — does not exist. Cheapest item
  here and the first thing a regulator asks for.
- **Art. 13 transparency** — employees have no privacy notice telling them their
  conversations and retrieved mail are stored, where, for how long, and which
  third parties see them. There is no mention of GDPR, personal data or privacy
  anywhere in `docs/`.
- **Art. 6 legal basis** — none stated. For workplace tools this is normally
  legitimate interest or contract performance; **consent is generally not valid
  in an employment relationship** because of the power imbalance, so it should
  not be the basis chosen.

---

## Legal reading — needs confirmation

### Belgium-specific

- **CAO/CCT nr. 81** (26 April 2002) governs monitoring of employees' electronic
  online communications. This is not monitoring software, but it _stores
  employees' communications content_ in an employer-administered system, so if
  that data could ever be consulted about an individual, its purpose-limitation
  and prior-information rules engage. An explicit written commitment that the
  data will not be used for individual performance monitoring is cheap and worth
  making.
- **Works council / ondernemingsraad** (and the CPBW/CPPT) normally must be
  informed or consulted before introducing technology that affects working
  conditions or processes employee data. Doing this before rollout is far
  cheaper than retrofitting it.
- Supervisory authority is the **GBA/APD**; the Belgian Act of 30 July 2018
  supplements the GDPR, including on employment-context processing.
- **DPIA (Art. 35)** is probably not strictly triggered by a small internal
  assistant, but the APD publishes a list of processing requiring one, and with
  mailbox content plus AI in scope a short DPIA is cheap insurance.

### EU AI Act

As an internal productivity assistant this sits in the low-obligation tier; the
Art. 50 "users know they are interacting with AI" duty is satisfied by it
obviously being a chat interface. It would change character sharply if outputs
were ever used for HR decisions (Annex III high-risk, plus an obligation to
inform workers' representatives before deployment). Recording that as an
explicit out-of-scope commitment now, while it is free, is worthwhile.

---

## Plan

Ordered by a mix of risk and cost. Items 1–3 and 5 are independent of the legal
questions and can start immediately; only item 4 blocks on someone else.

| #   | Action                                                                                                                                                                                                                                                       | Depends on               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| 1   | **ROPA + employee privacy notice.** One page each. Draftable from the data map above; the parts needing DTSC input are legal basis and retention period.                                                                                                     | DTSC input on two fields |
| 2   | **Decide and enforce a retention period for `conversations`.** A dated sweep is a small amount of code; the number is a business decision. Resolves the asymmetry with the stash's 7 days.                                                                   | retention decision       |
| 3   | ~~**Arm the session sweep**~~ (done — `startSessionSweepTimer`) and ~~**encrypt Graph-derived `tool_result` content**~~ (done — the whole `context` blob is encrypted, following the `user_tokens` pattern). Remaining: Redis and Neo4j are still plaintext. | —                        |
| 4   | **Confirm DPAs and the transfer mechanism** for Anthropic — now the only LLM processor. Gates production rollout more than any code here.                                                                                                                    | counsel                  |
| 5   | **Postgres backups, with the encryption keys escrowed separately.** Now triply justified: Art. 32(1)(c), ops, and the fact that a dump without `DATA_ENCRYPTION_KEY` is unrecoverable ciphertext.                                                            | —                        |
| 6   | **Before rollout:** works council information, and the CAO 81 purpose statement.                                                                                                                                                                             | HR / works council       |
| 7   | Drop the dead `auth_sessions.token_cache` column.                                                                                                                                                                                                            | —                        |

## Related

- Issue **#129** — auth hardening (session sweep, prod cutover chores).
- [`docs/deployment/azure-vm.md`](../deployment/azure-vm.md) — the compose override that
  stops the databases listening on `0.0.0.0` in production.
- [`docs/MICROSOFT_GRAPH.md`](../MICROSOFT_GRAPH.md) — what the Graph tools
  retrieve, i.e. what can end up inside `conversations.context`.
- [`docs/plan/ROADMAP.md`](../plan/ROADMAP.md) — multi-user phasing.
