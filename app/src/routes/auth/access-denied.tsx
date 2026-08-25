import { A } from '@solidjs/router'

/**
 * Shown when a valid Entra sign-in belongs to an account the allow-list does
 * not admit. The only action it can offer is a way back to sign-in, so that is
 * what the page is built around.
 *
 * Same design language as `signin.tsx` (#226 B8): attributify, `ui-*` theme
 * tokens, `cyber-button`, material-symbols.
 */
export default function AccessDenied() {
  return (
    <div
      flex="~ col"
      items="center"
      justify="center"
      p="x-4 y-12 sm:x-6 lg:x-8"
      min-h="screen"
      bg="ui-bg-primary"
    >
      <div
        w="full"
        max-w="md"
        p="8"
        rounded="lg"
        bg="ui-bg-secondary"
        border="1 ui-border-primary"
        shadow="lg"
        text="center"
      >
        <div
          flex="~"
          items="center"
          justify="center"
          w="16"
          h="16"
          m="x-auto b-4"
          rounded="full"
          bg="ui-danger/10"
          border="1 ui-danger/40"
        >
          <span
            class="i-material-symbols-gpp-bad-outline"
            w="8"
            h="8"
            text="ui-danger"
            aria-hidden="true"
          />
        </div>

        <h1 text="2xl ui-text-primary" font="semibold" m="b-4">
          Access Denied
        </h1>

        <div
          flex="~ col"
          gap="3"
          m="b-6"
          p="4"
          text="left"
          rounded="md"
          bg="ui-bg-tertiary"
          border="1 ui-border-primary"
        >
          <p text="sm ui-text-primary">
            Your account is not authorized to access this application.
          </p>
          <p text="sm ui-text-secondary">
            Access to DTalk.ai Knowledge System is restricted to authorized users only. If you
            believe you should have access, please contact the administrator.
          </p>
          <div p="t-3" border="t ui-border-primary">
            <p text="xs ui-text-secondary" font="semibold" m="b-1">
              Need access?
            </p>
            <p text="xs ui-text-tertiary">
              Contact your system administrator to request access to this application.
            </p>
          </div>
        </div>

        {/*
          `cyber-button=""`, not a valueless `cyber-button`: the JSX
          transformer only rewrites valueless attributes on intrinsic
          elements, so on a component Solid renders the boolean as
          `cyber-button="true"` and the `[cyber-button=""]` rule misses.
        */}
        <A
          href="/auth/signin"
          cyber-button=""
          flex="~"
          items="center"
          justify="center"
          gap="2"
          w="full"
        >
          <span class="i-material-symbols-login" w="5" h="5" aria-hidden="true" />
          Return to Sign In
        </A>
      </div>
    </div>
  )
}
