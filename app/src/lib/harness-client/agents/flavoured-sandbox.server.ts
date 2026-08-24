/**
 * Flavoured Sandbox Agent (router over sandbox flavours)
 *
 * Demonstrates the composable recipe from docs/sandbox-flavours.md: a `router`
 * that dispatches each turn to a differently-*flavoured* `withSandbox` route.
 * Flavour selection lives entirely in the harness — the routed controller is
 * flavour-agnostic.
 *
 * Routes (all four `base`-derived, all PERSISTENT + workspace-synced):
 *   - basic            → `base` box. Quick shell / general work.
 *   - image_processing → `image-processing` box (Pillow, OpenCV, imagemagick).
 *   - data             → `data` box (pandas/numpy/polars/pyarrow,
 *                        matplotlib/seaborn, excel backends, reportlab/pypdf).
 *   - office           → `office` box (python-docx, openpyxl + xlsxwriter,
 *                        PyMuPDF) for editing docx/xlsx/pdf files.
 *
 * **Every route gets `id: ${sessionId}:${rootfs}` + `sessionId` + `syncWorkspace`
 * — one durable session workspace, N flavour containers.** The flavour-scoped
 * attachment id gives each flavour its own container; the shared `sessionId`
 * (the Data Stash key) makes /work hydrate/promote common across them, so only
 * in-VM scratch differs.
 *
 * That uniformity is the fix for the multi-turn failure #243 left standing:
 * `basic` used to be the odd one out — an anonymous-pool (ephemeral) box with
 * no `id`, and `syncWorkspace` is a no-op without one. So a turn the router
 * sent to `basic` ran in a container where `/work/in` did not exist at all,
 * and a file ingested on an earlier `data` turn was invisible ("ingest the
 * spreadsheet" → `data`, then "list the files in /work/in" → `basic` →
 * "No such file or directory" → max retries exceeded). Per-turn flavour
 * choice is the point of this agent, so the workspace — not the routing —
 * is what had to become session-wide.
 *
 * The corollary the actors are told about (WORKSPACE_NOTE): a later turn may
 * land in a *different* flavour container, so anything worth keeping goes to
 * /work/out (promoted to the Data Stash, restored into every flavour's
 * /work/in), never to bare /work.
 *
 * NOTE: the interactive Shell terminal attaches to the base `sessionId`
 * container (PtyManager keys on sessionId, rootfs 'base'), NOT these flavoured
 * ones — flavour-aware Shell is deferred (#116). See docs/sandbox-flavours.md.
 */
'use server'

// @unocss-include — the icon class literal below must be extracted (see uno.config content.filesystem)
import {
  router,
  routes,
  compactExecution,
  actorCritic,
  createActorControllerAdapter,
  createCriticAdapter,
  type ConfiguredPattern,
} from '../../harness-patterns'
import { withSandbox } from '../../sandbox/with-sandbox.server'
import type { SessionData } from '../session.server'
import type { AgentConfig } from '../registry.server'
import type { FewShot } from '../../../../baml_client/types'

const WORKSPACE_NOTE = `
Files under /work/in are restored inputs; write deliverables the user should keep
to /work/out (saved to the Data Stash and restored next time). /work is scratch:
a later turn may run in a DIFFERENT sandbox flavour, and only /work/in and
/work/out follow the conversation — never leave something you need again in bare
/work.
Python notes: for multi-line Python, WRITE a .py file (sandbox_write) and run it,
or use a quoted heredoc (python3 - <<'PY' ... PY) — never nest escaped quotes in
python3 -c. Python runs with PYTHONSAFEPATH=1 (cwd is not on sys.path); to import
your own helper modules from /work, run with PYTHONPATH=/work.
`.trim()

const BASIC_GUIDANCE = `
You have a PERSISTENT plain Linux sandbox. Use sandbox_bash / sandbox_write /
sandbox_read for shell work and small scripts (Python 3 is available, but with
NO third-party packages — no pandas, no Pillow; say so rather than improvising
if a task needs them).
${WORKSPACE_NOTE}
`.trim()

const IMAGE_GUIDANCE = `
You have a PERSISTENT image-processing sandbox. Available via sandbox_bash:
Python 3 with numpy, Pillow (PIL) and OpenCV (cv2), plus imagemagick (\`convert\`).
${WORKSPACE_NOTE}
`.trim()

const DATA_GUIDANCE = `
You have a PERSISTENT data sandbox. Available via sandbox_bash: Python 3 with
pandas, numpy, polars, pyarrow, matplotlib and seaborn (plots). Excel is fully
supported: read xlsx with pandas (openpyxl) or polars (fastexcel/calamine),
write with xlsxwriter/openpyxl. Also python-docx / python-pptx / reportlab /
pypdf. Save plots/spreadsheets/reports to /work/out.
${WORKSPACE_NOTE}
`.trim()

const OFFICE_GUIDANCE = `
You have a PERSISTENT office sandbox for EDITING documents. Available via
sandbox_bash: Python 3 with python-docx (Word), openpyxl + xlsxwriter (Excel),
and PyMuPDF (\`import pymupdf\` or \`import fitz\`) for reading, editing and
creating PDFs. Edit files from /work/in and save results to /work/out.
${WORKSPACE_NOTE}
`.trim()

