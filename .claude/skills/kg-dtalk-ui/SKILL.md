---
name: kg-dtalk-ui
description: House styleguide for this repo's SolidStart + Ark UI + UnoCSS-attributify interface. Use before writing or reviewing any .tsx under app/src — carries the attributify-only rule and its exceptions, the four house recipes, the role-to-colour mapping, the icon set, and pointers to the accessibility and network-graph checklists.
---

<!-- Derivative work. Mostly ours; the accessibility checklist and the
     network-graph guidance are adapted from nextlevelbuilder/ui-ux-pro-max-skill
     (MIT © 2024 Next Level Builder). Pin + adaptations:
     .claude/skills/PROVENANCE.md · full licence: .claude/skills/NOTICE.md -->

# kg-dtalk-ui — house styleguide

The UI is `app/` — SolidStart routes and components, Ark UI headless primitives,
UnoCSS with attributify mode, Cytoscape.js for graphs.

**This skill is recipes and rules. It is not a token cache.** The token list —
every `ui-*` role, and the fixed `neon-*` / `cyber-*` / `dark-*` values behind
the graph palettes — lives in
[`app/uno.config.ts`](../../../app/uno.config.ts) under `theme.colors` and its
first preflight, and that file is the only place it is written down. Read it when you need a value.
Restating it here would be a cache of a one-file lookup, and it would go stale.

Two reference files carry the long checklists:

- [`A11Y-CHECKLIST.md`](A11Y-CHECKLIST.md) — accessibility and interaction rules,
  each rewritten in this stack's syntax. Read it when building or reviewing an
  interactive surface.
- [`GRAPH-VIZ.md`](GRAPH-VIZ.md) — Cytoscape / network-graph rules: render
  thresholds, the adjacency table as the accessible source of truth, the
  keyboard contract that replaces drag.

---

## 1. Attributify only

Every utility goes in an attribute. Never `class=`.

```tsx
<div flex="~ col" gap="2" p="4" bg="ui-bg-secondary" text="sm ui-text-secondary">
```

### The three exceptions, and nothing else

1. **Icon glyphs.** `presetIcons` emits a class, not an attribute:
   `<span class="i-material-symbols-database-outline" />`. There is no
   attributify form; this one is structural.
2. **Preflight classes.** `uno.config.ts` defines real CSS classes in its
   `preflights` block — `prose-chat`, `graph-entity`, `doc-ref`, `doc-ref-mark`,
   `doc-ref-chip`, `doc-ref-footer`, `think-root`/`-trigger`/`-preview`/
   `-content`/`-body`, `thread-flash-done`/`-error`,
   `progress-indeterminate`, `cold-start-spin`, `agent-glyph`. These are
   hand-written CSS, not utilities. Use them by name with `class=`.
3. **Strings crossing the HTML sanitiser.** `ChatMessages.tsx` builds markup as
   a string for sanitised chat HTML; those carry preflight class names by
   necessity. Do not introduce new ones without a preflight rule to back them.

Anything else in a `class=` is a violation, and the fix is mechanical. Measured
on this branch, the live violations are `Counter.tsx`, `AgentSelector.tsx:99`,
`ChatSidebar.tsx:939`, `ChatInput.tsx:59` and `LiveProgressBar.tsx:164`.
(`AuthProvider.tsx` and `routes/auth/*` were on that list until #226 B8;
`src/__tests__/routes/auth-pages.test.tsx` now keeps them off it.) Migrating
the rest is not this skill's job — not writing new ones is.

### Three traps, verified against this config

