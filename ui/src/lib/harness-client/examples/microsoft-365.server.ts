/**
 * Microsoft 365 Agent (Pattern C / #110)
 *
 * Answers questions about the signed-in user's own Microsoft 365 data by
 * calling Graph **as that user**: the app-side `graph` tools resolve a
 * delegated per-user token server-side (see `lib/app-tools/graph.server.ts`),
 * so Entra enforces the scope and no credential ever reaches the model.
 *
 * Profile, today's calendar and recent inbox mail — enough for a "what does my
 * day look like?" briefing, which the loop assembles from several calls in one
 * turn — plus finding and browsing the person's OneDrive/SharePoint files.
 *
 * It composes an explicit subset of `tools.graph` rather than the whole
 * namespace: see {@link MICROSOFT_365_TOOLS} for which tools, and why.
 */
"use server";

// @unocss-include — the icon class literal below must be extracted (see uno.config content.filesystem)
import {
  simpleLoop,
  synthesizer,
  Tools,
  createLoopControllerAdapter,
  type ConfiguredPattern,
} from "../../harness-patterns";
import type { SessionData } from "../session.server";
import type { AgentConfig } from "../registry.server";

/**
 * The graph tools this agent composes, in the order it should reach for them.
 *
 * **To give this agent another tool, add its name here.** An explicit list, not
 * all of `tools.graph`, because "a tool exists" and "this agent can do something
 * useful with it" are different questions — and for one tool the answer is no:
 *
 * `graph_file_ingest` is absent deliberately. It copies a file's bytes into the
 * conversation's Data Stash, where they are reachable only through a retriever
 * pattern — and this agent has none. Exposing it would advertise a capability
 * whose payoff the agent can't deliver: the model would ingest a file, get back a
 * document id, and have no way to read a word of it. The file tools it *does*
 * have (search + browse) are the half that works without a retriever.
 *
 * Nothing here gates the *registry*: a newly registered graph tool still appears
 * in `tools.graph` for every other consumer. This list only decides what this one
 * agent's loop is handed.
 */
export const MICROSOFT_365_TOOLS = [
  "graph_me",
  "graph_calendar_today",
  "graph_mail_recent",
  "graph_mail_attachments",
  "graph_files_search",
  "graph_files_list",
  "graph_files_recent",
  "graph_files_shared",
] as const;

async function createPatterns(_sessionId: string): Promise<ConfiguredPattern<SessionData>[]> {
  const tools = await Tools();
  const available = new Set(tools.graph ?? []);
  // Filtering the allowlist (rather than the namespace) keeps a tool that isn't
  // registered — a typo, a module not imported — out of the loop's tool list
  // instead of into it. Same shape as code-mode's meta-tool subset.
  const graphTools = MICROSOFT_365_TOOLS.filter((t) => available.has(t));

  const graphPattern = simpleLoop<SessionData>(
    createLoopControllerAdapter(graphTools),
    graphTools,
    {
      patternId: "microsoft-365",
      liveEvents: true,
      rememberPriorTurns: false,
      // A "what's on today?" briefing needs several calls in one turn
      // (calendar + mail, sometimes profile), plus room to recover from a
      // failed call, so this is deliberately higher than a single-shot loop.
      maxTurns: 8,
      // The controller never needs a URL to decide the next action, and a Loop
      // hit's webUrl is ~519 chars of base64 — half the hit. The synthesizer
      // still gets every webUrl for citation links (it reads the full events,
      // not this projection). `graph_mail_recent` is deliberately unprojected:
      // its webLink is short and its results are already capped previews.
      resultOmit: {
        graph_files_search: ["webUrl"],
        graph_files_list: ["webUrl"],
        graph_files_recent: ["webUrl"],
        graph_files_shared: ["webUrl"],
      },
    },
  );

  const responseSynth = synthesizer<SessionData>({
    mode: "thread",
    patternId: "response-synth",
    liveEvents: true,
  });

  return [graphPattern, responseSynth];
}

export const microsoft365Agent: AgentConfig = {
  id: "microsoft-365",
  name: "Microsoft 365",
  description:
    "Answers from your own Microsoft 365 account (delegated, per-user via Entra)",
  icon: "i-material-symbols-window-sharp",
  // Not an MCP gateway server: these tools run in-process so the per-user
  // token stays server-side (#107). Listed for UI display only.
  servers: ["graph (app-side, per-user)"],
  createPatterns,
};
