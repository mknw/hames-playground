/**
 * Sandbox Agent — one agent, three flavours, chosen per message by a router.
 *
 * The app's ONLY sandbox agent (owner decision, 2026-10-03: "only one sandbox
 * agent, and use the basic one alongside the existing two flavoured ones: data
 * and office"). It replaced two agents: `sandbox-session` (one persistent box,
 * no router) and `flavoured-sandbox` (a router over four flavours). The host
 * maps both old ids onto this one, so their stored conversations still open.
 *
 * Routes — all `base`-derived, all PERSISTENT + workspace-synced:
 *   - basic  → `base` box: the conversation's OWN sandbox, the very container
 *              the interactive Shell attaches to (what `sandbox-session` was).
 *   - data   → `data` box (pandas/numpy/polars/pyarrow, matplotlib/seaborn,
 *              excel backends, reportlab/pypdf).
 *   - office → `office` box (python-docx, openpyxl + xlsxwriter, PyMuPDF) for
 *              editing docx/xlsx/pdf files.
 *
 * The `image-processing` route is gone from here. The rootfs flavour itself is
 * still a `@hames-ai/sandbox` capability; no agent selects it.
 *
 * **One durable session workspace, one container per flavour.** Every route
 * passes the conversation id as `sessionId` (the Data Stash key), so /work
 * hydrate/promote is common to all three. The attachment `id` is what picks the
 * container: `basic` uses the bare conversation id, which is the key the
 * PtyManager acquires for the Shell (`attachments.acquire(sessionId, 'base')`),
 * so the agent and the Shell share one box; `data` and `office` use
 * `${sessionId}:${rootfs}`, a box each. A flavour-aware Shell is deferred (#116).
 *
 * That uniformity is the fix for the multi-turn failure #243 left standing: a
 * route without an `id` gets an anonymous-pool box, `syncWorkspace` is a no-op
 * there, and a turn routed to it could not see a file ingested on an earlier
 * turn ("ingest the spreadsheet" → `data`, then "list the files in /work/in" →
 * `basic` → "No such file or directory"). Per-turn flavour choice is the point
 * of this agent, so the workspace — not the routing — is session-wide.
 *
 * The corollary the actors are told about (WORKSPACE_NOTE): a later turn may
 * land in a DIFFERENT flavour's container, so anything worth keeping goes to
 * /work/out (promoted to the Data Stash, restored into every flavour's
 * /work/in), never to bare /work.
 *
 * The loop and synth pattern ids are the ones `flavoured-sandbox` used. They
 * are written into every stored event, so keeping them keeps that agent's
 * conversations readable as one history rather than two.
 */
// @unocss-include — the icon class literal lives in the app's registry overlay
// (see the host's harness-client/registry.server.ts), not here: `icon`/`accent`
// are UI fields and stay app-side (the #225 composition-root decision).
import {
  router,
  routes,
  compactExecution,
  actorCritic,
  type ConfiguredPattern,
} from '@hames-ai/harness-patterns'
import {
  bamlPatterns,
  createActorControllerAdapter,
  createCriticAdapter,
} from '@hames-ai/harness-baml'
import type { AgentData, AgentDefinition, AgentDeps } from '../types'
import type { FewShot } from '@hames-ai/harness-patterns/types'

import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'

// The 'use server' directive this file carried before the move was the only
// thing keeping its exports off the client; this is the real guard, and the
// reason stripping the directive removes nothing load-bearing.
assertServerOnImport()

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

/** The plain session box — what `sandbox-session` told its actor, plus the one
 *  thing a router changes: the next turn may not land in this box. */
const BASIC_GUIDANCE = `
You have a PERSISTENT plain Linux sandbox for this conversation, shared with the
user's interactive terminal (the Sandbox tab's Shell opens this same box).

Available tools (all run inside the sandbox):
- sandbox_bash: run a shell command. Python 3 is available, with NO third-party
  packages — no pandas, no Pillow; say so rather than improvising if a task
  needs them.
- sandbox_write / sandbox_read / sandbox_edit: manage files under /work.
- sandbox_list / sandbox_search: inspect the working directory.

Guidance:
1. Build incrementally — check /work/in and /work/out for files from earlier
   turns before recreating anything.
2. For anything computational, run code in the sandbox rather than guessing.
3. When a task produces a FILE the user should keep, write it to /work/out
   (don't just compute the answer with a throwaway python3 -c).
4. To continue a partial or large file, APPEND to it (bash \`cat >> file <<'EOF'\`)
   — don't regenerate the whole file from scratch.
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
 * Few-shot examples for the actor's `tool_args` formatting (#85). Observed
 * live (.harness-logs/regression.json): Sonnet 5 emitted multiline
 * `python3 -c \"` commands whose over-escaped quotes bash mangles into
 * "unterminated string literal". The heredoc shot anchors the quote-free way
 * to run multi-line Python inline; the write shot anchors write-then-run, with
 * the newline inside the file content as an escape, not a raw line break.
 */
