/**
 * Flavoured Sandbox Agent (router over sandbox flavours)
 *
 * Demonstrates the composable recipe from docs/sandbox-flavours.md: a `router`
 * that dispatches each turn to a differently-*flavoured* `withSandbox` route.
 * Flavour selection lives entirely in the harness — the routed controller is
 * flavour-agnostic.
 *
 * Routes:
 *   - basic            → EPHEMERAL `base` box (anonymous pool: a reset,
 *                        fresh-state VM each turn). Quick shell / general work.
 *   - image_processing → PERSISTENT `image-processing` box (Pillow, OpenCV,
 *                        imagemagick).
 *   - data             → PERSISTENT `data` box (pandas/numpy/polars/pyarrow,
 *                        matplotlib/seaborn, excel backends, reportlab/pypdf).
 *   - office           → PERSISTENT `office` box (python-docx, openpyxl +
 *                        xlsxwriter, PyMuPDF) for editing docx/xlsx/pdf files.
 *
 * The two persistent routes use a **flavour-scoped attachment id**
 * (`${sessionId}:${rootfs}`) so they get separate containers, while `sessionId`
 * (the Data Stash key) is shared — so /work hydrate/promote is common across
 * flavours, only in-VM scratch differs. This shows multiple persistent flavours
 * in one session working today, without the deferred flavour-in-identity change.
 *
 * NOTE: the interactive Shell terminal attaches to the base `sessionId`
 * container (PtyManager keys on sessionId, rootfs 'base'), NOT these flavoured
 * ones — flavour-aware Shell is deferred (#116). See docs/sandbox-flavours.md.
 */
"use server";

import {
  router,
  routes,
  synthesizer,
  actorCritic,
  createActorControllerAdapter,
  createCriticAdapter,
  type ConfiguredPattern,
} from "../../harness-patterns";
import { withSandbox } from "../../sandbox/with-sandbox.server";
import type { SessionData } from "../session.server";
import type { AgentConfig } from "../registry.server";
import type { FewShot } from "../../../../baml_client/types";

const WORKSPACE_NOTE = `
Files under /work/in are restored inputs; write deliverables the user should keep
to /work/out (saved to the Data Stash and restored next time). /work is scratch.
Python notes: for multi-line Python, WRITE a .py file (sandbox_write) and run it,
or use a quoted heredoc (python3 - <<'PY' ... PY) — never nest escaped quotes in
python3 -c. Python runs with PYTHONSAFEPATH=1 (cwd is not on sys.path); to import
your own helper modules from /work, run with PYTHONPATH=/work.
`.trim();

const BASIC_GUIDANCE = `
You have an EPHEMERAL Linux sandbox — a fresh box each turn, no state persists.
Use sandbox_bash / sandbox_write / sandbox_read for quick shell work and small
scripts (Python 3 is available). Don't rely on files from previous turns.
`.trim();

const IMAGE_GUIDANCE = `
You have a PERSISTENT image-processing sandbox. Available via sandbox_bash:
Python 3 with numpy, Pillow (PIL) and OpenCV (cv2), plus imagemagick (\`convert\`).
${WORKSPACE_NOTE}
`.trim();

const DATA_GUIDANCE = `
You have a PERSISTENT data sandbox. Available via sandbox_bash: Python 3 with
pandas, numpy, polars, pyarrow, matplotlib and seaborn (plots). Excel is fully
supported: read xlsx with pandas (openpyxl) or polars (fastexcel/calamine),
write with xlsxwriter/openpyxl. Also python-docx / python-pptx / reportlab /
pypdf. Save plots/spreadsheets/reports to /work/out.
${WORKSPACE_NOTE}
`.trim();

