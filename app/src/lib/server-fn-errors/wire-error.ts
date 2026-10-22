/**
 * What a server function's thrown error looks like to its caller.
 *
 * The framework's server-function handler catches whatever a function throws and
 * serialises it to the caller. Left alone that is the error's message, its
 * stack, every own property (a driver's `code`/`detail`/`query`, a syscall's
 * `path`) and its `cause` chain. A caller needs the message of an error the app
 * wrote for it, and nothing else; the rest belongs in the server log.
 *
 * `handler-transform.ts` routes the handler's catch, and the in-process call path
 * (server rendering, a server function calling another), through {@link toWireError}.
 *
 * ## Which build keeps detail
 *
 * `import.meta.env.DEV`: a constant the production build replaces with `false`,
 * and the same one `lib/auth/dev-bypass.ts` gates on, so the layers that run
 * with the bypass are exactly the layers that keep full errors. It is a
 * property of the build, never of the request — nothing a caller sends (a header,
 * a query parameter) can switch it.
 *
 * ## Which messages survive production
 *
 * An allowlist, because the alternative is a denylist of everything that can
 * carry foreign text, and that list is open-ended (a database driver's message
 * quotes SQL, an upstream provider's quotes its response body, a syscall's
 * names a path). A message crosses only when:
 *
 *  - the error is marked {@link USER_FACING} — a class whose message the app
 *    wrote for the user; or
 *  - it is a bare `Error` with no own properties and no `cause` — what the app's
 *    own `throw new Error('sessionId is required')` is. Every library error
 *    this is not: drivers and the provider client throw subclasses, and Node's
 *    system errors are bare `Error`s that carry `code`/`path`/`syscall`.
 *
 * Everything else crosses as {@link GENERIC_MESSAGE}.
 */

/** Marks an error class whose message is written for the user. */
export const USER_FACING = Symbol.for('hames.user-facing-error')

export const GENERIC_MESSAGE = 'The request failed.'

/** A defence against an authored message that embeds something long. */
const MAX_MESSAGE_LENGTH = 500

function isAuthored(error: Error): boolean {
  if ((error as unknown as Record<symbol, unknown>)[USER_FACING] === true) return true
  return (
    Object.getPrototypeOf(error) === Error.prototype &&
    Object.keys(error).length === 0 &&
    !('cause' in error)
  )
}

/**
 * What the server log keeps of a thrown value. Never the object itself: Node's
 * inspector prints every own property and the `cause` chain, and provider and
 * driver errors carry prompts, response bodies and row detail there. So: the
 * name, message, code and stack, and the NAMES in the cause chain.
 */
export function describeForLog(thrown: unknown): Record<string, unknown> {
  if (!(thrown instanceof Error)) return { type: typeof thrown }
  const code = (thrown as { code?: unknown }).code
  const causes: string[] = []
  const seen = new Set<unknown>([thrown])
  let cause = (thrown as { cause?: unknown }).cause
  while (cause !== undefined && causes.length < 5 && !seen.has(cause)) {
    seen.add(cause)
    causes.push(cause instanceof Error ? cause.name : typeof cause)
    cause = cause instanceof Error ? (cause as { cause?: unknown }).cause : undefined
  }
  return {
    name: thrown.name,
    message: thrown.message,
    code: typeof code === 'string' || typeof code === 'number' ? code : undefined,
    stack: thrown.stack,
    causes,
  }
}

export interface WireErrorOptions {
  /** Keep the thrown value untouched. Defaults to the build constant above. */
  detailed?: boolean
  log?: (...args: unknown[]) => void
}

export function toWireError(thrown: unknown, options: WireErrorOptions = {}): unknown {
  // A thrown `Response` is the framework's redirect/status channel, not an error.
  if (thrown instanceof Response) return thrown
  if (options.detailed ?? import.meta.env.DEV === true) return thrown

  ;(options.log ?? console.error)('[server-fn] a server function threw:', describeForLog(thrown))

  const message =
    thrown instanceof Error && isAuthored(thrown)
      ? thrown.message.slice(0, MAX_MESSAGE_LENGTH)
      : GENERIC_MESSAGE
  const safe = new Error(message)
  // Own property `stack` is what the serialiser reads; none, nothing to send.
  delete (safe as { stack?: string }).stack
  return safe
}
