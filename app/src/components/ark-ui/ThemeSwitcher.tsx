import { Menu } from '@ark-ui/solid/menu'
import { createSignal, For, onCleanup, onMount } from 'solid-js'
import {
  applyTheme,
  applyThemeChoice,
  readThemeChoice,
  resolveTheme,
  THEME_CHOICES,
  watchSystemTheme,
  type Theme,
  type ThemeChoice,
} from '~/lib/theme'

/**
 * The light / dark / system control (#226 B8). The palette it switches lives
 * in `uno.config.ts` as `--ui-*` variables and the rule in `lib/theme.ts` —
 * this component is only the control.
 *
 * It is a menu rather than a cycling button because there are three settings:
 * a button that cycles cannot say what the other two are, and `system` in
 * particular is invisible until you land on it. Ark's `Menu` carries the
 * radio semantics (`menuitemradio` + checked state) for free, and it is the
 * same primitive as the user menu sitting next to it in the bar.
 *
 * Two signals, and they are not the same thing: `choice` is what the user
 * picked and what is persisted; `theme` is what the document is rendering.
 * They differ exactly when the choice is `system`, which is why the trigger
 * glyph reads `theme` (what you are looking at) and the checkmark reads
 * `choice` (what you asked for).
 *
 * The document is already correct before this mounts — the boot script in
 * `entry-server.tsx` applied the same rule pre-paint — so `onMount` is
 * bringing the component in step with the document, not the other way round.
 * It goes through `show()` anyway rather than reading the class back: that is
 * the same call the OS listener makes, so mount and an OS flip cannot end up
 * disagreeing about what the document says.
 */

const GLYPH: Record<ThemeChoice, string> = {
  light: 'i-material-symbols-light-mode',
  dark: 'i-material-symbols-dark-mode',
  system: 'i-material-symbols-computer-outline',
}

const LABEL: Record<ThemeChoice, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
}

export const ThemeSwitcher = () => {
  const [choice, setChoice] = createSignal<ThemeChoice>('system')
  const [theme, setTheme] = createSignal<Theme>('dark')

  /** Repaint the document and keep the glyph in step. */
  const show = (next: Theme) => {
    setTheme(next)
    applyTheme(next)
  }

  /**
   * The OS listener exists only while the choice is `system`. Re-subscribing
   * on every change is what makes an explicit `light`/`dark` immune to an OS
   * flip, rather than merely ignoring the event.
   */
  let unwatch = () => {}
  const watchIfSystem = (next: ThemeChoice) => {
    unwatch()
    unwatch = next === 'system' ? watchSystemTheme(show) : () => {}
  }

  onMount(() => {
    const stored = readThemeChoice()
    setChoice(stored)
    show(resolveTheme(stored))
    watchIfSystem(stored)
  })
  onCleanup(() => unwatch())

  const select = (next: ThemeChoice) => {
    setChoice(next)
    setTheme(applyThemeChoice(next))
    watchIfSystem(next)
  }

  // The trigger says what is rendered; the menu says what was chosen.
  const triggerLabel = () => `Theme: ${LABEL[choice()]}`

  return (
    <Menu.Root positioning={{ placement: 'bottom-end' }}>
      <Menu.Trigger
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
        title={triggerLabel()}
        aria-label={triggerLabel()}
      >
        {/* The glyph shows the mode you are in — under `system` that is
            whichever one the OS resolved to, which is the honest answer. */}
        <span class={GLYPH[theme()]} w="5" h="5" text="ui-accent" aria-hidden="true" />
      </Menu.Trigger>

      <Menu.Positioner>
        <Menu.Content
          bg="ui-bg-secondary"
          border="1 ui-border-primary"
          rounded="lg"
          shadow="lg"
          p="y-1"
          min-w="40"
          z="50"
        >
          <Menu.RadioItemGroup
            value={choice()}
            onValueChange={(details) => select(details.value as ThemeChoice)}
          >
            <For each={THEME_CHOICES}>
              {(option) => (
                <Menu.RadioItem
                  value={option}
                  flex="~"
                  items="center"
                  gap="2"
                  p="x-3 y-2"
                  text="sm ui-text-primary"
                  bg="hover:ui-bg-hover"
                  cursor="pointer"
                  transition="colors"
                >
                  <span class={GLYPH[option]} w="4" h="4" text="ui-accent" aria-hidden="true" />
                  <Menu.ItemText flex="1">{LABEL[option]}</Menu.ItemText>
                  {/* `flex` is load-bearing: an icon span is `display:inline`
                      until something blockifies it, and an inline box ignores
                      width and height — the glyph collapses to nothing. */}
                  <Menu.ItemIndicator flex="~">
                    <span
                      class="i-material-symbols-check-small"
                      w="4"
                      h="4"
                      text="ui-accent"
                      aria-hidden="true"
                    />
                  </Menu.ItemIndicator>
                </Menu.RadioItem>
              )}
            </For>
          </Menu.RadioItemGroup>
        </Menu.Content>
      </Menu.Positioner>
    </Menu.Root>
  )
}
