/** The eval's stand-in for the in-VM sandbox: the production tool names, no execution. */
import type { MCPToolDescription, ToolTransport } from '@hames-ai/harness-patterns'
import type { ArgsPredicate } from './tool-arguments'
import type { ConversationScenario, ConversationTrace } from './conversation'

/** The sandbox's file tools as production exposes them (rust-mcp-filesystem
 * `write_file` / `read_text_file` / `list_directory` under the `sandbox_` prefix,
 * `packages/sandbox` V0_IN_VM_SERVERS). Their argument names are the documented
 * ones (docs/plan/sandbox.md); this is not read from a running server. */
export const SANDBOX_FILE_TOOLS: MCPToolDescription[] = [
  {
    name: 'sandbox_write',
    description: 'Write a file in /work.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path under /work.' },
        content: { type: 'string', description: 'The file content.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'sandbox_read',
    description: 'Read a text file from /work.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'File path under /work.' } },
      required: ['path'],
    },
  },
  {
    name: 'sandbox_list',
    description: 'List a directory under /work.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory path under /work.' } },
      required: ['path'],
    },
  },
]

export interface SyntheticSandboxState {
  scenario: () => ConversationScenario
  trace: () => ConversationTrace | undefined
  turn: () => number
  /** Stash contents by file name: the uploaded inputs, and every artifact created. */
  documents: Map<string, string>
  /** Files the actor wrote with `sandbox_write`, by absolute path. */
  written: Map<string, string>
  descriptions: MCPToolDescription[]
}

const WORK = '/work/'
const IN = `${WORK}in/`

/** Why the shell request was refused, as a shell would say it; the model has
 * nothing else to correct itself against. */
function refusal(predicate: ArgsPredicate | undefined, args: Record<string, unknown>): string {
  const why = predicate?.violations?.(args) ?? []
  return (
    'Invalid synthetic shell request; no code executed.' + (why.length ? ` ${why.join('; ')}.` : '')
  )
}

export function createSyntheticSandbox(state: SyntheticSandboxState): ToolTransport {
  const call: ToolTransport['callTool'] = async (name, args) => {
    const ok = (data: unknown) => ({ success: true, data })
    const fail = (error: string) => ({ success: false, data: null, error })
    const path = typeof args.path === 'string' ? args.path : ''
    const inWork = path.startsWith(WORK) && !path.includes('..')
    const result = await (async () => {
      if (name === 'sandbox_bash') {
        const scenario = state.scenario()
        const predicate = scenario.expectedArgs?.sandbox_bash as ArgsPredicate | undefined
        if (!predicate?.(args)) return fail(refusal(predicate, args))
        for (const file of scenario.artifacts) {
          state.documents.set(file, state.documents.get('lantern-notes.md') ?? '')
          state.trace()?.artifacts.push(file)
          if (file.endsWith('.md')) state.trace()?.indexed.push(file)
        }
        return {
          success: true,
          data: {
            artifacts: scenario.artifacts.map((n) => ({ name: n, url: `stash://fixture/${n}` })),
            stdout:
              'Synthetic transport recorded the request. Source data: North revenue 47; South revenue 19. No generated code was executed.',
            stderr: '',
            exit_code: 0,
            timed_out: false,
          },
        }
      }
      if (name === 'sandbox_write') {
        if (!inWork || typeof args.content !== 'string')
          return fail('write_file: path must be under /work and content must be a string.')
        state.written.set(path, args.content)
        return ok({ path, bytes: args.content.length })
      }
      if (name === 'sandbox_read') {
        const content = inWork
          ? (state.written.get(path) ??
            (path.startsWith(IN) ? state.documents.get(path.slice(IN.length)) : undefined))
          : undefined
        return content === undefined ? fail(`read_text_file: no such file: ${path}`) : ok(content)
      }
      if (name === 'sandbox_list') {
        if (!inWork) return fail('list_directory: path must be under /work.')
        const dir = path.endsWith('/') ? path : `${path}/`
        const names = [...state.written.keys()]
          .filter((p) => p.startsWith(dir) && !p.slice(dir.length).includes('/'))
          .map((p) => p.slice(dir.length))
        if (dir === IN)
          names.push(
            ...[...state.documents.keys()].filter(
              (f) => f === 'lantern-notes.md' || f.endsWith('.csv'),
            ),
          )
        return ok(names)
      }
      return fail(`${name}: not available in the synthetic sandbox.`)
    })()
    state.trace()?.tools.push({ name, args, success: result.success, turn: state.turn() })
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
