// docs/tutorials/examples/running-code-in-a-sandbox.ts
//
// The worked example for `docs/tutorials/running-code-in-a-sandbox.md`. Every line of
// code below is lifted VERBATIM from that page's own TypeScript fences —
// nothing here is a paraphrase, and the pin
// `app/src/__tests__/docs/tutorials-examples-pins.test.ts` re-extracts those
// fences on every CI run and fails if this file and the page disagree by a
// byte. Outside them the file may carry only comments and `console.log`
// echoes, so the wiring you read here is the page's wiring.
//
// Taken:     #1 §2 "Wrap a pattern" — the page's minimal containment shape.
// Not taken: #2 §4 "Flavours". It redeclares §2's `sessionId` and `loop` and
//            re-imports `ConfiguredPattern` and `AgentData`: two independent
//            sketches of the same wrapper, which cannot share one module.
//
// TYPE-CHECKS ONLY. The pattern being wrapped is a `declare const` — the page's
// way of standing up a value a compiler can see and a test cannot build — and a
// real run needs a container engine plus the rootfs images (page §6).

import { withSandbox } from "@hames/sandbox";
import type { ConfiguredPattern } from "@hames/harness-patterns";
import type { AgentData } from "@hames/agents";

declare const loop: ConfiguredPattern<AgentData>;
declare const sessionId: string;

const sandboxed = withSandbox({
  id: sessionId, // id-addressable: the same VM for every turn of this conversation
  sessionId, // per-session cap accounting
  rootfs: "base",
  egress: "mcp-only",
})(loop);