const SANDBOX_FEW_SHOTS: FewShot[] = [
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
 *  scope the injected `withSandbox` sets up, so the tools argument is left
 *  empty. */
function sandboxLoop(patternId: string, guidance: string) {
  const actor = createActorControllerAdapter({
    contextPrefix: guidance,
    fewShots: SANDBOX_FEW_SHOTS,
  })
  const critic = createCriticAdapter()
  return actorCritic<AgentData>(actor, critic, [], {
    patternId,
    liveEvents: true,
    maxRetries: 6,
    // The actor typically inspects inputs, WRITES a script, RUNS it, then
    // confirms the output — a multi-step chain. Let it free-run and have the
    // critic judge only when the actor signals is_final (or every 3rd turn as a
    // backstop), so the critic can't accept a written-but-unrun script as
    // "done" (see .harness-logs/context-3817275e-*.json).
    criticCadence: 3,
    // Sandbox work is linear (write file → run script → read output): calls in
    // a batch run strictly IN ORDER, so later calls see earlier calls' effects
    // on the VM filesystem — one actor round-trip instead of N. Not 'parallel':
    // concurrent sandbox_bash on one VM FS races.
    multiToolCalls: 'sequential',
  })
}

async function createPatterns(
  sessionId: string,
  deps: AgentDeps,
): Promise<ConfiguredPattern<AgentData>[]> {
  // The sandbox wrapper is injected app-side wiring (SD-19: the containment
  // posture stays app-side and is supplied, not carried). A missing one is not
  // a degraded composition — it is a misconfigured one — so it fails loudly
  // instead of silently running every route on the host process.
  if (!deps.withSandbox) {
    throw new Error(
      'sandbox requires deps.withSandbox — the composition root must supply it (AgentDeps)',
    )
  }

  // `id: sessionId` — the conversation's own box, the one the Shell attaches
  // to (PtyManager keys on the session id with rootfs 'base'). Release
  // decrements its refCount without resetting, so /work survives between turns.
  const basic = deps.withSandbox({
    id: sessionId,
    sessionId,
    rootfs: 'base',
    egress: 'mcp-only',
    // Durable workspace (#89): hydrate the conversation's stored documents into
    // /work/in at each turn's entry (diff-wise), promote /work/out deliverables
    // back to the Data Stash each turn.
    syncWorkspace: true,
  })(sandboxLoop('flavour-basic-loop', BASIC_GUIDANCE))

  // The flavoured boxes: a flavour-scoped `id` gives each its own container,
  // and the shared `sessionId` gives them all the same durable workspace.
  const data = deps.withSandbox({
    id: `${sessionId}:data`,
    sessionId,
    rootfs: 'data',
    egress: 'mcp-only',
    syncWorkspace: true,
  })(sandboxLoop('flavour-data-loop', DATA_GUIDANCE))

  const office = deps.withSandbox({
    id: `${sessionId}:office`,
    sessionId,
    rootfs: 'office',
    egress: 'mcp-only',
    syncWorkspace: true,
  })(sandboxLoop('flavour-office-loop', OFFICE_GUIDANCE))

  const routerPattern = router<AgentData>(
    {
      basic:
        'Plain shell / general Linux work — listing or inspecting the workspace, file ' +
        'management, small scripts with no third-party Python packages',
      data: 'Data ANALYSIS — pandas/numpy/polars over datasets (incl. xlsx/csv), matplotlib/seaborn plots, reports',
      office:
        'Document EDITING — modify/create Word (docx), Excel (xlsx) or PDF files themselves (not analyze their data)',
    },
    // The routing implementation is REQUIRED config, wired from `harness-baml`
    // at the composition root (BAML-companion seam lane) — core hosts no
    // default import.
    { liveEvents: true, route: bamlPatterns().router },
  )

  const routesPattern = routes<AgentData>({ basic, data, office }, { liveEvents: true })

  const synth = compactExecution<AgentData>({
    mode: 'thread',
    patternId: 'flavoured-sandbox-synth',
    liveEvents: true,
    synthesize: bamlPatterns().synthesize,
  })

  return [routerPattern, routesPattern, synth]
}

export const sandboxAgent: AgentDefinition = {
  id: 'sandbox',
  name: 'Sandbox',
  description:
    'A persistent Linux sandbox shared with the interactive Shell: a plain, data or office box, picked per message over one session workspace.',
  welcome:
    'I run shell and Python in a Linux box that keeps its files between messages. ' +
    'Each message goes to a plain box (the one the Sandbox tab opens), a data and ' +
    'charts box, or a Word, Excel and PDF box. What I put in /work/out is kept.',
  servers: [],
  usesSandbox: true,
  createPatterns,
}
