import { test, expect } from '../lib/fixtures'
import { conversationRows } from '../lib/db'
import {
  composer,
  open,
  send,
  stopButton,
  tierOption,
  userBubbles,
  waitForReplies,
} from '../lib/chat'

test('Stop during a pending tier save says the message was not sent and posts no turn', async ({
  page,
  appUrl,
  backend,
}) => {
  await open(page, appUrl, { agent: 'General Agent · Next' })

  // Hold the real action's response until Stop has been pressed. The write
  // reaches the server, but runSend remains parked on pendingTierWrite.
  let releaseWrite!: () => void
  const released = new Promise<void>((resolve) => (releaseWrite = resolve))
  let writePending!: () => void
  const pending = new Promise<void>((resolve) => (writePending = resolve))
  await page.route('**/_server', async (route) => {
    const id = decodeURIComponent(route.request().headers()['x-server-id'] ?? '')
    if (!id.includes('--setConversationTier_')) return route.fallback()
    const response = await route.fetch()
    writePending()
    await released
    await route.fulfill({ response })
  })

  let turnPosts = 0
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/events' && request.method() === 'POST') {
      turnPosts++
    }
  })

  try {
    await tierOption(page, 'Anthropic').click()
    await pending
    await send(page, 'cancel this unsent question')
    await expect(stopButton(page)).toBeVisible()
    await stopButton(page).click()
  } finally {
    releaseWrite()
  }

  await expect(page.getByText('Message not sent.', { exact: true })).toBeVisible()
  await expect(page.getByText('Stopped watching this response.', { exact: true })).toHaveCount(0)
  await expect(composer(page)).toBeEditable()
  expect(turnPosts).toBe(0)
  expect(await backend.calls()).toHaveLength(0)
  expect(await conversationRows()).toHaveLength(0)

  // Reload confirms the cancellation notice describes reality: the unsent
  // message never became a persisted conversation. The next send still works.
  await page.reload()
  await expect(composer(page)).toBeEditable()
  await expect(userBubbles(page)).toHaveCount(0)
  await send(page, 'send this new question')
  await waitForReplies(page, 1)
  expect(turnPosts).toBe(1)
})
