/**
 * Microsoft Graph app-side tools (Pattern C, #110) — Server Only.
 *
 * Each tool calls Graph **as the signed-in user** via `graphFetch`, which
 * resolves that user's delegated token server-side. Entra enforces the scope,
 * so we don't write a scoping guard and the model never sees a credential.
 *
 * First slice is deliberately `User.Read`-only — the scope already has tenant
 * admin consent, so the whole per-user token path is provable end-to-end with
 * no new tenant configuration. Mail/Files/Calendar tools slot in here once
 * their scopes are consented and added to the sign-in request
 * (`entra-config.server.ts`).
 */
import { assertServerOnImport } from "../harness-patterns/assert.server";
import { graphFetch } from "../auth/graph-token.server";
import { registerAppTool } from "./registry.server";

assertServerOnImport();

/** Fields we surface from `/me`. Explicit so we never dump the whole payload
 *  (which can include tenant metadata) into the model's context. */
const ME_FIELDS = [
  "displayName",
  "givenName",
  "surname",
  "userPrincipalName",
  "mail",
  "jobTitle",
  "officeLocation",
  "preferredLanguage",
] as const;

export interface GraphMeResult {
  displayName: string | null;
  givenName: string | null;
  surname: string | null;
  userPrincipalName: string | null;
  mail: string | null;
  jobTitle: string | null;
  officeLocation: string | null;
  preferredLanguage: string | null;
}

/** Pick + null-normalize the fields we advertise. */
export function shapeMe(raw: unknown): GraphMeResult {
  const src = (raw ?? {}) as Record<string, unknown>;
  const out = {} as Record<string, string | null>;
  for (const f of ME_FIELDS) {
    const v = src[f];
    out[f] = typeof v === "string" && v.trim() ? v : null;
  }
  return out as unknown as GraphMeResult;
}

registerAppTool({
  name: "graph_me",
  namespace: "graph",
  description:
    "Get the signed-in user's own Microsoft 365 profile (name, work email/UPN, " +
    "job title, office, language). Acts as the current user — no user or token " +
    "argument is accepted or needed.",
  // No parameters at all: the identity is the request's authenticated user.
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  execute: async (_args, { userId }) => {
    const raw = await graphFetch(
      userId,
      `/me?$select=${ME_FIELDS.join(",")}`,
      { scopes: ["User.Read"] },
    );
    return shapeMe(raw);
  },
});
