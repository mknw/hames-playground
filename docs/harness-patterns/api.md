# Harness Patterns API Reference

Complete API documentation for the harness-patterns framework.

> **Source:** See [`ui/src/lib/harness-patterns/`](../../ui/src/lib/harness-patterns/) for implementation details.

---

## Types

### UnifiedContext

Source of truth for session state.

```typescript
interface UnifiedContext<T> {
  sessionId: string
  createdAt: number
  events: ContextEvent[]
  status: CtxStatus           // 'running' | 'paused' | 'done' | 'error'
  error?: string
  data: T
  input: string
}
```

### ContextEvent

Events tagged with pattern origin.

```typescript
interface ContextEvent {
  type: EventType
  ts: number
  patternId: string
  data: unknown
}

type EventType =
  | 'user_message' | 'assistant_message'
  | 'tool_call' | 'tool_result'
  | 'controller_action' | 'critic_result'
  | 'pattern_enter' | 'pattern_exit'
  | 'approval_request' | 'approval_response'
  | 'error'
  | 'reference_attached' | 'intent_compacted'  // observability events emitted by withReferences / compactIntent
```

### PatternScope

Isolated workspace for pattern execution.

```typescript
interface PatternScope<T> {
  id: string
  events: ContextEvent[]      // Local events (uncommitted)
  data: T
  startTime: number
}
```

### ConfiguredPattern

Pattern with configuration metadata.

```typescript
interface ConfiguredPattern<T> {
  name: string
  fn: ScopedPattern<T>
  config: PatternConfig
}

type ScopedPattern<T> = (
  scope: PatternScope<T>,
  view: EventView
) => Promise<PatternScope<T>>
```

### BAML Types

```typescript
// From baml_client - standardized controller output
interface ControllerAction {
  reasoning: string
  tool_name: string           // Tool to call. In simpleLoop, `'Return'` exits the loop. In actorCritic, the actor's exit signals are ignored — the critic alone decides termination via `is_sufficient`.
  tool_args: string           // JSON payload
  status: string
  is_final: boolean           // simpleLoop only — actorCritic ignores this on the actor side
}

// Critic evaluation result
interface CriticResult {
  is_sufficient: boolean
  explanation: string
  suggested_approach?: string
}

// LoopTurn — entries pushed by simpleLoop on each iteration
interface LoopTurn {
  n: number
  reasoning?: string
  tool_call?: ToolCall
  tool_result?: ToolResult
  expansions?: ExpandedRef[]    // Refs resolved via ref:<id> this turn (rendered as "Expanded refs this turn")
}

interface ExpandedRef {
  ref_id: string
  content: string               // Full content (truncated to settings.maxResultChars)
}

// PriorResult — compact reference attached to LoopController as turns_previous_runs
interface PriorResult {
  ref_id: string                // Pass as ref:<id> in any tool's args to inline-expand
  tool: string
  summary: string
  expanded_in_turn: number | null  // Set explicitly to null when not yet expanded (MiniJinja `is none` semantics)
}
```

---

## Patterns

### simpleLoop

ReAct-style decide-execute loop.

```typescript
function simpleLoop<T>(
  controller: ControllerFn,
  tools: string[],
  config?: SimpleLoopConfig
): ConfiguredPattern<T>

interface SimpleLoopConfig extends PatternConfig {
  schema?: string                 // Injected to controller
  maxTurns?: number               // Default: 5
  rememberPriorTurns?: boolean    // Default: true
  priorTurnCount?: number         // Default: 3
  includeFailedResults?: boolean  // Default: false
  fewShots?: FewShot[]            // EXAMPLES block in controller prompt
  onToolResult?: OnToolResult     // Enrich/transform tool results pre-commit (closes #7)
}

type OnToolResult = (
  toolName: string,
  result: { success: boolean; data: unknown; error?: string },
  context: { callId?: string; args: unknown }
) => Promise<{ data?: unknown } | void> | { data?: unknown } | void
```

