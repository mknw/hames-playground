/**
 * The theme switch (#226 B8) — one rule, three consumers.
 *
 * The palette itself is CSS: `uno.config.ts` defines every `--ui-*` variable
 * on `:root` (dark) and overrides it on `:root.light`. This module owns the
 * only other half of the mechanism — WHICH class `<html>` carries, and how a
 * stored choice survives a reload.
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
 * **Dark is the default, and the OS `prefers-color-scheme` is deliberately
 * ignored.** Only the themed surfaces (the auth pages) follow the palette so
 * far; the rest of the app is still fixed dark hexes. Honouring a light OS
 * setting would therefore hand a user who never asked for it a light sign-in
 * page in front of a dark app. Light is opt-in, by the switcher, until the
 * app's screens have moved onto the `ui-*` tokens — at which point this
 * function is the one place to add the media query back.
 *
 * `THEME_BOOT_SCRIPT` is the same rule as a string, inlined in the document
 * head by `entry-server.tsx` so it runs before first paint. An inline script
 * cannot import, so the rule is written twice by necessity; keeping both
 * copies in this file is what stops them drifting.
 */

export type Theme = 'dark' | 'light'

/** localStorage key holding the user's explicit choice, if they made one. */
export const THEME_STORAGE_KEY = 'theme'

/**
 * The theme to show: the stored choice if the user made one, else dark. Safe
 * to call anywhere — a browser that denies storage, or a server with no
 * `localStorage`, resolves to dark.
 */
export function resolveTheme(): Theme {
  try {
    if (globalThis.localStorage?.getItem(THEME_STORAGE_KEY) === 'light') return 'light'
  } catch {
    // Private-mode / blocked storage. Dark is the default anyway.
  }
  return 'dark'
}

/**
 * Put `theme` on `<html>` and persist it, so the choice survives a reload.
 * A no-op off the browser.
 */
export function applyTheme(theme: Theme): void {
  const root = globalThis.document?.documentElement
  if (!root) return
  root.classList.toggle('dark', theme === 'dark')
  root.classList.toggle('light', theme === 'light')
  try {
    globalThis.localStorage?.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // Storage refused; the class is applied either way, it just won't persist.
  }
}

/**
 * Body of the blocking inline script in the document head. Applies the stored
 * theme before first paint — without it a stored light preference arrives only
 * at hydration and the page flashes dark first. It deliberately does NOT
 * write storage: resolving is a read, and the switcher owns the write.
 */
export const THEME_BOOT_SCRIPT = `try{var l=localStorage.getItem('${THEME_STORAGE_KEY}')==='light';var c=document.documentElement.classList;c.toggle('light',l);c.toggle('dark',!l)}catch(e){document.documentElement.classList.add('dark')}`