| Trap                                                                                                                                                                                                   | Wrong                                             | Right                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- | ----------------------------------------- |
| `color` is a real HTML attribute and collides with attributify                                                                                                                                         | `color="cyan-400"`                                | fold it into `text`: `text="xs cyan-400"` |
| `opacity` does **not** resolve as an attributify attribute; the short alias does                                                                                                                       | `opacity="0 group-hover:100"` → emits **nothing** | `op="0 group-hover:100"`                  |
| A valueless shortcut works on an intrinsic element but **not** on a component — the JSX transformer only rewrites the former, so Solid renders the boolean as `="true"` and `[cyber-button=""]` misses | `<A cyber-button>` → unstyled link                | `<A cyber-button="">`                     |
| Shortcuts work as **valueless** attributes — this is what makes recipe R1 below possible                                                                                                               | `class="cyber-button"`                            | `<button cyber-button p="2">`             |

The `opacity` one is the expensive kind of bug: no error, no CSS, an element
that is simply always visible. If a utility silently emits nothing, try the
short alias before assuming the value is wrong.

### `.ts` files are not scanned by default

UnoCSS only extracts from `[jt]sx` and friends. Agent icon classes live as
string literals in `src/lib/harness-client/agents/*.server.ts`, so those files
need **both** halves of the escape hatch: the `content.filesystem` glob in
`uno.config.ts` **and** a literal `@unocss-include` comment in the file. Adding
a new agent with an icon means adding that comment; the top of `uno.config.ts`
explains why both are required.

---

## 2. One themed palette, and a fixed one for data

There are two colour families in `uno.config.ts` and the difference between
them is the whole theming story:

| Family                                                                        | Shape         | Theme-aware?                            |
| ----------------------------------------------------------------------------- | ------------- | --------------------------------------- |
| `ui-bg-*`, `ui-text-*`, `ui-border-*`, `ui-accent`, `ui-danger`, `ui-success` | `var(--ui-…)` | **yes** — this is the interface palette |
| `dark-bg-*`, `dark-text-*`, `dark-border-*`, `neon-*`, `cyber-*`              | fixed hexes   | **no** — the same colour in either mode |

**Write `ui-*`.** The fixed family is not a second option for chrome; what is
left of it is _data_ colour — the Cytoscape node/edge styles, the per-turn and
per-agent graph palettes in `lib/turn-colors.ts` and `lib/agent-palette.ts`,
xterm's terminal theme. None of those can read a CSS variable, which is the
only reason they are still hexes. `cyber-{600,700,800}` (indigo) is the one
chrome exception, kept fixed because it reads on both grounds.

`ui-*` names the same roles the `dark-*` family did, and its dark values are
those hexes byte for byte (`ui-accent` = `neon-cyan`, `ui-success` =
`neon-green`). That is what made the app-wide migration a rename with no
visual change in dark. `src/__tests__/lib/uno-theme.test.ts` asserts the
equality per token; `src/__tests__/lib/theme-migration.test.ts` fails if a
`dark-*` or `neon-cyan`/`neon-green` token reappears under `src/components`
or `src/routes`.

### How the switch works (#226 B8)

1. `uno.config.ts`'s **first preflight** declares every `--ui-*` variable on
   `:root` (dark) and redefines it on `:root.light`. That is the entire
   palette; nothing else in the pipeline knows about themes.
2. `src/lib/theme.ts` owns which class `<html>` carries. It applies **both**
   `dark` (UnoCSS's own dark-variant hook) and `light` (what the override keys
   off). `light` is a positive marker on purpose: a document with neither
   class — the server-rendered one — is dark, so there is no flash.
3. `THEME_BOOT_SCRIPT` from the same module is inlined in the head by
   `entry-server.tsx` and resolves the theme before first paint.
4. `ThemeSwitcher` in `Nav` is the only writer of `localStorage.theme`.

**Choice and theme are different things.** The switcher offers three settings
— `light`, `dark`, `system` — and `system` is the default and what an absent
key means. It follows `prefers-color-scheme` live, through a `matchMedia`
listener that exists _only_ while `system` is selected; an explicit
`light`/`dark` is stored and ignores the OS. Only those two strings are ever
written, so picking `system` back removes the key rather than storing a third
value.

