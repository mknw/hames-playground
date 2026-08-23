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
    },
  },
  shortcuts: {
    // Futuristic UI shortcuts
    'glass-panel': 'bg-dark-bg-secondary/50 backdrop-blur-lg border border-dark-border-primary',
    'neon-border': 'border-2 border-neon-cyan shadow-[0_0_10px_rgba(0,255,255,0.5)]',
    'cyber-button':
      'bg-cyber-700 hover:bg-cyber-600 text-white font-medium px-4 py-2 rounded-md transition-all duration-200 hover:shadow-[0_0_15px_rgba(79,70,229,0.5)]',
  },
  // Custom CSS for markdown rendering
  preflights: [
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
          background: rgba(0,255,255,0.1);
          padding: 0.2em 0.4em;
          border-radius: 4px;
          font-family: 'Fira Code', monospace;
          font-size: 0.9em;
        }
        .prose-chat pre {
          background: #0a0a0f;
          padding: 1em;
          border-radius: 8px;
          overflow-x: auto;
          margin: 0.75em 0;
          border: 1px solid #2a2a3a;
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
          color: #00ffff;
          font-weight: 600;
        }
        .prose-chat em {
          font-style: italic;
        }
        .prose-chat a {
          color: #00ffff;
          text-decoration: underline;
        }
        .prose-chat blockquote {
          border-left: 3px solid #4f46e5;
          padding-left: 1em;
          margin: 0.75em 0;
          color: #a1a1aa;
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
          border-bottom: 1px solid rgba(255,255,255,0.06);
          border-radius: 8px 8px 0 0;
          overflow: hidden;
        }
        .think-trigger {
          display: flex;
          align-items: center;
          gap: 6px;
          width: 100%;
          padding: 4px 8px;
          background: rgba(255,255,255,0.03);
          cursor: pointer;
          font-size: 0.75rem;
          color: #71717a;
          border: none;
          text-align: left;
          transition: background 0.15s ease;
        }
        .think-trigger:hover {
          background: rgba(255,255,255,0.06);
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
          background: rgba(0,0,0,0.15);
          border-top: 1px solid rgba(255,255,255,0.05);
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
           instead — there the accent is always on. */
        .agent-glyph {
          color: #71717a;
          transition: color 0.15s ease;
        }
        .group:hover .agent-glyph,
        .agent-glyph[data-lit="true"] {
          color: var(--agent-accent, #71717a);
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

        /* Graph entity interactive spans in chat messages */
        .graph-entity {
          cursor: pointer;
          border-bottom: 1px dashed rgba(0,255,255,0.4);
          transition: all 0.15s ease;
          border-radius: 2px;
          padding: 0 2px;
        }
        .graph-entity:hover {
          background: rgba(0,255,255,0.15);
          border-bottom-color: #00ffff;
          color: #00ffff;
        }
        .graph-entity.toggled {
          background: rgba(0,255,255,0.2);
          border-bottom: 1px solid #00ffff;
          color: #00ffff;
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
