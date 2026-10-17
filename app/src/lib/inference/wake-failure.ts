import type { WakeBox } from './cold-start.server'

/** A wake that failed, carrying the box that failed as data so no caller parses a message that
 *  embeds remote response text. Its own module so the eval runner can import it without loading
 *  the server-only wake. */
export class WakeFailure extends Error {
  constructor(
    readonly box: WakeBox,
    message: string,
  ) {
    super(message)
  }
}
