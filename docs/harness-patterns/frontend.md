# Frontend Integration

Guide for integrating harness-patterns with SolidStart frontend.

---

## Architecture

```
src/lib/
├── harness-patterns/       # Core patterns library
│   ├── harness.server.ts
│   ├── router.server.ts
│   ├── patterns/
│   └── ...
│
├── harness-client/         # Frontend integration layer
│   ├── actions.server.ts   # Server actions
│   ├── session.server.ts   # Session management
│   └── index.ts
│
└── otel/                   # OpenTelemetry instrumentation
    ├── sdk.server.ts       # OTel SDK with CompactSpanExporter
    ├── ui-processor.server.ts
    └── ...
```

---

## Server Actions

The `harness-client` module provides server actions for SolidStart components.

### API

```typescript
"use server"

// Process a user message (uses default patterns)
export async function processMessage(
  sessionId: string,
  message: string
): Promise<HarnessResultScoped<SessionData>>

// Process with a specific agent from registry
export async function processMessageWithAgent(
  sessionId: string,
  message: string,
  agentId: string = "default"
): Promise<HarnessResultScoped<SessionData>>

// Get list of available agents
export async function getAgentList(): Promise<Array<{
  id: string
  name: string
  description: string
  icon: string
  servers: string[]
}>>

// Approve a pending action
export async function approveAction(
  sessionId: string
): Promise<HarnessResultScoped<SessionData>>

// Reject a pending action
export async function rejectAction(
  sessionId: string,
  reason?: string
): Promise<HarnessResultScoped<SessionData>>

// Clear session state
export function clearSession(sessionId: string): void
```

### Result Type

```typescript
interface HarnessResultScoped<T> {
  response: string            // AI response text
  data: T                     // Session data
  status: CtxStatus           // 'running' | 'paused' | 'done' | 'error'
  duration_ms: number         // Execution time
  context: UnifiedContext<T>  // Full context (for debugging)
  serialized: string          // JSON for persistence
}

interface SessionData {
  intent?: string
  lastAction?: ControllerAction
  pendingAction?: ControllerAction
  response?: string
  // ... pattern-specific data
}
```

---

## Component Integration

### Basic Chat Component

```tsx
import { createSignal, createUniqueId, onCleanup } from 'solid-js'
import {
  processMessage,
  approveAction,
  rejectAction,
  clearSession
} from '~/lib/harness-client'

export const ChatInterface = () => {
  const sessionId = createUniqueId()
  const [messages, setMessages] = createSignal<Message[]>([])
  const [loading, setLoading] = createSignal(false)
  const [pendingApproval, setPendingApproval] = createSignal<ControllerAction | null>(null)

  // Cleanup session on unmount
  onCleanup(() => clearSession(sessionId))

  const handleSend = async (content: string) => {
    // Add user message
    setMessages(prev => [...prev, {
      id: crypto.randomUUID(),
      role: 'user',
      content,
      timestamp: new Date()
    }])

    setLoading(true)
    try {
      const result = await processMessage(sessionId, content)

      // Add assistant response
      if (result.response) {
        setMessages(prev => [...prev, {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: result.response,
          timestamp: new Date()
        }])
      }

      // Handle approval flow
      if (result.status === 'paused' && result.data.pendingAction) {
        setPendingApproval(result.data.pendingAction)
      }
    } finally {
      setLoading(false)
    }
  }

  const handleApprove = async () => {
    setLoading(true)
    try {
      const result = await approveAction(sessionId)
      setPendingApproval(null)

      if (result.response) {
        setMessages(prev => [...prev, {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: result.response,
          timestamp: new Date()
        }])
      }
    } finally {
      setLoading(false)
    }
  }

  const handleReject = async () => {
    setLoading(true)
    try {
      const result = await rejectAction(sessionId)
      setPendingApproval(null)

      if (result.response) {
        setMessages(prev => [...prev, {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: result.response,
          timestamp: new Date()
        }])
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <MessageList messages={messages()} />

      <Show when={pendingApproval()}>
        <ApprovalDialog
          action={pendingApproval()!}
          onApprove={handleApprove}
          onReject={handleReject}
        />
      </Show>

      <ChatInput onSend={handleSend} disabled={loading()} />
    </div>
  )
}
```

