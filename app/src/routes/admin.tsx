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
 *  - the 27B's live state (cold / starting / ready), read from
 *    `getPreviewHeaderState()` — the SAME payload the header strip renders,
 *    so the two surfaces cannot disagree about that box — plus the 4B's
 *    state and both boxes' up-since, which no strip renders and which ride
 *    this page's own admin payload (`getGpuAdminState`) instead; the poll
 *    that refreshes the one re-reads the other, so both stay live while the
 *    page is open (round 5: a poll that refreshed only the header froze the
 *    4B at page load — a down box kept billing, a starting one never began);
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
import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js'
import { Switch } from '@ark-ui/solid/switch'
import {
  getGpuAdminState,
  setGpuKeepRunning,
  type GpuAdminState,
} from '~/lib/harness-client/gpu-admin.server'
import {
  getPreviewHeaderState,
  type PreviewHeaderState,
} from '~/lib/harness-client/preview-header.server'
import {
  asHeaderState,
  ACTIVE_POLL_INTERVAL_MS,
  POLL_INTERVAL_MS,
  TICK_INTERVAL_MS,
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

  // Both payloads are plain signals fed by ONE read cycle rather than
  // resources, for two reasons a resource cannot offer. A failed refetch
  // RECORDS its error on the resource, and a poll that cannot reach the server
  // would flip this page to the refusal panel instead of keeping the last good
  // payload on screen — the refusal is the FIRST read's business alone
  // (`refused` below). And a resource's refetch overlaps freely with the one
  // before it, while a slower OLD answer must never overwrite a newer payload.
  const [admin, setAdmin] = createSignal<GpuAdminState | null>(null)
  const [warmth, setWarmth] = createSignal<PreviewHeaderState | null>(null)
  /** Set by a read that failed while there was no payload to keep — the 403
   *  (or the failure) the forbidden panel renders. A later read that fails
   *  keeps the payload it has and never touches this. */
  const [refused, setRefused] = createSignal(false)

  // The toggle's own pending/error channel: a wake can take minutes, and a
  // failure here is the difference between "the boxes are coming" and "the
  // boxes did not come" — it is never swallowed into a silently-off switch.
  const [busy, setBusy] = createSignal(false)
  const [failed, setFailed] = createSignal<string | null>(null)

  /** Has a good admin payload ever landed? A plain flag rather than a signal
   *  read, because the decision below is made OUTSIDE any tracked scope: a
   *  failed poll must not re-render anything, it only decides whether there
   *  is a payload to keep. */
  let haveAdminPayload = false

  /** Read the admin payload. A failed read KEEPS the last good payload: the
   *  poll's next cycle replaces it, and only a failure with nothing to keep
   *  is the refusal the page must show. */
  const loadAdmin = async () => {
    try {
      setAdmin(await getGpuAdminState())
      haveAdminPayload = true
      setRefused(false)
    } catch {
      if (!haveAdminPayload) setRefused(true)
    }
  }

  /** Read the header payload — the same read the strip polls. The same rule as
   *  the strip's own poll: a failed read leaves the last known state on screen
   *  until a cycle can replace it. */
  const loadWarmth = async () => {
    try {
      setWarmth(asHeaderState(await getPreviewHeaderState()))
    } catch {
      // keeps the last good payload
    }
  }

  // ONE read cycle at a time, serialized rather than overlapping. A cycle
  // started before a flip can resolve after the flip's own read and would
  // overwrite its fresher payload with a stale one; a poll tick landing while
  // a slow cycle is still on the wire must not stack a second fetch on it.
  // Each cycle awaits its predecessor, so at most one is ever in flight, and
  // neither load ever rejects (each keeps the last good payload on failure),
  // so a failed cycle cannot poison the chain.
  let cycle: Promise<void> | null = null
  const readBoth = (): Promise<void> => {
    const next = (cycle ?? Promise.resolve()).then(() =>
      Promise.all([loadAdmin(), loadWarmth()]).then(() => undefined),
    )
    cycle = next
    return next
  }

  /** The poll's tick: SKIPS while a cycle is still in flight or queued — the
   *  next tick catches up, and a slow read never piles fetches behind it. */
  let pollActive = false
  const poll = () => {
    if (pollActive) return
    pollActive = true
    void readBoth().finally(() => {
      pollActive = false
    })
  }

  onMount(() => {
    void readBoth()
  })

  // Poll the boxes' state the way the strip does, at the strip's own rates:
  // settled boxes every 15s, a starting one every 3s so the flip a switch
  // causes is visible where the switch is. The interval is owned by an effect
  // that TRACKS the rate (the strip's own reason: a timer armed once at mount
  // is armed before the first payload, and always at the settled rate).
  //
  // Each poll re-reads BOTH payloads, not just the header warmth: the 4B's
  // state and both boxes' up-sinces ride the admin payload, so a poll that
  // refreshed only the header would freeze them at page load — a 4B that went
  // down kept billing, and one that came up during this page's lifetime never
  // started (the round-5 blocking defect).
  const pollInterval = () => {
    const s = warmth()?.warmth.state
    return s === 'starting' || s === 'answering' || busy()
      ? ACTIVE_POLL_INTERVAL_MS
      : POLL_INTERVAL_MS
  }
  createEffect(() => {
    const timer = setInterval(() => poll(), pollInterval())
    onCleanup(() => clearInterval(timer))
  })

  const flip = async (on: boolean) => {
    if (busy()) return
    setBusy(true)
    setFailed(null)
    try {
      await setGpuKeepRunning(on)
      await readBoth()
    } catch (err) {
      // The switch's persisted state is NOT assumed: re-read it, because the
      // write happened before the wake and a failed wake leaves it ON (no
      // silent auto-off) — the page must say which of the two is true.
      await loadAdmin()
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

  /** The per-hour rate of each box the keep-running loop actually keeps up:
   *  the small box's always — the loop keeps it in every configuration — plus
   *  the 27B's only when there IS a 27B box of ours to keep. On the OpenRouter
   *  route the 27B is a public per-token API, not a scale-to-zero box of ours,
   *  and the loop skips it exactly as the wake does (`wake.server.ts`) —
   *  pricing it here would bill a box nobody is keeping, and metering it would
   *  read a box nobody is keeping.
   */
  const perBoxRates = (): { large: number; small: number } => {
    const s = state()
    if (!s) return { large: 0, small: 0 }
    return {
      large: s.largeOnOpenRouter ? 0 : s.largeEurPerHour,
      small: s.smallEurPerHour,
    }
  }

  /** The per-hour price the "billed at" line shows: both kept boxes, summed. */
  const perHour = () => {
    const r = perBoxRates()
    return r.large + r.small
  }

  /** The same figure's breakdown, naming which boxes the rate is for — so on
   *  the OpenRouter route the missing 27B is explained rather than silently
   *  dropped. */
  const rateBreakdown = () => {
    const s = state()
    if (!s) return ''
    return s.largeOnOpenRouter
      ? `4B ≥ ${fmtEur(s.smallEurPerHour)}/h — the 27B runs through OpenRouter, so the loop keeps no 27B box`
      : `27B ≥ ${fmtEur(s.largeEurPerHour)}/h + 4B ≥ ${fmtEur(s.smallEurPerHour)}/h`
  }

  const runningSince = () => (state()?.keepRunning ? (state()?.switchedOnAt ?? null) : null)

  // ---- The "so far" meter ---------------------------------------------
  //
  // Three properties a recomputed `(now - stamp) × rate` cannot have (#1047
  // review rounds 2 and 3): it must MOVE while the page is open (a meter
  // frozen at page load reads as a hung page); it must NOT move while no box
  // is up — with the switch on but every wake failing, no GPU time is being
  // bought and the figure must not grow; and it must accrue PER BOX — each
  // box's rate only while THAT box is up, so on the OpenRouter route, where
  // the loop keeps no 27B, the meter still runs on the 4B the loop IS
  // keeping up and paying for.
  //
  // So the meter ACCRUES per box: it adds time only while the live payload
  // shows that box up, and freezes for a box while it does not. `ready` and
  // `answering` are completion evidence — the deployment answered a real
  // request — while `starting` is a wake in flight with no evidence yet, so
  // it does NOT count: the cold start it may end in is one of the spans the
  // meter's own footnote already excludes.
  //
  // The first up observation of a switch-on charges from the SERVER's
  // per-box up-since (`upSince` in the admin payload — when each box first
  // came up after being cold, not when the switch went on, and not the last
  // keep-warm ping), so a reload in the middle of a run re-bills the time the
  // boxes were actually up and neither re-adds the cold start the switch-on
  // woke into nor restarts the count at ~zero because a ping refreshed the
  // completion clock. The up-since is clamped at the switch-on stamp, because
  // a box that was already up when the switch flipped has been billed from
  // the flip, not from before it. It is process-local: a server restart
  // loses it, and the meter then starts from its own observation —
  // under-stating, never over-stating, which is the direction a floor may
  // err in.
  const [accruedEur, setAccruedEur] = createSignal<number | null>(null)
  let accrualStamp: number | null = null
  let lastTickAt = Date.now()
  /** Each box's accrued UP-time in ms for this switch-on. */
  const accruedUpMs: Record<'large' | 'small', number> = { large: 0, small: 0 }
  /** Which boxes have had their first up observation of this switch-on. */
  const seeded: Record<'large' | 'small', boolean> = { large: false, small: false }

  const accrue = (now: number) => {
    // Both payloads are plain signals, so no read here can throw: the old
    // try/catch guarded REJECTED resources, and a failed poll now keeps the
    // last good payload instead (see `loadAdmin` / `loadWarmth`). The reads
    // still TRACK: an effect running this sees each poll's refresh.
    const since = runningSince()
    const w = warmth()
    const s = state()
    // The 27B's up-state from the header payload (the strip renders it);
    // the 4B's from the admin payload — the per-box fields no strip
    // renders, moved off the payload every signed-in user receives.
    const up: Record<'large' | 'small', boolean> = {
      large: w?.warmth.state === 'ready' || w?.warmth.state === 'answering',
      small: s?.smallState === 'ready',
    }
    const upSince: Record<'large' | 'small', number | null> = {
      large: s?.largeUpSince ?? null,
      small: s?.smallUpSince ?? null,
    }
    const rates = perBoxRates()
    if (since !== accrualStamp) {
      // A new switch-on, or this page's first observation of one: the meter
      // restarts from its own stamp.
      accrualStamp = since
      accruedUpMs.large = 0
      accruedUpMs.small = 0
      seeded.large = false
      seeded.small = false
      lastTickAt = now
    }
    let eur = 0
    if (since !== null) {
      for (const box of ['large', 'small'] as const) {
        // A box the loop does not keep — the 27B on the OpenRouter route —
        // has no rate and no meter state: nothing is being bought for it.
        if (rates[box] <= 0) continue
        if (!up[box]) continue
        if (!seeded[box]) {
          seeded[box] = true
          const boxUpSince = upSince[box]
          // From the server's recorded up-since when there is one — never
          // the cold start before the box first came up — clamped at the
          // stamp (a box already up at the flip is billed from the flip);
          // from this page's own observation when there is not.
          const from = boxUpSince !== null ? Math.max(boxUpSince, since) : lastTickAt
          accruedUpMs[box] = now - from
        } else {
          accruedUpMs[box] += now - lastTickAt
        }
        eur += (accruedUpMs[box] / 3_600_000) * rates[box]
      }
    }
    lastTickAt = now
    setAccruedEur(since === null ? null : eur)
  }

  // The strip's own 1-second countdown tick (TICK_INTERVAL_MS), reused rather
  // than a second cadence invented: the meter and the header countdown then
  // read the same second. The effect beside it recomputes on every payload
  // and switch read too, so a flip or a poll answer shows up at once rather
  // than a second late.
  onMount(() => {
    const tick = setInterval(() => accrue(Date.now()), TICK_INTERVAL_MS)
    onCleanup(() => clearInterval(tick))
  })
  createEffect(() => {
    accrue(Date.now())
  })

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
        when={mounted() && admin()}
        fallback={
          <Show
            when={refused()}
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
                  while up ({rateBreakdown()})
                </p>
                <Show when={accruedEur() !== null}>
                  <p
                    text="xs ui-text-secondary"
                    title="A floor: it counts, for each box, the time that box was actually up since the switch was turned on — charging from the box's recorded up-since, so neither the cold start before it first came up nor a reload re-adds that span — and adds neither the spans a box was down in nor the scale-down window after the last answer. A server restart loses the up-since, and the count then starts from what this page observed itself."
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