const OFFICE_GUIDANCE = `
You have a PERSISTENT office sandbox for EDITING documents. Available via
sandbox_bash: Python 3 with python-docx (Word), openpyxl + xlsxwriter (Excel),
and PyMuPDF (\`import pymupdf\` or \`import fitz\`) for reading, editing and
creating PDFs. Edit files from /work/in and save results to /work/out.
${WORKSPACE_NOTE}
`.trim();

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
    user: "Write a hello-world Python script to /work/hi.py and run it.",
    reasoning:
      "Write the file first. Keys and string values are double-quoted; the newline inside the script is the escape sequence \\n, not a raw line break.",
    tool: "sandbox_write",
    args: JSON.stringify({ path: "/work/hi.py", content: 'print("hello")\n' }),
  },
  {
    user: "How many rows does /work/in/data.csv have?",
    reasoning:
      "Multi-line Python inline: use a quoted heredoc so no quotes need escaping inside the command. Never wrap a multi-line script in python3 -c \\\"...\\\".",
    tool: "sandbox_bash",
    args: JSON.stringify({
      command: "python3 - <<'PY'\nimport csv\nwith open('/work/in/data.csv') as f:\n    print(sum(1 for _ in f) - 1)\nPY",
    }),
  },
];

/** A sandbox tool-loop; the actor sees the in-VM `sandbox_*` tools via the ALS
 *  scope `withSandbox` sets up, so `availableTools` is left empty. */
function sandboxLoop(patternId: string, guidance: string) {
  const actor = createActorControllerAdapter({
    contextPrefix: guidance,
    fewShots: FLAVOURED_SANDBOX_FEW_SHOTS,
  });
  const critic = createCriticAdapter();
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
  });
}

async function createPatterns(sessionId: string): Promise<ConfiguredPattern<SessionData>[]> {
  // Ephemeral: no id (anonymous pool) → a reset (fresh-state) VM each turn.
  const basic = withSandbox({
    rootfs: "base",
    egress: "mcp-only",
    sessionId,
  })(sandboxLoop("flavour-basic-loop", BASIC_GUIDANCE));

  // Persistent + flavour-scoped id → its own container, distinct from `data`.
  // sessionId stays the conversation id, so /work is shared across flavours.
  const image = withSandbox({
    id: `${sessionId}:image-processing`,
    sessionId,
    rootfs: "image-processing",
    egress: "mcp-only",
    syncWorkspace: true,
  })(sandboxLoop("flavour-image-loop", IMAGE_GUIDANCE));

  const data = withSandbox({
    id: `${sessionId}:data`,
    sessionId,
    rootfs: "data",
    egress: "mcp-only",
    syncWorkspace: true,
  })(sandboxLoop("flavour-data-loop", DATA_GUIDANCE));

  const office = withSandbox({
    id: `${sessionId}:office`,
    sessionId,
    rootfs: "office",
    egress: "mcp-only",
    syncWorkspace: true,
  })(sandboxLoop("flavour-office-loop", OFFICE_GUIDANCE));

  const routerPattern = router<SessionData>(
    {
      basic: "Quick one-off shell / general Linux work in a throwaway box",
      image_processing:
        "Image manipulation — Pillow, OpenCV (cv2), imagemagick (resize, convert, analyze images)",
      data: "Data ANALYSIS — pandas/numpy/polars over datasets (incl. xlsx/csv), matplotlib/seaborn plots, reports",
      office:
        "Document EDITING — modify/create Word (docx), Excel (xlsx) or PDF files themselves (not analyze their data)",
    },
    { liveEvents: true },
  );

  const routesPattern = routes<SessionData>(
    {
      basic,
      image_processing: image,
      data,
      office,
    },
    { liveEvents: true },
  );

  const synth = synthesizer<SessionData>({
    mode: "thread",
    patternId: "flavoured-sandbox-synth",
    liveEvents: true,
  });

  return [routerPattern, routesPattern, synth];
}

export const flavouredSandboxAgent: AgentConfig = {
  id: "flavoured-sandbox",
  name: "Sandbox · Flavoured (router)",
  description:
    "Routes each turn to a purpose-built sandbox flavour — base (ephemeral), image-processing, or data.",
  icon: "🧪",
  servers: [],
  createPatterns,
};
