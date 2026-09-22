# Hosting the harness: running a turn in your own app

You have `@hames/harness-patterns` installed and some patterns composed. This
page is the smallest thing you need to know to run a turn from your own
application: what the **run frame** is, what each of its five slots does for
you, what happens when you skip it, and one complete host you can copy.

It assumes you already know what a pattern is. If you don't,
[`packages/harness-patterns/GUIDE.md`](../../packages/harness-patterns/GUIDE.md)
is the tour; come back here when you want to run one.

**The runnable version:** [`examples/hosting-the-harness.ts`](./examples/hosting-the-harness.ts) —
this page's code assembled into one file you can copy out and run.

---

## 1. The short version

Call an entry point. That is the whole contract:

```typescript
import { harness } from "@hames/harness-patterns";
import type { ConfiguredPattern, HarnessData } from "@hames/harness-patterns";

/** Your turn's data shape. The index signature is what every pattern needs. */
interface MyData extends HarnessData {
  [key: string]: unknown;
}
declare const myLoop: ConfiguredPattern<MyData>;
declare const mySynthesizer: ConfiguredPattern<MyData>;

const agent = harness<MyData>(myLoop, mySynthesizer);
const result = await agent("what were the Q3 results?");
```

`harness(...patterns)` returns a runner, and **the runner opens the run frame
for you**. So does `continueSession` (another turn on a stored context) and
`resumeHarness` (a turn that was paused at an approval gate). If those three are
how you run turns, you can stop reading at section 3 — the rest is for hosts
that need to put something in the frame, or that drive patterns directly.

---

## 2. What the frame is, and why there is one

Almost everything a running pattern needs is **ambient**: it is a property of the
run, not of any one call site, and threading it through every signature would
mean every intermediate pattern had to know about it. A tool call ten frames deep
has to reach the injection guard; a loop has to know the budget the host
configured; a prompt builder has to know which model this run's calls will take.

So they ride an `AsyncLocalStorage` scope — one, called the **run frame**, with
five named **slots**:

| slot         | what it holds                                                  | who reads it                          |
| ------------ | -------------------------------------------------------------- | ------------------------------------- |
| `guard`      | the active injection guard                                     | `callTool`, the retriever pattern     |
| `transports` | tool transports scoped to this run, innermost first            | `activeTransports()`, tool dispatch   |
| `config`     | the host's budgets and truncation limits                       | `runtimeConfig()`, every loop pattern |
| `live`       | where events go as they happen                                 | `emitLive` (via `trackEvent`)         |
| `inference`  | an opaque tier name, plus an optional per-role client override | your inference layer                  |