### Approval Dialog

```tsx
interface ApprovalDialogProps {
  action: ControllerAction
  onApprove: () => void
  onReject: () => void
}

const ApprovalDialog = (props: ApprovalDialogProps) => {
  return (
    <div class="approval-dialog">
      <h3>Action Requires Approval</h3>

      <div class="action-details">
        <p><strong>Tool:</strong> {props.action.tool_name}</p>
        <p><strong>Reasoning:</strong> {props.action.reasoning}</p>
        <pre>{props.action.tool_args}</pre>
      </div>

      <div class="actions">
        <button onClick={props.onApprove}>Approve</button>
        <button onClick={props.onReject}>Reject</button>
      </div>
    </div>
  )
}
```

---

## Session Management

Sessions are managed server-side in `session.server.ts`.

### SessionData Interface

```typescript
interface SessionData {
  intent?: string
  lastAction?: ControllerAction
  pendingAction?: ControllerAction
  response?: string
  results?: unknown[]
  turn?: number
  approved?: boolean
  [key: string]: unknown  // Allow pattern-specific fields
}
```

### Session Storage

Default implementation uses in-memory storage:

```typescript
interface Session {
  sessionId: string
  patterns: ConfiguredPattern<SessionData>[]
  lastResult: HarnessResultScoped<SessionData> | null
  serializedContext: string | null
}

const sessions = new Map<string, Session>()
```

For production, replace with Redis/database:

```typescript
// session.server.ts
import { redis } from './redis'

export async function getSession(sessionId: string): Promise<Session | null> {
  const data = await redis.get(`session:${sessionId}`)
  return data ? JSON.parse(data) : null
}

export async function updateSession(
  sessionId: string,
  updates: Partial<Session>
): Promise<void> {
  const session = await getSession(sessionId)
  if (session) {
    await redis.set(
      `session:${sessionId}`,
      JSON.stringify({ ...session, ...updates }),
      'EX',
      3600  // 1 hour TTL
    )
  }
}
```

---

## Pattern Configuration

Patterns are lazily initialized per session in `actions.server.ts`:

```typescript
async function createPatterns(): Promise<ConfiguredPattern<SessionData>[]> {
  const tools = await Tools()
  const schema = await getSchema()

  // Use adapter factories (see baml-adapters.server.ts) — they wrap the generic
  // LoopController with the right context for each domain.
  const neo4jController = createNeo4jController(tools.neo4j ?? [])
  const webController = createWebSearchController(tools.web ?? [])

  const neo4jPattern = simpleLoop(neo4jController, tools.neo4j ?? [], {
    patternId: 'neo4j-query',
    schema
  })

  const webPattern = simpleLoop(webController, tools.web ?? [], {
    patternId: 'web-search'
  })

  const routerPattern = router(
    {
      neo4j: 'Database queries and graph operations',
      web_search: 'Web lookups and information retrieval'
    },
    {
      neo4j: neo4jPattern,
      web_search: webPattern
    }
  )

  // Synthesizer generates human-readable response
  const responseSynth = synthesizer({
    mode: 'thread',
    patternId: 'response-synth'
  })

  return [routerPattern, responseSynth]
}
```