/**
 * Few-shot examples for the actor's `tool_args` formatting (#85 — mirrors
 * `sandbox-session`'s shots, which this agent originally lacked). Observed
 * live (.harness-logs/regression.json): Sonnet 5 emitted multiline
 * `python3 -c \"` commands whose over-escaped quotes bash mangles into
 * "unterminated string literal". The heredoc shot anchors the quote-free way
 * to run multi-line Python inline; the write shot anchors write-then-run.
 */
const FLAVOURED_SANDBOX_FEW_SHOTS: FewShot[] = [
  {
    user: 'Write a hello-world Python script to /work/hi.py and run it.',
    reasoning:
      'Write the file first. Keys and string values are double-quoted; the newline inside the script is the escape sequence \\n, not a raw line break.',
    tool: 'sandbox_write',
    args: JSON.stringify({ path: '/work/hi.py', content: 'print("hello")\n' }),
  },
  {
    user: 'How many rows does /work/in/data.csv have?',
    reasoning:
      'Multi-line Python inline: use a quoted heredoc so no quotes need escaping inside the command. Never wrap a multi-line script in python3 -c \\"...\\".',
    tool: 'sandbox_bash',
    args: JSON.stringify({
      command:
        "python3 - <<'PY'\nimport csv\nwith open('/work/in/data.csv') as f:\n    print(sum(1 for _ in f) - 1)\nPY",
    }),
  },
]

/** A sandbox tool-loop; the actor sees the in-VM `sandbox_*` tools via the ALS
 *  scope `withSandbox` sets up, so `availableTools` is left empty. */
function sandboxLoop(patternId: string, guidance: string) {
  const actor = createActorControllerAdapter({
    contextPrefix: guidance,
    fewShots: FLAVOURED_SANDBOX_FEW_SHOTS,
  })
  const critic = createCriticAdapter()
  return actorCritic<SessionData>(actor, critic, [], {
    patternId,
    availableTools: [],
    liveEvents: true,
    maxRetries: 6,
    // Deliverable-producing routes: the actor typically inspects inputs, WRITES
    // a script, RUNS it, then confirms the output — a multi-step chain. Let it
    // free-run and have the critic judge only when the actor signals is_final
    // (or every 3rd turn as a backstop), so the critic can't accept a written-
    // but-unrun script as "done" (see .harness-logs/context-3817275e-*.json).
    criticCadence: 3,
    // Same rationale as sandbox-session: linear effect-chains on one VM FS —
    // in-order batches save actor round-trips, concurrency would race.
    multiToolCalls: 'sequential',
  })
}

async function createPatterns(sessionId: string): Promise<ConfiguredPattern<SessionData>[]> {
  // Every route below is persistent + flavour-scoped id → its own container,
  // while `sessionId` (the Data Stash key) stays the conversation id, so /work
  // hydrate/promote is shared across flavours. `basic` is NOT the exception it
  // used to be: as an anonymous-pool sandbox it had no `id`, so `syncWorkspace`
  // was a no-op and /work/in never existed there — the multi-turn failure #243
  // left standing (see the module docstring).
  const basic = withSandbox({
    id: `${sessionId}:base`,
    sessionId,
    rootfs: 'base',
    egress: 'mcp-only',
    syncWorkspace: true,
  })(sandboxLoop('flavour-basic-loop', BASIC_GUIDANCE))

  const image = withSandbox({
    id: `${sessionId}:image-processing`,
    sessionId,
    rootfs: 'image-processing',
    egress: 'mcp-only',
    syncWorkspace: true,
  })(sandboxLoop('flavour-image-loop', IMAGE_GUIDANCE))

  const data = withSandbox({
    id: `${sessionId}:data`,
    sessionId,
    rootfs: 'data',
    egress: 'mcp-only',
    syncWorkspace: true,
  })(sandboxLoop('flavour-data-loop', DATA_GUIDANCE))

  const office = withSandbox({
    id: `${sessionId}:office`,
    sessionId,
    rootfs: 'office',
    egress: 'mcp-only',
    syncWorkspace: true,
  })(sandboxLoop('flavour-office-loop', OFFICE_GUIDANCE))

  const routerPattern = router<SessionData>(
    {
      basic:
        'Plain shell / general Linux work — listing or inspecting the workspace, file ' +
        'management, small scripts with no third-party Python packages',
      image_processing:
        'Image manipulation — Pillow, OpenCV (cv2), imagemagick (resize, convert, analyze images)',
      data: 'Data ANALYSIS — pandas/numpy/polars over datasets (incl. xlsx/csv), matplotlib/seaborn plots, reports',
      office:
        'Document EDITING — modify/create Word (docx), Excel (xlsx) or PDF files themselves (not analyze their data)',
    },
    { liveEvents: true },
  )

  const routesPattern = routes<SessionData>(
    {
      basic,
      image_processing: image,
      data,
      office,
    },
    { liveEvents: true },
  )

  const synth = compactExecution<SessionData>({
    mode: 'thread',
    patternId: 'flavoured-sandbox-synth',
    liveEvents: true,
  })

  return [routerPattern, routesPattern, synth]
}

export const flavouredSandboxAgent: AgentConfig = {
  id: 'flavoured-sandbox',
  name: 'Sandbox · Flavoured (router)',
  description:
    'Routes each turn to a purpose-built sandbox flavour — base, image-processing, data or office — over one shared session workspace.',
  icon: 'i-material-symbols-stack-star-outline',
  accent: 'orange',
  servers: [],
  createPatterns,
}
