export const projectCountArgs = (args: Record<string, unknown>): boolean =>
  typeof args.query === 'string' && /MATCH[\s\S]*Project[\s\S]*count/i.test(args.query)

/** The live transport records requests; this grades a production-shaped shell
 * request mentioning every required input/output, not Python execution. */
export const sandboxArgs =
  (files: string[]) =>
  (args: Record<string, unknown>): boolean =>
    typeof args.command === 'string' &&
    (args.cwd === undefined || typeof args.cwd === 'string') &&
    (args.timeout_ms === undefined ||
      (Number.isInteger(args.timeout_ms) && Number(args.timeout_ms) > 0)) &&
    !args.command.startsWith('fixture-write') &&
    /python3?|cat|pandoc|libreoffice|soffice|printf/.test(args.command) &&
    files.every((file) => (args.command as string).includes(file))

export const mailArgs = (args: Record<string, unknown>): boolean =>
  Object.keys(args).every((key) => ['limit', 'unread_only'].includes(key)) &&
  (args.unread_only === undefined || typeof args.unread_only === 'boolean') &&
  (args.limit === undefined ||
    (Number.isInteger(args.limit) && Number(args.limit) >= 1 && Number(args.limit) <= 25))
