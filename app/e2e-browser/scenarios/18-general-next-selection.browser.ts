import { test, expect } from '../lib/fixtures'
import { chooseAgent, open, send, waitForReplies } from '../lib/chat'

test('the sole selectable agent starts a real general-next turn', async ({
  page,
  appUrl,
  backend,
}) => {
  await open(page, appUrl)
  await chooseAgent(page, 'General Agent · Next')
  await send(page, 'how many nodes are in the graph?')
  await waitForReplies(page, 1)

  const functions = (await backend.calls()).map((call) => call.fn)
  expect(functions).toContain('LoopController')
  expect(functions).toContain('Synthesize')
  expect((await backend.toolCalls()).length).toBeGreaterThan(0)
})
