/**
 * Flavoured-sandbox multi-turn workspace regression test (#243 follow-up).
 *
 * Reproduces the live failure in `.harness-logs/243.json` at the routing level:
 *
 *   turn 1 "ingest the attached spreadsheet"  → router picks `data`   → the file
 *                                               is in /work/in, all good
 *   turn 2 "list the files in /work/in"       → router picks `basic`  → a
 *                                               DIFFERENT flavour container
 *
 * Before the fix, `basic` was the one route built without an attachment `id`
 * (anonymous warm pool), and `syncWorkspace` is a no-op without one — so turn 2
 * ran in a container where `/work/in` had never been created, `sandbox_list`
 * returned "No such file or directory (os error 2)" (243.json event 29), and the
 * actor burned all six retries.
 *
 * The invariant under test: **the session workspace is shared across flavours**,
 * so whichever flavour a turn lands in, `/work/in` exists and holds the
 * session's stored documents.
 *
 * Mocked at three seams, so no Docker and no Redis: `docker-backend.server`
 * (a fake backend whose every container carries its own in-memory filesystem — that
 * per-container isolation is what makes the cross-flavour bug reproducible),
 * `document-store.server` (one stored document), and BAML (a scripted router +
 * actor + critic). Everything between — `withSandbox`, the attachment table,
 * `work-artifacts`/`work-sync`, `callTool`'s sandbox dispatch, `router`/`routes`
 * and `actorCritic` — is the real code.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockAction, mockCriticResult } from '../../../mocks/baml'

vi.mock('../../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

// ---- Fake compute backend: one in-memory filesystem per container ---------
// Each `boot` mints a new VM whose FS starts as a bare rootfs — `/work` exists
// (as in the real image, see 243.json event 35) but `/work/in` does not. That
// is the whole point: a flavour switch means a different FS, so the only way
// turn 2 sees turn 1's input is the durable-workspace sync.

/** Minimal simulation of the in-VM filesystem behind the `sandbox_*` tools. */
class FakeVmFs {
  readonly dirs = new Set<string>(['/', '/work'])
  readonly files = new Map<string, string>()

  mkdirp(dir: string): void {
    const parts = dir.split('/').filter(Boolean)
    let acc = ''
    for (const p of parts) {
      acc += `/${p}`
      this.dirs.add(acc)
    }
  }

  write(path: string, content: string): void {
    this.mkdirp(path.slice(0, path.lastIndexOf('/')) || '/')
    this.files.set(path, content)
  }

  /** Files directly or transitively under `dir`, as POSIX-relative paths. */
  under(dir: string): string[] {
    const prefix = `${dir}/`
    return [...this.files.keys()]
      .filter((p) => p.startsWith(prefix))
      .map((p) => p.slice(prefix.length))
      .sort()
  }
}

/** Stand-in for sha256 — only its stability across calls matters for diffing. */
function fakeHash(content: string): string {
  let h = 0
  for (let i = 0; i < content.length; i++) h = (h * 31 + content.charCodeAt(i)) | 0
  return (h >>> 0).toString(16).padStart(64, '0').slice(0, 64)
}

