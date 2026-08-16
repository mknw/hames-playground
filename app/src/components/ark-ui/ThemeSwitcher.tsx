import { createSignal, createEffect, onMount } from 'solid-js'

export const ThemeSwitcher = () => {
  const [isDark, setIsDark] = createSignal(true) // Default to dark theme

  // Initialize theme from localStorage or default to dark
  onMount(() => {
    const savedTheme = localStorage.getItem('theme')
    const prefersDark = savedTheme === 'dark' || (!savedTheme && window.matchMedia('(prefers-color-scheme: dark)').matches)
    setIsDark(prefersDark)
    updateTheme(prefersDark)
  })

  // Update theme when toggled
  createEffect(() => {
    updateTheme(isDark())
  })

  const updateTheme = (dark: boolean) => {
    if (dark) {
      document.documentElement.classList.add('dark')
      localStorage.setItem('theme', 'dark')
    } else {
      document.documentElement.classList.remove('dark')
      localStorage.setItem('theme', 'light')
    }
  }

  const toggleTheme = () => {
    setIsDark(!isDark())
  }

  return (
    <button
      onClick={toggleTheme}
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
      title={isDark() ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      {isDark() ? (
        <svg
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          style={{"color":"#00ffff"}}
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
          />
        </svg>
      ) : (
        <svg
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          style={{"color":"#4f46e5"}}
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
          />
        </svg>
      )}
    </button>
  )
}
