/**
 * Scenario 5 — three turns, all of them still on screen, in the order they
 * were asked.
 *
 * The cheap version of this test counts bubbles, and a transcript that renders
 * the same reply three times would pass it. So the assertions are about
 * SEQUENCE and IDENTITY: each question is where the user left it, each answer
 * follows its own question, and the DOM order of the two kinds of bubble
 * alternates the way a conversation does.
 *
 * One assertion is about the wire rather than the screen, and it is the one
 * that makes the rest mean something: the third turn's controller prompt still
 * contains the first turn's question. Three bubbles prove the app kept a list;
 * that proves the SERVER kept a conversation — which is what a fourth turn will
 * be answered from. `app/e2e/scenarios/02-multi-turn` owns that claim in
 * general; repeating one line of it here is what stops this file from being a
 * rendering test wearing a conversation's clothes.
 */
import { test, expect } from '../lib/fixtures'
import { expectFakeAnswer, open, replies, send, userBubbles, waitForReplies } from '../lib/chat'

const QUESTIONS = [
  'how many nodes are in the graph?',
  'and how many relationships?',
  'summarise both answers',
]

test('three turns all stay visible, in order', async ({ page, appUrl, backend }) => {
  await open(page, appUrl)

  for (const [index, question] of QUESTIONS.entries()) {
    // Cleared before the LAST turn only, so the calls read back at the end are
    // unambiguously turn 3's — the history claim below is about what the third
    // turn was handed, and a whole-run call list would satisfy it with turn 1's
    // own prompt.
    if (index === QUESTIONS.length - 1) await backend.reset()
    await send(page, question)
    await waitForReplies(page, index + 1)
  }

  // Every question is still where it was asked.
  const asked = await userBubbles(page).allInnerTexts()
  expect(asked).toHaveLength(3)
  QUESTIONS.forEach((question, index) => expect(asked[index]).toContain(question))

  // Every answer is present, and each is a real reply rather than a repaint of
  // the previous one's node.
  const answers = await replies(page).allInnerTexts()
  expect(answers).toHaveLength(3)
  answers.forEach(expectFakeAnswer)

  // Question, answer, question, answer, question, answer — read off the DOM in
  // document order, which is the order a human reads them in. A transcript that
  // appended all three answers after all three questions would pass every
  // count above and fail here.
  const order = await page.evaluate(() =>
    [...document.querySelectorAll('[data-role="user"], [data-role="assistant"]')]
      .map((node) => node.getAttribute('data-role'))
      // The welcome bubble and the progress row are both assistant-shaped; the
      // first is chrome and the second is stamped `data-progress`.
      .filter((_, index, all) => all.length - index <= 6),
  )
  expect(order).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant'])

  // The server kept the conversation, not just the browser: something turn 3
  // put on the wire still carries turn 1's question.
  //
  // "Something", not "the controller's prompt": the intent the loop runs on is
  // compacted first (`CompactIntent`), so which call carries the raw history is
  // a detail of the chain rather than part of this claim — the same reading
  // `e2e/scenarios/02-multi-turn` takes. What would be a real failure is NO
  // call on turn 3 having seen turn 1, which is what a continuation that
  // silently started from an empty context looks like: it still answers, still
  // persists, and only breaks when a follow-up depends on an earlier answer.
  const turn3 = await backend.calls()
  expect(turn3.length, 'turn 3 made no model calls at all').toBeGreaterThan(0)
  expect(
    turn3.some((call) => call.prompt.includes(QUESTIONS[0])),
    'no call on turn 3 mentioned turn 1 — the continuation lost its history',
  ).toBe(true)
})