It is one frame rather than five stores because five stores meant five openers,
and an opener you forget fails **silently**: the guard is "present", the run is
green, and nothing is neutralized. That happened (#373). It also means one place
to look when you want to know what a run is carrying.

The frame is generic. Core does not know what your tier names mean, what a
"client" is, or what any of your transports do — `inference.tier` is an opaque
string your own inference layer narrows and interprets.

---

## 3. What happens if you skip it

`runChain` asks for the frame before it dispatches the first pattern, and throws
if there is none:

```
No run frame is open. A harness run must be opened with withRunFrame() — the
harness entry points (harness(...patterns), continueSession, resumeHarness) do
this for you; a script or background job that drives patterns directly must call
withRunFrame({}, fn) itself.
```

That is deliberate, and it is the reason the frame is worth having. Without the
refusal a frameless run would have no guard, the library's budgets instead of
yours, no live events and whatever tier your inference layer defaults to — four
degradations, none of which errors.

If you are driving patterns yourself — a script, a cron job, a test — open an
empty frame:

```typescript
import { withRunFrame } from "@hames/harness-patterns";
import { runChain } from "@hames/harness-patterns/patterns/chain.server";
import type {
  ConfiguredPattern,
  UnifiedContext,
} from "@hames/harness-patterns";

declare const ctx: UnifiedContext<Record<string, unknown>>;
declare const patterns: ConfiguredPattern<Record<string, unknown>>[];

await withRunFrame({}, () => runChain(ctx, patterns));
```

`{}` is a valid frame. Every slot then takes its default: no guard, no scoped
transports, the library's `DEFAULT_RUNTIME_CONFIG`, no live listener, no tier.

---

## 4. Filling the slots

Pass a frame to the entry point, as its last argument:

```typescript
import type {
  ContextEvent,
  HarnessRuntimeConfig,
} from "@hames/harness-patterns";

declare const agent: ReturnType<
  typeof import("@hames/harness-patterns").harness
>; // from §1
declare const input: string;
declare const sessionId: string;
declare const initialData: Record<string, unknown>;
declare const onEvent: (event: ContextEvent) => void;
declare const mySettings: HarnessRuntimeConfig;

const result = await agent(input, sessionId, initialData, onEvent, {
  config: mySettings,
  inference: { tier: "my-private-tier" },
});
```

`onEvent` is the ergonomic form of the `live` slot — pass it as the parameter and
the entry point puts it in the frame for you.

**Or open the frame yourself and let the entry point join it.** Do this when work
your turn _starts but does not await_ must keep the same slots — a detached
summarization, a background title generation. A nested entry joins the open frame
instead of opening a second one, provided it brings no slots of its own:

```typescript
import {
  withRunFrame,
  amendRunFrame,
  continueSession,
} from "@hames/harness-patterns";
import type {
  ConfiguredPattern,
  ContextEvent,
  HarnessData,
  HarnessResultScoped,
  HarnessRuntimeConfig,
} from "@hames/harness-patterns";

interface MyData extends HarnessData {
  [key: string]: unknown;
}
declare const mySettings: HarnessRuntimeConfig;
declare const tier: string;
declare const onEvent: (event: ContextEvent) => void;
declare const stored: string; // the serialized context from the previous turn
declare const patterns: ConfiguredPattern<MyData>[];
declare const message: string;
declare const summarizeInBackground: (
  r: HarnessResultScoped<MyData>,
) => Promise<void>;

await withRunFrame({ config: mySettings, inference: { tier } }, async () => {
  const result = await amendRunFrame({ live: onEvent }, () =>
    continueSession<MyData>(stored, patterns, message),
  );
  // Started inside the frame, so it keeps `config` and `inference` for its
  // whole continuation — which is what stops a detached summarization silently
  // changing provider or budget halfway through a turn.
  void summarizeInBackground(result);
  return result;
});
```

Note the entry point is called with **no** `onEvent` and **no** frame. A nested
entry that supplied either would be refused, by name — because a slot supplied
there would replace the enclosing run's, and "an inner call quietly replaced the
run's injection guard" is not a thing that should be possible by accident.

### `live` belongs to a RUN, not to the turn

Notice `live` is **amended around the run** above rather than put in the outer
frame beside `config` and `inference`. That asymmetry is the one thing on this
page that was learned the hard way.

A nested entry inherits the enclosing frame's listener — that is the affordance
that makes calling `continueSession` bare work at all. So if your turn starts a
**second** run inside the same frame (a title generator, a classifier, a
background summarizer — anything whose contract is that it fails quietly), that
run inherits your listener too, and everything it emits goes wherever your
listener sends it. In this repo's own app that meant a failed title generation —
documented as "no retry, no error event" — painting an inline error bubble in the
user's transcript.

The rule that falls out of it:

> Put in the frame what belongs to the **turn** (`config`, `inference`). Amend
> around the run what belongs to **one run** (`live`).

Sidecars then keep the turn's settings and tier — the whole reason for opening
the frame that wide — and keep none of the wire to the user.

### Scoping below a run

Two things legitimately narrow a slot for part of a run:
`withInjectionGuard(cfg)(pattern)` and `withSandbox(...)`. Both use
`amendRunFrame`, which merges into the open frame — and the merge rules are **not
uniform**:

- `transports` **prepend**: innermost first, outer scopes still reachable. Two
  nested sandboxes both own `sandbox_bash`, and only an order answers "which
  machine".
- `guard` **widens**: an inner guard is unioned with the enclosing one at
  construction, so it can add coverage and never remove it.
- everything else **replaces** for the duration.

`amendRunFrame` refuses outside a frame: something that scopes below a run needs
a run.

---

## 5. A complete minimal host

One file, no framework, no database. It builds a pattern, opens a frame with a
budget and a live listener, runs a turn, and runs a second turn on the same
context.

```typescript
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
```

Two things to notice, because they are the parts people get wrong:

- The frame goes to the **entry point**, not around it. Pass it as the last
  argument (as above) _or_ open it yourself and call the entry point bare
  (section 4) — but not both, or the nested entry is refused.
- `DEFAULT_RUNTIME_CONFIG` carries only the library's own knobs. If your patterns
  read host-specific settings — the sandbox package does — put your **whole**
  settings object in the `config` slot, not a projection of it.

---

## 6. Where to go next

- **Guards** — what the `guard` slot holds, how an agent declares one, and what
  the guard does to a hostile tool result: [guarding an
  agent](./guarding-an-agent.md).
- **Transports** — supplying your own tool backend: the same guide, § "Tool
  transports".
- **Your own provider or model** — filling the `inference` slot with a client
  override of your own: `packages/harness-baml/README.md` § "The role → client
  seam".
- **The frame's own reasoning** — why it refuses, why the store lives on a
  `globalThis` symbol, and what the per-slot merge asymmetry protects:
  `packages/harness-patterns/run-frame.server.ts`.
