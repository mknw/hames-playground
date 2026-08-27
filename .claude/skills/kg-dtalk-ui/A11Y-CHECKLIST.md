<!-- Adapted from nextlevelbuilder/ui-ux-pro-max-skill (MIT © 2024 Next Level Builder),
     .claude/skills/ui-ux-pro-max/references/quick-reference.md §1 "Accessibility"
     and §2 "Touch & Interaction". Rule IDs and conformance levels are upstream's;
     the guidance column is rewritten for this stack. Pin + adaptations:
     .claude/skills/PROVENANCE.md · full licence: .claude/skills/NOTICE.md -->

# Accessibility checklist

Upstream's rule IDs and WCAG conformance levels are preserved verbatim, so a
`git diff` against the pinned upstream file stays readable. What is rewritten is
the **how**: each rule states what it looks like in attributify syntax, in Ark
UI, or in this repo's components.

Read this before shipping an interactive surface, and when reviewing one.

Two measured gaps to hold in mind — both are why this file exists rather than
being assumed:

- **6 of 60 buttons** in `app/src/components` carry an `aria-label`. 39 carry a
  `title`, which is not a substitute.
- **2 focus styles** exist across the whole component tree
  (`ChatInput.tsx:81`, `GraphVisualization.tsx:807`).

---

## 1. Accessibility (CRITICAL)

| Rule                            | Level        | In this stack                                                                                                                                                                                                                                                       |
| ------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `color-contrast`                | WCAG AA      | 4.5:1 for body text, 3:1 for large. Check against the dark grounds `#0a0a0f` / `#12121a` / `#1a1a24`, never white. `dark-text-tertiary` (`#71717a`) fails on `dark-bg-primary` for body copy — it is a _muted label_ colour, not a text colour.                     |
| `focus-states`                  | Apple HIG/MD | Every interactive element gets a visible ring, 2–4px. The house form is `ring="2 transparent focus:neon-cyan/40"` (`ChatInput.tsx:81`) or `outline="none focus:border-neon-cyan/50"` when the border already frames the control. Never `outline="none"` on its own. |
| `alt-text`                      | WCAG A       | Meaningful `<img>` gets `alt`. Decorative gets `alt=""`.                                                                                                                                                                                                            |
| `aria-labels`                   | Apple HIG    | An icon-only `<button>` needs `aria-label`. See recipe R3 in `SKILL.md` — this is the single most-violated rule in the codebase.                                                                                                                                    |
| `icon-context`                  | —            | A glyph beside visible text is decorative: `aria-hidden="true"`. A glyph that _is_ the control needs the accessible name on the control. A glyph carrying state (run status, connection dot) needs a text alternative, not just a colour.                           |
| `keyboard-nav`                  | Apple HIG    | Tab order follows visual order. Anything with `onClick` on a non-button element needs `tabindex="0"`, `role`, and an Enter/Space handler — or should just be a `<button>`.                                                                                          |
| `form-labels`                   | WCAG A       | Use Ark UI's `Field`/`Label` parts, which wire `for`/`id` for you. A bare `<input placeholder="…">` has no label.                                                                                                                                                   |
| `skip-links`                    | WCAG A       | A skip-to-main link before the sidebar. Not present today; required for any new full-page route.                                                                                                                                                                    |
| `heading-hierarchy`             | WCAG A       | Sequential `h1`→`h6`, no skipped level. Do not pick a heading tag for its size — size is `text="lg"`.                                                                                                                                                               |
| `color-not-only`                | WCAG A       | Never carry meaning in hue alone. The run-status dots and the `#10b981`/`#f59e0b`/`#ef4444` shell states each need an adjacent word or glyph shape. `InteractiveTerminal.tsx:150` does this correctly; the sidebar rail dot does not.                               |
| `dynamic-type`                  | Apple/MD     | Respect browser text scaling: size in `rem`-based utilities (`text="xs"`, `p="2"`), not in fixed `px` inline styles. Do not clip growing text with a fixed `h`.                                                                                                     |
| `reduced-motion`                | Apple/MD     | Wrap animation in `@media (prefers-reduced-motion: reduce)`. The preflight CSS already does this for `thread-flash-*` and `progress-indeterminate` — copy that shape, and keep a motionless signal (border, dim fill) so the state is still communicated.           |
| `voiceover-sr`                  | Apple/MD     | Logical DOM reading order; meaningful names on controls. Ark UI parts carry the right roles — do not strip them.                                                                                                                                                    |
| `escape-routes`                 | Apple HIG    | Modals and multi-step flows need a cancel/back. Ark UI `Dialog` handles Escape; keep the visible close button too.                                                                                                                                                  |
| `keyboard-shortcuts`            | Apple HIG    | Do not shadow browser or AT shortcuts. Every drag action needs a keyboard alternative — see `GRAPH-VIZ.md`.                                                                                                                                                         |
| `focus-not-obscured`            | WCAG 2.2 AA  | The focused control must not be hidden by sticky UI. Relevant here: the sticky chat composer (`ChatInterface.tsx:650`) and the panel headers of recipe R2.                                                                                                          |
| `focus-not-obscured-enhanced`   | WCAG 2.2 AAA | The _entire_ focused component stays visible. Aspirational; note it, do not gate on it.                                                                                                                                                                             |
| `focus-appearance`              | WCAG 2.2 AAA | The focus indicator itself needs 3:1 contrast against both the control and the ground. `focus:neon-cyan/20` is too faint at 20% on `#0a0a0f` — prefer `/40` or higher for new work.                                                                                 |
| `dragging-alternative`          | WCAG 2.2 AA  | Every author-controlled drag needs a single-pointer and keyboard path. Applies to the graph canvas and to `i-mdi-drag` handles. See `GRAPH-VIZ.md`.                                                                                                                 |
| `web-target-size`               | WCAG 2.2 AA  | Pointer targets ≥ 24×24 CSS px, or a documented exception. `w="6" h="6"` is the floor; recipe R3's `w="8" h="8"` clears it comfortably. Watch the `p="x-2 y-0.5"` toolbar buttons.                                                                                  |
| `consistent-help`               | WCAG 2.2 A   | Repeated help affordances keep the same relative position across views.                                                                                                                                                                                             |
| `redundant-entry`               | WCAG 2.2 A   | Do not re-ask for information already given in the same flow.                                                                                                                                                                                                       |
| `accessible-authentication`     | WCAG 2.2 AA  | The sign-in route must allow paste and password managers, and must not require a cognitive test. Relevant to `routes/auth/signin.tsx` and the Entra flow.                                                                                                           |
| `auto-rotation-controls`        | WAI          | Moving content needs pause/stop and must stop on focus or under reduced motion.                                                                                                                                                                                     |
| `contextual-live-badge-updates` | —            | Announce a changed count or status as a complete phrase, without moving focus — one `aria-live="polite"` region, `aria-atomic` only where needed. Directly applicable to the streaming chat turn, the running-tool indicator and the sidebar completion badge.      |

