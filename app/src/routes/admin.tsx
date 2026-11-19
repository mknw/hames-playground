/**
 * Admin (`/admin`) — the owner-only GPU panel (#1047).
 *
 * Owner, 2026-11-19: "I want an interface setting in a third page … which
 * gives me the option of connect the modal gpu on demand. and keep it
 * running. This will be useful for the live demo I will give tomorrow." — and
 * the amendment that made it this page: "The modal (or admin panel, a 4th
 * tab) will be only accessible to me."
 *
 * One control: **Keep the self-deployed GPUs running**. On wakes both boxes
 * now and keeps them up until it is switched off — no tab has to stay open,
 * no idle cap applies, and the switch itself lives in Postgres, so it
 * survives a reload, a closed tab and another browser entirely. Off returns
 * to today's behaviour: keep-warm while a page is open, then scale down.
 *
 * Three facts sit beside the switch:
 *  - the boxes' live state (cold / starting / ready), read from
 *    `getPreviewHeaderState()` — the SAME payload the header strip renders,
 *    so the two surfaces cannot disagree about the one box;
 *  - "running since", from the switch's own persisted stamp; and
 *  - the per-hour price the app already computes (`cost-rates.server.ts`),
 *    because a switch that keeps an H100 up is a switch that spends about
 *    €4.60 an hour, and the person flipping it should see the meter running.
 *
 * Access: the page renders behind `AuthProvider` like every other route, but
 * the real gate is server-side — every action in
 * `harness-client/gpu-admin.server.ts` refuses a non-admin with a 403, so a
 * hidden tab is presentation, not access control. The route fetches
 * client-side only (the `mounted` gate, as `AuthProvider` does): the fetch
 * itself is the permission check, and what a non-admin gets is the forbidden
 * panel below rather than a flash of owner-only controls.
 *
 * Look and layout follow `dashboard.tsx` / `use-cases.tsx`: the `ui-*` tokens
 * only, cards on the page ground, and a single column that holds at 390px.
 */
import { A } from '@solidjs/router'
import { createEffect, createResource, createSignal, onCleanup, onMount, Show } from 'solid-js'
import { Switch } from '@ark-ui/solid/switch'
import { getGpuAdminState, setGpuKeepRunning } from '~/lib/harness-client/gpu-admin.server'
import { getPreviewHeaderState } from '~/lib/harness-client/preview-header.server'
import {
  asHeaderState,
  ACTIVE_POLL_INTERVAL_MS,
  POLL_INTERVAL_MS,
  WARMTH_PRESENTATION,
} from '~/components/ark-ui/PreviewHeaderStrip'
import { fmtEur } from '@hames-ai/harness-patterns/observability/token-totals'
import { formatCountdown } from '~/lib/preview-header-format'

/** The switch's label, on its own line: the words the owner asked for,
 *  following the header's "start self-deployed GPUs" vocabulary. */
export const GPU_KEEP_LABEL = 'Keep the self-deployed GPUs running'

/** The state the toggle shows while its wake is in flight — the same wording
 *  class as the header's pending state, because this control can hold for
 *  minutes on a cold box. */
export const GPU_KEEP_STARTING = 'starting the boxes…'

/** What the page says when the caller is not the deployment admin. Wording is
 *  deliberately "not found"-adjacent: it names no capabilities, confirms no
 *  secrets, and hands the visitor back to the chat. */
export const GPU_ADMIN_FORBIDDEN = 'Admin only'

