# Entra ID (Microsoft) SSO — setup

The app authenticates users with **Microsoft Entra ID** via a direct MSAL
OpenID Connect auth-code flow (issue #119). This note is the concrete list of
what the **Entra tenant owner** must provision, plus the env the app needs.

> **Why direct MSAL and not Stack Auth?** #110 (on-behalf-of, for Graph
> connectors) needs the *raw* Entra access/ID token server-side. A
> Stack-brokered Microsoft login only yields a Stack session, never the Entra
> token — so we own the OIDC client directly.

---

## 1. App registration

Use the existing **DTalk v2** registration (client id
`8006d5eb-14f6-4214-be5a-0f3448b34063`) or create one: Entra admin center →
**App registrations** → **New registration**.

- **Supported account types:** *Accounts in this organizational directory only*
  (single tenant). Gives a fixed `AZURE_TENANT_ID` and matches the MS-only
  identity decision.

## 2. Redirect URIs — **Authentication** blade → *Add a platform* → **Web**

The redirect must point at the app's **server** callback (the code→token
exchange is server-side), not at Stack Auth. Add one per environment:

| Environment | Redirect URI |
|-------------|--------------|
| Local dev   | `http://localhost:3444/api/auth/callback` |
| Production  | `https://<app-domain>/api/auth/callback` |

`http://localhost` is allowed by Entra for loopback; production must be HTTPS.
(If migrating from the Stack setup, **remove** the old
`https://api.stack-auth.com/api/v1/auth/oauth/callback/microsoft` redirect.)

Front-channel logout returns to `AUTH_POST_LOGOUT_REDIRECT_URI`
(default `.../auth/signin`); no separate registration needed for the v2 logout
endpoint.

## 3. Client secret — **Certificates & secrets** → *New client secret*

Copy the **value** (not the id) into `AZURE_CLIENT_SECRET`. Note the expiry and
set a rotation reminder. (Rotate out any secret previously shared with Stack.)

## 4. API permissions — **API permissions** → Microsoft Graph → *Delegated*

| Permission | Admin consent |
|------------|---------------|
| `openid`, `profile`, `email`, `offline_access` | not required (user consent) |
| `User.Read` | grant tenant-wide admin consent |
| `Mail.Read`, `Mail.Send`, `Calendars.ReadWrite`, `Files.Read.All`, `Sites.Read.All` | add + grant admin consent before enabling the connectors — see "Scopes are requested up front" below |

`offline_access` is what yields the refresh token the app persists for the
future OBO exchange (#110). Additional Graph scopes for #110 (e.g. `Mail.Read`,
`Files.Read.All`) are added there, with admin consent, when that work starts.

---

## App environment

Set these where the app runs (see `ui/.env.example`). None are `VITE_`-prefixed
— all server-side, never shipped to the browser.

```
AZURE_TENANT_ID=<tenant (directory) GUID>
AZURE_CLIENT_ID=<app registration client id>
AZURE_CLIENT_SECRET=<from Certificates & secrets>
AUTH_SESSION_SECRET=<openssl rand -base64 32>   # signs auth cookies
# Encrypts the stored per-user token cache (#110). Strongly recommended in
# production so it can rotate independently of the cookie-signing key; when
# unset, the key is HKDF-derived from AUTH_SESSION_SECRET.
TOKEN_ENCRYPTION_KEY=<openssl rand -base64 32>
# Optional overrides (defaults target dev):
# AUTH_REDIRECT_URI=http://localhost:3444/api/auth/callback
# AUTH_POST_LOGOUT_REDIRECT_URI=http://localhost:3444/auth/signin
```

⚠️ Rotating `TOKEN_ENCRYPTION_KEY` (or `AUTH_SESSION_SECRET` when no dedicated
key is set) makes existing stored token caches undecryptable. That is handled
gracefully — affected users are simply asked to sign in again — but it does mean
background runs for those users fail until they do.

Access is still gated by the email allow-list (`VITE_ALLOWED_EMAILS`); a
signed-in account whose email isn't listed lands on `/auth/access-denied` and
gets no session.

