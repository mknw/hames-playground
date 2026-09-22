// docs/tutorials/examples/hosting-the-harness.ts
//
// The worked example for `docs/tutorials/hosting-the-harness.md`. Every line of
// code below is lifted VERBATIM from that page's own TypeScript fences —
// nothing here is a paraphrase, and the pin
// `app/src/__tests__/docs/tutorials-examples-pins.test.ts` re-extracts those
// fences on every CI run and fails if this file and the page disagree by a
// byte. Outside them the file may carry only comments and `console.log`
// echoes, so the wiring you read here is the page's wiring.
//
// Taken:     fence #5, §5 "A complete minimal host" — the page's own complete
//            example, which is already written as a whole file.
// Not taken: #1 §1, #2 §3, #3 §4, #4 §4 — `declare const` sketches of the same
//            turn. The complete host supersedes them, and they redeclare each
//            other's names (`MyData`, `mySettings`, `onEvent`, `patterns`), so
//            no two of them can share one module.
//
// RUNS OFFLINE: no model, no MCP gateway, no container, no API key. See
// ./README.md for how to run it from your own project.

// host.ts — run with: npx tsx host.ts
//
// NOT `node --experimental-strip-types`: this package's `main` is `./index.ts`,
// and Node refuses to strip types under `node_modules`
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). `tsx` has no such rule.
import {
  harness,
  continueSession,
  DEFAULT_RUNTIME_CONFIG,
  simpleLoop,
  compactExecution,
  type CompactExecutionData,
  type ConfiguredPattern,
  type ContextEvent,
  type ControllerFn,
  type HarnessData,
  type RunFrame,
  type SimpleLoopData,
} from "@hames/harness-patterns";

// 0. One data shape for the whole chain. Each pattern constrains it (a loop
//    needs `SimpleLoopData`, the synthesizer `CompactExecutionData`), and the
//    index signature is what `harness` asks for.
interface HostData extends HarnessData, SimpleLoopData, CompactExecutionData {
  [key: string]: unknown;
}

// 1. A controller. Yours will call a model; this one is a stub so the file runs.
const controller: ControllerFn = async () => ({
  action: {
    reasoning: "nothing to look up",
    tool_name: "Return",
    tool_args: "{}",
    status: "done",
    is_final: true,
  },
});

// 2. Patterns.
const patterns: ConfiguredPattern<HostData>[] = [
  simpleLoop<HostData>(controller, ["Return"], {
    patternId: "work",
    liveEvents: true,
  }),
  compactExecution<HostData>({
    mode: "response",
    patternId: "answer",
    synthesize: async ({ userMessage }) => ({
      value: `You asked: ${userMessage}`,
    }),
  }),
];

// 3. The frame. `config` is where your own budgets go; the library's defaults
//    are a complete, valid starting point.
const frame: RunFrame = {
  config: { ...DEFAULT_RUNTIME_CONFIG, maxToolTurns: 4 },
  live: (event: ContextEvent) => console.log("[live]", event.type),
};

// 4. A turn. The runner opens the frame; nothing below needs to know it exists.
const first = await harness<HostData>(...patterns)(
  "what were the Q3 results?",
  "session-1",
  undefined,
  undefined,
  frame,
);
console.log(first.response);

// 5. A second turn on the same context, with the same frame.
const second = await continueSession<HostData>(
  first.serialized,
  patterns,
  "and Q4?",
  undefined,
  frame,
);
console.log(second.response);
