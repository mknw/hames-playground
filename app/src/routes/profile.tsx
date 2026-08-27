/**
 * Profile page (`/profile`).
 *
 * The user menu has linked here since it was written; the route did not exist,
 * so "Profile Settings" landed on the 404 page. This is the alpha-minimal
 * version of what that link promises: who you are signed in as, which theme
 * the interface uses, and which inference tier your chats run on.
 *
 * Deliberately not an account system. Nothing here is editable except the
 * theme, because the theme is the only one of the three the app itself owns —
 * name and mail address come from Entra, and the tier already has exactly one
 * control (the header switch) which is on screen at the same time as this page.
 *
 * Auth matches the rest of the app: the page renders behind `AuthProvider`, and
 * `getProfile()` independently re-checks the session and resolves the owner
 * from it, so an unauthenticated fetch gets nothing regardless of the client
 * gate. The encrypted `users` columns are read through their own repository
 * module — see `lib/auth/profile.server.ts`.
 */

import { createResource, createSignal, Show, type JSX } from 'solid-js'
import { getProfile, type ProfileView } from '~/lib/auth/profile.server'
import { ThemeSwitcher } from '~/components/ark-ui/ThemeSwitcher'
import { TIER_LABELS } from '~/lib/preview-header-format'

/** Epoch millis → the viewer's locale. Em dash when the row has no stamp. */
const fmtWhen = (ms: number | null): string => (ms === null ? '—' : new Date(ms).toLocaleString())

const Section = (props: { title: string; hint?: string; children: JSX.Element }) => (
  <section
    flex="~ col"
    gap="3"
    p="4"
    rounded="lg"
    bg="ui-bg-secondary"
    border="1 ui-border-primary"
  >
    <div flex="~ col" gap="1">
      <h2 text="sm ui-text-tertiary" tracking="wide" uppercase>
        {props.title}
      </h2>
      <Show when={props.hint}>
        <span text="xs ui-text-secondary">{props.hint}</span>
      </Show>
    </div>
    {props.children}
  </section>
)

/** One label/value pair. `<dl>` rather than a table: these are name-value
 *  pairs, and a screen reader announces them as such. */
const Field = (props: { label: string; children: JSX.Element }) => (
  <div flex="~ wrap" gap="2" items="baseline">
    <dt text="xs ui-text-tertiary" min-w="28">
      {props.label}
    </dt>
    <dd text="sm ui-text-primary" m="0">
      {props.children}
    </dd>
  </div>
)

export default function Profile() {
  // A failed load is reported rather than thrown: there is no ErrorBoundary
  // above this route, so an uncaught rejection would paint an empty page.
  const [failure, setFailure] = createSignal<string | null>(null)
  const [profile] = createResource<ProfileView | undefined>(async () => {
    try {
      return await getProfile()
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err))
      return undefined
    }
  })

  // No `min-h="screen"`: `Nav` sits above this route in the root layout, so a
  // full viewport here would always overflow by the nav's height.
  return (
    <main
      flex="~ col"
      gap="6"
      p="6"
      max-w="3xl"
      bg="ui-bg-primary"
      text="ui-text-primary"
      font="sans"
    >
      <header flex="~ col" gap="1">
        <h1 text="2xl ui-text-primary" font="medium">
          Profile
        </h1>
        <span text="xs ui-text-secondary">
          Your account, and the two settings that follow you rather than a conversation
        </span>
      </header>

      <Show
        when={profile()}
        fallback={
          <div p="4" text="sm ui-text-tertiary" role="status" aria-live="polite">
            <Show when={failure()} fallback="Loading your profile…">
              {(message) => <span text="ui-danger">Could not load your profile: {message()}</span>}
            </Show>
          </div>
        }
      >
        {(data) => (
          <>
            <Section title="Account" hint="Signed in through Microsoft Entra.">
              <dl flex="~ col" gap="2" m="0">
                <Field label="Name">{data().displayName ?? '—'}</Field>
                <Field label="Email">
                  <span font="mono">{data().email}</span>
                </Field>
                <Field label="First sign-in">{fmtWhen(data().firstLogin)}</Field>
                <Field label="Last sign-in">{fmtWhen(data().lastLogin)}</Field>
              </dl>
            </Section>

            <Section
              title="Appearance"
              hint="Light, dark, or whatever your operating system asks for. Stored in this browser."
            >
              <div flex="~" items="center" gap="3">
                <ThemeSwitcher />
                <span text="xs ui-text-secondary">The same control as the one in the top bar.</span>
              </div>
            </Section>

            <Section
              title="Inference"
              hint="Which models your chats run on. Stored on the server, so it holds across browsers and for runs started without one."
            >
              <div flex="~ wrap" items="center" gap="3">
                <span
                  text="xs ui-accent"
                  bg="ui-accent/10"
                  p="x-1.5 y-0.5"
                  rounded="sm"
                  font="mono"
                >
                  {TIER_LABELS[data().tier]}
                </span>
                <span text="xs ui-text-secondary">
                  Change it with the switch at the left of the top bar — one control, so this page
                  cannot disagree with it.
                </span>
              </div>
            </Section>
          </>
        )}
      </Show>
    </main>
  )
}
