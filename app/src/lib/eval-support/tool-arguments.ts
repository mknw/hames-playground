export const projectCountArgs = (args: Record<string, unknown>): boolean =>
  typeof args.query === 'string' && /MATCH[\s\S]*Project[\s\S]*count/i.test(args.query)

/** A scenario's argument predicate. `scripts` is the text of the files the shell
 * command runs (the synthetic sandbox resolves it from what the actor wrote); the
 * graders have only the arguments and pass none. */
export type ArgsPredicate = (args: Record<string, unknown>, scripts?: string) => boolean

/** What the production `sandbox_bash` input schema itself rejects (rootfs/mcp-shell:
 * `command` string, `cwd` string, `timeout_ms` positive integer); undefined when it fits. */
export function sandboxShapeError(args: Record<string, unknown>): string | undefined {
  if (typeof args.command !== 'string') return "'command' must be a string"
  if (args.cwd !== undefined && typeof args.cwd !== 'string') return "'cwd' must be a string"
  if (
    args.timeout_ms !== undefined &&
    !(Number.isInteger(args.timeout_ms) && Number(args.timeout_ms) > 0)
  )
    return "'timeout_ms' must be a positive integer"
  return undefined
}

const EXECUTORS = new Set(['python3', 'python', 'pandoc', 'libreoffice', 'soffice'])
const WRITERS = new Set(['cat', 'printf'])

/** The program each segment of a shell line starts with, skipping `FOO=bar` prefixes. */
const heads = (command: string): string[] =>
  command
    .split(/[\n;|&]+/)
    .map(
      (s) =>
        s
          .trim()
          .replace(/^(\w+=\S*\s+)+/, '')
          .split(/\s+/)[0]
          .split('/')
          .at(-1) ?? '',
    )
    .filter(Boolean)

/** The live transport records requests; this grades a production-shaped shell
 * request, not Python execution: it must RUN something able to produce the output
 * (a converter or interpreter, or `cat`/`printf` redirected to a file) and the
 * command, or a script it runs, must name every file listed. Naming files is not
 * running them: `echo a b | cat` and a bare `printf 'a b'` do not pass. */
export const sandboxArgs =
  (files: string[]): ArgsPredicate =>
  (args, scripts = '') => {
    if (sandboxShapeError(args) !== undefined) return false
    const command = args.command as string
    if (command.startsWith('fixture-write')) return false
    const runs = heads(command).some(
      (h) => EXECUTORS.has(h) || (WRITERS.has(h) && />\s*\S/.test(command)),
    )
    return runs && files.every((file) => `${command}\n${scripts}`.includes(file))
  }

export const mailArgs = (args: Record<string, unknown>): boolean =>
  Object.keys(args).every((key) => ['limit', 'unread_only'].includes(key)) &&
  (args.unread_only === undefined || typeof args.unread_only === 'boolean') &&
  (args.limit === undefined ||
    (Number.isInteger(args.limit) && Number(args.limit) >= 1 && Number(args.limit) <= 25))
