# UI Architecture Reference

> **Scope:** This document covers the `app/` directory - the SolidJS frontend application.

Quick reference for the SolidJS frontend structure, configuration, and patterns.

---

## 1. Package Management & Core Dependencies

### Package Manager

- **pnpm** - Fast, disk space efficient package manager
- Node.js >= 22 required

### Core Stack

```json
{
  "framework": "@solidjs/start ^1.2.0",
  "router": "@solidjs/router ^0.15.3",
  "ui-library": "@ark-ui/solid ^5.26.2",
  "auth": "@azure/msal-node ^5.4.2 (Entra OIDC)",
  "styling": "unocss ^66.5.4",
  "bundler": "vinxi ^0.5.8"
}
```

### ESLint Configuration

**File:** `app/eslint.config.ts`

Key rules:

```typescript
{
  "prefer-const": "warn",
  "no-constant-binary-expression": "error",
  "@typescript-eslint/no-empty-object-type": ["error", {
    "allowInterfaces": "with-single-extends"  // Allows module augmentation
  }],
  "@typescript-eslint/no-unused-vars": ["error", {
    "varsIgnorePattern": "^_|^T$",  // Ignore _ and T (generic params)
    "argsIgnorePattern": "^_"
  }]
}
```

---

## 2. UnoCSS Configuration

### Setup Files

- **Config:** `app/uno.config.ts`
- **TypeScript Shim:** `app/src/shims.d.ts`

### Configuration

```typescript
defineConfig({
  presets: [
    presetAttributify(), // Enables attribute-based styling
    presetWind4(), // Tailwind v4-like utilities
    presetWebFonts({
      // Google Fonts
      fonts: {
        sans: "Inter",
        serif: "Roboto Slab",
        mono: "Fira Code",
      },
    }),
  ],
  transformers: [
    transformerAttributifyJsx(), // JSX/TSX support
  ],
});
```

### Attributify Syntax

Enables attribute-based styling instead of `class`:

```tsx
// Traditional
<div class="flex items-center gap-2 bg-blue-500">

// Attributify
<div flex items-center gap-2 bg-blue-500>

// With variants
<button bg="blue-500 hover:blue-600" text="white sm">

// Grouped values
<div p="x-4 y-2" border="~ gray-200">

// Self-referencing with ~
<div border="~ red">  // = border border-red
```

### TypeScript Shim

**File:** `app/src/shims.d.ts`

```typescript
import type { AttributifyAttributes } from "@unocss/preset-attributify";

declare module "solid-js" {
  namespace JSX {
    interface HTMLAttributes<T> extends AttributifyAttributes {
      // Add custom utility types here if needed
      tracking?: string | boolean;
      leading?: string | boolean;
    }
  }
}
```

---

## 3. Authentication

### Architecture Overview

**Identity source:** Microsoft Entra ID via a direct MSAL (`@azure/msal-node`)
OpenID Connect **auth-code flow** — the code→token exchange runs server-side
(replaced Stack Auth in #119; chosen over federating into Stack because
#110/OBO needs the raw Entra token server-side).
**Client-side:** no auth SDK — `AuthProvider` reads the session via the
`getSessionUser()` server action.
**Server-side:** `getCurrentUser()` reads the `kg_session` cookie → a Postgres
`auth_sessions` row.
**Email allowlist:** still gates access (`app/src/lib/auth/allowList.ts`).

### Sign-in flow (server-side OIDC)

| Route                    | Does                                                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/auth/login`    | generate PKCE + state + nonce (stashed in a short-lived **signed** handshake cookie) → 302 to Entra authorize                                                      |
| `GET /api/auth/callback` | validate `state` vs the handshake cookie, redeem the code, enforce the allowlist, upsert `users`, create an `auth_sessions` row, set the `kg_session` cookie → `/` |
| `GET /api/auth/logout`   | delete the session row (server-side revocation), clear the cookie, 302 to Entra sign-out                                                                           |

Config lives in `app/src/lib/auth/entra-config.server.ts` (env: `AZURE_TENANT_ID`,
`AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AUTH_SESSION_SECRET`; see
[`docs/deployment/entra-setup.md`](deployment/entra-setup.md)). `isEntraConfigured()`
lets `/api/auth/login` fail soft (503) when the tenant config is absent, so
dev-bypass stays a zero-config path.

### Session store

**File:** `app/src/lib/auth/session-store.server.ts` — Postgres `auth_sessions`
(opaque cookie id → row: `user_id` = Entra `oid`, email, display name,
`home_account_id`, 8h expiry). Every sign-in also upserts `users`
(`app/src/lib/auth/users.server.ts`: oid, email, display name, tenant, first/last
login) — the app's own activity record.

The user's **MSAL token cache is not stored on the session**: it lives encrypted
and per-user in `user_tokens` so runs without a live session can still act for
the user. See [MICROSOFT_GRAPH.md](MICROSOFT_GRAPH.md).

### Server Validation

**File:** `app/src/lib/auth/server.ts`

```typescript
// Use in server functions:
const user = await getAuthenticatedUser();
// → Returns: { id (Entra oid), email, displayName }
// → Throws if: not authenticated or email not in allowlist

// Non-throwing variant for the client AuthProvider resource:
const maybeUser = await getSessionUser(); // → AuthUser | null
```

### AuthProvider Component

**File:** `app/src/components/AuthProvider.tsx`

Provides app-wide auth context:

```typescript
const { user, loading, refetch, signOut } = useAuth();
// user() → AuthUser | null  ({ id, email, displayName })
```

**Redirect Logic:**

1. Authenticated user on `/auth/*` → redirect to `/`
2. Unauthenticated user on protected route → redirect to `/auth/signin`
3. `signOut()` → full navigation to `/api/auth/logout`

Allowlist rejection is enforced **server-side** (the callback sends unlisted
emails to `/auth/access-denied` and mints no session).

### Sign-in page

**File:** `app/src/routes/auth/signin.tsx` — a single **"Sign in with Microsoft"**
link to `/api/auth/login`, which starts the OIDC flow. The link carries
`rel="external"` so `@solidjs/router` doesn't intercept it as a client route
(without that, the click is swallowed and the server route never runs).

### Dev Bypass (#42)

**File:** `app/src/lib/auth/dev-bypass.ts` — single source of truth.

```typescript
isBypassEnabled(): boolean   // import.meta.env.DEV  &&  VITE_DEV_BYPASS_AUTH === 'true'
BYPASS_USER                  // { id: 'dev-bypass-user', email: 'dev@local' }
```

Both gates must pass. The `import.meta.env.DEV` half is the **production
guard**: Vite statically replaces `DEV` with `false` in production builds,
so the bypass is structurally impossible to honor in a prod bundle no
matter what `VITE_DEV_BYPASS_AUTH` is set to. If the env var leaks into a
prod build, the module logs a one-shot warning at load so the
misconfiguration is visible — but the bypass still does not activate.

`BYPASS_USER.id` is the shared literal used by both the client
(`AuthProvider.tsx` mock user) and the server (`actions.server.ts`,
`/api/events`, `/api/stash` `requireUserId`). Before #42 the frontend used
`dev-user` while the backend used `dev-bypass-user`, so `useAuth().user().id`
did not match the `user_id` Postgres rows were written under.

**To enable real auth locally** (e.g. to test the Entra sign-in), set
`VITE_DEV_BYPASS_AUTH='false'` in `app/.env`, fill in the `AZURE_*` +
`AUTH_SESSION_SECRET` values, and sign in with an email in
`VITE_ALLOWED_EMAILS`. See `app/.env.example` and
[`docs/deployment/entra-setup.md`](deployment/entra-setup.md).

**Known footgun (out of scope for #42):** because `BYPASS_USER.id` is a
single literal, all devs running against shared Postgres share one
conversation namespace. Per-dev seeding (e.g. from `git config user.email`)
remains tracked on #42.

---

## 4. User Avatar & Actions

### UserMenu Component

**File:** `app/src/components/ark-ui/UserMenu.tsx`

Integration via `useAuth()`:

```tsx
import { useAuth } from "~/components/AuthProvider";

const { user, signOut } = useAuth();

// Available user data (AuthUser):
user().profileImageUrl; // Avatar URL (nullable; unused by the Entra flow today)
user().displayName; // Display name (nullable)
user().email; // Email address

// Sign out action:
await signOut(); // → full navigation to /api/auth/logout (revokes session)
```

**Component Structure:**

- **Ark UI Avatar:** Shows profile image or initials fallback
- **Ark UI Menu:** Dropdown with Profile Settings & Sign Out
- **Positioning:** Added to Nav via `<li class="ml-auto">`
- **Visibility:** Only shown when `user()` exists

**Usage in Nav:**

```tsx
// app/src/components/Nav.tsx
import { UserMenu } from "~/components/ark-ui/UserMenu";

<nav class="bg-sky-800">
  <ul class="...">
    <li>Home</li>
    <li>About</li>
    <li class="ml-auto">
      <UserMenu /> {/* Auto-hides when logged out */}
    </li>
  </ul>
