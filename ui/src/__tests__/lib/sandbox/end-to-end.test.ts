/**
 * End-to-end integration test — `withSandbox(actorCritic(...))`.
 *
 * Build-order step 4 (see docs/plan/sandbox.md → "v0 build order"). Proves the
 * full chain composes: a real `actorCritic` driven by the real BAML adapters,
 * wrapped in `withSandbox`, dispatching through real `callTool` and the real
 * ALS scope, to a real `DockerBackend` whose Docker engine and MCP SDK have
 * been mocked at their lowest seam.
 *
 * Concretely — a scripted "count the words in this string" task. The mocked
 * BAML actor proposes:
 *   turn 1 → `sandbox_write` to `/work/count.py`
 *   turn 2 → `sandbox_bash` running `python3 /work/count.py`
 * The mocked critic accepts after the second turn; the mocked in-VM shell
 * MCP simulates the python execution and returns the word count. The chain
 * terminates with the count on `scope.data.result`.
 *
 * What this test rules in (over step 3's unit tests):
 *   - actorCritic loop integrates with the adapter's sandbox-aware prompt
 *     enrichment (the BAML actor sees `sandbox_*` in its `tools` arg).
 *   - The real `callTool` routes sandbox-owned names to the in-VM transport.
 *   - DockerBackend.boot + connectMcp + destroy sequence end-to-end.
 *   - The host gateway client is never reached for sandbox-owned calls.
 *   - On critic acceptance, the chain returns with `result.data.result`
 *     equal to the last sandbox_bash output.
 *
 * Like docker-backend.test.ts, the docker CLI (`node:child_process.spawn`)
 * and the MCP SDK (Stdio + Streamable HTTP transports + Client) are mocked,
 * so no real Docker engine is required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mockAction, mockCriticResult } from '../../mocks/baml'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

// ---- Mock `node:child_process.spawn` -------------------------------------
// `DockerBackend` shells out to `docker run` / `rm` / `inspect`. Each spawn
// returns a fake child whose behavior is `spawnPlan`-driven (set per test
// when needed; otherwise returns stdout = a stable container id).
type SpawnPlan = (cmd: string, args: string[]) => { stdout?: string; stderr?: string; code?: number }
let spawnPlan: SpawnPlan = (_cmd, args) =>
  args[0] === 'run' ? { stdout: 'cid-integration', code: 0 } : { stdout: '', code: 0 }
const spawnCalls: Array<{ cmd: string; args: string[] }> = []

function mockSpawn(cmd: string, args: string[]) {
  spawnCalls.push({ cmd, args })
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    kill: () => void
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => {}
  const plan = spawnPlan(cmd, args)
  queueMicrotask(() => {
    if (plan.stdout) child.stdout.emit('data', Buffer.from(plan.stdout))
    if (plan.stderr) child.stderr.emit('data', Buffer.from(plan.stderr))
    child.emit('close', plan.code ?? 0)
  })
  return child
}

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
  default: { spawn: mockSpawn },
}))

// ---- Mock the in-VM MCP SDK clients --------------------------------------
// `connectMcp` opens one client per in-VM server via `docker exec -i <cid>
// init.sh serve <key>`. We simulate that here: filesystem keeps an in-memory
// file map; shell "executes" python3 against the stored script. The
// simulator parses one specific contract — a `text = "..."` assignment and a
// `print(len(text.split()))` — which is exactly what our actor writes.
const sandboxFiles = new Map<string, string>()
const inVmCalls: Array<{ server: string; name: string; args: unknown }> = []

function simulatePython3(scriptPath: string): string {
  const src = sandboxFiles.get(scriptPath) ?? ''
  const m = src.match(/text\s*=\s*"([^"]*)"/)
  if (!m) return '0'
  const wordCount = m[1].split(/\s+/).filter(Boolean).length
  return String(wordCount)
}

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    args: string[]
    constructor(opts: { args: string[] }) {
      this.args = opts.args
    }
  },
}))

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    private serverKey = 'unknown'
    async connect(transport: { args: string[] }) {
      // launch argv ends with `serve <key>`
      this.serverKey = transport.args[transport.args.length - 1]
    }
    async listTools() {
      if (this.serverKey === 'filesystem') {
        return {
          tools: [
            { name: 'read_text_file', description: 'read', inputSchema: { type: 'object' } },
            { name: 'write_file', description: 'write', inputSchema: { type: 'object' } },
            { name: 'edit_file', description: 'edit', inputSchema: { type: 'object' } },
            { name: 'list_directory', description: 'list', inputSchema: { type: 'object' } },
            { name: 'search_files_content', description: 'search', inputSchema: { type: 'object' } },
          ],
        }
      }
      if (this.serverKey === 'shell') {
        return { tools: [{ name: 'bash', description: 'shell', inputSchema: { type: 'object' } }] }
      }
      return { tools: [] }
    }
    async callTool({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) {
      inVmCalls.push({ server: this.serverKey, name, args })
      if (name === 'write_file' && typeof args.path === 'string' && typeof args.content === 'string') {
        sandboxFiles.set(args.path, args.content)
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }], isError: false }
      }
      if (name === 'bash' && typeof args.command === 'string') {
        // very narrow simulator: `python3 <path>` runs the stored script.
        const m = args.command.match(/python3\s+(\S+)/)
        if (m) {
          const stdout = simulatePython3(m[1])
          return { content: [{ type: 'text', text: stdout }], isError: false }
        }
        return { content: [{ type: 'text', text: '' }], isError: false }
      }
      return { content: [{ type: 'text', text: 'ok' }], isError: false }
    }
    async close() {}
  },
}))

// The host gateway client must never be reached for a sandbox-owned tool.
// If construction is ever attempted, count it so we can fail loudly.
let gatewayConstructed = 0
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    constructor() {
      gatewayConstructed += 1
    }
  },
}))

// ---- Mock BAML -----------------------------------------------------------
// The adapter dynamically imports `../../../baml_client`; vi.mock matches by
// resolved path, so we replace the whole module. `inlinedbaml` is also
// pulled in by the adapter's template-extraction code — mock it to noop so
// the test doesn't depend on a generated client.
const mockActorController = vi.fn()
const mockCritic = vi.fn()

vi.mock('../../../../baml_client', () => ({
  b: {
    ActorController: mockActorController,
    Critic: mockCritic,
    // The adapter doesn't call these here, but the import would fail at the
    // destructuring site otherwise.
    LoopController: vi.fn(),
    Router: vi.fn(),
    Synthesize: vi.fn(),
    ResultDescribe: vi.fn(),
  },
}))

vi.mock('../../../../baml_client/inlinedbaml', () => ({
  getBamlFiles: () => ({}),
}))

// ---- Mock host-gateway listTools ----------------------------------------
// The adapter's gateway-side `filterToolDescriptions` calls `mcpListTools()`.
// In a sandbox-only test the gateway returns nothing (no host tools needed).
vi.mock('../../../lib/harness-patterns/mcp-client.server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/harness-patterns/mcp-client.server')>()
  return {
    ...actual,
    listTools: vi.fn().mockResolvedValue([]),
  }
})

beforeEach(() => {
  spawnCalls.length = 0
  inVmCalls.length = 0
  sandboxFiles.clear()
  gatewayConstructed = 0
  mockActorController.mockReset()
  mockCritic.mockReset()
  spawnPlan = (_cmd, args) =>
    args[0] === 'run' ? { stdout: 'cid-integration', code: 0 } : { stdout: '', code: 0 }
})

describe('withSandbox(actorCritic) end-to-end — word count', () => {
  it('writes a script, runs it, and returns the count via the critic-accepted result', async () => {
    const { actorCritic } = await import('../../../lib/harness-patterns/patterns/actorCritic.server')
    const { createScope } = await import('../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../lib/harness-patterns/patterns')
    const {
      createActorControllerAdapter,
      createCriticAdapter,
    } = await import('../../../lib/harness-patterns/baml-adapters.server')
    const { withSandbox } = await import('../../../lib/sandbox/with-sandbox.server')

    const script =
      'text = "the quick brown fox jumps over the lazy dog"\nprint(len(text.split()))\n'

    mockActorController
      .mockResolvedValueOnce(
        mockAction({
          tool_name: 'sandbox_write',
          tool_args: JSON.stringify({ path: '/work/count.py', content: script }),
        }),
      )
      .mockResolvedValueOnce(
        mockAction({
          tool_name: 'sandbox_bash',
          tool_args: JSON.stringify({ command: 'python3 /work/count.py' }),
        }),
      )

    mockCritic
      .mockResolvedValueOnce(
        mockCriticResult({ is_sufficient: false, suggested_approach: 'now run it' }),
      )
      .mockResolvedValueOnce(mockCriticResult({ is_sufficient: true }))

    const actor = createActorControllerAdapter([])
    const critic = createCriticAdapter()
    const pattern = withSandbox({ rootfs: 'base' })(
      actorCritic(actor, critic, [], { availableTools: [], maxRetries: 3, patternId: 'e2e' }),
    )

    const scope = createScope('e2e', { intent: 'count words in the string' })
    const view = createEventView({
      sessionId: 'e2e',
      createdAt: Date.now(),
      events: [
        {
          type: 'user_message' as const,
          ts: Date.now(),
          patternId: 'harness',
          data: { content: 'count words in this sentence' },
        },
      ],
      status: 'running' as const,
      data: {},
      input: 'count words in this sentence',
    })

    const result = await pattern.fn(scope, view)

    // 1. Critic-accepted result is the bash stdout (9 words in the sentence).
    expect(result.data.result).toBe(9)

    // 2. Actor was driven exactly twice (write → bash), critic exactly twice.
    expect(mockActorController).toHaveBeenCalledTimes(2)
    expect(mockCritic).toHaveBeenCalledTimes(2)

    // 3. The adapter prepended sandbox tools to the actor's prompt — proves
    //    the ALS scope reached `baml-adapters.server.ts` from inside the
    //    wrapper. (3rd arg of ActorController is the `tools` array.)
    const firstCallTools = mockActorController.mock.calls[0][2] as Array<{ name: string }>
    const firstCallNames = firstCallTools.map((t) => t.name)
    expect(firstCallNames).toEqual(
      expect.arrayContaining([
        'sandbox_bash',
        'sandbox_write',
        'sandbox_edit',
        'sandbox_list',
        'sandbox_read',
        'sandbox_search',
      ]),
    )

    // 4. Dispatch routed both sandbox calls to the in-VM transport (one
    //    write_file on filesystem, one bash on shell). Neither hit the
    //    gateway.
    const writes = inVmCalls.filter((c) => c.name === 'write_file')
    const bashes = inVmCalls.filter((c) => c.name === 'bash')
    expect(writes).toHaveLength(1)
    expect(bashes).toHaveLength(1)
    expect(writes[0].server).toBe('filesystem')
    expect(bashes[0].server).toBe('shell')
    expect(gatewayConstructed).toBe(0)

    // 5. Backend lifecycle: docker run once, docker rm once on exit.
    expect(spawnCalls.some((s) => s.args[0] === 'run')).toBe(true)
    expect(spawnCalls.some((s) => s.args[0] === 'rm')).toBe(true)
  })
})
