import { A } from '@solidjs/router'

/**
 * The catch-all. Grouped with the auth pages because it is the same kind of
 * page — no state of its own, one job: hand the user their next action. It was
 * on the same off-palette light utilities and moves onto the `ui-*` theme
 * tokens with them (#226 B8). The SolidJS starter's outbound link is gone; a
 * 404 in this app should point back into this app.
 */
export default function NotFound() {
  return (
    <main
      flex="~ col"
      items="center"
      justify="center"
      gap="4"
      p="8"
      min-h="70vh"
      text="center"
      bg="ui-bg-primary"
    >
      <span
        class="i-material-symbols-explore-off-outline"
        w="10"
        h="10"
        text="ui-text-tertiary"
        aria-hidden="true"
      />
      <h1 text="3xl ui-text-primary" font="light" tracking="wide" uppercase>
        Not Found
      </h1>
      <p text="sm ui-text-secondary">That page does not exist.</p>
      <div flex="~" items="center" gap="3">
        <A href="/" text="sm ui-accent" hover="underline">
          Chat
        </A>
        <span text="xs ui-text-tertiary" aria-hidden="true">
          ·
        </span>
        <A href="/dashboard" text="sm ui-accent" hover="underline">
          Metrics
        </A>
      </div>
    </main>
  )
}