### Hand-written CSS reaches the palette too

The second preflight (`.prose-chat`, `.think-*`, `.graph-entity`,
`.agent-glyph`) is CSS, not utilities, so it cannot carry a token as an
attribute — it uses `var(--ui-…)` directly. Two token groups exist for it and
have no utility form: `--ui-accent-{soft,glow,strong,line}` (tints of the
accent) and `--ui-overlay-{wash,raise,line,hairline,sunken}` (neutral washes,
white-on-dark and **black**-on-light — that inversion is why they are
variables). An inline `style={{}}` can use them as well, and does where a
component sets colour imperatively.

### Still do not write `dark:` variants

The rule that produced the old "dark only" advice survives, for the same
reason: a per-component light branch doubles the surface of every recipe.
**Flip the token, not the component.** If a colour needs to differ between
modes, it needs a `ui-*` token — add the variable to both blocks of the
palette preflight, not a `dark:` utility to the component.

Practical consequence for contrast: a `ui-*` surface has to clear 4.5:1 in
**both** palettes — that is why `ui-accent` is `#0e7490` in light rather than
`#00ffff`. A colour written as a literal is only ever checked against the dark
ground, which is the failure this palette exists to prevent.

**Not on the theme yet**, and each is a visible seam in light mode: the
Cytoscape canvas, `UserMenu`'s dropdown (white in both modes), the retriever
citation chips (`.doc-ref*`) and the sidebar completion-flash keyframes.

---

## 3. Icons: material-symbols

**`material-symbols` and `material-symbols-light` are the icon set.** They are
the only two collections registered in `presetIcons` in `uno.config.ts`.

```tsx
<span
  class="i-material-symbols-database-outline"
  w="5"
  h="5"
  text="ui-accent"
  aria-hidden="true"
/>
```

