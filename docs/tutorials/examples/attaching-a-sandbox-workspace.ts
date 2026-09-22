// docs/tutorials/examples/attaching-a-sandbox-workspace.ts
//
// The worked example for `docs/tutorials/attaching-a-sandbox-workspace.md`. Every line of
// code below is lifted VERBATIM from that page's own TypeScript fences —
// nothing here is a paraphrase, and the pin
// `app/src/__tests__/docs/tutorials-examples-pins.test.ts` re-extracts those
// fences on every CI run and fails if this file and the page disagree by a
// byte. Outside them the file may carry only comments and `console.log`
// echoes, so the wiring you read here is the page's wiring.
//
// Taken:     #1 §2 "Supply the store", #2 §2 (the typed refusal), #3 §3 "Turn
//            it on" — in page order.
// Not taken: #4 §5 "The tenant seam". It re-imports `withSandbox`, which §3
//            already imports, and one module cannot bind the same import twice.
//            The resolver rule it teaches is the page's §5; read it there.
//
// TYPE-CHECKS ONLY. The store is a `declare const` — supplying it is the host's
// job, which is what §2 is about — and `withSandbox` needs a container engine.

import { configureWorkspaceStore } from "@hames/sandbox/workspace-store";
import type { WorkspaceStore } from "@hames/sandbox";

declare const store: WorkspaceStore;

configureWorkspaceStore({
  // Every document stored under this session, including hidden/archived ones —
  // the package filters those, because that policy is the sandbox's.
  list: store.list,
  // One document's body, or null when it is gone. A TTL expiry between the
  // list and the read is an ordinary case, not an error.
  get: store.get,
  // Store a file promoted out of /work/out.
  store: store.store,
  // Your extension→MIME table, and what it considers text.
  guessMimeType: store.guessMimeType,
  isTextMime: store.isTextMime,
});

import { WorkspaceStoreNotConfiguredError } from "@hames/sandbox";

declare const err: unknown;

if (err instanceof WorkspaceStoreNotConfiguredError) {
  // your "this deployment is misconfigured" path
}

import { withSandbox } from "@hames/sandbox";
import type { ConfiguredPattern } from "@hames/harness-patterns";
import type { AgentData } from "@hames/agents";

declare const loop: ConfiguredPattern<AgentData>;
declare const sessionId: string;

const sandboxed = withSandbox({
  id: sessionId, // REQUIRED for sync — see below
  sessionId, // the workspace key
  rootfs: "base",
  egress: "mcp-only",
  syncWorkspace: true,
})(loop);
