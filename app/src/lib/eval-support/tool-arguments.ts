export const projectCountArgs = (args: Record<string, unknown>): boolean =>
  typeof args.query === 'string' && /MATCH[\s\S]*Project[\s\S]*count/i.test(args.query)

/** A scenario's argument predicate. `scripts` is the text of the files the shell
 * command runs (the synthetic sandbox resolves it from what the actor wrote) and
 * `readFiles` the bare names a sandbox tool returned earlier in the same turn (the
 * synthetic sandbox resolves both from the trace); the graders have only the arguments
 * and pass neither. */
export type ArgsPredicate = (
  args: Record<string, unknown>,
  scripts?: string,
  readFiles?: readonly string[],
) => boolean

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
/** Writers able to leave a file when their stdout is redirected. `echo` joins `cat` and
 * `printf`: same transcription, same grammar (owner ruling 2026-10-25 — the interface
 * contract, not a command whitelist; the run-3 candidates that reached for `echo` when
 * `printf` was withheld were writing the same file). */
const WRITERS = new Set(['cat', 'printf', 'echo'])

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

/** The live transport records requests; this grades a production-shaped shell request by
 * the INTERFACE CONTRACT, not a command whitelist: the command must run something able to
 * produce the declared artifact — a converter or interpreter, or `cat`/`printf`/`echo`
 * redirected to a file — and the artifact predicate validates the OUTPUT, which for the
 * graders (who hold only the arguments and the scripts) resolves to the command, or a
 * script it runs, naming the declared output and every declared input the script does not
 * get another way. The synthetic sandbox judges the same way and additionally checks the
 * produced artifact it records. Naming files is not running them: `echo a b | cat` and a
 * bare `printf 'a b'` do not pass.
 *
 * An input may be credited by a READ instead of a name (R6DIAG row 14, run 6): an
 * executor that read the file with `sandbox_read` earlier in the same turn holds its
 * content, so a script that transcribes it is a computation, not a silent no-op — while
 * a script that neither names an input nor had it read would run, exit 0 and leave
 * nothing behind. The declared OUTPUT must still be NAMED by the command or a script it
 * runs; a read can never credit a file nothing writes. Reads are bare names, as declared
 * here; the synthetic sandbox reduces the read paths to theirs. */
export const sandboxArgs =
  (output: string, ...inputs: string[]): ArgsPredicate =>
  (args, scripts = '', readFiles = []) => {
    if (sandboxShapeError(args) !== undefined) return false
    const command = args.command as string
    if (command.startsWith('fixture-write')) return false
    const runs = heads(command).some(
      (h) => EXECUTORS.has(h) || (WRITERS.has(h) && />\s*\S/.test(command)),
    )
    const named = `${command}\n${scripts}`
    return (
      runs &&
      named.includes(output) &&
      inputs.every((file) => named.includes(file) || readFiles.includes(file))
    )
  }

/** A `writtenArtifacts` predicate: the written text names every phrase, ignoring case
 * and whitespace runs, so a reformatted checklist passes and a paraphrase does not. */
export const writtenContains =
  (...phrases: string[]) =>
  (content: string): boolean => {
    const text = content.replace(/\s+/g, ' ').toLowerCase()
    return phrases.every((p) => text.includes(p.replace(/\s+/g, ' ').toLowerCase()))
  }

export const mailArgs = (args: Record<string, unknown>): boolean =>
  Object.keys(args).every((key) => ['limit', 'unread_only'].includes(key)) &&
  (args.unread_only === undefined || typeof args.unread_only === 'boolean') &&
  (args.limit === undefined ||
    (Number.isInteger(args.limit) && Number(args.limit) >= 1 && Number(args.limit) <= 25))
