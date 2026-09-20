/**
 * GraphAuthRequiredError — owned by the package so `instanceof` survives the
 * seam (#225 PR-3, design S1).
 *
 * Raised when we cannot get a token without user interaction — no stored cache,
 * an unusable/expired refresh token, or a scope the user hasn't consented to.
 * Tool wrappers translate this into a "please sign in again" result rather than
 * failing the whole run.
 *
 * The class moved here VERBATIM from the host's token module in PR-C2: the
 * host's `graphFetch` implementation keeps throwing it (importing it from
 * here), and the Graph tools check `instanceof` — one class, two importers,
 * so the check keeps meaning the same thing across the seam.
 */
export class GraphAuthRequiredError extends Error {
  constructor(
    message: string,
    readonly userId: string,
    /** HTTP status when Graph itself rejected the call (401 expired token,
     *  403 missing consent OR resource-level denial such as SharePoint
     *  Embedded); undefined when token ACQUISITION failed before any HTTP
     *  request. Lets tools tell "sign in again" apart from "re-auth won't
     *  help" (e.g. Loop content, #137). */
    readonly status?: number,
  ) {
    super(message)
    this.name = 'GraphAuthRequiredError'
  }
}
