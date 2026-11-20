/**
 * Scenario 26 — the admin panel drives the GPU boxes through Modal's control
 * API, and shows which one is up (#1057).
 *
 * The owner's words: "Create the new issue using Modal's control API.
 * introduce control and feedback for the admin panel, and more faithful
 * visualizations/interactions in the chat interface." The switch until now
 * kept the boxes warm by SENDING THEM REQUESTS — every HTTP request, a
 * `GET /health` included, starts a cold container — so what this scenario
 * establishes is the acceptance the control route exists for:
 *
 *   - the switch boots both boxes with NO request sent to either (`min_containers=1`
 *     through the sidecar fake — the wire is the honest witness, the same way
 *     scenario 21 counted wake pings);
 *   - the panel's per-box lines come from the CONTROL PLANE: cold when Modal
 *     reports no container, up — with the box's own `restored`/`gpu` from
 *     `/status` — when it reports one;
 *   - a per-box stop-now ends the containers behind a confirmation;
 *   - off releases the autoscaler (`min_containers=0`), still with no model
 *     request on the wire.
 *
 * `MODAL_CONTROL_BASE` is pointed at the same fake as the model routes in
 * global setup, so every call here is hermetic: nothing reaches Modal, and
 * nothing wakes a real box.
 */
import { test, expect } from '../lib/fixtures'
import type { ModalControlCall } from '../lib/control'
import { open } from '../lib/chat'

const KEEP_LABEL = 'Keep the self-deployed GPUs running'
const keepSwitch = (page: import('@playwright/test').Page) =>
  page.getByRole('checkbox', { name: KEEP_LABEL })

/** The switch's autoscaler assertions, as the fake recorded them. */
async function autoscalers(
  backend: import('../lib/control').FakeBackend,
): Promise<Array<Pick<ModalControlCall, 'box' | 'minContainers'>>> {
  return (await backend.modalCalls()).map(({ box, minContainers }) => ({ box, minContainers }))
}

test('the switch boots both boxes with no request sent, and the lines read from the control plane', async ({
  page,
  appUrl,
  backend,
}) => {
  await open(page, appUrl)
  await page.goto(`${appUrl}/admin`)

  // ---- The panel reads from the control plane: both boxes observed COLD ----
  await expect(page.getByTestId('gpu-modal-card')).toContainText('Modal control')
  await expect(page.getByTestId('gpu-modal-large')).toContainText('27B')
  await expect(page.getByTestId('gpu-modal-large')).toContainText('cold')
  await expect(page.getByTestId('gpu-modal-small')).toContainText('4B')
  await expect(page.getByTestId('gpu-modal-small')).toContainText('cold')

  // ---- ON asserts min_containers=1 per box, and NO model request is sent --
  const before = await backend.calls()
  await keepSwitch(page).press('Space')
  await expect(keepSwitch(page)).toBeChecked()

  const assertions = await autoscalers(backend)
  expect(assertions).toContainEqual({ box: 'large', minContainers: 1 })
  expect(assertions).toContainEqual({ box: 'small', minContainers: 1 })

  // THE acceptance: booted with no request sent. Nothing reached either box —
  // no wake ping, no health poll, not one model call.
  expect(await backend.calls()).toEqual(before)

  // ---- A container comes up: the line names it, restored, GPU, up-for ----
  await backend.modalArm({ large: 1 })
  await expect(page.getByTestId('gpu-modal-large')).toContainText('restored from a snapshot')
  await expect(page.getByTestId('gpu-modal-large')).toContainText('NVIDIA L4')
  await expect(page.getByTestId('gpu-modal-large')).toContainText('up for')

  // ---- Stop now, behind a confirmation: only the confirmed stop stops -----
  const confirm = page.waitForEvent('dialog')
  page.once('dialog', (dialog) => void dialog.dismiss())
  await page
    .getByTestId('gpu-modal-large')
    .getByRole('button', { name: /stop now/i })
    .click()
  await confirm
  const stops = (await backend.modalCalls()).filter((call) => call.route === 'stop')
  expect(stops).toEqual([])

  const confirmed = page.waitForEvent('dialog')
  page.once('dialog', (dialog) => void dialog.accept())
  await page
    .getByTestId('gpu-modal-large')
    .getByRole('button', { name: /stop now/i })
    .click()
  await confirmed
  await expect
    .poll(async () => (await backend.modalCalls()).filter((call) => call.route === 'stop').length, {
      message: 'the confirmed stop did not reach the sidecar fake',
    })
    .toBe(1)
  // The stop cleared the fake's armed container: the line observes it.
  await expect(page.getByTestId('gpu-modal-large')).toContainText('cold')

  // ---- OFF releases the autoscaler, still with no request sent -----------
  const modelCalls = await backend.calls()
  await keepSwitch(page).press('Space')
  await expect(keepSwitch(page)).not.toBeChecked()
  const release = (await autoscalers(backend)).filter((call) => call.minContainers === 0)
  expect(release).toContainEqual({ box: 'large', minContainers: 0 })
  expect(release).toContainEqual({ box: 'small', minContainers: 0 })
  expect(await backend.calls()).toEqual(modelCalls)
})
