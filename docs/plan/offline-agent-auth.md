# Acting for an offline user — the agent-trigger endpoint's credential model

**Status:** the offline mechanism is **already shipped and is the right one**;
this plan is about the credential in front of it, which is not. Plan-only — no
code in the PR that adds this file.

The question this answers, as asked:

> "I was hoping to be able to use their tokens while offline for the POST
> endpoint (in which they could activate any workload on their behalf,
> connecting to an agent, see PR #106). If this is insecure, what is another way
> to achieve it? This might be the OBO pattern."

Three-sentence answer:

1. **Using the user's tokens while offline is already how it works**, and it is
   defensible: `POST /api/agents/:id` (#106) and routines (#131) both run under
   `runAgentInBackground`, which reaches an **encrypted, per-user, session-
   outliving MSAL cache** (`user_tokens`) and calls `acquireTokenSilent` — so
   Entra still mints a short-lived *delegated* token and still enforces the
   scope. Nothing about being offline weakens that.
2. **The OAuth2 On-Behalf-Of grant is not the mechanism here** and adopting it
   would add machinery without adding safety — the app *is* the confidential
   OIDC client since #119, so there is no incoming user assertion to exchange.
   OBO becomes correct only in one specific future (below).
3. **The insecure part is the front door, not the back door.** The Bearer secret
   in `configs/action-tokens.yaml` is a static, never-expiring, plaintext string
   that confers a user's *entire* consented delegated authority — including
   `Mail.Send`, `Calendars.ReadWrite`, `Files.Read.All`, `Sites.Read.All` — on
   *any* registered agent, with no rotation, no revocation that takes effect
   without a restart, no expiry, no per-agent scoping, no rate limit, and no
   audit. **Stealing that string is strictly better for an attacker than
   stealing the refresh token it fronts**, because it needs no encryption key,
   no database access, and arrives with a natural-language remote-execution
   interface.

So the recommendation is not "replace the offline token mechanism". It is
**harden the action token into a bound, revocable, scoped, audited credential**,
and keep the Entra half as-is.

Related: #106 (the endpoint), #107 (the three credential patterns), #110
(Pattern C, closed), #119 (Entra SSO, closed), #129 (auth hardening).

---

## 1. Ground truth — what is already built

Worth stating precisely, because both #107 and #110 describe the offline
refresh-token cache as future work, and it is not.

| Concern | Where | State |
|---|---|---|
| Per-user MSAL cache that **outlives the session** | `app/src/lib/auth/user-tokens.server.ts` (`user_tokens`, PK = Entra `oid`) | shipped |
| **Encrypted at rest** (AES-256-GCM, versioned envelope) | `app/src/lib/auth/secret-crypto.server.ts` | shipped |
| Silent delegated-token acquisition + rotation write-back | `app/src/lib/auth/graph-token.server.ts` (`getUserGraphToken`) | shipped |
| Credential attached inside the fetch, never returned to callers | `graphFetch` in the same file | shipped |
| Offline execution path | `harness-client/action-runner.server.ts` → `runWithRequestContext({userId, sessionId})` | shipped |
| Identity from AsyncLocalStorage, never from a tool argument | `app-tools/registry.server.ts` | shipped |
| Consent for the whole scope set requested up front at sign-in | `auth/entra-config.server.ts` (`DEFAULT_GRAPH_SCOPES`) | shipped |
| **Bearer secret → userId** for the trigger endpoint | `auth/action-tokens.server.ts` + git-ignored `configs/action-tokens.yaml` | **stopgap** |

#129's own list has largely closed too, which matters for sequencing: item 1
(encrypt the cache) is satisfied *by relocating it* — `user_tokens` is encrypted
and `auth_sessions.token_cache` is no longer written (the column may linger on
#119-era databases; dropping it is still open). Item 2 (scheduled session sweep)
landed as `startSessionSweepTimer`. Item 3 (`iat` on the signed handshake)
landed as `SIGNED_PAYLOAD_MAX_AGE_MS`. What remains of #129 is the **cutover
chores**: key custody, the client-secret expiry, and the legacy column.

The one design consequence of the shipped shape that is easy to miss:
`deleteUserTokenCache` is **deliberately not called on logout**. That is what
makes offline action possible at all, and it is also why "the user logged out"
is not a revocation event for this endpoint. Revocation has to be modelled
explicitly (§5).

---

## 2. Why the OBO grant is not the answer (and when it becomes one)

The On-Behalf-Of grant (`urn:ietf:params:oauth:grant-type:jwt-bearer`) exists
for a **middle-tier API**: a distinct client authenticates to Entra itself,
receives an access token *audienced to our API*, calls us, and we exchange that
user assertion for a downstream token. Every part of that presupposes an
incoming token.

Since #119 there isn't one. The browser holds an opaque session-id cookie; the
app redeems the auth code itself and holds the refresh token. There is no
assertion to exchange, so `acquireTokenSilent` on the stored refresh token is
not a weaker substitute for OBO — it is the same delegated outcome with less
machinery, and it needs no `api://…/access_as_user` scope and nothing under
"Expose an API". This reasoning is already recorded in
`graph-token.server.ts` and `docs/MICROSOFT_GRAPH.md` §"Why `acquireTokenSilent`,
not the On-Behalf-Of grant"; this plan does not reopen it.

**OBO becomes correct in exactly one future:** the iOS Shortcut (or any other
caller) stops presenting a shared secret and instead **authenticates to Entra as
its own registered client**, presenting a JWT audienced to our API. Then the
shared secret disappears entirely, Entra revocation and Conditional Access apply
to the *caller* as well as to the downstream call, and the trigger shows up in
Entra sign-in logs. That is the strategic end state in §4, tier 3 — and its
blocker is not Entra, it is that iOS Shortcuts has no OAuth affordance to do it
with. Note that OBO would replace the *front door* credential; the persisted
refresh cache still stays, because a token minted when the user pressed the
Shortcut button is not available three hours later when a routine fires.

---

## 3. Is offline refresh-token custody acceptable?

**Yes, with four conditions, none of which is exotic.** The reasoning below is
what makes it defensible rather than merely convenient.

**What makes it acceptable.** A refresh token is not a standing grant of
authority; it is a *request* for authority that Entra adjudicates on every
redemption. Each `acquireTokenSilent` is a live round trip to
`login.microsoftonline.com`, so account disable, password change, MFA reset,
admin session revocation, group/role change and Conditional Access policy
changes all take effect at the next redemption — typically within the
60–90-minute access-token lifetime, not at some cache TTL we chose. The token it
returns is **delegated**, so Entra (not our code) constrains it to that user's
own data; there is no over-privileged org token to guard. And the cache is
rotated on redemption, so a captured refresh token has a bounded useful life if
the legitimate holder keeps using it — the theft is self-limiting *and*
self-announcing, because our next redemption of a superseded token fails.

**Condition 1 — the encryption key must not live where the ciphertext lives.**
Today `TOKEN_ENCRYPTION_KEY` (or, unset, an HKDF derivation from
`AUTH_SESSION_SECRET`) is app env on the same VM as Postgres, and one key covers
every user's cache. `docs/MICROSOFT_GRAPH.md` already books this as an accepted
limit; the ROADMAP's Phase 3 target is Azure Key Vault. Until then, "encrypted
at rest" defends against a *backup* leak or a stray port, not against host
compromise. That is a real reduction in blast radius and worth having, but it
should be stated as what it is.

**Condition 2 — Conditional Access must be checked with the tenant owner, and
two specific controls are load-bearing.** CA is evaluated at token *issuance*,
which for us means at refresh-token redemption — so most policies are satisfied
by the claims the refresh token inherited from the original interactive sign-in
(device compliance included, since it was a compliant device that signed in).
Two controls break that:

- **Sign-in frequency (SIF).** A policy requiring interactive re-authentication
  every *N* hours makes silent acquisition fail at the boundary, by design.
  Background runs then stop working for the affected users until they next open
  the app. This is the single most likely cause of "the 3 a.m. routine quietly
  did nothing".
- **Token protection / token binding.** If the tenant enables it, a refresh
  token is bound to the device it was issued to, and redemption from our server
  fails outright. That would end the offline model, not degrade it.

Neither is a reason to avoid the design; both are reasons to **ask the tenant
owner before promising unattended operation**, and to build the visible-failure
path in §5 step 4 regardless.

**Condition 3 — treat lifetimes as facts to verify, not constants to hardcode.**
Access tokens are ~60–90 minutes. Refresh tokens for confidential clients are
long-lived (Microsoft's documented default is a 90-day inactivity window) and
are **not app-configurable** — refresh-token lifetime policies were retired in
2020. Microsoft has changed these defaults before, so nothing in the
implementation should depend on a specific number, and the values should be
re-checked against current Microsoft documentation at implementation time.

**Condition 4 — Continuous Access Evaluation should be handled, not
mistranslated.** CAE lets Graph reject a still-valid access token mid-lifetime
with a **claims challenge** in a `WWW-Authenticate` header. `graphFetch` maps
any 401/403 to `GraphAuthRequiredError`, so a challenge that could be satisfied
silently — by passing the returned `claims` back into `acquireTokenSilent` —
currently becomes a spurious "sign in again". That is a fidelity bug, not a
security hole, and it is cheap to fix (§5 step 4a).

**The conclusion, stated plainly:** the refresh-token cache is the *least*
dangerous long-lived secret in this path, because Entra polices it. The most
dangerous one is the action token, because nothing does.

---

## 4. Recommended mechanism

Three tiers. **Ship tiers 1 and 2; document tier 3 as the end state.** The
recommendation is deliberately the one that needs **no Entra app-registration
change at all** — that is a feature, not a compromise: it removes a tenant-owner
round trip from the critical path (#119 records how much lead time those carry).

### Tier 1 — DB-backed, hashed, scoped action tokens *(recommended, ship first)*

Replace the YAML secret map with an `action_tokens` table that stores only a
**SHA-256 of the secret** alongside the metadata that makes a credential
manageable: owning `user_id`, human label, an **agent allow-list**, `expires_at`,
`revoked_at`, `last_used_at`, `created_at`. The plaintext secret is shown once at
mint time and never stored. Shape and migration in §5.

What this buys, in order of importance: **revocation that works** (today's map
is parsed once and cached for the process lifetime, so editing the YAML to pull
a leaked secret does nothing until the next restart — see
`action-tokens.server.ts` `loadTokens`); **rotation without a deploy**;
**attribution** (which device fired this action); **containment** (a phone token
that may reach `microsoft-365` need not also reach `code-mode`,
`sandbox-session` or `flavoured-sandbox`, all of which are registered and all of
which a single secret can POST to today); and **expiry**, so an unused token
dies on its own.

Lookup by hash keeps the comparison off the raw secret. It also makes the store
readable by an operator without handing them 30 live credentials.

### Tier 2 — bind the token to a live authorization *(recommended, ship second)*

A tier-1 token is still a *standalone* authority: it authenticates on its own
evidence. Make it a **pointer to a live authorization** instead, by re-checking
at trigger time what sign-in checks at sign-in time:

- the owning user is still in the email allow-list (`isEmailAllowed`, which
  `POST /api/agents/:id` never consults — only `/api/auth/callback` does), and
- the user still has a usable token cache (`hasUserTokenCache`).

This closes the gap that matters most for a departing employee. When Entra
disables an account, the *Graph* half fails closed immediately and correctly —
but the rest of the tool surface does not depend on the user's Entra state at
all. Neo4j, the filesystem tools, the GitHub org token and the sandbox all run on
shared gateway credentials, so today a stale action token keeps buying agent
runs with org authority indefinitely. Tier 2 is what makes de-provisioning
actually de-provision.

Distinguish the failures in the response — `401` unknown/revoked/expired token
vs `403` token valid but the user is no longer authorized — so an operator can
tell a leak from a lifecycle event.

### Tier 3 — Entra-issued caller identity + the real OBO exchange *(end state, gated)*

Give the caller its own Entra app registration (mobile/native, PKCE), have the
user sign in on the device once, and have the endpoint **validate a JWT
audienced to our API** instead of matching a secret. Then
`acquireTokenOnBehalfOf` is the correct downstream exchange, and the shared
secret ceases to exist.

Why it is not tier 1: **iOS Shortcuts cannot do this.** It has no OAuth
affordance, so tier 3 needs a real companion client — and a Shortcut that stored
its own long-lived refresh token would simply move the custody problem onto the
phone. So tier 3 is gated on there being a first-class client app, and should be
revisited then rather than pre-built. The token-cache plumbing already in
`graph-token.server.ts` is the seam, as its own docstring notes.

### The app-only fallback — and the one rule about it

For work that genuinely needs no user context (org SharePoint reference data,
tenant-wide lookups), the right answer is **Pattern A** (#108): an app-only
Graph token via client credentials, which needs no user token and therefore no
offline custody at all. #137 is already in this territory.

**One rule, and it is absolute: never fall back from delegated to app-only.** A
`GraphAuthRequiredError` must not be rescued by retrying with an application
token. That would convert "this user is not allowed to see this" into "here it
is", silently, at exactly the moment the user's authority was revoked — a
textbook confused deputy. App-only must be a *deliberate route* chosen per tool
before any credential is acquired, never an error handler. And because app-only
tokens carry no delegated scoping, any such tool has to enforce data scoping
server-side itself (#107 principle 2).

### Entra app-registration changes, per tier

| Tier | App-registration work |
|---|---|
| 1 | **none** |
| 2 | **none** |
| 3 | *Expose an API* → `api://<client-id>` with an `access_as_user` scope; a second (mobile/native) registration for the caller with its redirect URI; the caller pre-authorized under "Authorized client applications"; admin consent. This is precisely the blade `docs/deploy/entra-setup.md` currently tells the operator to leave empty — that instruction stays correct until tier 3 is actually taken. |
| App-only | Application (not delegated) permissions + tenant admin consent; prefer **`Sites.Selected`** with a per-site grant over tenant-wide `Sites.Read.All`, so the app-only principal is not omniscient. |

Independent of tier, one registration change is worth doing for its own sake and
is already on #129's list: **swap `AZURE_CLIENT_SECRET` for a certificate
credential**. A service whose whole purpose is unattended operation should not
hold a credential that silently expires on a calendar date.

---

## 5. How `action-tokens.yaml` evolves

Target shape — deliberately mirroring `user_tokens`' conventions (own table so
secret material stays out of profile queries, idempotent `CREATE TABLE IF NOT
EXISTS` bootstrap, no shared migration file touched):

| Column | Purpose |
|---|---|
| `id` | opaque token id — safe to log, safe to show in the UI, safe to put on the action row |
| `user_id` | Entra `oid`; FK-in-spirit to `users.id` |
| `secret_hash` | SHA-256 of the presented secret. The plaintext is shown **once** at mint and never stored |
| `label` | which device this is (`"iPhone 15 Shortcut"`) |
| `allowed_agents` | agent ids this token may trigger; empty/null = all, and the UI should discourage that |
| `expires_at` | nullable, but the mint UI should default to a finite value |
| `revoked_at` | nullable; set to revoke. Effective on the next request, not the next restart |
| `created_at`, `last_used_at` | audit + a "this token has been idle for 8 months" report |

**Rotation** = mint a new token, move the device to it, revoke the old one — two
live tokens per device for as long as the handover takes, which is what makes
rotation something an operator will actually do. **Revocation** = one `UPDATE`;
this is the point where dropping (or short-TTL-bounding) the process-lifetime
cache in `loadTokens` stops being a nicety. A database round trip per trigger is
irrelevant next to the LLM run it gates.

**Audit** = record the token `id` (never the secret, never the hash) on the
action row, next to the existing `source='post'`. `ActionTrigger` is the natural
carrier and already survives into the persisted context. Without this, two
devices sharing a user are indistinguishable after the fact, and a leak cannot
be scoped to a device.

**Migration off YAML.** Read-through for one release: on a miss in
`action_tokens`, consult the YAML map, and on a hit there, transparently
import it (hashed) and log an audible deprecation. That way no device breaks on
deploy day and the file empties itself. Then delete the YAML path, the
`resolveConfigPath` candidates and `configs/template.action-tokens.yaml`, and
update `docs/AGENT_TRIGGER.md` + `docs/INDEX.md`'s config inventory.

`parseActionTokens` stays as-is and keeps its unit tests during the read-through
release — it is a pure function and the cheapest possible bridge.

---

## 6. Migration steps, ordered by risk

Each step is independently shippable and independently useful; each leaves the
endpoint working. Deliberately ordered so the two highest-value/lowest-risk
items are first.

**Step 0 — make revocation possible at all** *(hours; no schema, no API change)*
Drop the process-lifetime `tokenCache` in `action-tokens.server.ts` (or bound it
to ~60s), so editing `configs/action-tokens.yaml` takes effect without a
restart. Thread the matched entry's `label` onto the action row. This is the
smallest change that turns "we would have to redeploy to revoke" into "we can
revoke", and the label is the audit foundation every later step builds on.

**Step 1 — `action_tokens` table, hashed, with read-through from YAML**
*(§5)* No behaviour change for existing devices. Ship the mint/revoke UI in the
same step or immediately after — a store nobody can write to is not an
improvement.

**Step 2 — the live-authorization gate** *(tier 2)* Allow-list + token-cache
check at trigger time, with `401`/`403` distinguished. The one behaviour change
users could notice, hence after the store exists: it needs the audit trail to
diagnose a false rejection.

**Step 3 — per-token agent allow-list, expiry, rate limit** Enforce
`allowed_agents` (default the existing phone token to just the agents it
actually uses), start honouring `expires_at`, and add a per-token rate limit —
which is a cost control as much as a security one, since a leaked token is an
unmetered LLM-spend lever.

**Step 4 — make unattended failure visible** Today a background run whose
Graph token cannot be acquired gets `GraphAuthRequiredError` translated into an
ordinary failed tool result by `app-tools/registry.server.ts`, the agent
narrates "please sign in again", and the row finishes as `done`. For a routine
firing overnight, that is a silent no-op. Mark the run and the user as
needs-reauth and surface it — this is exactly #106's deferred "completion
email/push" item, and Condition 2 in §3 is why it is not optional.

- **Step 4a** — while in this code: handle the **CAE claims challenge** by
  parsing `WWW-Authenticate` on a 401 and retrying `acquireTokenSilent` with the
  returned `claims` before concluding that interaction is required. Small, and it
  removes a class of spurious re-auth prompts.

**Step 5 — key custody and credential hygiene** Move
`TOKEN_ENCRYPTION_KEY` into Azure Key Vault (Phase 3 of the ROADMAP; ideally
reached via the VM's managed identity so no key sits in env at all), switch the
app registration to a **certificate** credential, and drop the legacy
`auth_sessions.token_cache` column. These are #129's remaining cutover chores;
they are last only because they are ops-sequenced, not because they are
optional.

**Step 6 — tier 3, if and when a real client app exists** Not before.

Worth noting what is *not* on this list: nothing here changes
`user_tokens`, `secret-crypto.server.ts`, `getUserGraphToken` or `graphFetch`
beyond step 4a. The offline mechanism is not what needs work.

---

## 7. Threat table

"Today" = current `main`. "After" names the step from §6 that closes or bounds it.

| # | Threat | Today | Impact | After |
|---|---|---|---|---|
| 1 | **Stolen action token** (leaked from the phone, a Shortcut export, a config backup, an operator's clipboard) | Authenticates forever. Reaches *every* registered agent — including `code-mode` and the sandbox agents. Carries the user's full consented Graph authority, `Mail.Send` and `Calendars.ReadWrite` included. Revoking needs a file edit **plus a restart**. No rate limit, no audit, nothing to attribute it to | **Critical** — impersonation with write access to the victim's mailbox and calendar, plus org-credentialed tool access and unmetered LLM spend | Step 0 (revocable), 1 (hashed, rotatable, attributable), 2 (dies with the user's authorization), 3 (scoped, expiring, rate-limited) |
| 2 | **Stolen refresh token** — requires DB read **and** the encryption key | Ciphertext alone is useless. With the key: replayable until Entra invalidates it. Rotation on our next redemption breaks the thief's copy — and a failed redemption of a superseded token is a *detection signal* | High but well-bounded; every use is an Entra round trip subject to CA and revocation | Step 5 (key out of the host); already bounded by rotation, delegated scope and Entra adjudication |
| 3 | **Replay of a captured trigger request** | The body is not signed and there is no nonce or timestamp, so a captured HTTPS request replayed by anyone holding it re-runs the workload. TLS is the only barrier | Medium — duplicate side effects (a mail sent twice, an event created twice); no new authority gained | Partly step 3 (rate limit blunts volume). A per-request nonce or signed timestamp is the complete fix; it is **not** in §6 because tier 3 subsumes it, and it should be added if tier 3 slips |
| 4 | **Scope escalation** | Two shapes, both reachable. *(a)* One token → any agent, so a token issued for `microsoft-365` can drive `code-mode`/`sandbox-session`. *(b)* A future delegated→app-only fallback would silently swap per-user scoping for tenant-wide access | High for (a) today; (b) is latent | Step 3 for (a). For (b): the absolute rule in §4 — app-only is a chosen route, never an error handler — plus `Sites.Selected` over `Sites.Read.All` |
| 5 | **De-provisioned user still acts** | Graph fails closed (Entra refuses the redemption), but Neo4j, filesystem, GitHub-org and sandbox tools run on shared gateway credentials and never consult the user's Entra state. Logout is deliberately not revocation, so an ex-employee's token keeps buying org-credentialed runs | High — survives the normal offboarding checklist, which is the worst property a credential can have | Step 2 |
| 6 | **Prompt injection via the trigger body** | `transcribed_command` is untrusted natural language (a transcription) driving an agent that holds `Mail.Send`. Anyone with the token — or, if a transcription pipeline is ever shared, anyone who can influence it — gets natural-language control of a credentialed agent | High | Step 3 narrows *which* agent is reachable; the durable fix is a confirmation gate on write tools (#123; `entra-config.server.ts` already flags that any future write tool needs one) |
| 7 | **Insider / operator read of the token store** | `configs/action-tokens.yaml` is plaintext live credentials for every user, readable by anyone with host or backup access | Medium–High | Step 1 — hashes are not credentials |
| 8 | **Credential leaking into the model's context or event log** | Not reachable today, by construction: `graphFetch` attaches the token internally, no advertised tool schema has a token or user field, and `app-tools/registry.server.ts` returns messages without stack or credential detail. Asserted by the isolation tests | Would be Critical; currently defended | No change needed — but any new credentialed tool must keep the invariant, and the action token must never join `ActionTrigger` (only its **id**, §5) |
| 9 | **Silent unattended failure** | Not an attacker, but a security-relevant availability failure: a CA sign-in-frequency boundary or an expired refresh token makes overnight runs no-ops that report as `done` | Medium — erodes trust in the whole offline model, and masks threats 2 and 5 (a revoked token looks the same as a sleepy one) | Step 4 (+4a) |

---

## 8. Open questions for the user

Ordered by how much they change the plan.

1. **Does the tenant apply a Conditional Access sign-in-frequency policy, or
   token protection / token binding, to this app?** SIF caps how long unattended
   operation can work between interactive sign-ins; token binding would end it.
   This is a tenant-owner question with lead time, and it is the only one that
   could invalidate the offline model rather than merely shape it. Ask early —
   #119 learned this lesson about Entra questions generally.
2. **Should an action token be scoped to specific agents by default?** The plan
   assumes yes (step 3, threat 4a) and that the existing phone token gets
   narrowed to what it actually calls. Confirm which agents that is.
3. **What should a token's default lifetime be?** A finite `expires_at` is
   proposed; 90 days and 1 year are both defensible, and "never" should require
   an explicit choice rather than being the default.
4. **Is a mint/revoke UI in scope for step 1, or is an admin-only route enough
   for ~30 users?** The store is useless without *some* write path; the question
   is only how much surface it gets.
5. **Does step 4's notification go to email, push, or just an in-app
   needs-reauth badge?** #106 deferred this; §3 Condition 2 is the argument for
   picking one now.

## 9. Relationships

- **#106** — the endpoint this is about; its `configs/action-tokens.yaml` was
  always described as a stopgap, and its deferred "completion email/push" item
  is step 4.
- **#107** — the three credential patterns. This plan is Pattern C's async
  wrinkle, resolved, plus the rule governing when Pattern A may substitute.
- **#110** (closed) — shipped the encrypted per-user cache and
  `acquireTokenSilent`. Its "OBO" title is a misnomer the implementation already
  corrected; §2 records why.
- **#119** (closed) — made the app the confidential OIDC client, which is
  exactly why OBO does not apply.
- **#129** — items 1–3 have effectively landed (§1); its remaining cutover
  chores are step 5.
- **#131** — routines run the same `runAgentInBackground` path, so every step
  here applies to them too. They are also the acute case for step 4: nobody is
  watching when a routine fires.
- **#108 / #137** — the app-only route, and the one rule that keeps it from
  becoming a privilege-escalation path.
- **#123** — the confirmation gate that threat 6 ultimately needs.
- `docs/AGENT_TRIGGER.md`, `docs/MICROSOFT_GRAPH.md`,
  `docs/deploy/entra-setup.md` — the source-level docs each step must update.
