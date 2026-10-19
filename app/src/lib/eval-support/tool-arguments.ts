export const projectCountArgs = (args: Record<string, unknown>): boolean =>
  typeof args.query === 'string' && /MATCH[\s\S]*Project[\s\S]*count/i.test(args.query)

/** A scenario's argument predicate, optionally able to say WHICH rule a refused
 * request broke — the synthetic sandbox relays it so the actor can act on it. */
export type ArgsPredicate = ((args: Record<string, unknown>) => boolean) & {
  violations?: (args: Record<string, unknown>) => string[]
}

/** Why a shell request fails `sandboxArgs`, in the words a shell would use;
 * empty when it passes. Each rule is the one the predicate has always applied. */
export const sandboxArgsViolations =
  (files: string[]) =>
  (args: Record<string, unknown>): string[] => {
    if (typeof args.command !== 'string') return ["'command' must be a string"]
    const command = args.command
    const why: string[] = []
    if (args.cwd !== undefined && typeof args.cwd !== 'string') why.push("'cwd' must be a string")
    if (
      args.timeout_ms !== undefined &&
      !(Number.isInteger(args.timeout_ms) && Number(args.timeout_ms) > 0)
    )
      why.push("'timeout_ms' must be a positive integer")
    if (command.startsWith('fixture-write')) why.push('the command must be shell syntax')
    if (!/python3?|cat|pandoc|libreoffice|soffice|printf/.test(command))
      why.push('the command must run python3, cat, pandoc, libreoffice, soffice or printf')
    const missing = files.filter((file) => !command.includes(file))
    if (missing.length)
      why.push(
        `the command itself must name every input and output file it uses; not named: ${missing.join(', ')}`,
      )
    return why
  }

/** The live transport records requests; this grades a production-shaped shell
 * request mentioning every required input/output, not Python execution. */
export const sandboxArgs = (files: string[]): ArgsPredicate => {
  const violations = sandboxArgsViolations(files)
  return Object.assign((args: Record<string, unknown>) => violations(args).length === 0, {
    violations,
  })
}

export const mailArgs = (args: Record<string, unknown>): boolean =>
  Object.keys(args).every((key) => ['limit', 'unread_only'].includes(key)) &&
  (args.unread_only === undefined || typeof args.unread_only === 'boolean') &&
  (args.limit === undefined ||
    (Number.isInteger(args.limit) && Number(args.limit) >= 1 && Number(args.limit) <= 25))
