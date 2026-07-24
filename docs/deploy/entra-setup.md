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
# Optional overrides (defaults target dev):
# AUTH_REDIRECT_URI=http://localhost:3444/api/auth/callback
# AUTH_POST_LOGOUT_REDIRECT_URI=http://localhost:3444/auth/signin
```

Access is still gated by the email allow-list (`VITE_ALLOWED_EMAILS`); a
signed-in account whose email isn't listed lands on `/auth/access-denied` and
gets no session.

**Dev without a tenant:** `VITE_DEV_BYPASS_AUTH=true` (dev builds only) signs in
as the mock `dev-bypass-user` — no Entra round-trip. This is the default for
local iteration.

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
