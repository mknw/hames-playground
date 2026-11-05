/**
 * The public read path for a shared conversation — the ONLY surface in this app
 * that answers an anonymous browser with decrypted user content.
 *
 * It is a module of its own, with exactly one export, on purpose. Every export
 * of a `'use server'` module is an RPC the browser can call (SD-13), so the
 * blast radius of "this file is not owner-scoped" is exactly the set of
 * functions in this file — and that set is one function whose whole body is
 * below. Putting it in `actions.server.ts` beside the owner-scoped actions
 * would have made the difference between the two a line of code inside a
 * 270-line module rather than a file boundary a reviewer can see from the
 * import list.
 *
 * ## What authorizes the read
 *
 * The token, and nothing else. This path never reads the session cookie, never
 * calls `requireUser()`, and does not change behaviour for a signed-in caller —
 * a shared conversation looks the same to its owner as to a stranger.
 * `src/__tests__/lib/harness-client/public-share-surface.test.ts` is the pin:
 * it fails if this module grows a second export or acquires an auth import.
 *
 * ## What a viewer sees, decided rather than inherited
 *
 * The title, and the transcript's **user and assistant turns**. That is the
 * conversation as a person had it, and it is all of it.
 *
 * Everything else the owner sees is withheld, and each exclusion is a decision:
 *
 *   - **The serialized context blob** — the event stream carries verbatim tool
 *     results, which since per-user Graph access can hold mail bodies, calendar
 *     entries and file contents (SD-10). It never leaves this function; the
 *     projection below is built from it and the blob itself is dropped.
 *   - **Tool calls, tool results, graph elements, retriever citations** — the
 *     working-out, not the conversation. A citation in particular names a
 *     document in the owner's Data Stash that the viewer cannot and must not
 *     open.
 *   - **Observability internals** — LLM calls, prompts, token counts, cost.
 *     A share is a transcript, not a bill.
 *   - **Error and warning bubbles.** These are diagnostics, and they name
 *     infrastructure: an endpoint that did not wake, a client, a turn and
 *     attempt number. The owner's own transcript keeps them; a link handed to
 *     someone outside the deployment does not.
 *   - **The agent, the row's kind/source/status, the owner.** Who ran it and on
 *     what is not part of what was said, and `agent_id` in particular is an
 *     internal identifier the public route has no use for.
 *
 * The conversation id IS returned, because the page needs a stable key and it
 * is already in the sharer's own URL. It grants nothing: ids never authorize a
 * read (`lib/db/conversations.server.ts`, `SHARE_TOKEN_BYTES`).
 */
'use server'

import { loadSharedConversation as loadSharedRow } from '../db/conversations.server'
import { replayMessages } from '@hames-ai/agents/replay'
// Server-computed link verdicts (#901 slice 1, ruling Q1): the recognised-host
// list never reaches a shared transcript's HTML or payload — only the verdicts
// for the transcript's own already-visible links do, computed here.
import { recognisedLinkHostsFor } from './link-verdicts.server'

/** One turn of a shared transcript. A deliberate subset of `ReplayedMessage`:
 *  no `hint`, no `patternId`, no `turnInfo` — those ride on the error bubbles
 *  this projection drops, and re-exporting the wider type would make adding a
 *  field to it silently widen what a stranger can read. */
export interface SharedMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** Epoch ms — convert to Date on the client. */
  timestamp: number
  /** Server-computed link verdicts (#901 slice 1, ruling Q1): the recognised
   *  hostnames among this assistant turn's own http(s) links — addresses
   *  already visible in the transcript's own anchors, not the host list. What
   *  the ruling forbids is the list crossing; a link the dialog will treat
   *  differently from its neighbour has to carry the difference, so this is
   *  the verdict, filled for assistant turns only. */
  recognisedLinkHosts?: readonly string[]
}

export interface SharedConversationView {
  id: string
  title: string | null
  messages: SharedMessage[]
  /** Epoch ms. When the owner turned the link on. */
  sharedAt: number
}

/**
 * Resolve a share token to a read-only transcript, or `null`.
 *
 * `null` is the single answer for an unknown token, a revoked one and a
 * malformed one — the caller gets no way to tell a conversation that never
 * existed from one whose share was withdrawn, which is what keeps the route's
 * response a 404 rather than a 403 confirming there is something there.
 */
export async function loadSharedConversation(
  token: string,
): Promise<SharedConversationView | null> {
  // A non-string reaching here means a caller the type system did not see —
  // this is an RPC, so the browser chooses the argument.
  if (typeof token !== 'string') return null

  const row = await loadSharedRow(token)
  if (!row) return null

  const messages: SharedMessage[] = []
  for (const m of replayMessages(row.serializedContext)) {
    if (m.role !== 'user' && m.role !== 'assistant') continue
    // Field-by-field rather than a spread: a spread would carry whatever
    // `ReplayedMessage` grows next straight out to an anonymous viewer. The
    // verdicts are the one deliberate addition, computed for this turn's own
    // content right here — never taken from the replayed message.
    messages.push({
      id: m.id,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
      ...(m.role === 'assistant' ? { recognisedLinkHosts: recognisedLinkHostsFor(m.content) } : {}),
    })
  }

  return {
    id: row.id,
    title: row.title,
    messages,
    sharedAt: row.sharedAt.getTime(),
  }
}
