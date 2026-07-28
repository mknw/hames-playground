/**
 * Microsoft 365 Agent (Pattern C / #110)
 *
 * Answers questions about the signed-in user's own Microsoft 365 data by
 * calling Graph **as that user**: the app-side `graph` tools resolve a
 * delegated per-user token server-side (see `lib/app-tools/graph.server.ts`),
 * so Entra enforces the scope and no credential ever reaches the model.
 *
 * Tools available: `graph_me` (profile), `graph_calendar_today` (today's
 * events), `graph_mail_recent` (inbox, optionally unread-only) — enough for a
 * "what does my day look like?" briefing — plus `graph_file_ingest`, which pulls
 * one of the person's own OneDrive/SharePoint files into this conversation's Data
 * Stash so later turns (retriever, sandbox) can work on it. Further graph tools
 * appear in `tools.graph` automatically once registered, so this agent needs no
 * change to pick them up.
 */
"use server";

import {
  simpleLoop,
  synthesizer,
  Tools,
  createLoopControllerAdapter,
  type ConfiguredPattern,
} from "../../harness-patterns";
import type { SessionData } from "../session.server";
import type { AgentConfig } from "../registry.server";

async function createPatterns(_sessionId: string): Promise<ConfiguredPattern<SessionData>[]> {
  const tools = await Tools();
  const graphTools = tools.graph ?? [];

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
  icon: "🪟",
  // Not an MCP gateway server: these tools run in-process so the per-user
  // token stays server-side (#107). Listed for UI display only.
  servers: ["graph (app-side, per-user)"],
  createPatterns,
};
