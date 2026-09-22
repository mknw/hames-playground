# Wiring a host

**Audience:** someone past "it runs" and building the composition root — the one place
that decides what the packages are allowed to reach.

**You will build:** the three wiring points every host has, using this repo's own app as
the worked example, and learn which mistakes are caught at boot rather than mid-turn.

**Time:** 10 minutes to read; the code is three files.

---

## The shape

The packages own protocols; the **host owns identity, storage, catalogs, policy and
presentation**. Nothing crosses that line by import — it crosses by supply, at three
distinct points:

| Wiring point                 | When it runs               | What goes there                                                   |
| ---------------------------- | -------------------------- | ----------------------------------------------------------------- |
| **Boot-time seams**          | once, before any request   | module-level registrations a package refuses to work without      |
| **The `AgentDeps` bag**      | once per pattern build     | per-agent suppliers: catalog, sandbox, tier override, persistence |
| **The registration overlay** | once per agent, at startup | presentation the definitions deliberately do not carry            |

In this repo those are `app/src/middleware.ts`, `agentDeps()` in
`app/src/lib/harness-client/session.server.ts`, and
`app/src/lib/harness-client/registry.server.ts`. Read them in that order.

## 1. Boot-time seams

Some package seams are **explicit-config-only**: unset is a named error at first use,
never a silent default. That choice is the reason they belong at boot rather than at the
call site — the one place that runs before any request is the one place that can guarantee
they are set.

SolidStart imports `middleware.ts` once when the server handler graph loads, which makes
it this app's boot hook. Four registrations live there:

```typescript
import { configureNeo4j } from "@hames/connectors/neo4j/client";
import { configureWorkspaceStore } from "@hames/sandbox/workspace-store";
import {
  listDocuments,
  getDocument,
  storeDocument,
} from "@hames/harness-patterns/stash/document-store.server";

declare const endpoints: { neo4j: { bolt: string } };
declare const env: Record<string, string | undefined>; // your `process.env`
declare function guessMimeType(filename: string): string;
declare function isTextMime(mimeType: string): boolean;

// The driver's connection, handed over explicitly — the package never reaches
// for host config itself.
configureNeo4j({
  url: endpoints.neo4j.bolt,
  user: env.NEO4J_USER || "neo4j",
  password: env.NEO4J_PASSWORD || "password",
});

// The durable `/work` seam: the package owns the protocol, the host owns
// storage and content classification.
configureWorkspaceStore({
  list: listDocuments,
  get: getDocument,
  store: storeDocument,
  guessMimeType,
  isTextMime,
});
```

The other two are import side effects in the same file: one module registers the app's own
tools on the transport seam, and the same module registers the tool→namespace catalog:

```typescript
import { registerToolNamespaces } from "@hames/harness-patterns/tools.server";
import { registerTransport } from "@hames/harness-patterns/tool-transport.server";
import { mcpNamespace } from "@hames/connectors/mcp-catalog";
import type { ToolTransport } from "@hames/harness-patterns";

declare const appToolTransport: ToolTransport;

registerTransport(appToolTransport);
registerToolNamespaces(mcpNamespace);
```