## 2. Touch & Interaction (CRITICAL)

| Rule                    | In this stack                                                                                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `touch-target-size`     | 44×44pt / 48×48dp on touch; ≥24×24 CSS px is the web floor (see `web-target-size`). Extend the hit area with padding rather than growing the glyph.                    |
| `touch-spacing`         | ≥8px between adjacent targets — `gap="2"` in a control cluster, not `gap="1"`, wherever the cluster is reachable by touch.                                             |
| `hover-vs-tap`          | Primary actions fire on click/tap. Never hide a _necessary_ control behind hover. `ChatSidebar.tsx:939`'s hover-revealed row action needs a keyboard-focus reveal too. |
| `loading-buttons`       | Disable during async work and show progress. `ChatInterface.tsx:713` does this with a `disabled={promoting()}` + label swap — copy that shape.                         |
| `error-feedback`        | The message goes next to the problem, not only in a toast. Error styling is `#ef4444` **plus** a word or glyph (`color-not-only`).                                     |
| `cursor-pointer`        | `cursor="pointer"` on anything clickable that is not a `<button>`. The `graph-entity` and `doc-ref` preflight classes already set it.                                  |
| `press-feedback`        | Visible state change on press. The `hover:dark-bg-hover` fill of recipe R3 covers hover; add an `active:` state for anything that feels unresponsive.                  |
| `tap-delay`             | `touch-action: manipulation` on tap targets that need it.                                                                                                              |
| `gesture-alternative`   | No gesture-only path to a critical action — there is always a visible control.                                                                                         |
| `no-precision-required` | No pixel-perfect targets: thin edges, 1px handles, tiny glyphs without padding.                                                                                        |
| `drag-threshold`        | Require a small movement before a drag starts, so a click is not read as a drag.                                                                                       |

**Deferred — no touch/native surface today.** `gesture-conflicts`,
`standard-gestures`, `system-gestures`, `haptic-feedback`,
`safe-area-awareness`, `swipe-clarity`. This is a desktop web app; these rules
are kept by ID so the set still diffs cleanly against upstream, and become live
the day a mobile or native surface exists.