export default function Admin() {
  // Client-side only: the fetches below are the permission check, and SSR has
  // no session worth consulting for a page whose every action re-checks it.
  const [mounted, setMounted] = createSignal(false)
  onMount(() => setMounted(true))

  const [admin, { refetch: refetchAdmin }] = createResource(mounted, async () => getGpuAdminState())
  const [warmth, { refetch: refetchWarmth }] = createResource(mounted, async () =>
    asHeaderState(await getPreviewHeaderState()),
  )

  // The toggle's own pending/error channel: a wake can take minutes, and a
  // failure here is the difference between "the boxes are coming" and "the
  // boxes did not come" — it is never swallowed into a silently-off switch.
  const [busy, setBusy] = createSignal(false)
  const [failed, setFailed] = createSignal<string | null>(null)

  // Poll the boxes' state the way the strip does, at the strip's own rates:
  // settled boxes every 15s, a starting one every 3s so the flip a switch
  // causes is visible where the switch is. The interval is owned by an effect
  // that TRACKS the rate (the strip's own reason: a timer armed once at mount
  // is armed before the first payload, and always at the settled rate).
  const pollInterval = () => {
    const s = warmth()?.warmth.state
    return s === 'starting' || s === 'answering' || busy()
      ? ACTIVE_POLL_INTERVAL_MS
      : POLL_INTERVAL_MS
  }
  createEffect(() => {
    const timer = setInterval(() => void refetchWarmth(), pollInterval())
    onCleanup(() => clearInterval(timer))
  })

  const flip = async (on: boolean) => {
    if (busy()) return
    setBusy(true)
    setFailed(null)
    try {
      await setGpuKeepRunning(on)
      await Promise.all([refetchAdmin(), refetchWarmth()])
    } catch (err) {
      // The switch's persisted state is NOT assumed: re-read it, because the
      // write happened before the wake and a failed wake leaves it ON (no
      // silent auto-off) — the page must say which of the two is true.
      await refetchAdmin()
      setFailed(
        err instanceof Error ? err.message : 'The self-deployed GPUs could not be switched.',
      )
    } finally {
      setBusy(false)
    }
  }

  /** The warmth word + figure, exactly as the strip computes them — one
   *  source, one derivation, so the admin panel and the header cannot show
   *  two different boxes. */
  const warmthWord = () => warmth()?.warmth.state ?? 'unknown'
  const warmthFigure = () => {
    const w = warmth()?.warmth
    if (!w) return null
    if (w.state === 'ready' || w.state === 'answering') {
      return w.secondsUntilScaledown === null ? null : formatCountdown(w.secondsUntilScaledown)
    }
    if (w.state === 'starting' && w.coldStartEstimateMs !== null) {
      return formatCountdown(Math.round(w.coldStartEstimateMs / 1000))
    }
    return null
  }

  const state = () => admin()
  const perHour = () => (state() ? state()!.largeEurPerHour + state()!.smallEurPerHour : 0)
  const runningSince = () => (state()?.keepRunning ? (state()?.switchedOnAt ?? null) : null)
  const accruedEur = () => {
    const since = runningSince()
    return since === null ? null : ((Date.now() - since) / 3_600_000) * perHour()
  }

  const fmtWhen = (ms: number) => new Date(ms).toLocaleString()

  return (
    <main flex="~ col" gap="6" p="6" bg="ui-bg-primary" text="ui-text-primary" font="sans">
      <header flex="~ wrap" items="center" gap="4">
        <div flex="~ col" gap="1">
          <h1 text="2xl ui-text-primary" font="medium">
            Admin
          </h1>
          <span text="xs ui-text-secondary">
            The self-deployed GPUs: connect them on demand, keep them running for the demo, and see
            what they cost
          </span>
        </div>
      </header>

      <Show
        when={mounted() && !admin.error && admin()}
        fallback={
          <Show
            when={admin.error}
            fallback={
              <p p="6" text="sm ui-text-tertiary" role="status">
                Reading the GPU state…
              </p>
            }
          >
            {/* The forbidden (or failed) case: never a flash of owner-only
                controls. The gate itself is server-side; this is what refusing
                looks like to a person. */}
            <section
              flex="~ col"
              items="center"
              justify="center"
              gap="4"
              p="8"
              min-h="50vh"
              text="center"
              bg="ui-bg-primary"
              data-testid="gpu-admin-forbidden"
            >
              <span
                class="i-material-symbols-explore-off-outline"
                w="10"
                h="10"
                text="ui-text-tertiary"
                aria-hidden="true"
              />
              <h1 text="3xl ui-text-primary" font="light" tracking="wide" uppercase>
                {GPU_ADMIN_FORBIDDEN}
              </h1>
              <p text="sm ui-text-secondary">
                That page is restricted to this deployment's administrator.
              </p>
              <A href="/" text="sm ui-accent" hover="underline">
                Chat
              </A>
            </section>
          </Show>
        }
      >
        {(s) => (
          <>
            {/* ---- The switch ------------------------------------------ */}
            <section
              flex="~ col"
              gap="3"
              p="4"
              rounded="lg"
              bg="ui-bg-secondary"
              border="1 ui-border-primary"
              data-testid="gpu-keep-card"
            >
              <Switch.Root
                data-testid="gpu-keep-switch"
                flex="~"
                items="center"
                gap="3"
                ring="2 transparent focus-within:ui-accent"
                checked={s().keepRunning}
                disabled={busy() || !s().configured}
                onCheckedChange={(d) => void flip(d.checked)}
              >
                <Switch.Label text="sm ui-text-primary">{GPU_KEEP_LABEL}</Switch.Label>
                <Switch.Control
                  bg="ui-bg-tertiary"
                  border="1 ui-border-primary"
                  rounded="full"
                  p="1"
                  ring="2 transparent focus-within:ui-accent"
                >
                  <Switch.Thumb text="ui-accent">
                    {busy() ? '··' : s().keepRunning ? 'On' : 'Off'}
                  </Switch.Thumb>
                </Switch.Control>
                <Switch.HiddenInput />
              </Switch.Root>

              <p text="xs ui-text-secondary">
                <Show
                  when={s().configured}
                  fallback={
                    <span>
                      The self-hosted inference endpoint is not configured on this deployment, so
                      there is nothing to keep running (see{' '}
                      <span font="mono">app/.env.example</span>).
                    </span>
                  }
                >
                  On wakes both GPUs now and keeps them up until this is switched off — with no
                  browser open, and past every idle cap and scale-down window. Off returns to
                  today's behaviour: warm while someone has the app open, then scaled to zero. The
                  switch is kept on the server, so it survives a reload or a closed tab.
                </Show>
              </p>

              <Show when={busy()}>
                <p role="status" text="xs ui-text-primary" data-testid="gpu-keep-busy">
                  {GPU_KEEP_STARTING} this can take minutes on a cold box.
                </p>
              </Show>
              <Show when={failed()}>
                <p role="alert" text="xs ui-danger" data-testid="gpu-keep-failed">
                  {failed()}
                  <Show when={s().keepRunning}>
                    {' '}
                    The switch is left on and keeps retrying; switch it off to stop.
                  </Show>
                </p>
              </Show>
            </section>

            {/* ---- Live state + cost ----------------------------------- */}
            <section
              flex="~ col"
              gap="3"
              p="4"
              rounded="lg"
              bg="ui-bg-secondary"
              border="1 ui-border-primary"
            >
              <div flex="~ items-center" gap="3">
                <span
                  flex="~"
                  items="center"
                  gap="1"
                  data-testid="gpu-warmth"
                  title={WARMTH_PRESENTATION[warmthWord()].hint}
                >
                  {WARMTH_PRESENTATION[warmthWord()].glyph()}
                  <span text="sm ui-text-primary">{WARMTH_PRESENTATION[warmthWord()].word}</span>
                </span>
                <Show when={warmthFigure() !== null}>
                  <span text="xs ui-text-tertiary" font="mono">
                    {warmthFigure()}
                  </span>
                </Show>
              </div>
              <p text="xs ui-text-secondary">
                The same live state the header shows, from the same server read.
              </p>

              <Show
                when={runningSince() !== null}
                fallback={
                  <p text="xs ui-text-secondary">
                    The GPUs are not being kept running; they scale to zero after their idle
                    windows.
                  </p>
                }
              >
                <p text="xs ui-text-secondary" data-testid="gpu-keep-since">
                  Kept running since <span font="mono">{fmtWhen(runningSince()!)}</span> · billed at{' '}
                  <span font="mono" text="ui-text-primary">
                    ≥ {fmtEur(perHour())}/hour
                  </span>{' '}
                  while up (27B ≥ {fmtEur(s().largeEurPerHour)}/h + 4B ≥{' '}
                  {fmtEur(s().smallEurPerHour)}/h)
                </p>
                <Show when={accruedEur() !== null}>
                  <p
                    text="xs ui-text-secondary"
                    title="A floor: it counts the time since the switch was turned on, and adds neither the cold start before the first call nor the scale-down window after the last."
                  >
                    ≥ <span font="mono">{fmtEur(accruedEur()!)}</span> so far — a floor, not the
                    bill.
                  </p>
                </Show>
              </Show>
            </section>
          </>
        )}
      </Show>
    </main>
  )
}
