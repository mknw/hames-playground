/** The eval's stand-in for the in-VM sandbox: the production tool names, no execution.
 *
 * The transport is not the grader. A request is judged the way production would judge
 * it — a shell runs what it is given and says only what a shell says — and the scenario's
 * predicate (`valid` on the trace) is applied afterwards, to the command plus the scripts
 * it runs. So a refusal never carries the predicate's rule: a request that does not meet
 * it runs, exits 0 and leaves nothing behind, exactly as a script that never saves would.
 *
 * Not modelled: production promotes any new file under /work/out to an artifact
 * (`packages/sandbox/work-sync.server.ts`); here only an accepted shell request records
 * the scenario's artifacts, and a `sandbox_write` to /work/out is deliberately not graded. */
import type { MCPToolDescription, ToolTransport } from '@hames-ai/harness-patterns'
import { V0_IN_VM_SERVERS } from '@hames-ai/sandbox/types'
import { sandboxShapeError, type ArgsPredicate } from './tool-arguments'
import type { ConversationScenario, ConversationTrace } from './conversation'

const schema = (properties: Record<string, object>, required: string[]) => ({
  type: 'object',
  properties,
  required,
})
const PATH = { type: 'string', description: 'File path under /work.' }

/** The sandbox's file tools as production exposes them (rust-mcp-filesystem tools under
 * the `sandbox_` prefix, `packages/sandbox` V0_IN_VM_SERVERS). Hermetic stand-ins only:
 * their descriptions are NOT the server's text. Live mode derives all five from the
 * gateway's own entries (`evals/general-next/tool-catalog.ts`), so it never uses these. */
export const SANDBOX_FILE_TOOLS: MCPToolDescription[] = [
  {
    name: 'sandbox_write',
    description: 'Write a file in /work.',
    inputSchema: schema({ path: PATH, content: { type: 'string' } }, ['path', 'content']),
  },
  {
    name: 'sandbox_read',
    description: 'Read a text file from /work.',
    inputSchema: schema({ path: PATH }, ['path']),
  },
  {
    name: 'sandbox_edit',
    description: 'Replace text in a file under /work.',
    inputSchema: schema(
      {
        path: PATH,
        edits: {
          type: 'array',
          items: schema({ oldText: { type: 'string' }, newText: { type: 'string' } }, [
            'oldText',
            'newText',
          ]),
        },
      },
      ['path', 'edits'],
    ),
  },
  {
    name: 'sandbox_list',
    description: 'List a directory under /work.',
    inputSchema: schema({ path: PATH }, ['path']),
  },
  {
    name: 'sandbox_search',
    description: 'Search file contents under /work.',
    inputSchema: schema({ path: PATH, query: { type: 'string' } }, ['path', 'query']),
  },
]

/** Live mode: the sandbox's file tools ARE the gateway's rust-mcp-filesystem entries, renamed by
 * V0_IN_VM_SERVERS. Derived, never restated, so the description is the server's own text; an
 * entry the gateway does not list is an error, not a stand-in. */
export function sandboxFileToolsFromGateway(gateway: MCPToolDescription[]): MCPToolDescription[] {
  return V0_IN_VM_SERVERS.flatMap((server) => Object.entries(server.tools))
    .filter(([, exposed]) => exposed !== 'sandbox_bash')
    .map(([native, exposed]) => {
      const tool = gateway.find((t) => t.name === native)
      if (!tool) throw new Error(`Production tool metadata missing: ${native} (${exposed})`)
      return { ...tool, name: exposed }
    })
}

export interface SyntheticSandboxState {
  scenario: () => ConversationScenario
  /** A new trace is a new run: the actor's written files do not outlive it. */
  trace: () => ConversationTrace | undefined
  turn: () => number
  /** Stash contents by file name: the uploaded inputs, and every artifact created. */
  documents: Map<string, string>
  descriptions: MCPToolDescription[]
}

const WORK = '/work/'
const IN = `${WORK}in/`
const OUT = `${WORK}out/`

const withinWork = (path: string) =>
  (path === '/work' || path.startsWith(WORK)) && !path.split('/').includes('..')

type Result = { success: boolean; data: unknown; error?: string }

