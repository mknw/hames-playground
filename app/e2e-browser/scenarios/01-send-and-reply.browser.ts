/**
 * Scenario 1 — a message goes in, an answer comes out, the sidebar notices.
 *
 * The floor of this layer. Everything else here assumes a turn can be started
 * from a keyboard and finish on screen; if this is red nothing above it means
 * anything.
 *
 * It is deliberately NOT the same claim as `e2e/scenarios/01-fresh-conversation`.
 * That one proves the server action returns an answer and the row is `done`;
 * this one proves a HUMAN sees it — the bubble is painted, the composer comes
 * back, and the conversation appears in the list where they would click to
 * return to it. Both were true of the failures the owner kept hitting except
 * the second.
 */
import { test, expect } from '../lib/fixtures'
import { FAKE_TITLE } from '../lib/env'
import {
  expectFakeAnswer,
  open,
  replies,
  replyTexts,
  send,
  sendButton,
  threadRow,
  userBubbles,
  waitForReplies,
} from '../lib/chat'

const QUESTION = 'how many nodes are in the graph?'

test('a sent message gets an assistant reply on screen, and the sidebar picks the thread up', async ({
  page,
  appUrl,
  backend,
}) => {
  await open(page, appUrl)

  // The empty state is the honest "before": asserting the row COUNT went 0 → 1
  // would pass on a sidebar that renders nothing at all.
  await expect(page.getByText('No conversations yet. Send a message to start.')).toBeVisible()

  await send(page, QUESTION)

  // What the user typed is echoed as their own turn.
  await expect(userBubbles(page).filter({ hasText: QUESTION })).toHaveCount(1)

  // The answer lands as a bubble — not merely as a settled network request.
  await waitForReplies(page, 1)
  const [answer] = await replyTexts(page)
  expectFakeAnswer(answer)

  // The composer is usable again. A turn that finishes but leaves Send hidden
  // is indistinguishable, from the chair, from one that never finished.
  await expect(sendButton(page)).toBeVisible()

  // The sidebar row, by the title the server generated and pushed down the
  // same stream — this is the `title_updated` frame arriving in a browser.
  await expect(threadRow(page, FAKE_TITLE)).toBeVisible()

  // Evidence, not inputs: the turn really ran a chain through the fake rather
  // than short-circuiting somewhere. `Router` is the first call every turn
  // makes, and `Synthesize` is the one whose text became the bubble above.
  const served = await backend.calls()
  expect(served.map((call) => call.fn)).toContain('Router')
  expect(served.map((call) => call.fn)).toContain('Synthesize')

  // And the tool half actually ran: the fake gateway saw the loop's call.
  expect((await backend.toolCalls()).length).toBeGreaterThan(0)

  // Exactly one answer, not a duplicate painted by both the stream and the
  // final result — a shape this app has had before.
  await expect(replies(page)).toHaveCount(1)
})