const unquote = (s: string) => s.replace(/^'|'$/g, '').replace(/'\\''/g, "'")

/**
 * Interpret the handful of shell command shapes `work-sync.server.ts` emits
 * (`mkdir -p`, the `find … sha256sum` listing) plus the plain `ls` the actor
 * may reach for. Anything else is reported as an unsupported command rather
 * than silently succeeding, so a change in work-sync's commands surfaces here.
 */
function runBash(fs: FakeVmFs, command: string): { stdout: string; stderr: string; code: number } {
  const listing = /^mkdir -p (.+?) && cd (.+?) && find \. -type f -exec sha256sum/.exec(command)
  if (listing) {
    const dir = unquote(listing[1])
    fs.mkdirp(dir)
    const lines = fs
      .under(dir)
      .map((rel) => `${fakeHash(fs.files.get(`${dir}/${rel}`)!)}  ./${rel}`)
    return { stdout: lines.join('\n'), stderr: '', code: 0 }
  }
  const mkdir = /^mkdir -p (.+)$/.exec(command)
  if (mkdir) {
    fs.mkdirp(unquote(mkdir[1]))
    return { stdout: '', stderr: '', code: 0 }
  }
  const ls = /^ls(?: -la)? (\S+)$/.exec(command)
  if (ls) {
    const dir = unquote(ls[1]).replace(/\/$/, '')
    if (!fs.dirs.has(dir)) {
      return {
        stdout: '',
        stderr: `ls: cannot access '${dir}': No such file or directory\n`,
        code: 2,
      }
    }
    return { stdout: `${fs.under(dir).join('\n')}\n`, stderr: '', code: 0 }
  }
  return { stdout: '', stderr: `unsupported command in test: ${command}`, code: 127 }
}

const SANDBOX_TOOLS = ['sandbox_bash', 'sandbox_write', 'sandbox_read', 'sandbox_list']

/** Every transport handed out, in boot order — the test asserts over these. */
const vms: Array<{ id: string; rootfs: string; fs: FakeVmFs }> = []

const backendMock = vi.hoisted(() => ({ nextId: 0 }))

vi.mock('../../../../lib/sandbox/docker-backend.server', () => {
  class FakeDockerBackend {
    kind = 'docker' as const

    async boot(rootfs: string) {
      const id = `sbx-${++backendMock.nextId}`
      const fs = new FakeVmFs()
      vms.push({ id, rootfs, fs })
      return { id, backend: 'docker', rootfs, bootedAt: Date.now(), native: { containerId: id } }
    }

    async destroy() {}

    async reset(vm: { id: string }) {
      return vm
    }

    async connectMcp(vm: { id: string }) {
      const fs = vms.find((v) => v.id === vm.id)!.fs
      return {
        vmId: vm.id,
        toolNames: async () => SANDBOX_TOOLS,
        listTools: async () =>
          SANDBOX_TOOLS.map((name) => ({ name, description: name, inputSchema: {} })),
        ownsTool: (name: string) => SANDBOX_TOOLS.includes(name),
        callTool: async (name: string, args: Record<string, unknown>) => {
          if (name === 'sandbox_bash') {
            const out = runBash(fs, String(args.command))
            return {
              success: out.code === 0,
              data: {
                stdout: out.stdout,
                stderr: out.stderr,
                exit_code: out.code,
                timed_out: false,
              },
            }
          }
          if (name === 'sandbox_write') {
            fs.write(String(args.path), String(args.content))
            return { success: true, data: 'ok' }
          }
          if (name === 'sandbox_read') {
            const content = fs.files.get(String(args.path))
            return content === undefined
              ? { success: false, error: 'No such file or directory (os error 2)' }
              : { success: true, data: content }
          }
          // sandbox_list — the tool the actor used in 243.json, and the one
          // that failed there because the directory did not exist.
          const dir = String(args.path).replace(/\/$/, '')
          if (!fs.dirs.has(dir)) {
            return { success: false, error: 'No such file or directory (os error 2)' }
          }
          return {
            success: true,
            data: fs
              .under(dir)
              .map((rel) => `[FILE] ${rel}`)
              .join('\n'),
          }
        },
        close: async () => {},
      }
    }

    async health() {
      return { state: 'healthy' as const }
    }

    async reapOrphans() {
      return 0
    }
  }
  return { DockerBackend: FakeDockerBackend }
})

// ---- Document store: the session owns one ingested file -------------------
const INGESTED = 'Coworking_Analyse.csv'
const docs = vi.hoisted(() => ({
  store: [] as Array<{ id: string; filename: string; content: string }>,
}))

vi.mock('../../../../lib/document-store.server', () => ({
  listDocuments: vi.fn(async () =>
    docs.store.map((d, i) => ({
      id: d.id,
      sessionId: 'sess-243',
      filename: d.filename,
      mimeType: 'text/csv',
      size: d.content.length,
      uploadedAt: 1_000 + i,
    })),
  ),
  getDocument: vi.fn(async (_sessionId: string, docId: string) => {
    const d = docs.store.find((x) => x.id === docId)
    return d
      ? {
          id: d.id,
          sessionId: 'sess-243',
          filename: d.filename,
          mimeType: 'text/csv',
          size: d.content.length,
          uploadedAt: 1_000,
          content: d.content,
        }
      : null
  }),
  storeDocument: vi.fn(async () => ({ id: 'stored' })),
}))

// ---- BAML: a scripted router + actor + critic ------------------------------
// The router's picks are the reproduction: `data` on turn 1, `basic` on turn 2.
const routerRoutes = vi.hoisted(() => ({ queue: [] as string[] }))

const listWorkIn = mockAction({
  reasoning: 'List the restored inputs.',
  tool_name: 'sandbox_list',
  tool_args: JSON.stringify({ path: '/work/in' }),
  is_final: true,
})

vi.mock('../../../../../baml_client', () => ({
  b: {
    Router: vi.fn(async () => ({
      intent: 'inspect the workspace',
      needs_tool: true,
      route: routerRoutes.queue.shift() ?? 'basic',
      response: 'Looking into that...',
    })),
    ActorController: vi.fn(async () => listWorkIn),
    LoopController: vi.fn(async () => listWorkIn),
    Critic: vi.fn(async () => mockCriticResult({ is_sufficient: true })),
    Synthesize: vi.fn(async () => 'Here is what /work/in holds.'),
    ResultDescribe: vi.fn(async () => 'Listed the workspace inputs.'),
    ResultDescribeBatch: vi.fn(async () => ({ summaries: [] })),
  },
}))

vi.mock('@boundaryml/baml', () => {
  class MockCollector {
    last = {
      rawLlmResponse: 'Raw response',
      usage: { inputTokens: 10, outputTokens: 10 },
      calls: [{ httpRequest: { body: {} } }],
    }
    constructor(_name?: string) {}
  }
  return { Collector: MockCollector }
})

// ---- The test -------------------------------------------------------------

interface ToolResultEvent {
  type: string
  patternId: string
  data: { tool?: string; success?: boolean; result?: unknown }
}

/** The `sandbox_list` results a given flavour loop produced. */
function listResults(events: unknown[], patternId: string) {
  return (events as ToolResultEvent[]).filter(
    (e) => e.type === 'tool_result' && e.patternId === patternId && e.data?.tool === 'sandbox_list',
  )
}

describe('flavoured-sandbox — one session workspace across flavours (#243 follow-up)', () => {
  beforeEach(() => {
    vms.length = 0
    backendMock.nextId = 0
    docs.store = [{ id: 'doc-1', filename: INGESTED, content: 'month,revenue\nJan,10\n' }]
    routerRoutes.queue = ['data', 'basic']
  })

  afterEach(async () => {
    const { __resetSandboxDefaultsForTests } =
      await import('../../../../lib/sandbox/with-sandbox.server')
    __resetSandboxDefaultsForTests()
    vi.resetModules()
  })

  it('sees an ingested file on turn 2 after the router switches flavour (data → basic)', async () => {
    const { flavouredSandboxAgent } =
      await import('../../../../lib/harness-client/agents/flavoured-sandbox.server')
    const { harness, continueSession } = await import('../../../../lib/harness-patterns')
    const patterns = await flavouredSandboxAgent.createPatterns('sess-243')

    // Turn 1 — routed to `data`, where the ingested file is hydrated.
    const turn1 = await harness(...patterns)(
      'Ingest the attached spreadsheet and tell me what columns it has.',
      'sess-243',
    )
    const dataListing = listResults(turn1.context.events, 'flavour-data-loop')
    expect(dataListing.length).toBeGreaterThan(0)
    expect(dataListing[0].data.success).toBe(true)
    expect(String(dataListing[0].data.result)).toContain(INGESTED)

    // Turn 2 — routed to `basic`: a DIFFERENT flavour, hence a different
    // container and a different filesystem. This is the exact turn that failed
    // in 243.json with "No such file or directory".
    const turn2 = await continueSession(turn1.serialized, patterns, 'list the files in /work/in')
    const basicListing = listResults(turn2.context.events, 'flavour-basic-loop')
    expect(basicListing.length).toBeGreaterThan(0)
    expect(basicListing[0].data.success).toBe(true)
    expect(String(basicListing[0].data.result)).toContain(INGESTED)

    // …and it really was a separate container, so the file arrived through the
    // durable workspace and not because both turns shared one VM.
    const rootfsUsed = vms.map((v) => v.rootfs)
    expect(rootfsUsed).toContain('data')
    expect(rootfsUsed).toContain('base')
    expect(new Set(vms.map((v) => v.id)).size).toBe(vms.length)
  })

  it('creates /work/in in the basic flavour even when the session has no documents', async () => {
    // A conversation that starts on `basic` with an empty stash must still find
    // an (empty) /work/in — hydrate is what creates the workspace layout, and
    // an ENOENT there is what sent the actor into its retry spiral.
    docs.store = []
    routerRoutes.queue = ['basic']

    const { flavouredSandboxAgent } =
      await import('../../../../lib/harness-client/agents/flavoured-sandbox.server')
    const { harness } = await import('../../../../lib/harness-patterns')
    const patterns = await flavouredSandboxAgent.createPatterns('sess-243')

    const turn = await harness(...patterns)('list the files in /work/in', 'sess-243')
    const listing = listResults(turn.context.events, 'flavour-basic-loop')
    expect(listing.length).toBeGreaterThan(0)
    expect(listing[0].data.success).toBe(true)
  })
})