JS-orchestration workflows (the kg-agent gateway's `code-mode` factory + generated tools) live in a separate agent — see [`code-mode.server.ts`](../../ui/src/lib/harness-client/examples/code-mode.server.ts) and [`examples.md` § 11. Code Mode Agent](examples.md#11-code-mode-agent).

---

## OpenTelemetry Integration

### Server Setup

OTel is initialized in `entry-server.tsx`:

```typescript
import './lib/otel/sdk.server'
```

The `CompactSpanExporter` provides clean console output:

```
[router] → neo4j (intent: "Query graph data")
[simpleLoop] neo4j-query ✓ (1234ms)
  [tool] read_neo4j_cypher ✓ (456ms)
[harness] Session cl-3 completed in 1500ms
```

### Telemetry Streaming

Spans can be streamed to the UI via SSE:

```typescript
// routes/api/telemetry/stream.ts
import { uiSpanProcessor } from '~/lib/otel/ui-processor.server'

export function GET() {
  const stream = new ReadableStream({
    start(controller) {
      const unsubscribe = uiSpanProcessor.subscribe((span) => {
        controller.enqueue(`data: ${JSON.stringify(span)}\n\n`)
      })

      return () => unsubscribe()
    }
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache'
    }
  })
}
```

### Client Subscription

```typescript
// hooks/useTelemetryStream.ts
import { createSignal, onCleanup } from 'solid-js'

export function useTelemetryStream() {
  const [spans, setSpans] = createSignal<Span[]>([])

  const eventSource = new EventSource('/api/telemetry/stream')

  eventSource.onmessage = (event) => {
    const span = JSON.parse(event.data)
    setSpans(prev => [...prev, span])
  }

  onCleanup(() => eventSource.close())

  return spans
}
```

---

## Error Handling

### Server Action Errors

```tsx
const handleSend = async (content: string) => {
  try {
    const result = await processMessage(sessionId, content)

    if (result.status === 'error') {
      // Handle application-level error
      setMessages(prev => [...prev, {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: `Error: ${result.response}`,
        timestamp: new Date(),
        isError: true
      }])
    }
  } catch (error) {
    // Handle network/serialization error
    console.error('Server action failed:', error)
  }
}
```

### Approval Flow Errors

```tsx
const handleApprove = async () => {
  try {
    await approveAction(sessionId)
  } catch (error) {
    if (error.message.includes('No pending operation')) {
      // Already processed or expired
      setPendingApproval(null)
    }
  }
}
```

---

## Best Practices

1. **Use `createUniqueId()`** - Each browser tab gets its own session
2. **Clean up on unmount** - Call `clearSession()` in `onCleanup()`
3. **Handle loading states** - Disable input during processing
4. **Null-check responses** - Response may be empty on errors
5. **Bind BAML methods** - Always use `.bind(b)` when passing to patterns
6. **Add synthesizer** - Include a synthesizer pattern for readable responses

---

## Notes

- `"use server"` must be at file top level, not nested in functions
- Server actions are automatically serialized by SolidStart
- Client only sees `HarnessResultScoped` (serializable data)
- Full session state is kept server-side
- OTel tracing is built into all patterns

---

## Agent Registry

The `harness-client` includes an agent registry for managing multiple agent configurations.

### Registry API

```typescript
// registry.server.ts
interface AgentConfig {
  id: string
  name: string
  description: string
  icon: string                // Emoji for UI
  servers: string[]           // MCP server namespaces used
  createPatterns: () => Promise<ConfiguredPattern<SessionData>[]>
}

// Register a new agent
registerAgent(config: AgentConfig): void

// Get agent by ID
getAgent(id: string): AgentConfig | undefined

// Get all agents
getAllAgents(): AgentConfig[]

// Get metadata (safe for client)
getAgentMetadata(): Array<{ id, name, description, icon, servers }>
```

### Using in Components

```tsx
import { createResource } from 'solid-js'
import { getAgentList, processMessageWithAgent } from '~/lib/harness-client'

const AgentSelector = () => {
  const [agents] = createResource(getAgentList)
  const [selectedAgent, setSelectedAgent] = createSignal('default')

  const handleSend = async (message: string) => {
    const result = await processMessageWithAgent(
      sessionId,
      message,
      selectedAgent()
    )
    // ...
  }

  return (
    <select onChange={e => setSelectedAgent(e.target.value)}>
      <For each={agents()}>
        {agent => <option value={agent.id}>{agent.icon} {agent.name}</option>}
      </For>
    </select>
  )
}
```

---

**Last Updated:** 2026-02-05
