/**
 * The theme switch (#226 B8) — one rule, three consumers.
 *
 * The palette itself is CSS: `uno.config.ts` defines every `--ui-*` variable
 * on `:root` (dark) and overrides it on `:root.light`. This module owns the
 * only other half of the mechanism — WHICH class `<html>` carries, and how a
 * stored choice survives a reload.
 *
 * **Choice and theme are two different things.** The user picks one of three
 * — `light`, `dark`, `system` — and that is what is persisted. What the
 * document renders is always one of two, and `system` resolves to whichever
 * the OS asks for at that moment. Collapsing the two would lose the
 * distinction between "I want dark" and "I want whatever the OS wants, which
 * happens to be dark right now": the first must not follow a later OS change,
 * the second must.
 *
 * Both classes are applied, and they are not redundant:
 *  - `dark` is UnoCSS's own dark-variant hook (`presetWind4` emits
 *    `.dark .dark\:…`), so it has to be present for a `dark:` utility to work
 *    at all.
 *  - `light` is what the palette override keys off. It is a POSITIVE marker
 *    so that a document with neither class — the server-rendered one, before
 *    any script runs — is dark. Keying light off `:root:not(.dark)` would
 *    make every first paint light and then flip.
 *
 * **`system` is the default, and dark is where every unknown lands.** The
 * server cannot read `prefers-color-scheme`, so SSR emits neither class and
 * paints dark; `THEME_BOOT_SCRIPT` runs blocking in the head and resolves the
 * real answer before the first paint, so a light OS never sees a dark flash.
 * A browser with no `matchMedia`, or one that refuses storage, resolves dark.
 *
 * `THEME_BOOT_SCRIPT` is the same rule as a string. An inline script cannot
 * import, so the rule is written twice by necessity; keeping both copies in
 * this file is what stops them drifting, and `theme.test.ts` executes the
 * script and cross-checks it against `resolveTheme()` on every input.
 */

/** What the document renders. Always one of two. */
export type Theme = 'dark' | 'light'

/** What the user picked. `system` defers to the OS, live. */
export type ThemeChoice = Theme | 'system'

/** The three settings the switcher offers, in the order it offers them. */
export const THEME_CHOICES: readonly ThemeChoice[] = ['light', 'dark', 'system']

/** localStorage key holding the user's choice. Absent means `system`. */
export const THEME_STORAGE_KEY = 'theme'

/**
 * Light is the queried side, not dark: `(prefers-color-scheme: dark)` also
 * matches nothing on a browser that reports `no-preference`, and dark is this
 * app's default — asking about light keeps "no answer" and "wants dark" on
 * the same branch.
 */
export const PREFERS_LIGHT_QUERY = '(prefers-color-scheme: light)'

/**
 * The user's stored choice, or `system` if they never made one. An
 * unrecognised stored value is treated as no choice at all.
 */
export function readThemeChoice(): ThemeChoice {
  try {
    const stored = globalThis.localStorage?.getItem(THEME_STORAGE_KEY)
    if (stored === 'light' || stored === 'dark') return stored
  } catch {
    // Private-mode / blocked storage. `system` is the default anyway.
  }
  return 'system'
}

/**
 * What the OS is asking for right now. Dark off the browser, and dark on a
 * browser that expresses no preference.
 */
export function systemTheme(): Theme {
  try {
    return globalThis.matchMedia?.(PREFERS_LIGHT_QUERY).matches ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

/** The theme a choice renders as. Defaults to the stored choice. */
export function resolveTheme(choice: ThemeChoice = readThemeChoice()): Theme {
  return choice === 'system' ? systemTheme() : choice
}

/**
 * Put `theme` on `<html>`. Deliberately does NOT persist: what gets stored is
 * the *choice*, and `system` is not a theme. A no-op off the browser.
 */
export function applyTheme(theme: Theme): void {
  const root = globalThis.document?.documentElement
  if (!root) return
  root.classList.toggle('dark', theme === 'dark')
  root.classList.toggle('light', theme === 'light')
}

/**
 * Persist `choice`, apply the theme it resolves to, and return that theme.
 * `system` is stored by removing the key, so a browser that later gains an OS
 * preference is not pinned by a stale value.
 */
export function applyThemeChoice(choice: ThemeChoice): Theme {
  const theme = resolveTheme(choice)
  applyTheme(theme)
  try {
    if (choice === 'system') globalThis.localStorage?.removeItem(THEME_STORAGE_KEY)
    else globalThis.localStorage?.setItem(THEME_STORAGE_KEY, choice)
  } catch {
    // Storage refused; the class is applied either way, it just won't persist.
  }
  return theme
}

/**
 * Call `onChange` whenever the OS flips, until the returned function is
 * called. Callers only subscribe while the choice is `system` — a stored
 * `light`/`dark` must survive an OS change untouched. Returns a no-op
 * unsubscribe where `matchMedia` is missing.
 */
export function watchSystemTheme(onChange: (theme: Theme) => void): () => void {
  const query = globalThis.matchMedia?.(PREFERS_LIGHT_QUERY)
  if (!query?.addEventListener) return () => {}
  const handler = (event: MediaQueryListEvent) => onChange(event.matches ? 'light' : 'dark')
  query.addEventListener('change', handler)
  return () => query.removeEventListener('change', handler)
}

/**
 * Body of the blocking inline script in the document head. Applies the
 * resolved theme before first paint — without it a light preference (stored
 * or from the OS) arrives only at hydration and the page flashes dark first.
 * It deliberately does NOT write storage: resolving is a read, and the
 * switcher owns the write.
 */
export const THEME_BOOT_SCRIPT = `try{var s=localStorage.getItem('${THEME_STORAGE_KEY}');var l=s==='light'||(s!=='dark'&&matchMedia('${PREFERS_LIGHT_QUERY}').matches);var c=document.documentElement.classList;c.toggle('light',l);c.toggle('dark',!l)}catch(e){document.documentElement.classList.add('dark')}`
