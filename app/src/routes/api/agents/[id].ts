/**
 * Agent Trigger Endpoint
 *
 *   POST /api/agents/:id
 *     Authorization: Bearer <shared-secret>   → resolves to a userId
 *     Body: multipart/form-data
 *       transcribed_command  (text) → harness input
 *       short_description     (text) → sticky conversation title
 *       original_recording    (file) → stored in the Data Stash for provenance
 *                                        + playback (keyed by the run id)
 *   → 202 { run_id }     # run_id == sessionId == conversation row id
 *
 * Fires a fixed agent (per :id) asynchronously, in-process: the row is
 * persisted as a `kind='action'` conversation (status='running'), the run is
 * kicked off WITHOUT awaiting, and 202 returns immediately. See
 * `action-runner.server.ts` for the execution model and `INSTRUCTIONS.md` for
 * the design + the persistent-node-server caveat.
 */

import type { APIEvent } from "@solidjs/start/server";
import { getAgent } from "../../../lib/harness-client/registry.server";
import {
  bearerSecret,
  resolveActionUser,
} from "../../../lib/auth/action-tokens.server";
import {
  seedActionRow,
  runAgentInBackground,
  type ActionTrigger,
} from "../../../lib/harness-client/action-runner.server";
import { storeDocument } from "../../../lib/document-store.server";
import { guessMimeType } from "../../../lib/stash/upload-service.server";
import { newSessionId } from "../../../lib/session-id";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function POST(event: APIEvent) {
  const agentId = event.params.id;

  // 1. Unknown agent → 404, before doing anything else.
  if (!getAgent(agentId)) {
    return json({ error: `Unknown agent: ${agentId}` }, 404);
  }

  // 2. Bearer secret → userId (per-device map in configs/action-tokens.yaml).
  const userId = resolveActionUser(
    bearerSecret(event.request.headers.get("authorization")),
  );
  if (!userId) {
    return json({ error: "Unauthorized" }, 401);
  }

  // 3. Parse the multipart body.
  let form: FormData;
  try {
    form = await event.request.formData();
  } catch {
    return json({ error: "multipart/form-data body required" }, 400);
  }

  const transcribedCommand = String(
    form.get("transcribed_command") ?? "",
  ).trim();
  if (!transcribedCommand) {
    return json({ error: "transcribed_command is required" }, 400);
  }
  const shortDescription = String(form.get("short_description") ?? "").trim();

  const runId = newSessionId();

  // 4. Store the recording in the Data Stash (keyed by runId, so it surfaces in
  //    that conversation's "Your Uploads" and is playable via ?download).
  //    Best-effort: a storage failure (e.g. Redis down) must not block the run.
  let recording: Pick<
    ActionTrigger,
    "recordingDocId" | "recordingFilename" | "recordingMimeType"
  > = {};
  const file = form.get("original_recording");
  if (
    file != null &&
    typeof file !== "string" &&
    typeof (file as Blob).arrayBuffer === "function"
  ) {
    const blob = file as File;
    const filename = blob.name || "recording";
    const mimeType = blob.type || guessMimeType(filename);
    try {
      const bytes = Buffer.from(await blob.arrayBuffer()).toString("base64");
      const doc = await storeDocument({
        sessionId: runId,
        filename,
        mimeType,
        content: bytes,
        encoding: "base64",
      });
      recording = {
        recordingDocId: doc.id,
        recordingFilename: filename,
        recordingMimeType: mimeType,
      };
    } catch (err) {
      console.error(`[action] failed to store recording for ${runId}:`, err);
    }
  }

  const trigger: ActionTrigger = {
    transcribedCommand,
    shortDescription,
    ...recording,
  };

  // 5. Insert the observable row before returning, so the action is visible
  //    (with a running spinner) the moment the caller gets its 202.
  try {
    await seedActionRow(runId, userId, agentId, trigger);
  } catch (err) {
    console.error(`[action] failed to seed action row for ${runId}:`, err);
    return json({ error: "Failed to create action" }, 500);
  }

  // 6. Fire-and-forget the harness run. Intentionally NOT awaited — the run
  //    persists its own result/status on completion (persistent-node-server
  //    assumption; see INSTRUCTIONS.md).
  void runAgentInBackground(runId, userId, transcribedCommand, agentId, trigger);

  // 7. 202 Accepted — run_id is the sessionId / conversation row id.
  return json({ run_id: runId }, 202);
}
