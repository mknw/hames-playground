import { createSignal, onMount } from 'solid-js'
import { applyTheme, resolveTheme, type Theme } from '~/lib/theme'

/**
 * The light/dark control (#226 B8). The palette it switches lives in
 * `uno.config.ts` as `--ui-*` variables and the switch rule in `lib/theme.ts`
 * — this component is only the button.
 *
 * Dark is rendered on the server and applied by the boot script in
 * `entry-server.tsx`, so the initial signal is dark and `onMount` only
 * re-reads storage to stay in step after hydration. There is no `createEffect`
 * writing the document: the toggle handler is the single write path, so the
 * component cannot fight the boot script for the class.
 */
export const ThemeSwitcher = () => {
  const [theme, setTheme] = createSignal<Theme>('dark')

  onMount(() => {
    const resolved = resolveTheme()
    setTheme(resolved)
    applyTheme(resolved)
  })

  const toggle = () => {
    const next: Theme = theme() === 'dark' ? 'light' : 'dark'
    setTheme(next)
    applyTheme(next)
  }

  const isDark = () => theme() === 'dark'
  const label = () => (isDark() ? 'Switch to light mode' : 'Switch to dark mode')

  return (
    <button
      onClick={toggle}
      flex="~"
      items="center"
      justify="center"
      w="10"
      h="10"
      rounded="full"
      bg="cyber-800/20 hover:cyber-700/30"
      border="1 cyber-700/50"
      transition="all"
      cursor="pointer"
      title={label()}
      aria-label={label()}
      aria-pressed={!isDark()}
    >
      {/* The glyph offers the mode you would get, not the one you are in. */}
      <span
        class={isDark() ? 'i-material-symbols-light-mode' : 'i-material-symbols-dark-mode'}
        w="5"
        h="5"
        text="ui-accent"
        aria-hidden="true"
      />
    </button>
  )
}
