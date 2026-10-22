/**
 * Build-time hooks that route the framework's two error-serialising paths
 * through `toWireError` (see `wire-error.ts` for why and for the rule).
 *
 *  - the server-function HTTP handler catches a thrown value and serialises it
 *    in the same block, with no seam to intercept in between, so one line in
 *    that catch is the seam;
 *  - a server function called in-process (during server rendering, or from
 *    another server function) goes through `createServerReference`'s `apply`
 *    and never reaches the handler, so its result is wrapped there.
 *
 * Each rewrite fails the build when its anchor is not there exactly once: after
 * a framework upgrade the alternative is a path quietly serialising errors in
 * full again. `wire-error.test.ts` runs both against the installed files and
 * pins their hashes, so an upgrade forces a re-review.
 */

export const HANDLER_ID = /@solidjs[\\/]start[\\/]dist[\\/]runtime[\\/]server-handler\.js$/
export const RUNTIME_ID = /@solidjs[\\/]start[\\/]dist[\\/]runtime[\\/]server-fns-runtime\.js$/

const IMPORT = 'import { toWireError } from "~/lib/server-fn-errors/wire-error";\n'

function replaceOnce(code: string, anchor: string, replacement: string, what: string): string {
  const occurrences = code.split(anchor).length - 1
  if (occurrences !== 1) {
    throw new Error(
      `server-fn error serialisation: expected one \`${anchor}\` in the ${what}, found ${occurrences}`,
    )
  }
  return IMPORT + code.replace(anchor, replacement)
}

export function wrapHandlerErrors(code: string): string {
  const anchor = 'catch (x) {'
  return replaceOnce(
    code,
    anchor,
    `${anchor}\n        x = toWireError(x);`,
    'server-function handler',
  )
}

export function wrapInProcessErrors(code: string): string {
  const anchor = 'return fn.apply(thisArg, args);'
  return replaceOnce(
    code,
    anchor,
    `let result;
                try {
                    result = fn.apply(thisArg, args);
                }
                catch (x) {
                    throw toWireError(x);
                }
                return result && typeof result.then === "function"
                    ? result.then(undefined, (x) => { throw toWireError(x); })
                    : result;`,
    'in-process server-function runtime',
  )
}

export function wireErrorsPlugin() {
  return {
    name: 'wire-errors',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      const path = id.split('?')[0]
      if (HANDLER_ID.test(path)) return { code: wrapHandlerErrors(code), map: null }
      if (RUNTIME_ID.test(path)) return { code: wrapInProcessErrors(code), map: null }
      return null
    },
  }
}

/**
 * The plugins a vinxi router gets. `server` (server rendering) and
 * `server-function` both bundle the in-process runtime; the handler is the
 * latter's alone. The client bundle must not carry either.
 */
export function wireErrorPluginsFor(router: string) {
  return router === 'server' || router === 'server-function' ? [wireErrorsPlugin()] : []
}