See [`ui/src/lib/harness-patterns/README.md` § Hooks](../../ui/src/lib/harness-patterns/README.md#simpleloopcontroller-tools-config) for the full hook contract and the `enrichNeo4jResult` recipe.

### actorCritic

Generate-evaluate loop with retry logic.

```typescript
function actorCritic<T>(
  actor: ControllerFn,
  critic: CriticFn,
  tools: string[],
  config?: ActorCriticConfig
): ConfiguredPattern<T>

interface ActorCriticConfig extends PatternConfig {
  availableTools?: string[]
  maxRetries?: number             // Default: 3
  onToolResult?: OnToolResult     // Same shape + semantics as SimpleLoopConfig
}
```

### withReferences

Wrap a pattern so that on entry, an LLM-driven selector picks relevant prior `tool_result` events and attaches them to the inner pattern's `priorResults` channel via `scope.data.attachedRefs`. See [`with-references.md`](with-references.md) for full design + selection cases.

```typescript
function withReferences<T>(
  pattern: ConfiguredPattern<T>,
  config?: WithReferencesConfig
): ConfiguredPattern<T>

interface WithReferencesConfig extends PatternConfig {
  scope?: 'self' | 'global'    // Default: 'global'
  source?: string | string[]   // Explicit patternId allow-list; overrides scope
  maxRefs?: number             // Default: 5 (cap after selection)
  selector?: SelectorFn        // Override default LLM selector (b.ReferenceSelector)
}

type SelectorFn = (input: {
  intent: string
  recentMessages: Array<{ role: 'user' | 'assistant'; content: string }>
  candidates: ReferenceCandidate[]
}) => Promise<{
  selected: Array<{ ref_id: string; reason: string }>
  reasoning: string
}>
```

**Skip optimizations:** the LLM selector is bypassed and a `reference_attached` event with a `skipped` field is emitted when:
- `skipped: 'empty'` — no eligible candidates
- `skipped: 'single'` — exactly one candidate (attached unconditionally)
- `skipped: 'cached'` — process-lifetime LRU hit on `(intent_hash, stash_snapshot_hash)`

**Composes with `expandPreviousResult`:** the wrapper attaches *compact* refs (summary only). Inside the loop, the controller can either pass `ref:<ref_id>` as a tool argument (inline-expanded by `resolveRefs` before dispatch) or call the synthetic `expandPreviousResult` tool to load full content into a turn record. Either path records an `expansions[]` entry on the `LoopTurn`; the compact ref's `expanded_in_turn` field is then annotated with the first turn that expanded it, rendered as `(expanded in turn N)`.

### synthesizer

Generate human-readable response from pattern output.

```typescript
function synthesizer<T>(config: SynthesizerConfig): ConfiguredPattern<T>

interface SynthesizerConfig extends PatternConfig {
  mode: 'message' | 'response' | 'thread'
  synthesize?: SynthesisFn
  skipIfHasResponse?: boolean
}
```

### compactIntent

Rewrite the latest user message into a self-contained `data.intent` brief
before a router-less actor runs, resolving bare back-references (*"try again"*,
*"I can't find the file"*) against recent message history. The chain-based
counterpart to `router` (which sets `data.intent` as a side-effect of
classification). Writes the carrier `actorCritic`/`simpleLoop` already read, so
no controller-prompt change.

```typescript
function compactIntent<T>(config?: CompactIntentConfig): ConfiguredPattern<T>

type CompactIntentConfig = PatternConfig
// Default viewConfig: { fromLast: false, fromLastNTurns: 5,
//   eventTypes: ['user_message', 'assistant_message'] }
```

**Behavior:**
- Calls BAML `CompactIntent` (cheap `DescribeAnthropic` client) and writes the
  result to `scope.data.intent`.
- **Turn 1 (no history):** skips the LLM call and passes the message through
  unchanged.
- **Backward-safe:** on any failure it leaves `intent` unset, so the actor falls
  back to the raw user message — never fatal.
- Emits an `intent_compacted` observability event (carrying the LLM call),
  mirroring `withReferences`' `reference_attached`.

Adopted by the Sandbox · Session agent ([#83](https://github.com/mknw/harness-playground/issues/83) Part A). Part E (the `compact*` naming unification) is a deferred follow-up.

### router

Route to patterns based on intent classification.

```typescript
function router<T>(
  routes: Routes,
  patterns: RoutePatterns<T>,
  config?: PatternConfig
): ConfiguredPattern<T>

type Routes = Record<string, string>  // name -> description
type RoutePatterns<T> = Record<string, ConfiguredPattern<T>>
```

### parallel

Execute patterns concurrently.

```typescript
function parallel<T>(
  patterns: ConfiguredPattern<T>[],
  config?: PatternConfig
): ConfiguredPattern<T>
```

**Behavior:**
- Runs all patterns via `Promise.allSettled`
- Merges events from fulfilled patterns
- Logs errors from rejected patterns
- Merges data from all branches

### judge

Evaluate and rank outputs from parallel patterns.

```typescript
function judge<T>(
  evaluator: EvaluatorFn,
  config?: JudgeConfig
): ConfiguredPattern<T>

type EvaluatorFn = (
  query: string,
  candidates: Array<{ source: string; content: string }>
) => Promise<{
  reasoning: string
  rankings: Array<{ source: string; score: number; reason: string }>
  best: { source: string; content: string } | null
}>

interface JudgeConfig extends PatternConfig {
  // Uses patternId for identification
}
```

### guardrail

Wrap pattern with validation rails.

```typescript
function guardrail<T>(
  pattern: ConfiguredPattern<T>,
  config: GuardrailConfig<T>
): ConfiguredPattern<T>

interface GuardrailConfig<T> extends PatternConfig {
  rails: Rail<T>[]
  circuitBreaker?: CircuitBreakerConfig
  onBlock?: (rail: string, reason: string) => void
}

interface Rail<T> {
  name: string
  phase: 'input' | 'execution' | 'output'
  check: (ctx: RailContext<T>) => Promise<RailResult>
}

interface RailResult {
  ok: boolean
  reason?: string
  action?: 'block' | 'warn' | 'redact' | 'retry'
  redacted?: string
}

interface CircuitBreakerConfig {
  maxFailures: number
  windowMs: number
  cooldownMs: number
}
```

**Built-in Rails:**
```typescript
piiScanRail       // Detect and redact secrets/tokens
pathAllowlistRail // Block paths outside workspace
driftDetectorRail // Detect large file changes (>60%)
```

### hook

Execute pattern on lifecycle events.

```typescript
function hook<T>(
  pattern: ConfiguredPattern<T>,
  config: HookConfig<T>
): ConfiguredPattern<T>

interface HookConfig<T> extends PatternConfig {
  trigger: HookTrigger
  background?: boolean        // Fire-and-forget
}

type HookTrigger = 'session_close' | 'error' | 'approval_timeout' | 'custom'
```

### chain

Sequential pattern composition.

```typescript
async function chain<T>(
  ctx: UnifiedContext<T>,
  patterns: ConfiguredPattern<T>[]
): Promise<UnifiedContext<T>>
```

### configurePattern

Create a custom pattern from a function.

```typescript
function configurePattern<T>(
  name: string,
  fn: ScopedPattern<T>,
  config?: PatternConfig
): ConfiguredPattern<T>
```

---

## Harness Functions

### harness

Create callable agent from patterns.

```typescript
function harness<T>(
  ...patterns: ConfiguredPattern<T>[]
): (input: string, sessionId?: string, initialData?: Partial<T>) => Promise<HarnessResultScoped<T>>

interface HarnessResultScoped<T> {
  response: string
  data: T
  status: CtxStatus
  duration_ms: number
  context: UnifiedContext<T>
  serialized: string          // JSON for persistence
}
```

### resumeHarness

Resume paused harness after approval.

```typescript
async function resumeHarness<T>(
  serializedContext: string,
  patterns: ConfiguredPattern<T>[],
  approved: boolean
): Promise<HarnessResultScoped<T>>
```

### continueSession

Continue session with new input.

```typescript
async function continueSession<T>(
  serializedContext: string,
  patterns: ConfiguredPattern<T>[],
  newInput: string
): Promise<HarnessResultScoped<T>>
```

---

## Tools

### Tools

Fetch and group MCP tools by namespace.

```typescript
async function Tools(): Promise<ToolSet>

type ToolSet = Record<string, string[]> & { all: string[] }

// Example:
const tools = await Tools()
tools.neo4j  // ['read_neo4j_cypher', 'write_neo4j_cypher', ...]
tools.web    // ['search', 'fetch', 'fetch_content']
tools.all    // All available tools
```

### callTool

Execute MCP tool.

```typescript
async function callTool(
  toolName: string,
  args: Record<string, unknown>
): Promise<ToolCallResult>

interface ToolCallResult {
  success: boolean
  data: unknown
  error?: string
}
```

### listTools

List available MCP tools.

```typescript
async function listTools(): Promise<MCPToolDescription[]>

interface MCPToolDescription {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}
```

---

## BAML Adapters

Factory functions for creating BAML-backed controllers:

```typescript
// Generic adapters
createLoopControllerAdapter(tools: string[]): ControllerFn
createActorControllerAdapter(tools: string[]): ControllerFn
createCriticAdapter(): CriticFn

// Namespace-specific adapters
createNeo4jController(tools: string[]): ControllerFn
createWebSearchController(tools: string[]): ControllerFn
createMemoryController(tools: string[]): ControllerFn
createContext7Controller(tools: string[]): ControllerFn
createGitHubController(tools: string[]): ControllerFn
createFilesystemController(tools: string[]): ControllerFn
createRedisController(tools: string[]): ControllerFn
createDatabaseController(tools: string[]): ControllerFn
```

---

## EventView API

Fluent API for querying events.

```typescript
function createEventView<T>(ctx: UnifiedContext<T>): EventView

interface EventView {
  // Pattern selectors
  fromPattern(id: string): EventView
  fromPatterns(ids: string[]): EventView
  fromLastPattern(): EventView
  fromLastNPatterns(n: number): EventView
  fromAll(): EventView

  // Type selectors
  ofType(type: EventType): EventView
  ofTypes(types: EventType[]): EventView
  tools(): EventView          // tool_call + tool_result
  messages(): EventView       // user_message + assistant_message
  actions(): EventView        // controller_action

  // Quantity selectors
  last(n: number): EventView
  first(n: number): EventView
  since(ts: number): EventView

  // Execution
  get(): ContextEvent[]
  serialize(): string         // XML format for LLM
  exists(): boolean
  count(): number
}
```

---

## Configuration

### PatternConfig

Base configuration for all patterns.

```typescript
interface PatternConfig {
  patternId?: string
  commitStrategy?: CommitStrategy
  trackHistory?: TrackHistory
  viewConfig?: ViewConfig
}

type CommitStrategy = 'always' | 'on-success' | 'last' | 'never'

type TrackHistory = boolean | EventType | EventType[]

interface ViewConfig {
  fromPatterns?: string[]
  fromLastN?: number
  fromLast?: boolean          // Default: true
  eventTypes?: EventType[]
  limit?: number
}
```

### Pattern Defaults

| Pattern | trackHistory | commitStrategy |
|---------|-------------|----------------|
| simpleLoop | `'tool_result'` | `'on-success'` |
| actorCritic | `'tool_result'` | `'on-success'` |
| synthesizer | `'assistant_message'` | `'always'` |
| compactIntent | `'intent_compacted'` | `'always'` |
| router | `false` | `'always'` |
| chain | `false` | `'always'` |

---

## Context Helpers

```typescript
// Create new context
function createContext<T>(input: string, initialData?: T, sessionId?: string): UnifiedContext<T>

// Serialize/deserialize
function serializeContext<T>(ctx: UnifiedContext<T>): string
function deserializeContext<T>(json: string): UnifiedContext<T>

// Scope management
function createScope<T>(patternId: string, data: T): PatternScope<T>
function createEvent(type: EventType, patternId: string, data: unknown): ContextEvent
function trackEvent<T>(scope: PatternScope<T>, type: EventType, data: unknown, shouldTrack: boolean): void
function commitEvents<T>(ctx: UnifiedContext<T>, scope: PatternScope<T>, strategy: CommitStrategy): void
function enterPattern<T>(ctx: UnifiedContext<T>, patternId: string): void
function exitPattern<T>(ctx: UnifiedContext<T>, patternId: string, status: CtxStatus): void

// Status setters
function setError<T>(ctx: UnifiedContext<T>, error: string, patternId: string): void
function setDone<T>(ctx: UnifiedContext<T>): void
function setPaused<T>(ctx: UnifiedContext<T>): void

// Utilities
function generateId(prefix?: string): string
function resolveConfig(patternName: string, config?: PatternConfig): PatternConfig
function shouldTrack(type: EventType, trackHistory: TrackHistory): boolean
```

---

## Constants

```typescript
const MAX_TOOL_TURNS = 5
const MAX_RETRIES = 3

const DEFAULT_TRACK_HISTORY: Record<string, TrackHistory>
const DEFAULT_COMMIT_STRATEGY: Record<string, CommitStrategy>
```

---

**Last Updated:** 2026-06-15