export function createSyntheticSandbox(state: SyntheticSandboxState): ToolTransport {
  const written = new Map<string, string>()
  let current: unknown
  const ok = (data: unknown) => ({ success: true, data })
  const fail = (error: string) => ({ success: false, data: null, error })

  const produced = () => state.trace()?.artifacts ?? []
  /** Every file the actor could see: inputs, what a shell request produced, what it wrote. */
  const files = (): Map<string, string> => {
    const all = new Map<string, string>()
    const made = state.scenario().sandboxRun?.files ?? {}
    for (const [name, text] of state.documents)
      all.set(produced().includes(name) ? `${OUT}${name}` : `${IN}${name}`, made[name] ?? text)
    for (const [path, text] of written) all.set(path, text)
    return all
  }
  const shell = (stdout: string, code = 0, stderr = '', artifacts: unknown[] = []) => ({
    success: code === 0,
    data: { artifacts, stdout, stderr, exit_code: code, timed_out: false },
  })

  /** `head`, `cat`, `wc` and `ls` on files the actor can see: read-only, nothing recorded. */
  const inspect = (command: string, cwd: string) => {
    const [program, ...rest] = command.trim().split(/\s+/)
    if (!/^(head|cat|wc|ls)$/.test(program) || /[;|&<>$`()]/.test(command)) return undefined
    const all = files()
    const targets = rest
      .filter((a) => !a.startsWith('-'))
      .map((a) => (a.startsWith('/') ? a : `${cwd.replace(/\/$/, '')}/${a}`))
    if (program === 'ls') {
      const names = (dir: string) => listing(all, dir.endsWith('/') ? dir : `${dir}/`)
      return shell(
        (targets.length ? targets : [cwd])
          .flatMap(names)
          .map((l) => l.replace(/^\[\w+\] /, ''))
          .join('\n'),
      )
    }
    for (const path of targets)
      if (!all.has(path)) return shell('', 1, `${program}: ${path}: No such file or directory`)
    const text = targets.map((p) => all.get(p)!)
    if (program === 'cat') return shell(text.join(''))
    if (program === 'head')
      return shell(text.map((t) => t.split('\n').slice(0, 10).join('\n')).join('\n'))
    return shell(text.map((t, i) => `${t.split('\n').length - 1} ${targets[i]}`).join('\n'))
  }

  const bash = (args: Record<string, unknown>): { result: Result; valid?: boolean } => {
    const shape = sandboxShapeError(args)
    if (shape) return { result: fail(`Invalid arguments for sandbox_bash: ${shape}.`) }
    const command = args.command as string
    const cwd = typeof args.cwd === 'string' ? args.cwd : '/work'
    const inspected = inspect(command, cwd)
    if (inspected) return { result: inspected, valid: false }
    // The scripts this command runs are part of the request.
    const scripts = [...written].filter(([p]) => command.includes(p)).map(([, text]) => text)
    const script = /\bpython3?\s+(\/\S+\.py)/.exec(command)?.[1]
    if (script && !files().has(script))
      return {
        result: shell(
          '',
          2,
          `python3: can't open file '${script}': [Errno 2] No such file or directory`,
        ),
        valid: false,
      }
    const scenario = state.scenario()
    const predicate = scenario.expectedArgs?.sandbox_bash as ArgsPredicate | undefined
    if (!predicate?.(args, scripts.join('\n'))) return { result: shell(''), valid: false }
    const made = scenario.sandboxRun?.files ?? {}
    for (const file of scenario.artifacts) {
      state.documents.set(file, made[file] ?? state.documents.get('lantern-notes.md') ?? '')
      state.trace()?.artifacts.push(file)
      if (file.endsWith('.md')) state.trace()?.indexed.push(file)
    }
    return {
      result: shell(
        scenario.sandboxRun?.stdout ?? scenario.artifacts.map((n) => `Saved ${OUT}${n}`).join('\n'),
        0,
        '',
        scenario.artifacts.map((n) => ({ name: n, url: `stash://fixture/${n}` })),
      ),
      valid: true,
    }
  }

  const call: ToolTransport['callTool'] = async (name, args) => {
    if (state.trace() !== current) {
      written.clear()
      current = state.trace()
    }
    const path = typeof args.path === 'string' ? args.path : ''
    const inWork = withinWork(path)
    let valid: boolean | undefined
    const result = ((): Result => {
      if (name === 'sandbox_bash') {
        const run = bash(args)
        valid = run.valid
        return run.result
      }
      if (name === 'sandbox_write') {
        if (!inWork || typeof args.content !== 'string')
          return fail('write_file: path must be under /work and content must be a string.')
        written.set(path, args.content)
        return ok(`Successfully wrote to ${path}`)
      }
      if (name === 'sandbox_read') {
        const content = inWork ? files().get(path) : undefined
        return content === undefined ? fail(`read_text_file: no such file: ${path}`) : ok(content)
      }
      if (name === 'sandbox_edit') {
        const text = inWork ? written.get(path) : undefined
        if (text === undefined || !Array.isArray(args.edits))
          return fail(`edit_file: no such file: ${path}`)
        let next = text
        for (const e of args.edits as Array<{ oldText?: unknown; newText?: unknown }>) {
          if (
            typeof e.oldText !== 'string' ||
            typeof e.newText !== 'string' ||
            !next.includes(e.oldText)
          )
            return fail(`edit_file: could not find the text to replace in ${path}`)
          next = next.replace(e.oldText, () => e.newText as string)
        }
        written.set(path, next)
        return ok(`Edited ${path}`)
      }
      if (name === 'sandbox_list') {
        if (!inWork) return fail('list_directory: path must be under /work.')
        return ok(listing(files(), path.endsWith('/') ? path : `${path}/`).join('\n'))
      }
      if (name === 'sandbox_search') {
        if (!inWork || typeof args.query !== 'string')
          return fail('search_files_content: bad arguments.')
        const dir = path.endsWith('/') ? path : `${path}/`
        const hits = [...files()]
          .filter(([p]) => p.startsWith(dir))
          .flatMap(([p, text]) =>
            text
              .split('\n')
              .flatMap((line, i) =>
                line.includes(args.query as string) ? [`${p}:${i + 1}: ${line}`] : [],
              ),
          )
        return ok(hits.join('\n') || 'No matches found')
      }
      return fail(`${name}: not available in the synthetic sandbox.`)
    })()
    state.trace()?.tools.push({
      name,
      args,
      success: result.success,
      turn: state.turn(),
      ...(valid === undefined ? {} : { valid }),
    })
    return result
  }
  return {
    id: 'general-eval-synthetic-sandbox',
    ownsTool: (name) => state.descriptions.some((t) => t.name === name),
    namespaceFor: () => 'sandbox',
    listTools: async () => state.descriptions,
    callTool: call,
  }
}

/** `[FILE] name` / `[DIR] name` lines for the direct children of `dir` (trailing slash). */
function listing(all: Map<string, string>, dir: string): string[] {
  const entries = new Set<string>(dir === WORK ? ['[DIR] in', '[DIR] out'] : [])
  for (const path of all.keys()) {
    if (!path.startsWith(dir)) continue
    const [head, ...below] = path.slice(dir.length).split('/')
    entries.add(`${below.length ? '[DIR]' : '[FILE]'} ${head}`)
  }
  return [...entries]
}
