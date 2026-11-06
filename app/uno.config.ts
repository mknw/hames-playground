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
  // The agents moved to @hames-ai/agents (#225 PR-2) — the icon literals moved
  // WITH them, into the overlay in `registry.server.ts` (one literal per
  // registration), so this glob names that file now. The collapsed support
  // rail (#933) keeps its tab-icon literals in `src/lib/support-rail.ts` for
  // the same reason, listed beside it.
  content: {
    filesystem: [
      'src/lib/harness-client/registry.server.ts',
      'src/lib/support-rail.ts',
      // The use-cases snapshot carries each question's icon class as a data
      // literal (same reason as the two above).
      'src/lib/use-cases.ts',
    ],
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
       * SELF-HOSTED (#285). This block used to say `provider: 'google'`, which
       * makes UnoCSS FETCH `fonts.googleapis.com/css2` while it builds its
       * preflights and inline the answer. That fetch ran on every `vinxi dev`
       * boot AND inside layer 1, because `uno-theme.test.ts` calls
       * `generator.generate(input, {})` and preflights are on by default — so
       * the merge gate and both e2e layers, all three advertised as hermetic,
       * each needed a third party to be up.
       *
       * It failed in two directions and the preset picked between them on
       * `process.env.CI`: unset, the failure was SWALLOWED and every glyph fell
       * back, reddening all six committed screenshot baselines with a
       * font-metrics diff (212px on the header strip, 429 on the sidebar, 8412
       * on the chat view) that looks exactly like a visual regression; set —
       * which `release:check` sets for every layer — it THREW and `vinxi dev`
       * exited 1 before serving. #283 raised the budget 2s → 30s, which removed
       * the flake and left the dependency.
       *
       * `provider: 'none'` keeps the half of this preset that is not a network
       * call — registering the five families in the theme, so `font-sans` /
       * `font-mono` / `font-lexend` still resolve — and emits no import and no
       * `@font-face`. Those now come from the `@fontsource/*` packages imported
       * in `src/app.tsx`, at the exact weights the Google request named (400 for
       * Inter / Roboto Slab / Fira Code, 200 for the two Lexends: a bare
       * `family=X` asks css2 for the 400 instance, and `:200` asked for 200).
       *
       * #283's 30s budget is gone rather than shrunk, and may be: `timeouts`
       * bounds a fetch that no longer happens. `uno-fonts.test.ts` pins that the
       * generated CSS names neither fonts host, so the dependency cannot come
       * back through a one-line provider edit without a red test.
       */
      provider: 'none',
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
      // Graph-canvas DATA colours (#1008: same hues, toned down — saturated
      // enough to stay distinguishable on the canvas, no longer neon).
      neon: {
        cyan: '#45b0b8',
        magenta: '#b863c9',
        green: '#3fb950',
        orange: '#d9822b',
        purple: '#9a6bd8',
        blue: '#4a9de0',
        pink: '#d1609c',
      },
      dark: {
        // Mirrors the dark `--ui-*` values above (#1008). No component uses
        // these any more (theme-migration.test.ts keeps it that way); they
        // stay in step so the graph-canvas data colours and the chrome never
        // quietly diverge.
        bg: {
          primary: '#0f1115',
          secondary: '#16191e',
          tertiary: '#1d2127',
          hover: '#262b33',
        },
        border: {
          primary: '#2b3038',
          secondary: '#3a4048',
          accent: '#4b525c',
        },
        text: {
          primary: '#e2e4e8',
          secondary: '#9aa1ab',
          tertiary: '#7b828c',
        },
      },
      // Theme-aware semantic palette (#226 B8). These are the SAME roles as
      // `dark.*` above, but each value is a CSS variable rather than a hex, so
      // the palette flips at the `:root` level (see the first preflight below)
      // and a component never needs a `dark:` / light branch of its own.
      //
      // The dark values of these variables are byte-identical to the `dark.*`
      // hexes above (#1008 re-pinned them together: the sober dark palette
      // replaced the neon accent and the violet-cast neutrals in BOTH places,
      // so migrating a component stays a rename, `dark-bg-primary` →
      // `ui-bg-primary`). `uno-theme.test.ts` asserts that equality so it
      // cannot silently drift.
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
        // The primary button's pair (#1008 round 2). Without these keys
        // `text-ui-on-accent` / `bg-ui-accent-deep` resolve to nothing and the
        // button text silently inherits the body colour, which fails AA on
        // the accent in both themes; uno-theme.test.ts pins that they emit.
        'accent-deep': 'var(--ui-accent-deep)',
        'on-accent': 'var(--ui-on-accent)',
        danger: 'var(--ui-danger)',
        success: 'var(--ui-success)',
      },
    },
    // presetWind4 ships `xs`…`9xl` and nothing below `xs`, so `text="2xs"` was
    // a silent no-op: no theme entry, no rule, no CSS — every site that asked
    // for a caption size rendered at the ambient 16px (found by the #937
    // review, on the nav's captions). In wind4 the size namespace is `text`,
    // resolved through `--text-<size>-fontSize` / `-lineHeight` custom
    // properties — `theme.fontSize` is dead weight here. Declared so the size
    // exists; `uno-theme.test.ts` pins that the utility actually emits.
    text: {
      '2xs': {
        fontSize: '0.6875rem',
        lineHeight: '0.875rem',
      },
    },
  },
  shortcuts: {
    'glass-panel': 'bg-ui-bg-secondary/50 backdrop-blur-lg border border-ui-border-primary',
    // The primary button. #1008 round 2: the strong violet indigo leaves the
    // primary buttons with the rest of the neon look — the button ground is
    // the accent itself, with --ui-on-accent as its text (dark mode: the
    // page's near-black on the muted teal; light mode: white on the deep
    // teal) and --ui-accent-deep as the hover, one step down the same ramp
    // in each theme. Both pairs are AA-checked in event-contrast.test.ts.
    'cyber-button':
      'bg-ui-accent hover:bg-ui-accent-deep text-ui-on-accent font-medium px-4 py-2 rounded-md transition-all duration-200',
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
          /* Sober dark neutrals (#1008): the same near-black steps as before,
             with the violet cast dropped for flat blue-grey. */
          --ui-bg-primary: #0f1115;
          --ui-bg-secondary: #16191e;
          --ui-bg-tertiary: #1d2127;
          --ui-bg-hover: #262b33;
          --ui-border-primary: #2b3038;
          --ui-border-secondary: #3a4048;
          --ui-border-accent: #4b525c;
          --ui-text-primary: #e2e4e8;
          --ui-text-secondary: #9aa1ab;
          --ui-text-tertiary: #848b93;
          /* A muted teal, not neon: 7.3:1 on --ui-bg-primary, 4.5:1 or better
             on every surface it is written on. */
          --ui-accent: #45b0b8;
          --ui-danger: #f87171;
          --ui-success: #3fb950;

          /* Tints of the accent. Written out per theme rather than mixed
             from --ui-accent at use time, for the same reason the values
             themselves are: the hand-written CSS below reads them directly. */
          --ui-accent-soft: rgba(69, 176, 184, 0.1);
          --ui-accent-glow: rgba(69, 176, 184, 0.15);
          --ui-accent-strong: rgba(69, 176, 184, 0.2);
          --ui-accent-line: rgba(69, 176, 184, 0.4);

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
          --ui-code-bg: #0c0e11;

          /* Observability event-label colours (#1008 round 2): one muted pair
             per event type, AA (>= 4.5:1) against every dark row ground.
             Consumed as vars by lib/observability/event-styles.ts. */
          --ui-evt-user-message: #7092c2;
          --ui-evt-assistant-message: #5c9e77;
          --ui-evt-tool-call: #9d81de;
          --ui-evt-tool-result: #5f98a3;
          --ui-evt-controller-action: #a1905d;
          --ui-evt-intent-compacted: #a1905d;
          --ui-evt-plan-created: #a1905d;
          --ui-evt-model-call: #a1905d;
          --ui-evt-critic-result: #c9759f;
          --ui-evt-pattern-enter: #94a3b8;
          --ui-evt-pattern-exit: #94a3b8;
          --ui-evt-approval-request: #b28768;
          --ui-evt-approval-response: #5c9e77;
          --ui-evt-error: #c97c75;
          --ui-evt-reference-attached: #c073c7;
          --ui-evt-content-sanitized: #b28768;
          --ui-evt-warning: #a88b62;
          --ui-evt-loop-recovery: #849959;
          --ui-evt-hitl-request: #b28768;
          --ui-evt-hitl-response: #5c9e77;
          --ui-evt-decision-made: #8188de;
          --ui-evt-memory-recalled: #5a9c93;
          --ui-evt-memory-written: #5a9c93;
          --ui-evt-egress-audit: #b28768;
          --ui-evt-egress-refused: #b28768;
          --ui-evt-egress-blocked: #b28768;

          /* Per-pattern boundary labels, same treatment; the 6 percent tint
             wash itself lives in pattern-colors.json. */
          --ui-pat-harness: #94a3b8;
          --ui-pat-router: #9d81de;
          --ui-pat-neo4j-query: #5f99a3;
          --ui-pat-web-search: #a68c60;
          --ui-pat-response-synth: #c9759f;
          --ui-pat-quality-judge: #cc7685;
          --ui-pat-doc-lookup: #8486e3;
          --ui-pat-memory-store: #5a9c94;
          --ui-pat-memory-write: #5a9c94;
          --ui-pat-parallel-research: #6597ad;
          --ui-pat-parallel-sources: #6597ad;
          --ui-pat-session-tracker: #b28768;
          --ui-pat-ontology-scope: #be75c9;
          --ui-pat-ontology-proposal: #c075c9;
          --ui-pat-ontology-commit: #c073c7;
          --ui-pat-file-edit: #809959;
          --ui-pat-safe-file-edit: #809959;
          --ui-pat-issue-context: #b08766;
          --ui-pat-web-research: #a68c60;
          --ui-pat-kg-lookup: #5f99a3;
          --ui-pat-semantic-cache: #5f9aa3;
          --ui-pat-_default: #94a3b8;

          /* The accent as a BUTTON ground: dark mode's muted teal is light
             enough that its readable partner is the page's own near-black;
             light mode's deep teal takes white. --ui-accent-deep is the
             hover/pressed tone, one step down the same ramp. */
          --ui-on-accent: #0f1115;
          --ui-accent-deep: #2f9aa4;
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
          --ui-text-tertiary: #5f656d;
          --ui-accent: #0e7490;
          --ui-danger: #b91c1c;
          --ui-success: #166534;

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

          /* Event + pattern label colours, the light half of each pair above:
             the same hues darkened until every one clears 4.5:1 on white and
             the two grey grounds. */
          --ui-evt-user-message: #4e6687;
          --ui-evt-assistant-message: #406e53;
          --ui-evt-tool-call: #6c5999;
          --ui-evt-tool-result: #436b73;
          --ui-evt-controller-action: #706441;
          --ui-evt-intent-compacted: #706441;
          --ui-evt-plan-created: #706441;
          --ui-evt-model-call: #706441;
          --ui-evt-critic-result: #8c516f;
          --ui-evt-pattern-enter: #5b6470;
          --ui-evt-pattern-exit: #5b6470;
          --ui-evt-approval-request: #7d5e48;
          --ui-evt-approval-response: #406e53;
          --ui-evt-error: #8c5651;
          --ui-evt-reference-attached: #87518c;
          --ui-evt-content-sanitized: #7d5e48;
          --ui-evt-warning: #756144;
          --ui-evt-loop-recovery: #5a693d;
          --ui-evt-hitl-request: #7d5e48;
          --ui-evt-hitl-response: #406e53;
          --ui-evt-decision-made: #595e99;
          --ui-evt-memory-recalled: #3e6b65;
          --ui-evt-memory-written: #3e6b65;
          --ui-evt-egress-audit: #7d5e48;
          --ui-evt-egress-refused: #7d5e48;
          --ui-evt-egress-blocked: #7d5e48;

          --ui-pat-harness: #5b6470;
          --ui-pat-router: #6c5999;
          --ui-pat-neo4j-query: #416970;
          --ui-pat-web-search: #736143;
          --ui-pat-response-synth: #8c516e;
          --ui-pat-quality-judge: #8f535d;
          --ui-pat-doc-lookup: #595a99;
          --ui-pat-memory-store: #3e6b66;
          --ui-pat-memory-write: #3e6b66;
          --ui-pat-parallel-research: #476a7a;
          --ui-pat-parallel-sources: #476a7a;
          --ui-pat-session-tracker: #7d5e48;
          --ui-pat-ontology-scope: #85518c;
          --ui-pat-ontology-proposal: #86518c;
          --ui-pat-ontology-commit: #87518c;
          --ui-pat-file-edit: #596b3e;
          --ui-pat-safe-file-edit: #596b3e;
          --ui-pat-issue-context: #7a5e47;
          --ui-pat-web-research: #736143;
          --ui-pat-kg-lookup: #416970;
          --ui-pat-semantic-cache: #416a70;
          --ui-pat-_default: #5b6470;

          --ui-on-accent: #ffffff;
          --ui-accent-deep: #0c637a;

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
        /* The shared bar's page tabs (owner, round 4): from md up the label
           rides beside its icon on one line; below md the tab collapses to
           its icon only — the anchor's aria-label carries the name. A
           hand-written rule rather than utilities because the valueless
           'hidden' ATTRIBUTE in JSX is the native one (wind4's preflight
           hides [hidden] with !important, which no display utility can
           override at md), and attributify has no other base-none form. */
        .nav-tab-label { display: none; }
        @media (min-width: 48rem) {
          .nav-tab-label { display: inline; }
        }
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
        /* An image the chat sanitizer refused to load (lib/sanitize-html.ts):
           inert text standing where the <img> was. Dashed so it reads as
           "something was here" rather than as a chip or a control, and
           break-all because what it shows is usually one long URL. */
        .prose-chat .blocked-image {
          display: inline-block;
          padding: 0.1em 0.5em;
          border: 1px dashed var(--ui-border-secondary);
          border-radius: 4px;
          color: var(--ui-text-secondary);
          font-size: 0.85em;
          word-break: break-all;
        }

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

        /* Sandbox tab (#415): blinks TWICE when a sandbox is entered — two
           pulses of the success tint inside one 1.2s run, then nothing.
           Applied by SupportPanel for SANDBOX_BLINK_MS, which mirrors the
           duration. */
        @keyframes sandbox-tab-blink {
          0%, 50%, 100% { background-color: transparent; }
          25%, 75%      { background-color: color-mix(in srgb, var(--ui-success) 28%, transparent); }
        }
        .sandbox-tab-blink {
          animation: sandbox-tab-blink 1.2s ease-in-out 1;
        }
        /* Motionless fallback: no flashing, but the same signal — the tab
           carries a steady success underline for the same 1.2s. */
        @media (prefers-reduced-motion: reduce) {
          .sandbox-tab-blink {
            animation: none;
            box-shadow: inset 0 -2px 0 var(--ui-success);
          }
        }

        /* Collapsed support rail (#933): an event landing for a collapsed tab
           softly pulses that tab's rail icon — two low-contrast opacity dips
           inside one 1.2s run, the sandbox tab's shape. Applied by
           SupportPanelRail for SUPPORT_BLINK_MS, which mirrors the duration
           (uno-theme.test.ts pins the pair, as it does the sandbox tab's). */
        @keyframes support-rail-blink {
          0%, 50%, 100% { opacity: 1; }
          25%, 75%      { opacity: 0.35; }
        }
        .support-rail-blink {
          animation: support-rail-blink 1.2s ease-in-out 1;
        }
        .support-rail-blink .support-rail-blink-dot { display: none; }
        /* Motionless fallback: no pulsing — the icon carries a steady 6px dot
           in the tab's accent for the same 1.2s, the same geometry as the
           left rail's run-state dot. */
        @media (prefers-reduced-motion: reduce) {
          .support-rail-blink { animation: none; opacity: 1; }
          .support-rail-blink .support-rail-blink-dot { display: block; }
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

        /* The shared bar's indeterminate mode (#105, generalised in #295) — a
           40%-wide segment sweeping the 3px track, for any consumer of
           ProgressBar that passes percent: null. Named for the component
           rather than for the sidebar row that was its first caller: since
           #295 it is also the chain bar's and the boot splash's. */
        @keyframes progress-slide {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(250%); }
        }
        .progress-indeterminate {
          animation: progress-slide 1.2s ease-in-out infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          /* Motionless fallback: a dim full-width fill still signals "running". */
          .progress-indeterminate {
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
        /* Two things here are load-bearing, both because the mark is an empty
           <sup> whose glyph comes from an i-material-symbols-* utility.
           display:inline-block — an icon utility sets a 1em box but no display,
           and on a bare inline element that box is ignored, so the icon
           vanishes. And the selector is sup.doc-ref-mark rather than
           .doc-ref-mark: the icon utility declares color:inherit to paint its
           mask with currentColor, and at equal specificity the utility layer
           wins on source order — so a class-only rule loses the colour and the
           mark renders in the message's text colour. Element+class outranks it.
           Measured in a browser both ways. */
        sup.doc-ref-mark {
          display: inline-block;
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