`registerToolNamespaces` is the default the **injection guard** consults; the explicit
`namespaces` argument to `Tools()` is what **grouping** consults. Both are set from the
same map on purpose — the double coverage is what makes a missing catalog loud instead of
silent, and the guard is louder still: it refuses a namespace it cannot verify, which is
[exactly what you see](./guarding-an-agent.md#4-the-three-refusals) when this line is
missing.

> **Why `guessMimeType` / `isTextMime` ride along with the store.** The extension→MIME
> table decides what your stash keeps verbatim and what it base64-encodes. A second copy
> inside the package would drift from yours silently — in the direction of writing a
> binary deliverable out as mangled UTF-8.

## 2. The `AgentDeps` bag

One bag, built by the composition root, closed over by every registered agent's factory.
Here is this app's, with what each entry is and why it cannot live in the package:

```typescript
import type { AgentDeps } from "@hames/agents";
import type { RetrieverBackend } from "@hames/harness-patterns";
import type { OnToolResult } from "@hames/harness-patterns/types";

declare const mcpNamespace: (toolName: string) => string | undefined;
declare const enrichNeo4jResult: OnToolResult;
declare const createRedisBackend: (sessionId: string) => RetrieverBackend;
declare const wrapWithSandbox: NonNullable<AgentDeps["withSandbox"]>;
declare const clientOverrideFor: NonNullable<AgentDeps["clientOverride"]>;
declare const updateConversationTitle: NonNullable<AgentDeps["persistTitle"]>;
declare const doNotCachePatterns: (sessionId: string) => void;

export function agentDeps(): AgentDeps {
  return {
    toolNamespaces: mcpNamespace,
    enrichNeo4jResult,
    createRedisBackend,
    withSandbox: wrapWithSandbox,
    clientOverride: clientOverrideFor,
    persistTitle: updateConversationTitle,
    doNotCachePatterns,
  };
}
```

| Supplier             | Why it is injected                                                            |
| -------------------- | ----------------------------------------------------------------------------- |
| `toolNamespaces`     | **required.** Your deployment's catalog; a default would hide a moved catalog |
| `enrichNeo4jResult`  | host decoration of tool results                                               |
| `createRedisBackend` | your retrieval store, per session                                             |
| `withSandbox`        | the containment posture stays host-side and is supplied, never carried        |
| `clientOverride`     | tier routing is app policy — the package never imports a host client map      |
| `persistTitle`       | your database                                                                 |
| `doNotCachePatterns` | your pattern cache's refusal hook, for a degraded-but-usable build            |

Two properties of the bag are worth stating outright:

- **It is a function, not a constant.** It is called per pattern build, so anything
  request-scoped inside it is read at the right time.
- **Optional means optional.** Omit what you do not compose. An agent that _needs_ an
  omitted supplier throws by name at `createPatterns` — see
  [the missing-supplier throw](./hosting-the-harness-in-your-own-app.md#the-missing-supplier-throw-you-will-hit).

### The one trap: `tenantId` must be a resolver

`withSandbox` takes `tenantId` as **a string or a function**, and the agent path needs the
function. The reason is a lifetime mismatch, and it is the kind that type-checks:

- A host builds its patterns once and **caches the chain for the conversation's life**.
- The authenticated user is only in scope **for the duration of one turn**.

A literal read at wrap time therefore freezes whichever tenant happened to be in scope
during the build — including `'default'` for a build that ran outside a request, such as a
capability probe — onto every later turn of that conversation. Silently, on the one field
tenant isolation is scoped by. A function is called on **every run**, inside the request
scope, which is where the answer is actually knowable:

```typescript
import { withSandbox, type WithSandboxConfig } from "@hames/sandbox";
import type { AgentDeps } from "@hames/agents";

declare function getRequestUserId(): string | null;

const withSandboxDep: AgentDeps["withSandbox"] = (attach) =>
  withSandbox({
    id: attach.id,
    sessionId: attach.sessionId,
    rootfs: attach.rootfs as WithSandboxConfig["rootfs"],
    egress: attach.egress as WithSandboxConfig["egress"],
    syncWorkspace: attach.syncWorkspace,
    // A FUNCTION. Resolved per run, inside the request scope.
    tenantId: () => getRequestUserId() ?? undefined,
  });
```

Two details in that adapter that are not obvious:

- The package's `SandboxAttach` names `rootfs` and `egress` as plain strings; the host
  narrows them onto its own unions here. That cast is the one adapter seam between the two
  type surfaces, and it belongs at the composition root.
- `undefined` becomes the `'default'` tenant package-side, which keeps the existing cache
  volume's name verbatim. That is the single-operator migration rule, not a fallback that
  widens anything.

Direct callers that already hold the owner — an interactive shell route, say — pass the
string instead. The resolver exists for the _cached-chain_ path.

### `clientOverride`

`clientOverride` is the per-call BAML options bag, keyed by role. Its type is
`ClientOverride` from `@hames/harness-baml/consumer-clients.server` —
`(role) => { client, clientRegistry? } | undefined` — which is exactly what a
`defineInferenceClients` plug returns, so a consumer's plug drops into the bag with no
cast. Supply it to move roles onto your own models; omit it and every call runs on the
client its BAML function declares. The mechanism, the role list and what happens to roles
you do not map are in
[bring your own provider or model](./own-provider-or-model.md).

The one rule to carry over here: re-pointing a BAML **chain** is not the mechanism and
must not become it. `screen` (the injection screen) and `describe` (summarization) name the
same chain, and the difference between them exists only in the role map — so a chain edit
that reads like "switch summarization to a cheaper model" moves the injection screen with
it, implicitly.

## 3. The registration overlay

The definitions carry `id`, `name`, `description`, `welcome`, `servers` and
`createPatterns` — and no presentation, so a consumer who wants different presentation
overlays its own fields instead of forking. This app adds an icon and an accent colour,
and closes the factory over the bag:

```typescript
import type { AgentDefinition, AgentDeps, AgentData } from "@hames/agents";
import type { ConfiguredPattern } from "@hames/harness-patterns";
import { searchAgent } from "@hames/agents/agents/search.server";

declare function agentDeps(): AgentDeps;
declare function registerAgent(config: AgentConfig): void;

type AgentAccent = "indigo" | "orange" | "violet" | "blue";
interface AgentConfig extends Omit<AgentDefinition, "createPatterns"> {
  icon: string;
  accent: AgentAccent;
  createPatterns: (
    sessionId: string,
  ) => Promise<ConfiguredPattern<AgentData>[]>;
}

function overlay(
  def: AgentDefinition,
  icon: string,
  accent: AgentAccent,
): AgentConfig {
  return {
    ...def,
    icon,
    accent,
    // The bag is supplied HERE, so no call site downstream has to know it exists.
    createPatterns: (sessionId) => def.createPatterns(sessionId, agentDeps()),
  };
}

registerAgent(overlay(searchAgent, "i-material-symbols-search", "indigo"));
```

That one-line currying is the whole point of the seam: every consumer of a registered
agent calls `createPatterns(sessionId)` and never learns that a deps bag exists.

## 4. A checklist for your own root

1. Register the tool→namespace catalog **and** pass it to every `Tools()` call.
2. Register your transports before the first turn.
3. Configure the explicit-config-only seams you actually use (`configureNeo4j`,
   `configureWorkspaceStore`) at boot, not lazily.
4. Build one `AgentDeps` bag; make it a function; supply `tenantId` as a resolver.
5. Overlay presentation at registration; keep it out of the definitions.
6. Decide what a finished turn is — the chain will not decide it for you.

## 5. Where to go next

- [Bring your own provider or model](./own-provider-or-model.md) — the `clientOverride`
  supplier in full.
- [Running code in a sandbox](./running-code-in-a-sandbox.md) — what the `withSandbox`
  supplier is wrapping.
- [Attaching a sandbox workspace](./attaching-a-sandbox-workspace.md) — the
  `configureWorkspaceStore` seam end to end.
- [`@hames/agents` README](../../packages/agents/README.md) — the injected / imported /
  overlaid table this page walks through.
- [`@hames/connectors` README](../../packages/connectors/README.md) — the other
  explicit-config-only seam and its injected suppliers.