</nav>;
```

---

## 5. Application Layout & Chat Interface

### Overall Layout Structure

```
┌─────────────────────────────────────────────────────────┐
│ Nav (dark-bg-secondary)                                 │
│               [Metrics] [Theme] [Avatar Menu]           │
├────────────┬──────────────────────────┬─────────────────┤
│            │                          │                 │
│  Sidebar   │   Chat Messages          │  Support Panel  │
│  (64 cols) │   (ScrollArea)           │  (tabbed)       │
│            │                          │                 │
│  [History] │ ─────────────────────────│ Neo4j|Memory|   │
│  Thread 1  │   Chat Input             │ All|Observabi-  │
│  Thread 2  │   (Field.Textarea)       │ lity*|Tools     │
│  Thread 3  │                          │  (* default)    │
│            │                          │                 │
│ [+ New]    │                          │  [↓ Save]       │
└────────────┴──────────────────────────┴─────────────────┘
    ↑              ↑─── Splitter ───↑          ↑
Collapsible      60% default       40% default
```

### Main Page Component

**File:** `app/src/routes/index.tsx`

Since #226 B1 the route _composes_: per-session state lives in
`lib/session-registry.ts` (provided through `SessionRegistryContext`), the
conversation list in `lib/thread-list-store.ts`, and the route owns only view
state — which conversation is on screen, what the panels therefore show.

```tsx
<SessionRegistryContext.Provider value={registry}>
  <Splitter.Root orientation="horizontal" defaultSize={[60, 40]}>
    <Splitter.Panel id="chat">
      <ChatInterface
        sessionId={selectedSessionId()}
        onContextUpdate={handleContextUpdate}
      />
    </Splitter.Panel>

    <Splitter.ResizeTrigger id="chat:support" />

    <Splitter.Panel id="support">
      <SupportPanel
        graphElements={graphElements()}
        contextEvents={contextEvents()}
        unifiedContext={unifiedContext()}
        onClearGraph={clearGraph}
        onClearEvents={() => registry.clearEvents(selectedSessionId())}
      />
    </Splitter.Panel>
  </Splitter.Root>
</SessionRegistryContext.Provider>
```

### Chat Interface Components

**Location:** All in `app/src/components/ark-ui/`

#### 1. ChatInterface.tsx

Chat area for the selected conversation (the sidebar is a **sibling**, owned by
the route so thread selection can swap the `sessionId` prop):

```tsx
// routes/index.tsx
<div flex="~">
  <ChatSidebar ... />       // route-level sibling
  <ChatInterface sessionId={selectedSessionId()} ... />
</div>

