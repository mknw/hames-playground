/**
 * Build-time hook that routes the framework's server-function handler through
 * `toWireError` (see `wire-error.ts` for why and for the rule).
 *
 * The handler catches a thrown value and serialises it in the same block, with
 * no seam to intercept in between, so the one line this adds is the seam. It
 * fails the build when the anchor is not there exactly once: after a framework
 * upgrade the alternative is a handler quietly serialising errors in full again.
 * `wire-error.test.ts` runs this against the installed handler.
 */

export const HANDLER_ID = /@solidjs[\\/]start[\\/]dist[\\/]runtime[\\/]server-handler\.js$/

const ANCHOR = 'catch (x) {'
const IMPORT = 'import { toWireError } from "~/lib/server-fn-errors/wire-error";\n'

export function wrapHandlerErrors(code: string): string {
  const occurrences = code.split(ANCHOR).length - 1
  if (occurrences !== 1) {
    throw new Error(
      `server-fn error serialisation: expected one \`${ANCHOR}\` in the server-function handler, found ${occurrences}`,
    )
  }
  return IMPORT + code.replace(ANCHOR, `${ANCHOR}\n        x = toWireError(x);`)
}

export function wireErrorsPlugin() {
  return {
    name: 'wire-errors',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      return HANDLER_ID.test(id.split('?')[0]) ? { code: wrapHandlerErrors(code), map: null } : null
    },
  }
}