**Dev without a tenant:** `VITE_DEV_BYPASS_AUTH=true` (dev builds only) signs in
as the mock `dev-bypass-user` — no Entra round-trip. This is the default for
local iteration.

---

## Graph scopes and consent (Pattern C, #110)

Once signed in, the app can call Graph **as that user** — Entra enforces the
delegated scope, so there is no over-privileged org token and no app-side
scoping guard to get wrong. How that works internally, and how to add a
connector, is [MICROSOFT_GRAPH.md](../MICROSOFT_GRAPH.md); this section covers
only what the tenant needs.

One consequence is worth noting here because it saves portal work: the app is
itself the OIDC client, so it uses `acquireTokenSilent` rather than the
On-Behalf-Of grant — which means **nothing needs configuring under "Expose an
API"** and there is no `api://…/access_as_user` scope. Leave that blade empty.

### Scopes are requested up front — all of them

`DEFAULT_GRAPH_SCOPES` in `lib/auth/entra-config.server.ts` requests the whole
connector set at sign-in:

| Scope | For | Kind |
|---|---|---|
| `User.Read`, `email` | own profile | read |
| `Mail.Read` | mailbox search / summarise | read |
| `Mail.Send` | send as the user | **write** |
| `Calendars.ReadWrite` | availability + scheduling | **write** |
| `Files.Read.All` | OneDrive + SharePoint files the user can access | read |
| `Sites.Read.All` | SharePoint sites the user can access | read |

Why up front rather than incrementally: **adding a scope later forces every user
to sign in again** (their stored refresh token must cover it), and background runs
have no user present to consent mid-run. One consent, done.

A granted scope is not a capability. The model can only do what a *registered
tool* exposes, and today that is the read-only `graph_me`. Any future write tool
should carry its own confirmation gate.

> ⚠️ **Order matters.** Every scope in the request must exist under **API
> permissions** with consent granted *before* anyone signs in. A scope that is
> requested but not consented fails **the whole sign-in** — not just that
> connector ("Need admin approval"). If that happens, trim the list via the
> `AZURE_GRAPH_SCOPES` env var (space- or comma-separated) and restart — no code
> change or redeploy needed. Reserved scopes (`openid`/`profile`/
> `offline_access`) are stripped automatically; MSAL supplies them.

### Adding a scope later

Adding a scope to the sign-in request **forces every user to sign in again**
(their stored refresh token must cover it), which is the reason the full set is
taken up front. Grant it in the portal first, then extend
`DEFAULT_GRAPH_SCOPES`. Writing the tool that uses it is
[MICROSOFT_GRAPH.md](../MICROSOFT_GRAPH.md).

---

## Identity model & migration

- The stable per-user id (`userId`) is the Entra **`oid`** claim (the user's
  *Object ID*). Sessions, `conversations.user_id`, the `users` table, and
  per-user data all key on it.
- Every successful sign-in upserts a row in **`users`** (oid, email, display
  name, tid, first/last login) — the app's own activity record, and the future
  home for #108 role/tier data (e.g. gating sandbox agents by tier).
- No Stack→Entra id migration was needed: pre-cutover conversations were
  purged at cutover (2026-07-24) rather than remapped. If a deployment ever
  needs to preserve old rows, `conversations.user_id` is plain `TEXT`, so a
  data-only remap works.
- Agent-trigger tokens (`configs/action-tokens.yaml`) now map a Bearer secret
  to an Entra `oid` — see `configs/template.action-tokens.yaml`. The endpoint
  contract (`POST /api/agents/:id`) is unchanged.

## Sign-in flow (reference)

1. `/auth/signin` → **Sign in with Microsoft** → `GET /api/auth/login`
   (PKCE + state + nonce stashed in a signed handshake cookie) → 302 to Entra.
2. Entra → `GET /api/auth/callback`: validate `state`, redeem the code, check
   the allow-list, create a Postgres `auth_sessions` row (with the serialized
   MSAL token cache for #110), set the `kg_session` HttpOnly cookie → `/`.
3. `GET /api/auth/logout`: delete the session row, clear the cookie, redirect to
   Entra sign-out.