// ChatInterface renders:
<AgentSelector /> + <ChatMessages /> + <ChatInput />
```

Since #105, `ChatInterface` holds **no message state of its own**, and since
#226 B1 it does not receive accessors for it either: it reads and writes the
`SessionRegistry` from context, always addressing the _run's_ session id, so a
backgrounded run keeps filling its own thread.

#### 2. ChatSidebar.tsx

**Props:** `collapsed: boolean`, `onToggle: () => void`, `threads`, `selectedId`, `onSelectThread`, `onNewChat`, `onTitleRegenerated`, `onDeleteThreads` (#71). Live run state, progress and completion marks come from the `SessionRegistry` in context (#226 B1), not from props.

- Width: `3rem` (collapsed) → `16rem` (expanded)
- Smooth inline style transition
- Thread history with relative timestamps, **ordered by creation (newest first)** — deliberately _not_ `updated_at`, which every turn-save bumps and which made the list reshuffle under concurrent runs (#105)
- Settings gear icon (opens `SettingsPanel` FloatingPanel) + New Chat button in footer
- **Agent icon per row (#60):** `listConversations()` pre-resolves each row's `agentIcon` from the registry, so the sidebar needs no registry import. Pure `threadIcon()` rule: placeholders show nothing (the real icon lands with the run-start refetch); rows whose agent was removed fall back to a generic robot.
- **Agent accent colours:** colour encodes an agent _family_, not an individual agent — `lib/agent-palette.ts` holds five far-apart hues (indigo general · amber code · orange sandbox · violet knowledge · blue integrations) plus a zinc fallback, and the glyph shape separates agents inside a family. Each `AgentConfig` picks a token (`accent: 'orange'`) beside its `icon`; `listConversations()` pre-resolves `agentAccent` exactly like `agentIcon`, so the **token** travels the wire and `accentColor()` maps it to hex client-side (a light theme can remap later; unknown tokens fall back to zinc, and the resolver uses `hasOwnProperty` so a wire value of `'toString'` can't resolve off the prototype). Cyan/green/red are **reserved for run status** and never assigned — agent colour lives on the glyph, status colour on the border/dot/badge, so the two read independently. Expanded rows are muted at rest and light up on row hover or while selected; the collapsed rail is **always** accented, since with no title visible the colour is the only thing separating one 32px button from the next.
  - _How the hover is wired:_ the states live in an `.agent-glyph` preflight rule and the per-row colour arrives as an inline `--agent-accent` custom property. UnoCSS variants would work too — `group-hover:text-[#fb923c]` and `data-[lit=true]:text-[#fb923c]` both emit correctly (verified in built output) — but only from _literal_ class strings, so it needs a token→class map restating every hex next to the palette that already holds them. The custom property keeps one source of truth for the hexes and lets a new family be added with a single palette line; the cost is one hand-written preflight rule. A tradeoff, not a constraint.
- **Collapsed icon rail (#60):** collapsing no longer hides everything — a 3rem rail shows one agent-icon button per thread (tooltip = title, click to switch, selected highlight) plus a compact "+" new-chat button. Run state compresses to a 6px corner dot (`railDot`: pulsing cyan while live — live outranks a completion mark — completion color until opened). The rail ignores the kind filter: that control is invisible while collapsed, and a hidden control silently subsetting the list would confuse. Delete/select/Settings stay expanded-only.
- **Delete (#71):** hover-reveal trash per row (regenerate ↻ shifted to `right:2rem` to make room). **Hidden — not disabled — for placeholders and running rows** (`canDeleteRow`): deleting mid-run would be resurrected by the run's end-save upsert, so the affordance isn't offered; mid-run cancel is #105 PR 3. Confirm is an Ark `Dialog` (Escape + focus trap free) with single-line copy from `deleteConfirmCopy`. The sidebar owns the confirm UX; `onDeleteThreads` on the route owns the mutation — `deleteConversationsBulk` (atomic `DELETE … = ANY($1) … RETURNING id`), cache patched once from the returned ids, per-id registry cleanup (buffers, progress, completion marks + timers, abort controllers, run states), and rerouting to the newest remaining thread (or a fresh chat) when the open conversation died.
- **Select mode (#71):** checklist toggle beside "Chat History" — row clicks toggle selection, styled `role="checkbox"` spans lead each row (rows are `<button>`s; a real `<input>` would nest interactives), hover actions collapse, and an action bar offers Select all/Clear (label via `allEligibleSelected`), destructive "Delete selected (N)", Cancel. Select-all covers the _visible_ (filtered) eligible threads and counts skipped running rows for the confirm copy; selections persist across filter switches (a set of ids). Run state is re-checked at confirm time — newly-running rows move to the skip count. Exit paths: Cancel, Esc, successful bulk delete, sidebar collapse. Keyboard is the codebase's first document-level keydown (scoped to select mode, `onCleanup`ed): Esc exits, Cmd/Ctrl-A toggles select-all — bypassed while the dialog is open and when focus sits in an input/textarea/contentEditable so the composer keeps native select-all.
- **Optimistic "+ New Chat" placeholder (#44):** Clicking _+ New Chat_ immediately prepends a placeholder row keyed by the new `selectedSessionId` (`title: null`, `isPlaceholder: true`). Once the real row lands in the `threadsResource`, the merger (`mergeThreadsWithPlaceholder`) drops the placeholder by id. Purely client-side; switching to an existing thread clears it. Since #105's early persist, the real row already appears on the _first SSE event_ of the first run (derived title), so the placeholder only covers the pre-send moment.
- **Per-row live progress (#105):** while a conversation's run streams _in this browser_, the timestamp line gives way to the run's current status text + a 3px progress strip (`RowProgress`) fed by the same route-owned `ChainProgressController` as the in-chat bar (fill math shared via `progressPercent`; indeterminate shimmer until the chain projection seeds). Badges (`StatusBadge` via `rowIndicator`) are **action-rows only** — POST actions have no client stream, so their persisted `status` is their freshest signal.
- **Completion marks (#105):** a run that settles while another thread is in view flashes its row (green done / red error) then holds an accent border (`completionBorderColor`, inline `border-color` — see the attributify trap below) until the thread is opened. Runs that settle in the viewed thread mark nothing.

#### 3. ChatMessages.tsx

- **ScrollArea.Root** - Custom scrollable message container
- **Features:**
  - Auto-scroll to latest message
  - Different layouts for user vs assistant messages
  - Avatar with initials fallback
  - Message bubbles with timestamps
  - Empty state with icon
- **User messages:** Right-aligned, cyber-700 background
- **AI messages:** Left-aligned, dark-bg-tertiary background
- **Chat-Graph Entity Linking:** After rendering markdown, `annotateEntities()` post-processes the HTML to wrap known entity and relation names in `<span class="graph-entity" data-entity-name="..." data-entity-ids="...">` elements. Hovering highlights matching graph nodes/edges; clicking toggles a persistent highlight. A module-level `toggledEntities` Set tracks persistent state. Event delegation on the messages container handles all interactions via `handleMouseOver`, `handleMouseOut`, `handleClick`.
  - **Props:** `graphEntityNames?: Map<string, string[]>` (name → element IDs, built in `index.tsx` from graph elements), `onHighlightEntities?: (ids: string[]) => void`
  - **CSS:** `.graph-entity` styles in `uno.config.ts` (dashed underline, cyan glow on hover/toggle)

#### 4. ChatInput.tsx

- **Field.Textarea** with `autoresize` prop
- **Keyboard shortcuts:**
  - Enter → Send message
  - Shift+Enter → New line
- **Submit guard (#47):** When `disabled` is true, the textarea **stays editable** so the user's draft survives, but Enter no-ops. If `blockedMessage` is provided, an inline banner ("Waiting for `<tool>` to complete. Try later.") renders above the input — driven by the currently-running tool from the active session's `controller_action` events.
- **Concurrency cap (#105):** with `maxConcurrentRuns` sessions already streaming (default 3, Settings → Concurrency), sending into an _idle_ conversation is refused — composer disabled, banner "max N reached — wait for a session to stop". Client-side policy (`isAtConcurrencyCap` in `lib/run-registry.ts`); nothing running is ever interrupted, and the session that is itself streaming keeps the tool banner rather than the cap message.
- **Styling:** Neon cyan border on focus

#### 5. AgentSelector.tsx

**Props:** `selectedAgent: string`, `onAgentChange: (id: string) => void`, `disabled: boolean`

- Dropdown listing registered agents (search, general, sandbox-session, flavoured-sandbox, retriever, microsoft-365)
- Agent icons are **iconify classes** on `AgentConfig.icon` (material-symbols set), rendered as `<span class={icon}>` with inline sizing — see the icon-scanning gotcha in §6a
- Clearing the session on agent switch

#### 6. SupportPanel.tsx

Tabbed right panel. **Context manager is the default tab.** Uses `lazyMount` + `unmountOnExit` so inactive tabs don't hold Cytoscape instances in memory.

| Tab                             | Content                                                                                                                                                                                                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Neo4j                           | Graph visualization for Neo4j query results (accumulated, live sync)                                                                                                                                                                                        |
| Memory                          | Graph visualization for Memory MCP entities                                                                                                                                                                                                                 |
| All (Turn Explorer)             | Turn-based graph explorer — select specific turns, color-coded                                                                                                                                                                                              |
| **Context manager** _(default)_ | Event timeline + LLM call detail                                                                                                                                                                                                                            |
| Data                            | Data Stash — two collapsible groups: **Your Uploads** (drag-drop/picker + document chips) and **Agent Findings** (tool-result icons by turn), each with hide/archive/delete. See [DATA_STASH.md](DATA_STASH.md) for the upload→chunk→embed→search pipeline. |

**Conversation Sync toggle:** The Neo4j and Memory graph tabs have a ⏸/▶ "Sync" button (cyan when live, amber when paused). Implemented in `GraphTabContent` via a `syncEnabled` signal. When paused, the current element list is snapshotted into `frozenElements` and passed to `GraphVisualization` instead of live `props.elements`. Resuming restores the live feed.

**Touched-node highlight (Neo4j tab only):** When an agent runs a Neo4j query, the `enrichNeo4jResult` hook (`onToolResult` on `simpleLoop`) attaches a 1-hop neighborhood plus a `_touched` list to the tool result. The extractor tags nodes whose name is in that list with `data.touched = true`, and the Neo4j tab passes a static `TOUCHED_NODE_STYLES` block (`node[touched]` selector → magenta fill/border + glow) as `extraStyles` to `GraphVisualization`. The result: nodes the agent's query _actually targeted_ render in magenta, while neighborhood-context nodes render in the default cyan. The Memory tab does not receive this stylesheet.

**Touched-flag refresh across turns** (`app/src/lib/graph-merge.ts`): `index.tsx` accumulates elements via `mergeGraphElements(prev, fresh)` rather than ad-hoc dedup. When a fresh batch carries any element with `touched: true`, the merger first strips the flag from all prior elements, then re-applies it to elements in the new batch — so the magenta highlight tracks the most recent enriched query and doesn't linger on nodes from earlier topics. When the fresh batch carries no `touched` flags (e.g., a non-enriched tool, or a count-only query), prior `touched` flags are preserved.

**All Tab — Turn Explorer (AllGraphTab.tsx):**
The All tab does not use the accumulated `graphElements` signal. Instead, it derives graph elements on-demand from `contextEvents`:

1. `splitIntoTurns()` (from `turn-utils.ts`) splits the event stream at `user_message` boundaries
2. User opens the FloatingPanel ("Turns" button) to see turn columns side-by-side
3. Each column shows turn number, user message preview, and graph-producing tool results
4. Clicking a turn header toggles its selection; "All"/"None" buttons for bulk selection
5. `extractMultiTurnGraphElements()` extracts and merges elements from selected turns, tagging each with `data.turn = N`
6. Cytoscape renders elements with per-turn colors via `extraStyles` prop (attribute selectors: `node[turn=N]`)
7. A color legend overlay in the bottom-right corner shows the turn-color mapping

#### 7. GraphVisualization.tsx

Cytoscape.js graph component with dark futuristic theme.

**Rendering lifecycle:** With `unmountOnExit` on `Tabs.Root`, Cytoscape instances are fully created/destroyed when switching tabs. A `ResizeObserver` on `containerRef` drives a `visible()` signal to defer layout until the container has non-zero dimensions. The observer callback guards against a detached `containerRef` and defers `setVisible` + `cy.resize()` to `requestAnimationFrame` so that a notify-during-layout firing after the tab unmounts doesn't surface as the `ResizeObserver loop completed with undelivered notifications` warning (issue #38). The component-scoped `resizeObserver` and `resizeRafId` are torn down explicitly in `onCleanup` alongside `cy.destroy()`.

**Base styles** are extracted to a module-level `BASE_STYLES` constant. The `extraStyles` prop appends additional stylesheets (e.g. per-turn color rules) — a reactive `createEffect` re-applies `cy.style([...BASE_STYLES, ...extraStyles])` when they change.

**Features:**

- Incremental graph updates (additive, preserves positions)
- Collapsible Display Controls panel: node size, edge width, font size, edge labels toggle
- Node properties panel on click (inline `data` + `properties` merged)
- Inline property editing (pencil icon → textarea → Cypher persist via `onCypherWrite`)
- Relation creation mode (purple banner, click source then target)
- Node creation form ("+ Node" toolbar button — Name, Label, Description)
- `highlightedIds` prop adds `.highlighted` CSS class to matching elements
- `extraStyles` prop for dynamic Cytoscape stylesheet injection (used by AllGraphTab for turn colors)

**Props:**

```typescript
{
  elements: ElementDefinition[]
  highlightedIds?: string[]         // IDs to visually highlight (from chat entity hover/toggle)
  onNodeClick?: (id, data) => void
  onEdgeClick?: (id, data) => void
  onCypherWrite?: (cypher, params?) => Promise<void>  // For write operations
  extraStyles?: StylesheetJsonBlock[] // Additional Cytoscape styles (e.g. per-turn colors)
}
```

#### 8. ObservabilityPanel.tsx

Displays the full agent event timeline:

- Events are merged into `TimelineItem[]` via `buildTimelineItems()`: `tool_call` + `tool_result` pairs sharing the same `callId` appear as a single merged row
- Click any row → detail overlay with args / result / LLM call data
- **LLM call detail** (events with `llmCall`): two-tab layout — **Prompt** | **Output**. The Prompt tab uses an Ark UI Accordion with three sections: _Template_ (Jinja source with `{{ vars }}` and `{% if %}` / `{% for %}` blocks, sourced from `baml_src/`), _Variables_ (function inputs), _Rendered messages_ (HTTP body parsed into role/content bubbles via `ParsedPromptView`). Sourced from `LLMCallData` in `baml-adapters.server.ts` — `httpRequest.body` is read via `body.text()` because BAML returns an `HttpBody` class instance, not a plain object.
- **Save button** (floating, bottom-right): calls `showSaveFilePicker()` to save the full `UnifiedContext` as a named JSON file; falls back to `<a download>` on browsers without File System Access API
- Requires `context?: UnifiedContext` prop threaded down from `index.tsx` → `SupportPanel` → `ObservabilityPanel`
- **Split across files** (#226 B5): `ObservabilityPanel.tsx` is the composition root and the only public export. The pure projections live in `app/src/lib/observability/` — `projection.ts` (`buildTimelineItems()`, `getEventPreview()`, `getEventLane()`), `prompt-parse.ts` (`parsePromptBody()`, `flattenContent()`, `formatParamValue()`), `token-totals.ts` (`foldTokenTotals()`, `fmtTok()`, `fmtEur()` — the app's one price formatter) and `event-styles.ts` (icon/colour tables, `getPatternColor()`) — and the rendering in `components/ark-ui/observability/` (`SummaryBar`, `TimelineRows`, `EventDetail`, `LLMCallTabs`, `PromptView`)

### Theme System

**File:** `app/src/components/ark-ui/ThemeSwitcher.tsx`

```tsx
// Toggle between light/dark modes
// Persists to localStorage
// Updates document.documentElement.classList
```

**Custom Color Palette:** (defined in `uno.config.ts`)

```typescript
{
  cyber: {     // Purple/indigo brand colors
    600: '#4f46e5',
    700: '#4338ca',
    800: '#3730a3',
    // ... full scale
  },
  neon: {      // Accent colors for highlights
    cyan: '#00ffff',
    magenta: '#ff00ff',
    purple: '#9d00ff',
    // ... more neon colors
  },
  dark: {      // Semantic dark theme tokens
    bg: {
      primary: '#0a0a0f',      // Darkest background
      secondary: '#12121a',    // Main panels
      tertiary: '#1a1a24',     // Cards/inputs
      hover: '#22222f',        // Interactive states
    },
    border: {
      primary: '#2a2a3a',      // Main borders
      secondary: '#3a3a4a',    // Secondary borders
      accent: '#4a4a5a',       // Highlighted borders
    },
    text: {
      primary: '#e4e4e7',      // Main text
      secondary: '#a1a1aa',    // Secondary text
      tertiary: '#71717a',     // Tertiary/muted text
    }
  }
}
```

**UnoCSS Shortcuts:**

- `glass-panel` - Semi-transparent panel with backdrop blur
- `neon-border` - Cyan border with glow effect
- `cyber-button` - Cyber-themed button with glow on hover

### Component Data Flow

```
index.tsx (view state only)
    ├─ selectedSessionId / placeholderSessionId / sidebarCollapsed
    ├─ highlightedIds: Signal<string[]>          ← ids from the latest graph batch, cleared on switch
    ├─ graphEntityNames: Memo<Map<string, string[]>>  ← name → element IDs (for chat linking)
    │
    ├─ SessionRegistry (lib/session-registry.ts, via SessionRegistryContext) —
    │  per-conversation state that survives thread switches (#47/#105/SA-H8):
    │   ├─ messages(sid)   ← chat buffers (incl. the in-flight turn)
    │   ├─ events(sid) / graph(sid) / context(sid)   ← the panels' per-session projections
    │   ├─ progress(sid): ChainProgressController
    │   ├─ runState(sid): { isProcessing, runningTool } + runningCount()
    │   ├─ completion(sid): flash → accent border, cleared on open
    │   ├─ abort/registerAbort/abortAll             ← aborted on unload or explicit Stop
    │   └─ dispose(ids) / pruneIdle(keep)           ← the ONE forget rule, the ONE prune rule
    │
    ├─ ThreadListStore (lib/thread-list-store.ts) — the conversation list:
    │   └─ threads / refetch / applyTitle / markPromoted / remove / placeholder
    │
    ├─> ChatInterface (sessionId + a few route callbacks; state comes from context)
    │       ├─ selectedAgent: Signal<string>
    │       │   Props: graphEntityNames, onHighlightEntities, onContextUpdate,
    │       │          onRunStarted, onRunSettled, onTitleUpdated, onPromoted
    │       │
    │       ├─> AgentSelector (selectedAgent, onAgentChange, disabled)
    │       ├─> ChatMessages (messages, graphEntityNames, onHighlightEntities, onApproveWrite, onRejectWrite)
    │       │       └─ annotateEntities() — wraps entity names in interactive spans post-render
    │       └─> ChatInput (onSend, disabled, blockedMessage)
    │
    ├─> ChatSidebar (threads, selectedId, onDeleteThreads — run state from the registry)
    │       ├─ RowProgress — per-row status + strip off the same progress controllers
    │       ├─ collapsed icon rail (#60) + select mode / delete confirm (#71)
    │       └─ Dialog (Ark) — delete confirmation
    │
    └─> SupportPanel (lazyMount + unmountOnExit)
            │   Props: graphElements, contextEvents, highlightedIds, onCypherWrite
            ├─> GraphTabContent (Neo4j/Memory tabs)
            │       └─> GraphVisualization (elements, highlightedIds, onCypherWrite)
            │               └─ Inline edit / relation create / node create → onCypherWrite
            ├─> AllGraphTabWrapper (All tab — turn-based explorer)
            │       └─> AllGraphTab
            │               ├─ splitIntoTurns(contextEvents) → TurnData[]
            │               ├─ FloatingPanel with TurnColumn[] (horizontal layout)
            │               ├─ extractMultiTurnGraphElements() → tagged elements
            │               ├─> GraphVisualization (elements, extraStyles=turnStyles)
            │               └─ Turn color legend overlay
            ├─> DataStashPanel (events, onStashAction)
            ├─> SettingsPanel (FloatingPanel in ChatSidebar footer)
            │       └─ SliderSetting / NumberSetting components
            │       └─ getSettings() / updateSetting() from settings-store.ts
            ├─> ObservabilityPanel (events, context, onClear)
            │       ├─ buildTimelineItems() — merges tool pairs by callId
            │       └─ Save button → showSaveFilePicker() / <a download>
```

### Message Type

```typescript
interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  toolCall?: {
    // Present when status === 'paused' (approval gate)
    type: string;
    status: "pending" | "executed" | "error";
    tool: string;
    explanation?: string;
    isReadOnly: boolean;
    error?: string;
  };
}
```

### Metrics dashboard route (#132)

A second page — `routes/dashboard.tsx`, reached from the monitoring icon in the
nav (the old "Home"/"About" text links are gone; the chat _is_ `/`). It shows
token, cache and cost aggregates across everything the signed-in user has run.

| Layer  | File                              | Role                                                                                                                                                                                        |
| ------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fold   | `lib/metrics/aggregate.ts`        | Pure, client-safe folds over `ContextEvent[]`: `getEventMetrics` (the single accessor for step accounting), `foldEvents`, `aggregateByPattern`, `aggregateByConversation`, `buildDashboard` |
| Action | `lib/metrics/dashboard.server.ts` | `getMetricsDashboard(topN)` — `requireUser()`, load, fold, return aggregates only (raw events never cross the wire)                                                                         |
| Query  | `lib/db/conversations.server.ts`  | `listConversationEvents(userId)` projects `context -> 'events'` in SQL (same 200-row ceiling as the sidebar list)                                                                           |
| Page   | `routes/dashboard.tsx`            | Global cards + input-composition bar, per-pattern table, top-N conversations. No chart library — bars are divs                                                                              |

Numbers come from `event.metrics` (#122 / PR #130) and **only** from there:
`llmCall.usage` has no cache-write bucket and no cost, so folding it in would
understate spend while looking complete. LLM steps predating the attribute are
counted as _unmetered_ and called out in the UI rather than silently dropped.

---

## 6. Conversation Persistence

Conversations are persisted to Postgres so they survive process restarts and list per-user in the sidebar. The store is a single `conversations(id, user_id, agent_id, title, context jsonb, created_at, updated_at)` table; the JSONB blob is the full `serializeContext()` output (no normalization). Schema is bootstrapped idempotently on first DB hit — bring-up is just `docker compose up -d`.

### Layers

| Layer     | File                                   | Role                                                                                                                                                                                                                                                             |
| --------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pool      | `lib/db/client.server.ts`              | Lazy `pg.Pool` singleton, runs `CREATE TABLE IF NOT EXISTS` once per process                                                                                                                                                                                     |
| Repo      | `lib/db/conversations.server.ts`       | Typed CRUD: `loadConversation`, `saveConversation`, `listConversations`, `deleteConversation`, `deriveTitle`                                                                                                                                                     |
| Session   | `lib/harness-client/session.server.ts` | In-process pattern cache (non-serializable BAML clients) + Postgres-backed serialized context, scoped by `userId`                                                                                                                                                |
| Actions   | `lib/harness-client/actions.server.ts` | `listConversations()`, `loadConversation()` server actions for the sidebar; auth-gated                                                                                                                                                                           |
| Sidebar   | `components/ark-ui/ChatSidebar.tsx`    | Real thread list + "+ New Chat", selected-thread highlight, per-row + bulk delete (#71)                                                                                                                                                                          |
| Page      | `routes/index.tsx`                     | `selectedSessionId` signal; threads resource refetched after each turn AND on run start / settle (#105). **Always read via `threads.latest`** — see _Rendering gotchas_ in §6a                                                                                   |
| Hydration | `components/ark-ui/ChatInterface.tsx`  | `createEffect` on `props.sessionId` replays events into graph + observability. **Skipped while that session's run is in flight** (the live buffer is the only copy of the un-persisted turn); reads run state untracked so a finishing run doesn't re-trigger it |

### Row lifecycle (#105)

A conversation row is persisted **at run start**, not run end: `runTurn` (in
`actions.server.ts`) upserts a stub when no row exists — a minimal valid
context carrying the user message (a mid-run reload replays it) and a
`deriveTitle()` title — mirroring `seedActionRow` on the POST-trigger path.
The run's final `saveSession` overwrites the blob; the first-turn LLM title
replaces the derived one via `title_updated`. Guarded on "no existing row",
so pre-seeded action rows and second turns never hit it. The client refetches
the list on the first SSE event (which strictly follows the persist) and on
run settle, so new chats are visible — with live progress — for their entire
first run.

`listConversations` orders by **`created_at DESC`** (stable for a row's
lifetime), not `updated_at`, which every turn-save bumps — activity ordering
made the sidebar reshuffle under concurrent runs. `updatedAt` is still
returned for the "x ago" display.

### Sticky titles

The first 60 chars of the first `user_message` becomes the conversation title. Once set, it never changes via `saveConversation()` — `COALESCE(conversations.title, EXCLUDED.title)` on update. A dedicated `updateConversationTitle(id, userId, title)` action bypasses the COALESCE rule and is used by the LLM title generator (see §6b below) to replace the heuristic title once the model resolves. A future user-rename UI can use the same action.

### LLM-generated titles (§6b)

Once the first turn completes, a minimal one-pattern harness agent in `lib/harness-client/agents/title-generator.server.ts` calls a single BAML function (`GenerateConversationTitle`, using the `DescribeAnthropic` chain) and writes the result via `updateConversationTitle()`. The result is pushed to the client over the existing `/api/events` SSE stream as an `event: title_updated` frame before the stream closes (capped at 3s so a slow LLM never wedges the response). The client patches the threads cache in-place — no refetch. See §6b for the full architecture.

### Auth

Every public action and the `/api/events` / `/api/stash` routes authenticate via the Entra session (`getAuthenticatedUser()` → `getCurrentUser()`, §3) and scope session ops by `user.id` (the Entra `oid`). In dev with the bypass enabled (`isBypassEnabled()` from `lib/auth/dev-bypass.ts`), the user id falls back to `BYPASS_USER.id` (`'dev-bypass-user'`) — the same literal the client-side `AuthProvider` mock user uses, so `useAuth().user().id` matches the `conversations.user_id` rows. See §3 _Dev Bypass_ for the gate and the production guard.

---

## 6a. Multi-Session Runs: Per-Session State, Cap & Live Indicators (#47, #105)

Everything a run produces is scoped to its conversation, not to the
`ChatInterface` instance. Switching threads while a chain is running leaves
the streamed loop running on the server; up to `maxConcurrentRuns` sessions
(default 3) may stream at once, each with its own live view, sidebar
progress readout, and completion mark.

### State location

`lib/session-registry.ts` owns the per-session slots; the route creates one and
provides it through `SessionRegistryContext` (#226 B1).

| Slot                     | Read                                   | Purpose                                                                                                                                                                                                                                                   |
| ------------------------ | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| messages                 | `messages(sid)`                        | Chat buffers, **including the in-flight turn** (not persisted until run end — hoisting it out of the component is what makes switch-back non-destructive, #105). Idle buffers are pruned on thread switch; a _running_ session's buffer is irreplaceable. |
| events / graph / context | `events(sid)` etc.                     | The observability timeline, the graph and the last `UnifiedContext`, per conversation (SA-H8).                                                                                                                                                            |
| progress                 | `progress(sid)`                        | One `ChainProgressController` per session, lazily created. Feeds the in-chat bar AND the sidebar's `RowProgress` strip.                                                                                                                                   |
| run state                | `runState(sid)`, `runningCount()`      | `{ isProcessing, runningTool }` per session — composer guard, sidebar live gate, concurrency cap.                                                                                                                                                         |
| completion               | `completion(sid)`                      | Flash → accent border for runs that settle while another thread is in view. Cleared when the thread is opened.                                                                                                                                            |
| abort                    | `registerAbort` / `abort` / `abortAll` | One in-flight SSE stream per session. Torn down by an explicit Stop or on page unload — never on a chat switch.                                                                                                                                           |

Two lifecycle rules sit over them and are the reason the module exists:
`dispose(ids)` is the single place a conversation is forgotten, `pruneIdle(keep)`
the single prune rule (it spares `keep` and anything still running, and never
drops a progress controller).

Shared shapes + the pure cap policy (`countRunning`, `isAtConcurrencyCap`,
`capReachedMessage`) live in `lib/run-registry.ts`.

Inside `runSend` the active `props.sessionId` is captured as `runSessionId` at
submit time — all run writes are keyed on that captured id, not the live prop.

### Event routing

- **Progress is always routed** into `registry.progress(runSessionId)` regardless of which chat the user is viewing.
- **Messages** (user bubble, inline error/warning bubbles, final assistant message) are filed into `registry.appendMessage(runSessionId, …)` unconditionally — a backgrounded run fills its own thread's buffer; the view just renders the selected session's buffer.
- **Tool name** is extracted from `controller_action.action.tool_name` and pushed via `registry.updateRunState(runSessionId, { runningTool })`; a multi-call turn (`action.additional_calls`) shows the batch size instead (e.g. `"3 tools"`). When `is_final` is true the field clears.
- **Graph, events panel and context** are per-session too (SA-H8): they go to `runSessionId`'s slots whatever is on screen. Only the _highlight_ is view state — it moves only when the batch landed in the displayed conversation.
- **Run boundary callbacks:** `onRunStarted` (first SSE event → threads refetch; the early-persisted row appears) and `onRunSettled(sid, 'done' | 'error')` (threads refetch + completion mark; not fired on abort).

### Concurrency cap

`maxConcurrentRuns` (`HarnessSettings`, Settings → Concurrency slider) is a
client-side policy — the server takes no part. At the cap, a send into an
idle conversation is refused ("max N reached — wait for a session to stop");
the already-running session is never "at cap" for its own account (it keeps
the tool banner), and a non-positive/non-finite cap means _no cap_ so bad
localStorage can't lock the composer. Nothing running is ever interrupted —
mid-run cancellation is #105 PR 3, unbuilt.

### SSE envelope

`api/events.ts` spreads `sessionId` into every emitted JSON object (the `event: done` payload too). It's not part of the typed `ContextEvent` shape — it's an envelope-only field consumed by the client.

### Submit guard

`ChatInput` keeps the textarea editable while `disabled` is true. The Enter handler no-ops, but the user's draft survives. `blockedMessage` renders an inline banner above the input: the tool banner for the running session, or the cap message when a new run is refused.

### Lifecycle

| Event                           | Behavior                                                                                                                                                                                                                                              |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Submit on a non-running chat    | Cap check first. Then `registry.progress(sid).reset()`; `registry.updateRunState(sid, { isProcessing: true })`; SSE opens; per-session `AbortController` registered. Server-side, `runTurn` persists the row before running (see §6 _Row lifecycle_). |
| First SSE event                 | `onRunStarted` → `refetchThreads()` — the new row appears with derived title, status line, and progress strip.                                                                                                                                        |
| Switch chats mid-stream         | Nothing aborts. The hydration effect loads the target thread; the running thread's buffer/controller keep accumulating; its sidebar row keeps its strip.                                                                                              |
| Switch back to the running chat | The buffer + controller are still live — user bubble, inline errors, and bar all restore. Hydration is skipped (`isProcessing`, read untracked).                                                                                                      |
| Stream completes                | `progress.finish()`; run state cleared; `AbortController` unregistered; `onRunSettled` → refetch + (if backgrounded) completion mark: flash, then accent border until opened.                                                                         |
| Tab close / `beforeunload`      | Route calls `registry.abortAll()` → no zombie fetches in DevTools.                                                                                                                                                                                    |

### Rendering gotchas (all verified against built output)

1. **Attributify extractor:** UnoCSS's `presetAttributify` emits `[attr~="…"]`
   selectors only for values found as _literal text_ in source. Values that
   exist only inside dynamic expressions (`border={fn()}`) — and some literal
   fractions (`m="t-1.5"`) — are silently dropped from the built sheet. Rule:
   dynamic styling uses inline `style={{…}}`. Known pre-existing casualty:
   the sidebar's selected-row `border="1 neon-cyan/40"` never renders.
2. **Root Suspense vs resource refetch:** `app.tsx` wraps routes in an
   empty-fallback `<Suspense>`. Reading a `createResource` via `resource()`
   re-registers with that boundary on every `refetch()` — the whole route
   detaches for the query duration (blank flash, composer focus + scroll
   lost). Rule: resources that refetch during interaction are read via
   **`resource.latest`** (raw value once resolved, no Suspense; first load
   still suspends). Applied to `threads`.
3. **Icon classes in `.ts` files:** UnoCSS's default pipeline never scans
   plain `.ts` — so `AgentConfig.icon` literals in
   `harness-client/agents/*.server.ts` need BOTH (verified against
   `@unocss/vite` source): the `content.filesystem` glob in `uno.config.ts`
   (the client build reads files that are never in its module graph) AND a
   literal `@unocss-include` comment in each file — filesystem-globbed files
   still pass through the pipeline filter, which rejects `.ts` paths unless
   that marker appears in the code. Adding an agent: use an
   `i-material-symbols-*` class and keep the marker comment. Render with
   `class=` + inline sizing, never attributify (gotcha 1).
4. **Attributify props on Ark `Dialog` overlay parts:** without
   `lazyMount unmountOnExit`, Ark keeps the closed dialog MOUNTED with the
   `hidden` attribute — and any attributify display utility on it
   (`flex="~"` → `[flex~="~"]{display:flex}`) is an author rule that
   overrides the UA's `[hidden]{display:none}`, resurrecting the element.
   Compounding it, `position` is not an attributify rule at all
   (`position: "fixed"` in a props cast silently does nothing), so the
   resurrected overlay is _static and in-flow_: a phantom full-height flex
   item that starved the sidebar's `flex:1` thread list to zero height
   (found via computed styles in a live browser; the built CSS was fine).
   Rule: give `Dialog.Root` `lazyMount unmountOnExit`, and position
   Backdrop/Positioner with inline `style`.

---

## 6b. LLM-Generated Conversation Titles

Once the first user turn completes, a minimal harness agent generates a 3–5 word title and replaces the heuristic placeholder. The result is pushed to the client on the same SSE channel the turn was streamed over.

### Why a harness agent for one BAML call?

The `harness-patterns/` library is the testbed for an eventual standalone npm package. Its current example catalog (`harness-client/agents/`) ranges from `simpleLoop` through `actorCritic`, `parallel`, `guardrail`, and a full ontology-builder pipeline — but had no _minimum-rung_ example showing the library handles one-shot LLM jobs too. The title generator fills that gap with what is genuinely the smallest legal composition:

```ts
// app/src/lib/harness-client/agents/title-generator.server.ts
export const titleAgent = harness<TitleAgentData>(
  compactExecution<TitleAgentData>({
    patternId: "title-gen",
    mode: "message",
    synthesize: async ({ userMessage }) =>
      sanitizeTitle(await b.GenerateConversationTitle(userMessage)) ?? "",
  }),
);
```

One pattern (`compactExecution`), one BAML call, no tools, no router. `mode: 'message'` makes the compactExecution a thin shell around the custom `synthesize` fn: it pulls the latest `user_message` from the view and feeds it as the function's input.

### The BAML function

`app/baml_src/title.baml` — `GenerateConversationTitle(user_message: string) -> string`, wired to `DescribeAnthropic` (`[AnthropicHaiku45]`). Reuses the same lightweight client chain the background tool-result summarizer uses; both are "tiny async post-process" jobs.

### When it runs

| Trigger                          | Path                                                                                                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **First turn of a conversation** | `api/events.ts` calls `runFirstTurnTitleGen(ctx, sessionId, userId)` after the SSE `done` frame, before close. Hard 3s timeout.                                                                         |
| **On-demand from the sidebar**   | Hover-reveal `↻` icon on each row → calls the `regenerateConversationTitle(sessionId)` server action → loads context → calls `runRegenerateTitle()` (no first-turn gate, uses the latest user message). |

`runFirstTurnTitleGen` is the one with the gate: it skips when `ctx.events.filter(e => e.type === 'user_message').length !== 1`. Titles stay stable across turns; users learn to recognize them.

### How the title reaches the sidebar

The integrated SSE event approach — no new endpoint, no long-lived connection, no polling.

```
POST /api/events
  ◀── event: <ContextEvent>      (user_message)
  ◀── event: <ContextEvent>      (…)
  ◀── event: done {response, …}  ← user already sees the response
  ░░░ runFirstTurnTitleGen() runs (≤ 3s) ░░░
  ◀── event: title_updated {sessionId, title}    ← server pushes
                                                    stream closes
```

Server-side (`api/events.ts:78-95`):

```ts
controller.enqueue(`event: done\ndata: ${doneData}\n\n`);
await Promise.race([
  runFirstTurnTitleGen(result.context, sessionId, userId).then((title) => {
    if (!title) return;
    controller.enqueue(
      `event: title_updated\ndata: ${JSON.stringify({ sessionId, title })}\n\n`,
    );
  }),
  new Promise((resolve) => setTimeout(resolve, 3000)),
]).catch((err) => console.error("[title-gen] failed:", err));
controller.close();
```

Client-side: the typed SSE parser yields `{ event: 'title_updated', data: { sessionId, title } }` and `ChatInterface` invokes `props.onTitleUpdated?.(sessionId, title)`. `routes/index.tsx` patches the threads cache via `mutateThreads()` — no `listConversations()` round-trip.

### Bypassing the COALESCE-sticky upsert

`saveConversation()`'s `COALESCE(conversations.title, EXCLUDED.title)` keeps a once-set title forever. For the LLM title we need authoritative replacement, so `lib/db/conversations.server.ts` exposes a dedicated `updateConversationTitle(id, userId, title)` that does a direct `UPDATE … SET title = $1` scoped by `user_id`. The upsert path retains its sticky semantics for everything else.

### Failure handling

All failures (LLM throws, returns empty, sanitizer rejects, 3s timeout fires) are caught silently. The heuristic title (`deriveTitle()`) remains in place. No retry, no error event to the user.

### Sidebar regenerate (`↻` button)

`ChatSidebar.tsx` renders a hover-reveal `↻` icon on each non-placeholder row. Click → calls `regenerateConversationTitle(threadId)` server action → forwards the returned title to `onTitleRegenerated`, which routes through the same `handleTitleUpdated` patcher used by the SSE event. Inline spinner while in flight. Pending state is tracked per row in a `Set<sessionId>`.

### Replay correctness — `final?` discriminator

Restoring a conversation no longer surfaces residual router status messages ("Let me look into that…") as if they were assistant responses. `AssistantMessageEventData.final?: boolean` distinguishes the compactExecution's user-facing emit (and the router's direct-response branch) from intermediate routing status. `replayMessages` in `lib/harness-client/replay.ts` filters on it. The live stream is unaffected — the live UI only paints `finalResult.response` anyway.

---

## 6c. Typed SSE Parser

`app/src/lib/sse-client.ts` exposes a single function:

```ts
parseChatStream(response: Response): AsyncGenerator<ChatStreamEvent>
```

Wraps the `/api/events` response body and yields a discriminated union over event kinds:

```ts
type ChatStreamEvent =
  | { event: "message"; data: ContextEvent & { sessionId?: string } }
  | { event: "done"; data: DoneEventData }
  | { event: "error"; data: { sessionId?: string; error: string } }
  | { event: "title_updated"; data: TitleUpdatedEventData };
```

`ChatInterface.handleSendMessage` consumes it with `for await … switch (evt.event)`. Adding a new event type is a one-line union extension; TS surfaces every consumer that doesn't handle it. Frame buffering, partial reads, malformed JSON, multi-line `data:` payloads, and comment lines (`: keepalive`) are all handled inside the parser. Unknown event names still come through at runtime (so a future server-side addition doesn't crash an older client) but aren't part of the static type — consumers should treat them as no-ops via `default` branch.

---

## 7. UnoCSS Limitations & Workarounds

### SVG Elements

**UnoCSS attributify does NOT work on `<svg>` elements.**

Use standard SVG attributes:

```tsx
// ❌ WRONG - Causes TypeScript errors
<svg w="16" h="16" m="auto">

// ✓ CORRECT
<svg width="16" height="16" style="margin: 0 auto;">
```

**Attributes to convert:**

- `w="..."` → `width="..."`
- `h="..."` → `height="..."`
- `m="..."` → `style="margin: ..."`
- `text="color"` → `style="color: ..."`
- `transform="..."` → Use inline style with dynamic values

**Event handlers:** Wrap reactive values in functions for SolidJS

```tsx
// ❌ WRONG
onClick={props.onToggle}

// ✓ CORRECT
onClick={() => props.onToggle()}
```

---

## Quick Commands

```bash
pnpm dev          # Start dev server (port 3444)
pnpm dev:exposed  # Bind to 0.0.0.0 (needed for Docker / Playwright MCP)
pnpm build        # Production build
pnpm eslint       # Run linter
pnpm test:run     # Run vitest unit tests
```

---

## File Locations Cheatsheet

```
app/
├── eslint.config.ts              # ESLint rules
├── uno.config.ts                 # UnoCSS config + theme
├── baml_src/                     # BAML function definitions
│   ├── clients.baml              # LLM client config + fallback chains
│   ├── local-client.baml         # Local GLM-4.7 client (manual wiring)
│   ├── router.baml               # Router (intent classification)
│   ├── simpleLoop.baml           # Generic LoopController (used by every simpleLoop route)
│   ├── actorCritic.baml          # ActorController + Critic (used by guardrailed/ontology agents)
│   ├── compactExecution.baml          # Final response synthesis
│   ├── describe.baml             # Lightweight tool-result summarization
│   ├── title.baml                # Conversation title generation
│   ├── with-references.baml      # Reference selector for withReferences
│   ├── types.baml                # Shared schema types
│   └── generators.baml           # baml-generate output config
├── src/
│   ├── shims.d.ts                # TypeScript augmentation
│   ├── routes/
│   │   ├── index.tsx             # Main page with Splitter layout
│   │   └── dashboard.tsx         # Metrics dashboard (#132): tokens, cache, costs
│   ├── components/
│   │   ├── AuthProvider.tsx      # Auth context provider
│   │   ├── Nav.tsx               # Top bar: metrics link, theme switcher, user menu
│   │   └── ark-ui/
│   │       ├── UserMenu.tsx           # Avatar dropdown menu
│   │       ├── ThemeSwitcher.tsx      # Dark/light theme toggle
│   │       ├── ChatInterface.tsx      # Main chat container
│   │       ├── ChatSidebar.tsx        # Thread history sidebar
│   │       ├── ChatMessages.tsx       # Message display area
│   │       ├── ChatInput.tsx          # Autoresize textarea
│   │       ├── GraphVisualization.tsx # Cytoscape graph display (+ extraStyles prop)
│   │       ├── SupportPanel.tsx       # Tabbed right panel (lazyMount + unmountOnExit)
│   │       ├── AllGraphTab.tsx        # Turn-based graph explorer (FloatingPanel + color-coded)
│   │       ├── SettingsPanel.tsx      # Harness settings FloatingPanel (sliders, number inputs)
│   │       ├── ObservabilityPanel.tsx # Event timeline + tool-pair merging + Save button
│   │       ├── observability/         # Panel internals: SummaryBar, TimelineRows, EventDetail, LLMCallTabs, PromptView
│   │       ├── EventDetailOverlay.tsx # Event detail modal
│   │       ├── ToolCallDisplay.tsx    # Tool call status display (approval gate)
│   │       ├── AgentSelector.tsx      # Agent selection dropdown
│   │       └── EnvVarManager.tsx      # Environment variable config
│   └── lib/
│       ├── auth/                  # Authentication
│       │   ├── client.ts          # StackClientApp
│       │   ├── server.ts          # Server auth helpers (getAuthenticatedUser, dev-bypass)
│       │   └── allowList.ts       # Email access control
│       ├── db/                    # Postgres-backed persistence
│       │   ├── client.server.ts        # Lazy pg.Pool singleton + idempotent schema bootstrap
│       │   └── conversations.server.ts # Conversations repo (load/save/list/delete + deriveTitle)
│       ├── harness-patterns/      # Composable agent pattern framework
│       │   ├── index.ts           # Public exports
│       │   ├── types.ts           # UnifiedContext, PatternScope, ContextEvent, callId, etc.
│       │   ├── context.server.ts  # createContext(), createEvent(), generateId()
│       │   ├── tools.server.ts    # Tools() — MCP tool grouping by namespace
│       │   ├── router.server.ts   # router() pattern
│       │   ├── harness.server.ts  # harness(), resumeHarness(), continueSession()
│       │   ├── routing.server.ts  # BAML router integration
│       │   ├── state.server.ts    # Session state (serialize / deserialize)
│       │   ├── mcp-client.server.ts # callTool(), listTools()
│       │   ├── assert.server.ts   # Server-only import guards
│       │   ├── token-budget.server.ts # trimToFit(), getContextWindow(), estimateTokens()
│       │   ├── compactBulkData.server.ts    # compactBulkData() — background result summarization
│       │   └── patterns/
│       │       ├── simpleLoop.server.ts   # ReAct loop + callId (+ batchId on multi-call turns) on tool events
│       │       ├── actorCritic.server.ts  # Generate-evaluate + callId (+ batchId)
│       │       ├── parallel.server.ts     # Concurrent branches + pattern_enter/exit
│       │       ├── guardrail.server.ts    # Rail validation + pattern_enter/exit
│       │       ├── hook.server.ts         # Lifecycle hook + pattern_enter/exit
│       │       ├── compactExecution.server.ts  # Final response synthesis
│       │       ├── chain.server.ts        # Sequential composition
│       │       └── event-view.server.ts   # EventViewImpl (fluent query API)
│       ├── settings.ts             # HarnessSettings type, defaults, MODEL_CONTEXT_WINDOWS
│       ├── settings-store.ts      # Client-side reactive store (localStorage persistence)
│       ├── settings-context.server.ts # Request-scoped settings via AsyncLocalStorage
│       ├── turn-utils.ts           # splitIntoTurns(), extractTurnGraphElements()
│       ├── turn-colors.ts         # TURN_COLORS palette, getTurnColor()
│       ├── observability/         # Pure event-stream projections behind the timeline
│       │   ├── projection.ts      # buildTimelineItems(), getEventPreview(), getEventLane()
│       │   ├── prompt-parse.ts    # parsePromptBody(), flattenContent(), formatParamValue()
│       │   ├── token-totals.ts    # foldTokenTotals(), fmtTok(), fmtEur()
│       │   └── event-styles.ts    # eventIcons/eventColors tables, getPatternColor()
│       ├── neo4j/
│       │   ├── queries.ts         # runManualCypher() (read-only), getNodeProperties()
│       │   └── graph-edit.server.ts # createGraphNode()/linkGraphNodes()/setGraphNodeProperty() — authenticated, intent-shaped graph writes
│       └── harness-client/        # Pre-built agent server actions
│           ├── actions.server.ts  # processMessage(), approveAction(), listConversations(), loadConversation()
│           ├── turn.server.ts     # runTurnAndPersist() — the one run-a-turn-and-persist flow (interactive | triggered | approval)
│           ├── action-runner.server.ts # seedActionRow() + runAgentInBackground() — triggered runs, off the request path
│           ├── session.server.ts  # In-process pattern cache + Postgres-backed serialized context (per-user)
│           ├── registry.server.ts # Agent registry (6 examples)
│           ├── graph-extractor.ts # ContextEvent → GraphElement[]
│           ├── neo4j-enricher.server.ts # onToolResult recipe (1-hop neighborhood + touched tags)
│           ├── types.ts           # GraphElement, HarnessData, etc.
│           └── agents/            # 6 pre-built agent configurations
```

---

## MCP Tools Available

### Context7

- `resolve-library-id` - Search for library documentation
- `get-library-docs` - Fetch up-to-date docs for a library

**Example:**

```typescript
// 1. Find library ID
const results = await resolveLibraryId({ libraryName: "solidjs" });
// → Returns: /solidjs/solid, /solidjs/solid-start, etc.

// 2. Get documentation
const docs = await getLibraryDocs({
  context7CompatibleLibraryID: "/solidjs/solid",
  topic: "signals and reactivity",
  tokens: 3000,
});
```

### Ark UI

- `list_components` - List all available Ark UI components
- `get_component_props` - Get props for a specific component
- `list_examples` - List examples for a component
- `get_example` - Get specific example code
- `styling_guide` - Get data attributes for styling

**Frameworks:** ~~react, vue, svelte,~~ _solid_
