import {
  defineConfig,
  presetAttributify,
  presetWebFonts,
  transformerAttributifyJsx,
  presetIcons,
} from 'unocss'
// import transformerAttributifyJsx from '@unocss/transformer-attributify-jsx'
import type { IconifyJSON } from '@iconify/types'
import presetWind4 from '@unocss/preset-wind4'
// import presetIcons from "@unocss/preset-icons";

export default defineConfig({
  // UnoCSS only extracts utilities from files its pipeline scans, and plain
  // `.ts` is NOT in the default include (only [jt]sx & friends). Agent icon
  // classes live as literals in the server-side agent registry, so those
  // files are added to extraction explicitly — without this, `i-*` classes
  // referenced from AgentConfig.icon silently emit no CSS.
  //
  // BOTH halves below are required (verified against @unocss/vite source):
  //  1. this `content.filesystem` glob makes the client build READ the files
  //     (they're never in the client module graph, being .server.ts), and
  //  2. each listed file carries a literal `@unocss-include` comment —
  //     filesystem-globbed files still pass through the pipeline filter,
  //     which rejects `.ts` paths unless that marker appears in the code.
  // Globs are relative to app/; entries are watched in dev.
  content: {
    filesystem: ['src/lib/harness-client/agents/*.server.ts'],
  },
  presets: [
    presetIcons({
      collections: {
        'material-symbols': () =>
          import('@iconify-json/material-symbols/icons.json').then((i) => i.default as IconifyJSON),
        'material-symbols-light': () =>
          import('@iconify-json/material-symbols-light/icons.json').then(
            (i) => i.default as IconifyJSON,
          ),
      },
    }),
    presetAttributify(),
    presetWind4(),
    presetWebFonts({
      /**
       * The default budget for this fetch is 2000ms (`@unocss/preset-web-fonts`,
       * `timeouts.failure`), and five Google families do not reliably arrive in
       * it. Missing it is not a cosmetic problem — it has two failure modes, and
       * the preset picks between them on `process.env.CI`:
       *
       *  - **CI unset**: the failure is SWALLOWED. The dev server boots with no
       *    `@font-face` at all and every glyph renders in the fallback stack, so
       *    all six of `e2e-browser/`'s committed screenshot baselines go red with
       *    a font-metrics diff (measured: 212px on the header strip, 429 on the
       *    sidebar, 8412 on the chat view) that looks exactly like a real visual
       *    regression and is caused by the network.
       *  - **CI set**: it THROWS, uncaught, and `vinxi dev` exits 1 before
       *    serving. `pnpm release:check` spawns every layer with `CI=1`, so its
       *    browser layer could not run at all.
       *
       * Measured 2026-08-27: at the 2s default the fetch failed on 5 consecutive
       * boots and the baseline was red on all five; at 30s it succeeded and the
       * baseline was green. Raising the budget removes the flake but not the
       * DEPENDENCY — layer 3 still needs fonts.googleapis.com on every boot,
       * which is the part `docs/testing/pyramid.md` calls hermetic. Self-hosting
       * these five families is the fix that makes that claim true; it is a bigger
       * change than this one and is not made here.
       */
      timeouts: { warning: 2000, failure: 30_000 },
      provider: 'google',
      fonts: {
        sans: 'Inter',
        serif: 'Roboto Slab',
        mono: 'Fira Code',
        lexend: 'Lexend Zetta:200',
        lexend_exa: 'Lexend Exa:200',
      },
    }),
  ],
  transformers: [
    transformerAttributifyJsx(), // <--
  ],
  theme: {
    colors: {
      // Futuristic dark theme palette
      cyber: {
        50: '#f0f4ff',
        100: '#e0e7ff',
        200: '#c7d7fe',
        300: '#a5b4fc',
        400: '#818cf8',
        500: '#6366f1',
        600: '#4f46e5',
        700: '#4338ca',
        800: '#3730a3',
        900: '#312e81',
        950: '#1e1b4b',
      },
      neon: {
        cyan: '#00ffff',
        magenta: '#ff00ff',
        green: '#39ff14',
        orange: '#ff6600',
        purple: '#9d00ff',
        blue: '#0080ff',
        pink: '#ff007f',
      },
      dark: {
        bg: {
          primary: '#0a0a0f',
          secondary: '#12121a',
          tertiary: '#1a1a24',
          hover: '#22222f',
        },
        border: {
          primary: '#2a2a3a',
          secondary: '#3a3a4a',
          accent: '#4a4a5a',
        },
        text: {
          primary: '#e4e4e7',
          secondary: '#a1a1aa',
          tertiary: '#71717a',
        },
      },
      // Theme-aware semantic palette (#226 B8). These are the SAME roles as
      // `dark.*` above, but each value is a CSS variable rather than a hex, so
      // the palette flips at the `:root` level (see the first preflight below)
      // and a component never needs a `dark:` / light branch of its own.
      //
      // The dark values of these variables are byte-identical to the `dark.*`
      // hexes, `ui-accent`'s is `neon-cyan` and `ui-success`'s is `neon-green`
      // — so migrating a component is a rename (`dark-bg-primary` →
      // `ui-bg-primary`) with no visual change at all in dark mode.
      // `uno-theme.test.ts` asserts that equality so it cannot silently drift.
      //
      // `dark.*` and the unmapped `neon.*` entries above are kept because the
      // graph canvas and the per-turn palettes still need fixed hexes: those
      // are data colours, not chrome, and Cytoscape reads values rather than
      // classes.
      ui: {
        bg: {
          primary: 'var(--ui-bg-primary)',
          secondary: 'var(--ui-bg-secondary)',
          tertiary: 'var(--ui-bg-tertiary)',
          hover: 'var(--ui-bg-hover)',
        },
        border: {
          primary: 'var(--ui-border-primary)',
          secondary: 'var(--ui-border-secondary)',
          accent: 'var(--ui-border-accent)',
        },
        text: {
          primary: 'var(--ui-text-primary)',
          secondary: 'var(--ui-text-secondary)',
          tertiary: 'var(--ui-text-tertiary)',
        },
        // Brand accent and the two status colours the themed surfaces need.
        accent: 'var(--ui-accent)',
        danger: 'var(--ui-danger)',
        success: 'var(--ui-success)',
      },
    },
  },
  shortcuts: {
    // Futuristic UI shortcuts
    'glass-panel': 'bg-ui-bg-secondary/50 backdrop-blur-lg border border-ui-border-primary',
    'neon-border': 'border-2 border-neon-cyan shadow-[0_0_10px_rgba(0,255,255,0.5)]',
    'cyber-button':
      'bg-cyber-700 hover:bg-cyber-600 text-white font-medium px-4 py-2 rounded-md transition-all duration-200 hover:shadow-[0_0_15px_rgba(79,70,229,0.5)]',
  },
  preflights: [
    // Theme palette (#226 B8). `<html>` carries `dark` (UnoCSS's own dark
    // variant hook) or `light`; nothing at all means dark, so a server-
    // rendered page paints dark before hydration and never flashes. The
    // `light` class is a POSITIVE marker for exactly that reason — keying
    // light off `:root:not(.dark)` would make the pre-hydration document
    // light. `:root.light` also outranks `:root` on specificity, so the
    // override wins wherever UnoCSS chooses to emit the two blocks.
    //
    // Everything under `--ui-*` is theme-aware; `cyber-*` (indigo) is left
    // fixed because it reads on both grounds, and the surviving `neon-*` /
    // `dark-*` hexes are graph-canvas data colours. A screen joins the theme
    // by moving to the `ui-*` tokens — no `dark:` variant, no light branch.
    //
    // The second preflight below is hand-written CSS rather than utilities,
    // so it cannot express a token as an attribute. It reaches the same
    // palette through `var(--ui-…)` directly, which is why the tint and
    // overlay variables exist: a literal `rgba(255,255,255,0.06)` lightens a
    // dark surface and does nothing at all to a white one.
    {
      getCSS: () => `
        /* The document's own ground. Nothing painted it before, so any gap
           a page left uncovered fell through to the browser's white — visible
           on the 404, and on overscroll. Dark is the app's ground either way,
           so this cannot change a surface that was already covered. */
        html {
          background-color: var(--ui-bg-primary);
        }
        :root {
          --ui-bg-primary: #0a0a0f;
          --ui-bg-secondary: #12121a;
          --ui-bg-tertiary: #1a1a24;
          --ui-bg-hover: #22222f;
          --ui-border-primary: #2a2a3a;
          --ui-border-secondary: #3a3a4a;
          --ui-border-accent: #4a4a5a;
          --ui-text-primary: #e4e4e7;
          --ui-text-secondary: #a1a1aa;
          --ui-text-tertiary: #71717a;
          --ui-accent: #00ffff;
          --ui-danger: #f87171;
          --ui-success: #39ff14;

          /* Tints of the accent. Written out per theme rather than mixed
             from --ui-accent at use time: these are the exact rgba() the
             hand-written CSS below carried as literals, so the dark render
             is unchanged to the byte. */
          --ui-accent-soft: rgba(0, 255, 255, 0.1);
          --ui-accent-glow: rgba(0, 255, 255, 0.15);
          --ui-accent-strong: rgba(0, 255, 255, 0.2);
          --ui-accent-line: rgba(0, 255, 255, 0.4);

          /* Neutral washes over whatever surface they sit on. In dark they
             lighten (white at low alpha); in light they have to darken, and
             that inversion is the whole reason they are variables. */
          --ui-overlay-wash: rgba(255, 255, 255, 0.03);
          --ui-overlay-raise: rgba(255, 255, 255, 0.06);
          --ui-overlay-line: rgba(255, 255, 255, 0.06);
          --ui-overlay-hairline: rgba(255, 255, 255, 0.05);
          --ui-overlay-sunken: rgba(0, 0, 0, 0.15);

          /* Code blocks sit *below* the message surface, which is why this
             is not the tertiary background — in dark it goes darker than the
             page ground rather than lighter. */
          --ui-code-bg: #0a0a0f;
        }
        :root.light {
          /* Contrast-checked against the light grounds below: every text
             token clears 4.5:1 on both #ffffff and #f5f6f8. Cyan and red
             are darkened because the neon versions are unreadable on white. */
          --ui-bg-primary: #f5f6f8;
          --ui-bg-secondary: #ffffff;
          --ui-bg-tertiary: #eceef2;
          --ui-bg-hover: #e2e5ea;
          --ui-border-primary: #d9dde4;
          --ui-border-secondary: #c3c9d2;
          --ui-border-accent: #a7aeba;
          --ui-text-primary: #14161a;
          --ui-text-secondary: #4a4f57;
          --ui-text-tertiary: #6b7079;
          --ui-accent: #0e7490;
          --ui-danger: #b91c1c;
          --ui-success: #15803d;

          --ui-accent-soft: rgba(14, 116, 144, 0.1);
          --ui-accent-glow: rgba(14, 116, 144, 0.15);
          --ui-accent-strong: rgba(14, 116, 144, 0.22);
          --ui-accent-line: rgba(14, 116, 144, 0.5);

          /* Black, not white: a wash has to darken a light surface to read
             as one. The alphas are a little higher than their dark twins
             because black-on-near-white separates less than white-on-black. */
          --ui-overlay-wash: rgba(0, 0, 0, 0.03);
          --ui-overlay-raise: rgba(0, 0, 0, 0.06);
          --ui-overlay-line: rgba(0, 0, 0, 0.09);
          --ui-overlay-hairline: rgba(0, 0, 0, 0.07);
          --ui-overlay-sunken: rgba(0, 0, 0, 0.04);

          --ui-code-bg: #f1f3f6;
          /* Native controls, scrollbars and form widgets follow the theme.
             Deliberately not declared on the dark default: the dark app is
             on the browser default today and this change keeps it there. */
          color-scheme: light;
        }
      `,
    },
    // Hand-written CSS classes: markdown rendering, chat affordances, the
    // sidebar animations. Listed as exceptions in the kg-dtalk-ui skill.
    {
      getCSS: () => `
        .prose-chat {
          line-height: 1.6;
          word-wrap: break-word;
        }
        .prose-chat p {
          margin: 0.5em 0;
        }
        .prose-chat p:first-child {
          margin-top: 0;
        }
        .prose-chat p:last-child {
          margin-bottom: 0;
        }
        .prose-chat code {
          background: var(--ui-accent-soft);
          padding: 0.2em 0.4em;
          border-radius: 4px;
          font-family: 'Fira Code', monospace;
          font-size: 0.9em;
        }
        .prose-chat pre {
          background: var(--ui-code-bg);
          padding: 1em;
          border-radius: 8px;
          overflow-x: auto;
          margin: 0.75em 0;
          border: 1px solid var(--ui-border-primary);
        }
        .prose-chat pre code {
          background: transparent;
          padding: 0;
          border-radius: 0;
        }
        .prose-chat ul, .prose-chat ol {
          margin: 0.5em 0;
          padding-left: 1.5em;
        }
        .prose-chat li {
          margin: 0.25em 0;
        }
        .prose-chat strong {
          color: var(--ui-accent);
          font-weight: 600;
        }
        .prose-chat em {
          font-style: italic;
        }
        .prose-chat a {
          color: var(--ui-accent);
          text-decoration: underline;
        }
        .prose-chat blockquote {
          border-left: 3px solid #4f46e5;
          padding-left: 1em;
          margin: 0.75em 0;
          color: var(--ui-text-secondary);
        }
        .prose-chat h1, .prose-chat h2, .prose-chat h3 {
          font-weight: 600;
          margin: 1em 0 0.5em;
        }
        .prose-chat h1 { font-size: 1.25em; }
        .prose-chat h2 { font-size: 1.15em; }
        .prose-chat h3 { font-size: 1.05em; }

        /* Thinking/reasoning collapsible */
        .think-root {
          margin: -12px -12px 8px -12px;
          border-bottom: 1px solid var(--ui-overlay-line);
          border-radius: 8px 8px 0 0;
          overflow: hidden;
        }
        .think-trigger {
          display: flex;
          align-items: center;
          gap: 6px;
          width: 100%;
          padding: 4px 8px;
          background: var(--ui-overlay-wash);
          cursor: pointer;
          font-size: 0.75rem;
          color: var(--ui-text-tertiary);
          border: none;
          text-align: left;
          transition: background 0.15s ease;
        }
        .think-trigger:hover {
          background: var(--ui-overlay-raise);
        }
        .think-preview {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .think-content {
          overflow: hidden;
          transition: max-height 0.25s ease, opacity 0.2s ease;
        }
        .think-content[data-state="open"] {
          max-height: 50vh;
          overflow-y: auto;
          opacity: 1;
        }
        .think-content[data-state="closed"] {
          max-height: 0;
          opacity: 0;
        }
        .think-body {
          padding: 8px 10px;
          background: var(--ui-overlay-sunken);
          border-top: 1px solid var(--ui-overlay-hairline);
          font-size: 0.8rem;
          opacity: 0.6;
        }

        /* Sidebar completion flash (#105) — a backgrounded run finishing
           pulses its thread row once, then decays to the static accent
           border applied by ChatSidebar. Duration is mirrored by
           COMPLETION_FLASH_MS in lib/run-registry.ts. */
        @keyframes thread-flash-done {
          0%   { background-color: rgba(74,222,128,0); }
          12%  { background-color: rgba(74,222,128,0.22); }
          100% { background-color: rgba(74,222,128,0); }
        }
        @keyframes thread-flash-error {
          0%   { background-color: rgba(248,113,113,0); }
          12%  { background-color: rgba(248,113,113,0.22); }
          100% { background-color: rgba(248,113,113,0); }
        }
        .thread-flash-done {
          animation: thread-flash-done 2.4s ease-out 1;
        }
        .thread-flash-error {
          animation: thread-flash-error 2.4s ease-out 1;
        }
        /* The border still marks completion — only the motion is dropped. */
        @media (prefers-reduced-motion: reduce) {
          .thread-flash-done, .thread-flash-error { animation: none; }
        }

        /* Agent accent glyph in expanded sidebar rows. Muted at rest so the
           title stays the row's anchor; the agent's family colour appears on
           row hover and stays lit while the row is selected. The colour is
           per-row, so it arrives as an inline --agent-accent custom property
           (a dynamic utility class would never be extracted) and only the
           rest/hover *states* live here. Falls back to the muted tone when
           the property is absent. The collapsed rail sets its colour inline
           instead — there the accent is always on.

           span-qualified: the icon utility on the same element carries
           color: inherit at the same (0,1,0) specificity, later in the
           sheet — an unqualified .agent-glyph loses the tie and the glyph
           inherits the document default (black; nothing above it sets a
           colour), invisible on the dark ground. */
        span.agent-glyph {
          color: var(--ui-text-tertiary);
          transition: color 0.15s ease;
        }
        .group:hover .agent-glyph,
        .agent-glyph[data-lit="true"] {
          color: var(--agent-accent, var(--ui-text-tertiary));
        }

        /* Sidebar mini progress strip, indeterminate mode (#105) — shown
           between run start and the chain projection seed arriving. A 40%-
           wide segment sweeps the 3px track (RowProgress in ChatSidebar). */
        @keyframes thread-progress-slide {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(250%); }
        }
        .thread-progress-indeterminate {
          animation: thread-progress-slide 1.2s ease-in-out infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          /* Motionless fallback: a dim full-width fill still signals "running". */
          .thread-progress-indeterminate {
            animation: none;
            width: 100% !important;
            opacity: 0.35;
          }
        }

        /* Cold-start spinner (D-c) — the chat's notice that a turn is waiting
           on the self-hosted box to start. Hand-written rather than
           an animate= utility, for the reduced-motion branch below, which
           attributify has nowhere to put. */
        @keyframes cold-start-spin {
          to { transform: rotate(360deg); }
        }
        .cold-start-spin {
          animation: cold-start-spin 1.4s linear infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          /* Motionless fallback: the glyph stays, and the state was never
             carried by its rotation — the headline and the counting-down
             estimate beside it say what is happening in words. */
          .cold-start-spin { animation: none; }
        }

        /* Graph entity interactive spans in chat messages */
        .graph-entity {
          cursor: pointer;
          border-bottom: 1px dashed var(--ui-accent-line);
          transition: all 0.15s ease;
          border-radius: 2px;
          padding: 0 2px;
        }
        .graph-entity:hover {
          background: var(--ui-accent-glow);
          border-bottom-color: var(--ui-accent);
          color: var(--ui-accent);
        }
        .graph-entity.toggled {
          background: var(--ui-accent-strong);
          border-bottom: 1px solid var(--ui-accent);
          color: var(--ui-accent);
        }
        /* Retriever citations: inline filename superscript + sources footer */
        .doc-ref {
          cursor: pointer;
          border-bottom: 1px dashed rgba(34,211,238,0.5);
          border-radius: 2px;
          transition: all 0.15s ease;
        }
        .doc-ref:hover {
          background: rgba(34,211,238,0.15);
          border-bottom-color: #22d3ee;
        }
        .doc-ref-mark {
          font-size: 0.7em;
          color: #22d3ee;
          margin-left: 1px;
          vertical-align: super;
          line-height: 0;
        }
        .doc-ref-footer {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 6px;
          margin-top: 8px;
          padding-top: 6px;
          border-top: 1px solid rgba(255,255,255,0.06);
        }
        .doc-ref-chip {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          font-family: "Fira Code", ui-monospace, monospace;
          font-size: 10px;
          color: #7dd3fc;
          background: rgba(34,211,238,0.08);
          border: 1px solid rgba(34,211,238,0.25);
          border-radius: 5px;
          padding: 1px 7px;
          cursor: pointer;
          transition: all 0.15s ease;
        }
        .doc-ref-chip:hover {
          background: rgba(34,211,238,0.18);
          border-color: #22d3ee;
          color: #e0f2fe;
        }
      `,
    },
  ],
})