- **mdi is gone.** `@iconify-json/mdi` was dropped from `package.json` and
  every `i-mdi-*` reference in `src/` was migrated to this set (#226 B6). mdi is
  not a registered collection, so an `i-mdi-*` emits no CSS and renders as an
  empty span — treat any that reappears as a live bug, not as precedent.
- Browse names at [icones.js.org](https://icones.js.org), filtered to
  `material-symbols`.
- Size and colour the glyph with attributify (`w="5" h="5" text="ui-accent"`),
  not with an inline `style` object. Inline `style` on an icon is only correct
  when the colour is genuinely dynamic — see §4.

Decorative glyphs sitting next to visible text take `aria-hidden="true"`. An
icon that is the button's only content means the **button** needs an
`aria-label` — see `A11Y-CHECKLIST.md`.

---

## 4. Colour: token before hex

**If a value has a token, use the token** — and since #226 B8's follow-up that
matters more than it used to: a literal cannot flip with the theme, so a hex
where a `ui-*` role exists is a light-mode bug waiting to be filed, not a style
nit. The app-wide sweep already replaced the palette hexes that were reachable;
what is left, and the reason each survives:

| Hex       | Uses | Where, and why it is still a literal                                        |
| --------- | ---- | --------------------------------------------------------------------------- |
| `#22d3ee` | 17   | citation chips + Data Stash accents — **no token yet**, see the table below |
| `#00ffff` | 11   | Cytoscape node/edge styles — the canvas cannot read `var()`                 |
| `#f59e0b` | 10   | warning role — **no token yet**                                             |
| `#52525b` | 10   | disabled/grayed affordances — **no token yet**                              |
| `#ff00ff` | 7    | `neon-magenta`, graph data colour                                           |
| `#4f46e5` | 7    | `cyber-600`, and indigo is fixed on purpose                                 |
| `#0a0a0f` | 5    | Cytoscape label backgrounds, xterm's theme                                  |

Counts are literal occurrences (`grep -rhoE '#[0-9a-fA-F]{6}' src`), tests and
comments included — re-run it rather than trusting the number.

**The two legitimate reasons to write a hex inline** are a value the build
cannot see — a per-row accent resolved at runtime — and a consumer that does
not parse CSS at all (Cytoscape's style object, xterm's `theme`). Everywhere
else, an inline `style` can hold `var(--ui-text-secondary)` just as easily as
a hex, and several components now do. `src/lib/agent-palette.ts` documents
this deliberately — its values are applied through inline `style` or a CSS
custom property (`--agent-accent`) precisely because a dynamic utility class
would never be extracted. That module is the pattern to copy for anything
per-entity; do not invent a second one.

### Role → token — **PROPOSAL, not yet confirmed**

> ⚠️ **This table is a proposal awaiting one-time confirmation from the repo
> owner.** It was derived by measuring which hex is spent on which role across
> `app/src`; it is not derivable from `uno.config.ts`. #226 B8 and its follow-up
> have since added three of these roles as theme-aware tokens — `ui-accent`
> (the brand cyan), `ui-danger` (error) and `ui-success` — because the themed
> surfaces needed them. **The rest of the table still has no token, and every
> one of them is a hex that does not flip in light mode.** Until it is confirmed, treat it as
> documentation of current practice, not as a rule to enforce — and do not add
> tokens to `uno.config.ts` on its authority.

| Role                            | Hex in use | Uses | Where it is spent                                                                | Proposed token  |
| ------------------------------- | ---------- | ---- | -------------------------------------------------------------------------------- | --------------- |
| citation / retrieval / live run | `#22d3ee`  | 18   | `doc-ref*` chips, Data Stash tab, live-run rail dot, selected row, `tool_result` | `info` / `cite` |
| warning / pending / degraded    | `#f59e0b`  | 11   | shell "connecting", non-error alert messages, Redis chips, Stats tab             | `warning`       |
| error                           | `#ef4444`  | 7    | error events, failed tool calls, shell "closed", destructive confirm             | `error`         |
| success / connected / approved  | `#10b981`  | 6    | shell "connected", approval responses, Terminal tab                              | `success`       |
| assistant output / filesystem   | `#34d399`  | 5    | assistant messages, filesystem tools                                             | `success-alt`   |
| user input                      | `#60a5fa`  | 4    | user messages, web/search tools, `blue` agent family                             | `user`          |
| system / tool call / memory     | `#a78bfa`  | 5    | system events, `tool_call`, memory tools, `violet` agent family                  | `system`        |

Two collisions the confirmation has to settle, because a naive mapping breaks
something real:

1. **Two cyans, two jobs.** `neon-cyan` (`#00ffff`) is the _brand_ accent — graph
   entities, prose links, LLM chips. `#22d3ee` (cyan-400) is _retrieval and run
   status_. They are not interchangeable and merging them would erase the
   distinction between "this is ours" and "this is a citation".
2. **Three greens, and status colours are reserved.** Green is spent three ways
   — `#10b981` (connected/approved), `#34d399` (assistant output), `#4ade80`
   (the completion flash). Cutting that to one token is probably right, but
   `agent-palette.ts` **reserves** `#22d3ee` / `#4ade80` / `#f87171` for run
   status specifically so status stays readable on top of agent identity. So
   whatever `success` becomes, it must not also be assignable to an agent
   family — the reservation comment in that file is the authority.

---

## 5. The four house recipes

Derived from the actual duplication in `app/src`. Each is what the codebase
already converged on; the job of writing them down is to stop the next
component re-deriving it slightly differently.

### R1 — Primary button: **use the `cyber-button` shortcut**

`uno.config.ts` defines it and **nothing uses it**, while
`ChatSidebar.tsx:1000-1010` hand-copies its declaration list verbatim and
`ChatInterface.tsx:713-719` copies it minus the glow. That is the exact shape a
shortcut exists to prevent.

```tsx
<button cyber-button p="2" text="sm">
  + New Chat
</button>
```

Valueless attributify resolves shortcuts — verified against this config, the
attribute `cyber-button` matches and emits the full rule set. Add only what
genuinely differs (padding, text size, `flex="1"`); do **not** restate
`bg="cyber-700 hover:cyber-600"`, `text="white"`, `font="medium"`,
`rounded="md"`, `transition="all"` or the hover glow — the shortcut is those.

If a variant needs a different glow or colour, change the shortcut or add a
sibling shortcut in `uno.config.ts`. Do not fork it inline.

`glass-panel` and `neon-border` are in the same state — defined, unused. Same
rule: reach for them before hand-rolling a blurred panel or a glowing border.

### R2 — Panel header chrome

Thirty header rows share this. It is the strip at the top of every panel:
title on the left, controls on the right, one hairline under it.

```tsx
<div
  flex="~"
  items="center"
  justify="between"
  p="2 3"
  bg="ui-bg-tertiary"
  border="b ui-border-primary"
>
  <div flex="~" items="center" gap="2">
    <span
      class="i-material-symbols-terminal"
      w="4"
      h="4"
      text="ui-accent"
      aria-hidden="true"
    />
    <span text="xs ui-text-secondary">…title…</span>
  </div>
  <div flex="~" items="center" gap="1">
    {/* controls */}
  </div>
</div>
```

- `p="4"` instead of `p="2 3"` for a full-width page-level header
  (`observability/EventDetail.tsx`, the drill-down overlays); `p="2 3"` for a
  panel strip.
- `bg="ui-bg-tertiary"` when the header must separate from a
  `ui-bg-secondary` body; omit `bg` when the panel is already tertiary.
- The bottom hairline is always `border="b ui-border-primary"`. Never a
  hand-written `rgba(255,255,255,0.06)` — white-at-low-alpha lightens a dark
  surface and does nothing at all to a white one. Even the preflight CSS uses
  `var(--ui-overlay-line)` for it now.

### R3 — Icon button

Eighteen ghost buttons share the transparent/hover-fill pattern.

```tsx
<button
  onClick={…}
  title="New chat"
  aria-label="New chat"
  w="8" h="8" flex="~" items="center" justify="center"
  bg="transparent hover:ui-bg-hover"
  border="1 ui-border-secondary"
  rounded="md"
  transition="all"
>
  <span class="i-material-symbols-add-2" w="4" h="4" aria-hidden="true" />
</button>
```

Three non-negotiables, all of them accessibility:

- **`aria-label` is required** when the button's only content is a glyph.
  `title` alone is not an accessible name for every assistive technology, and
  measured on this branch only 6 of 60 buttons carry one.
- **`aria-hidden="true"` on the glyph**, so the label is not read twice.
- **Size with `w`/`h`, not inline `style`.** `ChatSidebar.tsx:702` sets a 32×32
  box through a `style` object; `w="8" h="8"` is the same box and stays in the
  attributify pipeline.

Use `cyber-button` instead when the button is the primary action in its region;
this recipe is for secondary and tertiary affordances.

### R4 — Chip

The small monospace label that tags a value with a role — `LLM`, a tool
namespace, a document reference.

```tsx
<span
  text="xs ui-accent"
  bg="ui-accent/10"
  p="x-1.5 y-0.5"
  rounded="sm"
  font="mono"
>
  LLM
</span>
```

The shape is fixed — `x-1.5 y-0.5`, `rounded="sm"`, `font="mono"`, `text="xs"`
— and **only the hue varies**, always as the `/10` tint of the same colour used
for the text. In use today: `ui-accent`, `ui-success`, `neon-orange`,
`neon-magenta`, `red-500`. A chip whose text colour and background tint
disagree is a bug, and one whose hue is a `neon-*` will be unreadable in light
mode — reach for a `ui-*` role first.

The chat-message equivalent is the `doc-ref-chip` preflight class; do not
re-implement it in attributify, and do not use this recipe inside sanitised
chat HTML.

---

## 6. Links open in a new tab

**Standing rule (owner decision, 2026-08-24): every link in the app opens in a
new tab. The app must never navigate away to follow a link.**

Both halves, always:

```tsx
<a href={url} target="_blank" rel="noopener noreferrer">
```

`rel` is not decoration. `target="_blank"` on its own hands the opened page a
live `window.opener` back into the app, and a good share of these hrefs come out
of model output.

Links produced from **data** rather than written by hand are already covered:
the DOMPurify hook in [`app/src/lib/sanitize-html.ts`](../../../app/src/lib/sanitize-html.ts)
stamps `target`/`rel` on every anchor in rendered assistant markdown. That is
also why both attributes are deliberately absent from that file's
`ALLOWED_ATTR` — a `target` written by the model is stripped first, so only the
hook's own value can reach the DOM. Do not add a second markdown or `innerHTML`
path that bypasses it — the gate below enforces that rather than only stating it,
because a second path costs more than a link in the wrong tab: it renders model
text with no sanitizer in front of it at all.

What is **not** a link under this rule:

| Stays in-tab                                                                                               | Why                                                                                     |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Router navigation — `<A>`, `navigate()`, and the same-origin plain `<a href="/…">` solid-router intercepts | In-app navigation between the app's own routes; not a link                              |
| The app's own auth endpoints (`/api/auth/login`, `/api/auth/logout`)                                       | The OAuth callback and the sign-out both have to land in the tab the user is looking at |
| Programmatic download anchors (`a.download = …`)                                                           | They hand the browser a file; they never navigate the current tab                       |

The **enforcement of record** for the data half is that hook. It runs on the
node, so it holds for hrefs nobody anticipated; three independent review rounds
attacked it from model output and none got a link through.

`app/src/__tests__/links-new-tab.test.ts` covers the hand-written half, and it
is a **lint, not a proof**. It reads `src/` as text, so it catches the literal
shapes it has been taught — JSX anchors, `document.createElement('a')` /
`createElementNS`, `location.href`/`assign`/`replace`, a whole-object
`location =` qualified by `window`/`self`/`top`/`parent`/`globalThis`/`document`,
`window.open`, and an enumerated set of markup sinks (`innerHTML`/`outerHTML`
write or append, `insertAdjacentHTML`, `document.write`/`writeln`,
`createContextualFragment`, `parseFromString`, `setHTMLUnsafe`, `marked`) —
that neither open a new tab nor hold a documented exception in its `ALLOWLIST`.
A new in-tab case means adding an entry there with a written reason; there is
nowhere else to put it.

**A green run means no _known_ shape is unguarded. It does not mean no link in
the app opens in-tab.** Anything reached by indirection (a tag, a sink or a
`location` held in a variable or a computed property), an anchor obtained by
query rather than created, anything rendered through a component boundary, a
markup sink outside that enumeration, and the non-link ways off the page
(`<form action="https://…">`, `navigate()` given an external URL) all pass it.
The families are written out in that file's header, which is the authority —
three review rounds each found more shapes inside the set an earlier version of
it claimed, so treat the list as maintained rather than complete. If you need
one of those, the gate will not stop you and neither will it cover you.

---

## 7. What this skill does not do

- It does not restate tokens. `app/uno.config.ts` owns them.
- It does not migrate existing code. The hex-instead-of-token sites and the
  `class=` violations named above are recorded as _evidence for the rules_, not
  as a work list this skill executes.
- It does not add tokens. The role table in §4 is a proposal; adding
  `theme.colors` entries needs the confirmation first.
- It does not cover native mobile or any surface outside `app/src`. It does
  cover the light palette (§2), but only the mechanism — retheming the
  unmigrated screens is not this skill's work list either.

Related repo documentation: [`docs/UI_ARCHITECTURE.md`](../../../docs/UI_ARCHITECTURE.md)
for component structure and data flow.
